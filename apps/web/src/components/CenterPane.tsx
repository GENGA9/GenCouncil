import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { familyColor, memberName } from "../model";
import type { ChatItem, Member, ProjectOv, RuntimeState, Task } from "../types";
import { GridSpinner } from "./GridSpinner";

const MODELS = ["", "opus", "sonnet", "fable", "haiku"];
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const STATUS_KO: Record<Task["status"], string> = { todo: "대기", doing: "진행", review: "검토", done: "완료", blocked: "막힘" };

interface Props {
  state: RuntimeState | null;
  chat: ChatItem[];
  firstTurn: boolean;
  loading: boolean;
  project?: ProjectOv;
  onSend: (message: string, files?: File[]) => Promise<void>;
  onSetChair: (model: string, effort: string, account?: string, advisor?: string) => Promise<void>;
  onReset: () => Promise<void>;
  onSetAutonomy: (autonomy: string) => Promise<void>;
  onRetrospect: () => Promise<void>;
  onResume: () => Promise<void>;
  onDismissResume: () => Promise<void>;
  onFinish: () => Promise<void>;
  onDelete: () => Promise<void>;
  onApproveFinish: () => Promise<void>;
  onDismissFinish: () => Promise<void>;
}

export function CenterPane({ state, chat, firstTurn, loading, project, onSend, onSetChair, onReset, onSetAutonomy, onRetrospect, onResume, onDismissResume, onFinish, onDelete, onApproveFinish, onDismissFinish }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [showState, setShowState] = useState(false);
  const addFiles = (list: FileList | File[] | null | undefined) => {
    const arr = Array.from(list ?? []).filter((f) => f.size > 0);
    if (arr.length) setFiles((cur) => [...cur, ...arr].slice(0, 10));
  };
  const listRef = useRef<HTMLDivElement>(null);
  const busy = state?.chair.busy ?? false;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, busy]);

  if (!state) {
    return <div className="center-empty muted">{loading ? "안건을 여는 중… (worktree 준비)" : "왼쪽에서 안건을 선택하세요."}</div>;
  }

  const submit = async () => {
    const t = text.trim();
    if ((!t && files.length === 0) || busy || sending) return;
    setSending(true);
    try {
      await onSend(t, files);
      setText("");
      setFiles([]);
    } catch {
      /* the app shows the error; keep the draft */
    } finally {
      setSending(false);
    }
  };

  const model = state.chair.model ?? "";
  const effort = state.chair.effort ?? "";
  const memberById = new Map(state.members.map((m) => [m.id, m]));
  const goalTasks = (i: number) => state.tasks.filter((t) => t.goal === i + 1);
  const orphanTasks = state.tasks.filter((t) => !t.goal);
  const allDone = state.tasks.length > 0 && state.tasks.every((t) => t.status === "done");

  return (
    <div className="center-inner">
      <div className="chair-head">
        <div className="chair-title">
          의장 · 클로드
          <select value={MODELS.includes(model) ? model : "custom"} onChange={(e) => e.target.value !== "custom" && onSetChair(e.target.value, effort)} title="의장 모델">
            {MODELS.map((m) => (
              <option key={m} value={m}>{m || "기본 모델"}</option>
            ))}
            {!MODELS.includes(model) && <option value="custom">{model}</option>}
          </select>
          <select value={effort} onChange={(e) => onSetChair(model, e.target.value)} title="추론 수준">
            {EFFORTS.map((e) => (
              <option key={e} value={e}>{e ? `추론 ${e}` : "추론 기본"}</option>
            ))}
          </select>

          <select
            value={state.chair.account ?? "claude"}
            title="의장 계정 (바꾸면 state.md 기반으로 새 세션 시작)"
            onChange={(e) => {
              if (confirm("의장 계정을 바꾸면 대화 세션이 새로 시작됩니다 (state.md는 유지). 계속할까요?")) void onSetChair(model, effort, e.target.value);
            }}
          >
            {state.accounts.filter((a) => a.provider === "claude").map((a) => (
              <option key={a.id} value={a.id}>{a.id}{a.status !== "ok" ? ` (${a.status})` : ""}</option>
            ))}
          </select>
          {busy && <GridSpinner color="var(--c-claude)" size={16} title="의장이 생각 중" />}
        </div>
        <div className="chair-actions">
          {project && (
            <select
              className="autonomy-select"
              value={project.members.autonomy}
              title="위원 자율성: 위원이 명령 실행 등 권한이 필요한 일을 할 때 누가 허락하는지 (제미나이 위원은 의장에게 승인을 넘길 수 없어 '의장이 승인'에서도 권한 확인 없이 실행)"
              onChange={(e) => onSetAutonomy(e.target.value)}
            >
              <option value="full">위원: 권한 확인 없음</option>
              <option value="chair">위원: 의장이 승인</option>
              <option value="edits">위원: 편집만 자동</option>
            </select>
          )}
          <button className="ghost small" onClick={() => setShowState((v) => !v)}>{showState ? "대화" : "의장 상태"}</button>
          <button className="ghost small" onClick={onReset} title="의장 세션을 새로 시작 (state.md 유지)">세션 초기화</button>
          <button className="ghost small" onClick={onRetrospect} disabled={busy || firstTurn} title="의장이 교훈·모델 성향을 공유 기억에 기록하고 제안을 검토">회고</button>
          <button className={`small ${allDone ? "primary" : "ghost"}`} onClick={onFinish} disabled={state.agenda.status === "closed"}>안건 종료</button>
          <button className="ghost small danger" onClick={onDelete} disabled={busy} title="이 안건을 지웁니다. 대화 기록은 프로젝트의 deleted 폴더로 옮겨집니다">삭제</button>
        </div>
      </div>

      <div className="goals">
        <div className="goals-head">
          <span>{state.agenda.title}</span>
          <span className="muted small mono">{state.agenda.branch}</span>
        </div>
        {state.agenda.goals.map((g, i) => (
          <div key={i} className="goal">
            <div className="goal-title">
              <span className="goal-n">목표{i + 1}</span> {g}
            </div>
            <div className="goal-tasks">
              {goalTasks(i).map((t) => <TaskChip key={t.id} t={t} member={t.memberId ? memberById.get(t.memberId) : undefined} />)}
            </div>
          </div>
        ))}
        {orphanTasks.length > 0 && (
          <div className="goal">
            <div className="goal-title muted">기타 작업</div>
            <div className="goal-tasks">{orphanTasks.map((t) => <TaskChip key={t.id} t={t} member={t.memberId ? memberById.get(t.memberId) : undefined} />)}</div>
          </div>
        )}
        {state.agenda.goals.length === 0 && <div className="muted small">아직 목표가 없습니다. 아래 채팅으로 할 일을 말하면 의장이 제목과 목표를 정합니다.</div>}
      </div>

      {showState ? (
        <pre className="chair-state">{state.chairState || "(아직 state.md 가 없습니다)"}</pre>
      ) : (
        <div className="chat" ref={listRef}>
          {chat.length === 0 && firstTurn && (
            <div className="chat-empty">
              <p className="muted">아직 의장과 대화가 없습니다.</p>
              {state.agenda.goals.length > 0 ? (
                <button className="primary" onClick={() => onSend("")} disabled={busy}>안건 시작 (의장이 목표를 분장)</button>
              ) : (
                <p className="small muted">무엇을 할지 아래 채팅창에 적어 주세요.</p>
              )}
            </div>
          )}
          {chat.map((c) => (
            <div key={c.id} className={`msg ${c.role}`}>
              {c.role === "assistant" && <span className="who">의장</span>}
              {c.role === "user" && <span className="who">나</span>}
              {c.role === "event" && <span className="who">이벤트</span>}
              {c.text && <div className="msg-text">{c.text}</div>}
              {c.attachments && c.attachments.length > 0 && state && (
                <div className={`msg-attachments ${c.role === "assistant" ? "shown" : ""}`}>
                  {c.attachments.map((a) => {
                    const url = api.attachmentUrl(state.key, a.id);
                    if (a.type.startsWith("image/"))
                      return (
                        <a key={a.id} href={url} target="_blank" rel="noreferrer" title={a.name}>
                          <img src={url} alt={a.name} />
                        </a>
                      );
                    if (a.type === "text/html")
                      return (
                        <div key={a.id} className="shown-html">
                          <iframe src={url} sandbox="allow-scripts" title={a.name} />
                          <a className="small" href={url} target="_blank" rel="noreferrer">↗ {a.name} 새 창에서 열기</a>
                        </div>
                      );
                    if (a.type.startsWith("video/")) return <video key={a.id} src={url} controls preload="metadata" />;
                    return (
                      <a key={a.id} className="file-chip" href={url} target="_blank" rel="noreferrer">📎 {a.name}</a>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {state.resume && !busy && (
            <div className="resume-card">
              <div className="resume-title">지난번 작업이 중간에 멈췄습니다</div>
              <ul className="small">
                {state.resume.members.map((m) => (
                  <li key={m.id}>
                    위원 {m.id}{m.model ? ` (${m.model})` : ""}: {m.taskTitle}
                  </li>
                ))}
                {state.resume.chair && <li>의장 응답: “{state.resume.chair.message.slice(0, 80)}{state.resume.chair.message.length > 80 ? "…" : ""}”</li>}
              </ul>
              <div className="small muted">이어서 하면 위원은 같은 작업 폴더에서 남긴 기록(STATE.md)을 보고 계속하고, 의장은 하던 일을 다시 이어갑니다.</div>
              <div className="resume-actions">
                <button className="primary" onClick={() => void onResume()}>이어서 하기</button>
                <button className="ghost small" onClick={() => void onDismissResume()}>무시</button>
              </div>
            </div>
          )}
          {busy && (
            <div className="msg thinking muted">
              <GridSpinner color="var(--c-claude)" size={12} /> 의장이 작업 중…
            </div>
          )}
        </div>
      )}

      {state.agenda.waitingForUser?.kind === "finish" && !busy && state.agenda.status !== "closed" && (
        <div className="ask-card finish">
          <div className="ask-head">의장이 안건 종료를 제안합니다</div>
          <div className="ask-question">{state.agenda.waitingForUser.question}</div>
          <div className="ask-options">
            <button className="primary small" disabled={sending} onClick={() => void onApproveFinish()}>안건 종료 승인</button>
            <button className="ghost small" disabled={sending} onClick={() => void onDismissFinish()}>계속 진행</button>
          </div>
          <div className="small muted">승인하면 안건 브랜치를 베이스 브랜치에 합치고 안건을 닫습니다. 더 고칠 것이 있으면 아래에 바로 적어도 됩니다.</div>
        </div>
      )}
      {state.agenda.waitingForUser && state.agenda.waitingForUser.kind !== "finish" && !busy && state.agenda.status !== "closed" && (
        <div className="ask-card">
          <div className="ask-head">의장이 결정을 기다립니다</div>
          <div className="ask-question">{state.agenda.waitingForUser.question}</div>
          {(state.agenda.waitingForUser.options?.length ?? 0) > 0 && (
            <div className="ask-options">
              {state.agenda.waitingForUser.options!.map((o) => (
                <button key={o} className="ghost small" disabled={sending} onClick={() => void onSend(o)}>{o}</button>
              ))}
            </div>
          )}
          <div className="small muted">버튼을 누르거나 아래에 직접 답하세요.</div>
        </div>
      )}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f, i) => (
            <span key={i} className="file-chip">
              {f.type.startsWith("image/") ? <img src={URL.createObjectURL(f)} alt="" /> : "📎"} {f.name || "붙여넣은 이미지"}
              <button className="icon" title="빼기" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
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
        <button className="ghost attach-btn" title="파일·사진 첨부" onClick={() => fileInput.current?.click()} disabled={busy || sending}>📎</button>
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
          placeholder={busy ? "의장이 응답 중입니다…" : "의장에게 말하기 (Enter 전송, Shift+Enter 줄바꿈, 사진은 붙여넣기·끌어놓기)"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />
        <button className="primary" onClick={submit} disabled={busy || sending || (!text.trim() && files.length === 0)}>{sending ? "올리는 중…" : "전송"}</button>
      </div>
      {project && (
        <div className="small muted center-foot">
          {project.repo}{project.localGit ? " (로컬 git)" : ""} · 위원 자율성 {project.members.autonomy} · 한도{" "}
          {Object.entries(state.limits)
            .filter(([, l]) => l.maxMembers > 0)
            .map(([k, l]) => `${k} ${state.active[k] ?? 0}/${l.maxMembers}${l.maxModel ? " ≤" + l.maxModel : ""}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

function TaskChip({ t, member }: { t: Task; member?: Member }) {
  return (
    <span className={`task ${t.status}`} title={`${t.id} ${t.description}${t.note ? "\n" + t.note : ""}${member ? `\n${member.id}` : ""}`}>
      <span className="task-status">{STATUS_KO[t.status]}</span> {t.title}
      {member && (
        <span className="task-member" style={{ color: familyColor(member) }}>
          {t.status === "doing" && <GridSpinner color={familyColor(member)} size={9} />} ← {memberName(member)}
        </span>
      )}
      {!member && t.memberId && <span className="task-member">← {t.memberId}</span>}
    </span>
  );
}
