import { useEffect, useRef, useState } from "react";
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
  onSend: (message: string) => Promise<void>;
  onSetChair: (model: string, effort: string, account?: string, advisor?: string) => Promise<void>;
  onReset: () => Promise<void>;
  onSetAutonomy: (autonomy: string) => Promise<void>;
  onRetrospect: () => Promise<void>;
  onFinish: () => Promise<void>;
}

export function CenterPane({ state, chat, firstTurn, loading, project, onSend, onSetChair, onReset, onSetAutonomy, onRetrospect, onFinish }: Props) {
  const [text, setText] = useState("");
  const [showState, setShowState] = useState(false);
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
    if (!t || busy) return;
    setText("");
    await onSend(t);
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
              title="위원 자율성: 위원이 명령 실행 등 권한이 필요한 일을 할 때 누가 허락하는지"
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
        {state.agenda.goals.length === 0 && <div className="muted small">목표가 없습니다. 의장에게 채팅으로 알려 주세요.</div>}
      </div>

      {showState ? (
        <pre className="chair-state">{state.chairState || "(아직 state.md 가 없습니다)"}</pre>
      ) : (
        <div className="chat" ref={listRef}>
          {chat.length === 0 && firstTurn && (
            <div className="chat-empty">
              <p className="muted">아직 의장과 대화가 없습니다.</p>
              <button className="primary" onClick={() => onSend("")} disabled={busy}>안건 시작 (의장이 목표를 분장)</button>
            </div>
          )}
          {chat.map((c) => (
            <div key={c.id} className={`msg ${c.role}`}>
              {c.role === "assistant" && <span className="who">의장</span>}
              {c.role === "user" && <span className="who">나</span>}
              {c.role === "event" && <span className="who">이벤트</span>}
              <div className="msg-text">{c.text}</div>
            </div>
          ))}
          {busy && (
            <div className="msg thinking muted">
              <GridSpinner color="var(--c-claude)" size={12} /> 의장이 작업 중…
            </div>
          )}
        </div>
      )}

      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={busy ? "의장이 응답 중입니다…" : "의장에게 말하기 (Enter 전송, Shift+Enter 줄바꿈)"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />
        <button className="primary" onClick={submit} disabled={busy || !text.trim()}>전송</button>
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
