// Talking to the chair from inside the picture: the card that says which project and agenda this
// is, the input box (floating over the picture, or at the foot of the record), and the record itself:
// everything said and reported, in order, for when the speech bubbles have gone by.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ChatItem, Overview, ProjectOv, RuntimeState } from "../types";
import type { ChairActions, ProjectActions, SendFn } from "./actions";
import type { SheetTab } from "./Sheet";
import { TINT, type Rgb, type TintId } from "./scene";

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** something a member did, shown between the chat lines */
export interface Report {
  id: number;
  ts: number;
  kind: "spawn" | "line" | "done";
  member: string;
  name: string;
  house: TintId;
  text: string;
  ok?: boolean;
  /** tool calls folded into this line */
  count?: number;
}

type FeedItem = { key: string; ts: number; chat?: ChatItem; report?: Report };

const MAX_FEED = 160;

interface CardProps {
  overview: Overview | null;
  state: RuntimeState | null;
  project?: ProjectOv;
  selected: string;
  loading: boolean;
  projects: ProjectActions;
  onSelect: (key: string) => void;
  /** opens the wiki, the memory, the accounts or the settings over the picture */
  onPage: (tab: SheetTab) => void;
}

/** Which project and agenda is open; opens the list to switch, add, or reach the wiki and the settings. */
export function AgendaCard({ overview, state, project, selected, loading, projects, onSelect, onPage }: CardProps) {
  const [picking, setPicking] = useState(false);
  const open = useMemo(() => (overview?.projects ?? []).map((p) => ({ p, agendas: p.agendas.filter((a) => a.status !== "closed") })), [overview]);
  const show = picking || (!state && !loading);
  return (
    <div className="vz-card">
      <button className="vz-card-main" onClick={() => setPicking((v) => !v)} aria-expanded={show} title="안건 바꾸기">
        <span className="vz-card-row">
          <span className="vz-card-key">PROJECT</span>
          <span className="vz-card-val">{project?.name ?? "—"}</span>
        </span>
        <span className="vz-card-row">
          <span className="vz-card-key">AGENDA</span>
          <span className="vz-card-val strong">{state?.agenda.title ?? (loading ? "불러오는 중…" : "안건을 고르세요")}</span>
          <span className="vz-caret">▾</span>
        </span>
        {state && (
          <span className="vz-card-sub">
            {state.agenda.branch}
            {state.agenda.status === "closed" ? " · 종료됨" : ""}
          </span>
        )}
      </button>
      {state?.agenda.goals[0] && !show && <div className="vz-goal">{state.agenda.goals[0]}</div>}
      {show && (
        <div className="vz-picker">
          {open.length === 0 && <div className="vz-picker-empty">제작위원회가 없습니다. 아래에서 추가하세요.</div>}
          {open.map(({ p, agendas }) => (
            <div key={p.id}>
              <div className="vz-picker-project">
                <span>{p.name}</span>
                <span className="vz-picker-tools">
                  <button title="설정 (의장·위원 한도)" onClick={() => projects.onSettings(p.id)}>⚙</button>
                  <button title="가이드라인 편집" onClick={() => projects.onGuidelines(p.id)}>✎</button>
                  <button
                    title="안건 추가"
                    onClick={() => {
                      setPicking(false);
                      void projects.onNewAgenda(p.id);
                    }}
                  >
                    ＋
                  </button>
                </span>
              </div>
              {agendas.length === 0 && <div className="vz-picker-empty">진행 중인 안건 없음</div>}
              {agendas.map((a) => (
                <button
                  key={a.key}
                  className={`vz-picker-row ${a.key === selected ? "on" : ""}`}
                  onClick={() => {
                    setPicking(false);
                    onSelect(a.key);
                  }}
                >
                  <span className={`vz-live ${a.chairBusy || a.running > 0 ? "on" : ""}`} />
                  <span className="vz-picker-title">{a.title}</span>
                  <span className="vz-picker-meta">
                    {a.waitingForUser && !a.chairBusy ? "결정 대기 · " : ""}
                    {a.running > 0 ? `${a.running} 실행 · ` : ""}
                    {a.taskCounts.done}/{a.taskCounts.total}
                  </span>
                </button>
              ))}
            </div>
          ))}
          <div className="vz-picker-foot">
            <button onClick={projects.onNewProject}>＋ 제작위원회</button>
            <button onClick={() => onPage("wiki")}>Gen Wiki</button>
            <button onClick={() => onPage("memory")}>기억</button>
            <button onClick={() => onPage("accounts")}>계정</button>
            <button onClick={() => onPage("settings")}>설정</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  state: RuntimeState | null;
  /** short placeholder, one line */
  compact: boolean;
  onSend: SendFn;
  chair: ChairActions;
  /** shows a button that opens the record */
  onLog?: () => void;
}

/** The chair's pending question with its answers, the files about to go, and the box to type in. */
export function Composer({ state, compact, onSend, chair, onLog }: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = state?.chair.busy ?? false;
  const closed = state?.agenda.status === "closed";
  const ask = state?.agenda.waitingForUser && !busy && !closed ? state.agenda.waitingForUser : undefined;

  const submit = async (override?: string) => {
    const t = (override ?? text).trim();
    if ((!t && files.length === 0 && override === undefined) || sending || !state) return;
    setSending(true);
    try {
      await onSend(t, override === undefined ? files : []);
      if (override === undefined) {
        setText("");
        setFiles([]);
      }
    } catch {
      /* the app shows the error; the draft stays */
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="vz-compose">
      {ask && (
        <div className="vz-ask">
          <span className="vz-ask-tag">{ask.kind === "finish" ? "의장이 안건 종료를 제안합니다" : "의장이 결정을 기다립니다"}</span>
          <span className="vz-ask-q">{ask.question}</span>
          <span className="vz-ask-options">
            {ask.kind === "finish" ? (
              <>
                <button className="vz-pill gold" disabled={sending} onClick={() => void chair.onApproveFinish()}>안건 종료 승인</button>
                <button className="vz-pill" disabled={sending} onClick={() => void chair.onDismissFinish()}>계속 진행</button>
              </>
            ) : (
              (ask.options ?? []).map((o) => (
                <button key={o} className="vz-pill gold" disabled={sending} onClick={() => void submit(o)}>{o}</button>
              ))
            )}
          </span>
        </div>
      )}
      {state?.resume && !busy && (
        <div className="vz-notice">
          <b>지난번 작업이 중간에 멈췄습니다</b>
          <span>
            위원 {state.resume.members.length}명{state.resume.chair ? " · 의장 응답" : ""}이 끊겼습니다.
          </span>
          <span className="vz-notice-actions">
            <button className="vz-pill gold" onClick={() => void chair.onResume()}>이어서 하기</button>
            <button className="vz-pill" onClick={() => void chair.onDismissResume()}>무시</button>
          </span>
        </div>
      )}
      {(state?.chair.queued?.length ?? 0) > 0 && (
        <div className="vz-notice">
          <b>의장 작업이 끝나면 전달할 메시지 {state!.chair.queued!.length}개</b>
          {state!.chair.queued!.map((q, i) => (
            <span key={i} className="vz-queued">{q}</span>
          ))}
          <span className="vz-notice-actions">
            <button className="vz-pill" onClick={() => void api.clearQueue(state!.key).catch(() => undefined)}>대기 취소</button>
          </span>
        </div>
      )}
      {files.length > 0 && (
        <div className="vz-files">
          {files.map((f, i) => (
            <button key={i} className="vz-file" title="빼기" onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))}>
              📎 {f.name} ✕
            </button>
          ))}
        </div>
      )}
      <form
        className="vz-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            if (picked.length) setFiles((cur) => [...cur, ...picked].slice(0, 10));
            e.target.value = "";
          }}
        />
        {onLog && (
          <button type="button" className="vz-attach" title="대화 기록 열기" onClick={onLog}>
            ☰
          </button>
        )}
        <button type="button" className="vz-attach" title="파일 첨부" disabled={!state || closed} onClick={() => fileInput.current?.click()}>
          ＋
        </button>
        <textarea
          value={text}
          rows={1}
          disabled={!state || closed}
          placeholder={!state ? "안건을 먼저 고르세요" : closed ? "종료된 안건입니다" : busy ? (compact ? "의장 작업 중 · 끝나면 전달" : "의장이 작업 중 · 보내면 끝난 뒤 전달됩니다") : compact ? "의장에게 말하기" : "의장에게 말하기 (Enter 전송 · Shift+Enter 줄바꿈)"}
          onChange={(e) => {
            setText(e.target.value);
            // grow with the text, up to the limit the stylesheet sets
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.style.height = "auto";
              void submit();
            }
          }}
        />
        <button type="submit" className="vz-send" disabled={!state || closed || sending || (!text.trim() && files.length === 0)} title="보내기">
          ➤
        </button>
      </form>
    </div>
  );
}

interface Props extends CardProps {
  chat: ChatItem[];
  reports: Report[];
  firstTurn: boolean;
  /** a phone: the record is a sheet over the picture */
  narrow: boolean;
  onClose: () => void;
  onSend: SendFn;
  chair: ChairActions;
}

/** The record: the whole conversation and every report, with the input at its foot. */
export function Console(props: Props) {
  const { state, chat, reports, firstTurn, narrow, onClose, onSend, chair } = props;
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const busy = state?.chair.busy ?? false;

  const feed = useMemo(() => {
    const items: FeedItem[] = [
      ...chat.map((c) => ({ key: `c${c.id}`, ts: Date.parse(c.ts) || 0, chat: c })),
      ...reports.map((r) => ({ key: `r${r.id}`, ts: r.ts, report: r })),
    ];
    // sort is stable: chat lines keep their own order when the clock ties
    return items.sort((a, b) => a.ts - b.ts).slice(-MAX_FEED);
  }, [chat, reports]);

  // follow the newest line unless the reader has scrolled up
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [feed, busy]);

  return (
    <section className="vz-console" aria-label="대화 기록">
      <div className="vz-console-head">
        {narrow ? <span className="vz-console-title">대화 기록 · 실시간 보고</span> : <AgendaCard {...props} />}
        <button className="vz-console-toggle" onClick={onClose} title="기록 닫기">
          {narrow ? "▾" : "⟩"}
        </button>
      </div>
      <div
        className="vz-feed"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!state && <div className="vz-feed-empty">안건을 고르면 의장과의 대화와 위원들의 보고가 여기에 쌓입니다.</div>}
        {state && feed.length === 0 && (
          <div className="vz-feed-empty">
            아직 대화가 없습니다.
            {firstTurn && state.agenda.goals.length > 0 && (
              <button className="vz-pill gold" disabled={busy} onClick={() => void onSend("").catch(() => undefined)}>
                안건 시작 (의장이 목표를 분장)
              </button>
            )}
          </div>
        )}
        {feed.map((f) => (f.chat ? <ChatLine key={f.key} c={f.chat} /> : <ReportLine key={f.key} r={f.report!} />))}
        {busy && (
          <div className="vz-typing">
            <span className="vz-dots"><i /><i /><i /></span>
            의장이 숙의 중
            <button
              className="vz-pill"
              onClick={() => {
                if (state && confirm("의장의 이번 작업을 멈출까요? (위원은 계속 작업합니다)")) void api.stopChair(state.key).catch(() => undefined);
              }}
            >
              ■ 멈추기
            </button>
          </div>
        )}
      </div>
      <Composer state={state} compact={narrow} onSend={onSend} chair={chair} />
    </section>
  );
}

const ROLE_TAG: Partial<Record<ChatItem["role"], string>> = { assistant: "의장", user: "나", event: "이벤트", error: "오류" };

function ChatLine({ c }: { c: ChatItem }) {
  const n = c.attachments?.length ?? 0;
  return (
    <div className={`vz-msg ${c.role}`}>
      {ROLE_TAG[c.role] && <span className="vz-msg-who">{ROLE_TAG[c.role]}</span>}
      <span className="vz-msg-text">
        {c.role === "tool" ? `⚙ ${c.text}` : c.text}
        {n > 0 && <span className="vz-msg-att"> 📎 첨부 {n}개 (작업실에서 보기)</span>}
      </span>
    </div>
  );
}

function ReportLine({ r }: { r: Report }) {
  return (
    <div className={`vz-msg report ${r.kind} ${r.ok === false ? "failed" : ""}`} style={{ "--c": css(TINT[r.house]) } as React.CSSProperties}>
      <span className="vz-msg-who">
        <i className="vz-msg-dot" />
        {r.name}
        <em>{r.kind === "spawn" ? "투입" : r.kind === "done" ? (r.ok === false ? "중단" : "보고") : ""}</em>
      </span>
      <span className="vz-msg-text">
        {r.text}
        {r.count && r.count > 1 ? <span className="vz-msg-count"> ×{r.count}</span> : null}
      </span>
    </div>
  );
}
