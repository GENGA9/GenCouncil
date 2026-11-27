import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { familyColor, memberName } from "../model";
import type { ChatItem, Member, ProjectOv, RuntimeState, Task, UploadHooks } from "../types";

import { fmtSize, MAX_UPLOAD_BYTES } from "../upload";
import { GridSpinner } from "./GridSpinner";
import { Attachments } from "./Attachments";
import { ZoomImg } from "./Lightbox";
import { useStickToBottom } from "./stickToBottom";
import { useT } from "../i18n";

/** chair models per CLI; the chair runs on whatever CLI its account belongs to */
export const CHAIR_MODELS: Record<string, string[]> = {
  claude: ["", "opus", "sonnet", "fable", "haiku"],
  gpt: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna"],
  gemini: ["gemini-4-argon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-3.8-flash"],
  grok: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"],
};
export const CHAIR_EFFORTS: Record<string, string[]> = {
  claude: ["", "low", "medium", "high", "xhigh", "max"],
  gpt: ["", "low", "medium", "high", "xhigh", "max"],
  gemini: ["", "low", "medium", "high"],
  grok: ["", "low", "medium", "high", "xhigh"],
};
/** this many member folders on disk and the folder button asks to be pressed */
export const FOLDERS_MANY = 10;
export const PROVIDER_LABEL: Record<string, string> = { claude: "클로드", gpt: "GPT", gemini: "제미나이", grok: "그록" };
export const CLI_PROVIDERS = ["claude", "gpt", "gemini", "grok"];
const STATUS_KO: Record<Task["status"], string> = { todo: "대기", doing: "진행", review: "검토", done: "완료", blocked: "막힘" };

/** Telegram paper-plane logo (circle with the plane); on = Telegram blue filled, off = grey outline */
function TelegramIcon({ on }: { on: boolean }) {
  return (
    <svg className="tg-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill={on ? "#229ED9" : "none"} stroke={on ? "#229ED9" : "currentColor"} strokeWidth="1.4" />
      <path
        d="M5.6 11.9l10.9-4.2c.5-.2 1 .1.8.9l-1.9 8.8c-.1.6-.5.8-1 .5l-2.9-2.1-1.4 1.4c-.2.2-.3.3-.6.3l.2-3 5.3-4.8c.2-.2 0-.3-.3-.1l-6.6 4.1-2.8-.9c-.6-.2-.6-.6.3-.9z"
        fill={on ? "#fff" : "currentColor"}
      />
    </svg>
  );
}

/** whether Telegram is set up on the server; asked once per page load */
type TelegramInfo = { configured: boolean; user?: string; autoNotify: boolean };
let telegramInfo: Promise<TelegramInfo> | undefined;
const loadTelegramInfo = () => (telegramInfo ??= api.telegram().catch((): TelegramInfo => ({ configured: false, autoNotify: false })));

/** Per-agenda switch for sending every notification to Telegram automatically (on by default; pending questions always go). Disabled and shown off while Telegram is not connected. */
export function TelegramAutoButton({ agendaKey, on, closed, onError }: { agendaKey: string; on: boolean; closed: boolean; onError: (msg: string) => void }) {
  const t = useT();
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    void loadTelegramInfo().then(setInfo);
  }, []);
  // the real state arrived (or the agenda changed): drop the optimistic value
  useEffect(() => setPending(null), [on, agendaKey]);
  if (!info) return null;
  // connected = configured and the bot answered (the server reports its user name only after verify)
  const connected = info.configured && Boolean(info.user);
  const forced = connected && info.autoNotify;
  const shown = connected && (forced || (pending ?? on));
  const title = !connected
    ? t("텔레그램이 연결되어 있지 않습니다")
    : forced
    ? t("텔레그램 자동 전송 켜짐(서버 설정 --auto on): 모든 안건의 알림을 보냅니다")
    : shown
      ? t("텔레그램 자동 전송 켜짐: 이 안건의 모든 알림을 보냅니다")
      : t("텔레그램 자동 전송 꺼짐: 결정 대기 질문만 보냅니다");
  return (
    <button
      className={`ghost small tg-auto ${shown ? "on" : "off"}`}
      title={title}
      aria-label={title}
      aria-pressed={shown}
      disabled={closed || forced || !connected}
      onClick={() => {
        const next = !shown;
        setPending(next);
        api.setTelegramAuto(agendaKey, next).catch((e: Error) => {
          setPending(null);
          onError(e.message);
        });
      }}
    >
      <TelegramIcon on={shown} />
    </button>
  );
}

interface Props {
  state: RuntimeState | null;
  chat: ChatItem[];
  firstTurn: boolean;
  loading: boolean;
  project?: ProjectOv;
  onSend: (message: string, files?: File[], hooks?: UploadHooks) => Promise<void>;
  onSetChair: (model: string, effort: string, account?: string, advisor?: string) => Promise<void>;
  onReset: () => Promise<void>;
  onSetAutonomy: (autonomy: string) => Promise<void>;
  onRetrospect: () => Promise<void>;
  onResume: () => Promise<void>;
  onDismissResume: () => Promise<void>;
  onFinish: () => Promise<void>;
  onDelete: () => Promise<void>;
  onApproveFinish: () => Promise<void>;
  onMergeBase: () => Promise<void>;
  onTidyFolders: () => void;
  onDismissFinish: () => Promise<void>;
}

export function CenterPane({ state, chat, firstTurn, loading, project, onSend, onSetChair, onReset, onSetAutonomy, onRetrospect, onResume, onDismissResume, onFinish, onDelete, onApproveFinish, onDismissFinish, onMergeBase, onTidyFolders }: Props) {
  const t = useT();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  // per pending file: upload progress, or the failure message (the chip stays so it can be retried or removed); key -1 = rejected before upload
  const [upProgress, setUpProgress] = useState<Record<number, number>>({});
  const [upFailed, setUpFailed] = useState<Record<number, string>>({});
  const [dragOver, setDragOver] = useState(false);
  // the goals card can be folded to give the chat more room; remembered on this device
  const [goalsFolded, setGoalsFolded] = useState(() => {
    try {
      return localStorage.getItem("gc.goalsFolded") === "1";
    } catch {
      return false;
    }
  });
  const toggleGoals = () => {
    const next = !goalsFolded;
    setGoalsFolded(next);
    try {
      localStorage.setItem("gc.goalsFolded", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  // the decision card can be folded so the chat above it stays readable on phones; a new question unfolds it
  const [foldedAsk, setFoldedAsk] = useState<string | null>(null);
  const askFolded = Boolean(state?.agenda.waitingForUser) && foldedAsk === state?.agenda.waitingForUser?.question;
  const askHead = (label: string) => (
    <button
      className="ask-head"
      onClick={() => setFoldedAsk(askFolded ? null : state?.agenda.waitingForUser?.question ?? null)}
      title={askFolded ? t("펼치기") : t("접어서 위 대화 보기")}
    >
      <span>{label}</span>
      <span className="ask-fold">{askFolded ? `${t("펼치기")} ▴` : `${t("접기")} ▾`}</span>
    </button>
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const [showState, setShowState] = useState(false);
  const addFiles = (list: FileList | File[] | null | undefined) => {
    const arr = Array.from(list ?? []).filter((f) => f.size > 0);
    const tooBig = arr.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const ok = arr.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (tooBig.length) setUpFailed((cur) => ({ ...cur, [-1]: t("업로드 실패: {names} — 2GB를 넘어 올릴 수 없습니다 ({size})", { names: tooBig.map((f) => f.name || t("파일")).join(", "), size: fmtSize(tooBig[0].size) }) }));
    if (ok.length) setFiles((cur) => [...cur, ...ok].slice(0, 10));
  };
  // the newest line stays in view (media loading later included) until the reader scrolls up
  const listRef = useStickToBottom<HTMLDivElement>(state?.key);
  const busy = state?.chair.busy ?? false;

  if (!state) {
    return <div className="center-empty muted">{loading ? t("안건을 여는 중… (worktree 준비)") : t("왼쪽에서 안건을 선택하세요.")}</div>;
  }

  const submit = async () => {
    const t = text.trim();
    if ((!t && files.length === 0) || sending) return;
    setSending(true);
    setUpProgress({});
    setUpFailed({});
    try {
      await onSend(t, files, {
        onProgress: (i, pct) => setUpProgress((cur) => ({ ...cur, [i]: pct })),
        onFail: (i, msg) => setUpFailed((cur) => ({ ...cur, [i]: msg })),
      });
      setText("");
      setFiles([]);
      setUpProgress({});
    } catch {
      /* the app shows the error; keep the draft */
    } finally {
      setSending(false);
    }
  };

  const model = state.chair.model ?? "";
  const effort = state.chair.effort ?? "";
  const chairProvider = state.chair.provider ?? "claude";
  const MODELS = CHAIR_MODELS[chairProvider] ?? CHAIR_MODELS.claude;
  const EFFORTS = chairProvider === "gemini" && /hydrogen|neon/i.test(model)
    ? [...CHAIR_EFFORTS.gemini, "xhigh"]
    : CHAIR_EFFORTS[chairProvider] ?? CHAIR_EFFORTS.claude;
  const memberById = new Map(state.members.map((m) => [m.id, m]));
  const goalTasks = (i: number) => state.tasks.filter((t) => t.goal === i + 1);
  const orphanTasks = state.tasks.filter((t) => !t.goal);
  const allDone = state.tasks.length > 0 && state.tasks.every((t) => t.status === "done");

  return (
    <div className="center-inner">
      <div className="chair-head">
        <div className="chair-title">
          <span className="chair-label">{t("의장 · {p}", { p: t(PROVIDER_LABEL[chairProvider] ?? chairProvider) })}</span>
          <select value={MODELS.includes(model) ? model : "custom"} onChange={(e) => e.target.value !== "custom" && onSetChair(e.target.value, chairProvider === "gemini" && effort === "xhigh" && !/hydrogen|neon/i.test(e.target.value) ? "high" : effort)} title={t("의장 모델 (이 안건에만 적용)")}>
            {MODELS.map((m) => (
              <option key={m} value={m}>{m || t("기본 모델")}</option>
            ))}
            {!MODELS.includes(model) && <option value="custom">{model}</option>}
          </select>
          <select value={effort} onChange={(e) => onSetChair(model, e.target.value)} title={t("추론 수준 (이 안건에만 적용)")}>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>{e ? t("추론 {v}", { v: e }) : t("추론 기본")}</option>
            ))}
          </select>

          <select
            value={state.chair.account ?? "claude"}
            title={t("의장 계정. GPT·제미나이·그록 계정을 고르면 그 AI가 의장을 맡습니다. 이 안건에만 적용되고 다른 안건은 그대로입니다 (바꾸면 state.md 기반으로 새 세션 시작)")}
            onChange={(e) => {
              const next = state.accounts.find((a) => a.id === e.target.value);
              const otherAi = next && next.provider !== chairProvider ? t(PROVIDER_LABEL[next.provider] ?? next.provider) : "";
              if (confirm(otherAi ? t("이 안건의 의장 계정을 바꾸면 {p}가 의장을 맡고 대화 세션이 새로 시작됩니다 (state.md는 유지). 다른 안건은 그대로입니다. 계속할까요?", { p: otherAi }) : t("이 안건의 의장 계정을 바꾸면 대화 세션이 새로 시작됩니다 (state.md는 유지). 다른 안건은 그대로입니다. 계속할까요?"))) void onSetChair(model, effort, e.target.value);
            }}
          >
            {CLI_PROVIDERS.map((p) => {
              const list = state.accounts.filter((a) => a.provider === p);
              return list.length ? (
                <optgroup key={p} label={t(PROVIDER_LABEL[p])}>
                  {list.map((a) => (
                    <option key={a.id} value={a.id}>{a.id}{a.status !== "ok" ? ` (${a.status})` : ""}</option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
          {project && (
            <select
              className="autonomy-select"
              value={project.members.autonomy}
              title={t("위원 권한(자율성): 위원이 명령 실행 등 권한이 필요한 일을 할 때 누가 허락하는지 (제미나이 위원은 의장에게 승인을 넘길 수 없어 '의장이 승인'에서도 권한 확인 없이 실행)")}
              onChange={(e) => onSetAutonomy(e.target.value)}
            >
              <option value="full">{t("권한: 확인 없음")}</option>
              <option value="chair">{t("권한: 의장 승인")}</option>
              <option value="edits">{t("권한: 편집만 자동")}</option>
            </select>
          )}
          <TelegramAutoButton agendaKey={state.key} on={state.agenda.telegramAuto !== false} closed={state.agenda.status === "closed"} onError={(m) => window.alert(m)} />
          {busy && <GridSpinner color={`var(--c-${chairProvider})`} size={16} title={t("의장이 생각 중")} />}
        </div>
        <div className="chair-actions">
          <button className="ghost small" onClick={() => setShowState((v) => !v)}>{showState ? t("대화") : t("의장 상태")}</button>
          <button className="ghost small" onClick={onReset} title={t("의장 세션을 새로 시작 (state.md 유지)")}>{t("세션 초기화")}</button>
          <button className="ghost small" onClick={onRetrospect} disabled={busy || firstTurn} title={t("의장이 교훈·모델 성향을 공유 기억에 기록하고 제안을 검토")}>{t("회고")}</button>
          <button className="ghost small" onClick={() => void onMergeBase()} disabled={state.agenda.status === "closed"} title={t("안건을 닫지 않고 지금까지의 결과를 메인(베이스 브랜치)에 합칩니다")}>{t("메인 반영")}</button>
          {(state.folders ?? 0) > 0 && (
            <button className={`small ${(state.folders ?? 0) >= FOLDERS_MANY ? "warn-btn" : "ghost"}`} onClick={onTidyFolders} title={t("위원 작업 폴더가 쌓인 것을 확인하고, 아무도 쓰지 않는 폴더를 지웁니다 (브랜치는 남음)")}>
              {t("폴더 {n}", { n: state.folders ?? 0 })}
            </button>
          )}
          <button className={`small ${allDone ? "primary" : "ghost"}`} onClick={onFinish} disabled={state.agenda.status === "closed"}>{t("안건 종료")}</button>
          <button className="ghost small danger" onClick={onDelete} disabled={busy} title={t("이 안건을 지웁니다. 대화 기록은 프로젝트의 deleted 폴더로 옮겨집니다")}>{t("삭제")}</button>
        </div>
      </div>

      <div className={`goals ${goalsFolded ? "folded" : ""}`}>
        <button className="goals-head" onClick={toggleGoals} title={goalsFolded ? t("목표 펼치기") : t("목표 접기")}>
          <span>{state.agenda.title}</span>
          <span className="goals-meta">
            {goalsFolded ? (
              <span className="muted small">
                {t("목표 {g} · 작업 {done}/{total}", { g: state.agenda.goals.length, done: state.tasks.filter((x) => x.status === "done").length, total: state.tasks.length })}
              </span>
            ) : (
              <span className="muted small mono">{state.agenda.branch}</span>
            )}
            <span className="ask-fold muted small">{goalsFolded ? `${t("펼치기")} ▾` : `${t("접기")} ▴`}</span>
          </span>
        </button>
        {!goalsFolded && state.agenda.goals.map((g, i) => (
          <div key={i} className="goal">
            <div className="goal-title">
              <span className="goal-n">{t("목표{n}", { n: i + 1 })}</span> {g}
            </div>
            <div className="goal-tasks">
              {goalTasks(i).map((t) => <TaskChip key={t.id} t={t} member={t.memberId ? memberById.get(t.memberId) : undefined} />)}
            </div>
          </div>
        ))}
        {!goalsFolded && orphanTasks.length > 0 && (
          <div className="goal">
            <div className="goal-title muted">{t("기타 작업")}</div>
            <div className="goal-tasks">{orphanTasks.map((t) => <TaskChip key={t.id} t={t} member={t.memberId ? memberById.get(t.memberId) : undefined} />)}</div>
          </div>
        )}
        {!goalsFolded && state.agenda.goals.length === 0 && <div className="muted small">{t("아직 목표가 없습니다. 아래 채팅으로 할 일을 말하면 의장이 제목과 목표를 정합니다.")}</div>}
      </div>

      {showState ? (
        <pre className="chair-state">{state.chairState || t("(아직 state.md 가 없습니다)")}</pre>
      ) : (
        <div className="chat" ref={listRef}>
          {chat.length === 0 && firstTurn && (
            <div className="chat-empty">
              <p className="muted">{t("아직 의장과 대화가 없습니다.")}</p>
              {state.agenda.goals.length > 0 ? (
                <button className="primary" onClick={() => onSend("")} disabled={busy}>{t("안건 시작 (의장이 목표를 분장)")}</button>
              ) : (
                <p className="small muted">{t("무엇을 할지 아래 채팅창에 적어 주세요.")}</p>
              )}
            </div>
          )}
          {chat.map((c) => (
            <div key={c.id} className={`msg ${c.role}`}>
              {c.role === "assistant" && <span className="who">{t("의장")}</span>}
              {c.role === "user" && <span className="who">{t("나")}</span>}
              {c.role === "event" && <span className="who">{t("이벤트")}</span>}
              {c.text && <div className="msg-text">{c.text}</div>}
              {c.attachments && c.attachments.length > 0 && state && <Attachments agenda={state.key} items={c.attachments} shown={c.role === "assistant"} />}
            </div>
          ))}
          {state.resume && !busy && (
            <div className="resume-card">
              <div className="resume-title">{t("지난번 작업이 중간에 멈췄습니다")}</div>
              <ul className="small">
                {state.resume.members.map((m) => (
                  <li key={m.id}>
                    {t("위원 {id}", { id: m.id })}{m.model ? ` (${m.model})` : ""}: {m.taskTitle}
                  </li>
                ))}
                {state.resume.chair && <li>{t("의장 응답: “{msg}”", { msg: state.resume.chair.message.slice(0, 80) + (state.resume.chair.message.length > 80 ? "…" : "") })}</li>}
              </ul>
              <div className="small muted">{t("이어서 하면 위원은 같은 작업 폴더에서 남긴 기록(STATE.md)을 보고 계속하고, 의장은 하던 일을 다시 이어갑니다.")}</div>
              <div className="resume-actions">
                <button className="primary" onClick={() => void onResume()}>{t("이어서 하기")}</button>
                <button className="ghost small" onClick={() => void onDismissResume()}>{t("무시")}</button>
              </div>
            </div>
          )}
          {busy && (
            <div className="msg thinking muted">
              <GridSpinner color={`var(--c-${chairProvider})`} size={12} /> {t("의장이 작업 중…")}{" "}
              <button
                className="ghost small"
                title={t("의장의 이번 작업을 멈춥니다. 위원은 계속 일하고, 기다리던 메시지가 바로 전달됩니다")}
                onClick={() => {
                  if (confirm(t("의장의 이번 작업을 멈출까요? (위원은 계속 작업합니다)"))) void api.stopChair(state.key);
                }}
              >
                {t("의장 멈추기")}
              </button>
            </div>
          )}
          {(state.chair.queued?.length ?? 0) > 0 && (
            <div className="msg queued">
              <div className="small muted">{t("의장 작업이 끝나면 전달할 메시지 {n}개", { n: state.chair.queued!.length })}</div>
              {state.chair.queued!.map((q, i) => (
                <div key={i} className="queued-text">{q}</div>
              ))}
              <button className="ghost small" onClick={() => void api.clearQueue(state.key)}>{t("대기 취소")}</button>
            </div>
          )}
        </div>
      )}

      {state.agenda.waitingForUser?.kind === "finish" && !busy && state.agenda.status !== "closed" && (
        <div className={`ask-card finish ${askFolded ? "folded" : ""}`}>
          {askHead(t("의장이 안건 종료를 제안합니다"))}
          <div className="ask-question">{state.agenda.waitingForUser.question}</div>
          <div className="ask-options">
            <button className="primary small" disabled={sending} onClick={() => void onApproveFinish()}>{t("안건 종료 승인")}</button>
            <button className="ghost small" disabled={sending} onClick={() => void onDismissFinish()}>{t("계속 진행")}</button>
          </div>
          <div className="small muted ask-hint">{t("승인하면 안건 브랜치를 베이스 브랜치에 합치고 안건을 닫습니다. 더 고칠 것이 있으면 아래에 바로 적어도 됩니다.")}</div>
        </div>
      )}
      {state.agenda.waitingForUser && state.agenda.waitingForUser.kind !== "finish" && !busy && state.agenda.status !== "closed" && (
        <div className={`ask-card ${askFolded ? "folded" : ""}`}>
          {askHead(t("의장이 결정을 기다립니다"))}
          <div className="ask-question">{state.agenda.waitingForUser.question}</div>
          {(state.agenda.waitingForUser.options?.length ?? 0) > 0 && (
            <div className="ask-options">
              {state.agenda.waitingForUser.options!.map((o) => (
                <button key={o} className="ghost small" disabled={sending} onClick={() => void onSend(o)}>{o}</button>
              ))}
            </div>
          )}
          <div className="small muted ask-hint">{t("버튼을 누르거나 아래에 직접 답하세요.")}</div>
        </div>
      )}
      {(files.length > 0 || upFailed[-1]) && (
        <div className="pending-files">
          {files.map((f, i) => (
            <span key={i} className={`file-chip ${upFailed[i] ? "failed" : ""}`} title={upFailed[i]}>
              {f.type.startsWith("image/") ? <ZoomImg src={URL.createObjectURL(f)} name={f.name || t("붙여넣은 이미지")} /> : "📎"} {f.name || t("붙여넣은 이미지")}
              <span className="muted"> {fmtSize(f.size)}</span>
              {sending && upProgress[i] !== undefined && !upFailed[i] && <span className="up-progress"> {upProgress[i] >= 100 ? t("처리 중…") : `${upProgress[i]}%`}</span>}
              {upFailed[i] && <span className="up-failed"> ⚠ {t("실패")}</span>}
              <button
                className="icon"
                title={t("빼기")}
                disabled={sending}
                onClick={() => {
                  setFiles((cur) => cur.filter((_, j) => j !== i));
                  setUpFailed({});
                  setUpProgress({});
                }}
              >
                ✕
              </button>
            </span>
          ))}
          {Object.entries(upFailed).map(([k, msg]) => (
            <div key={k} className="up-error" role="alert">
              {msg}
              {Number(k) >= 0 && ` — ${t("전송을 다시 눌러 재시도하거나 ✕로 뺄 수 있습니다.")}`}
            </div>
          ))}
          {sending && Object.keys(upProgress).length > 0 && <div className="up-status small muted">{t("올리는 중… (끝나면 의장에게 전달됩니다)")}</div>}
        </div>
      )}
      <div
        className={`composer ${dragOver ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <button className="ghost attach-btn" title={t("파일·사진 첨부")} onClick={() => fileInput.current?.click()} disabled={sending}>📎</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          placeholder={busy ? t("의장이 작업 중입니다. 지금 보내면 작업이 끝나는 대로 전달됩니다") : t("의장에게 말하기 (Enter 전송, Shift+Enter 줄바꿈, 사진은 붙여넣기·끌어놓기)")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />
        <button className="primary" onClick={submit} disabled={sending || (!text.trim() && files.length === 0)}>{sending ? t("올리는 중…") : busy ? t("대기 전송") : t("전송")}</button>
      </div>
      {project && (
        <div className="small muted center-foot">
          {t("{repo}{git} · 위원 자율성 {autonomy} · 한도", { repo: project.repo, git: project.localGit ? t(" (로컬 git)") : "", autonomy: project.members.autonomy })}{" "}
          {Object.entries(state.limits)
            .filter(([, l]) => l.maxMembers > 0)
            .map(([k, l]) => `${k} ${state.active[k] ?? 0}/${l.maxMembers}${l.maxModel ? " ≤" + l.maxModel : ""}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function TaskChip({ t: task, member }: { t: Task; member?: Member }) {
  const tr = useT();
  return (
    <span className={`task ${task.status}`} title={`${task.id} ${task.description}${task.note ? "\n" + task.note : ""}${member ? `\n${member.id}` : ""}`}>
      <span className="task-status">{tr(STATUS_KO[task.status])}</span> {task.title}
      {member && (
        <span className="task-member" style={{ color: familyColor(member) }}>
          {task.status === "doing" && <GridSpinner color={familyColor(member)} size={9} />} ← {memberName(member)}
        </span>
      )}
      {!member && task.memberId && <span className="task-member">← {task.memberId}</span>}
    </span>
  );
}
