// What opens when something in the picture is touched: the chair's controls, a house's ladder and
// finished members, a working member's card. The same actions as the workshop, laid out as cards.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHAIR_EFFORTS, CHAIR_MODELS, CLI_PROVIDERS, FOLDERS_MANY, PROVIDER_LABEL, TelegramAutoButton } from "../components/CenterPane";
import { familyOf, memberName, prettyModel } from "../model";
import type { Member, ProjectOv, RuntimeState, UsageSnapshot } from "../types";
import type { ChairActions, MemberActions, ProjectActions } from "./actions";
import { HOUSE_NAME, isActive, TINT, type HouseNode, type Ladder, type Rgb } from "./scene";

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** the model's name without the reasoning level that agy ids carry */
const bare = (m: Pick<Member, "id" | "provider" | "model" | "label">) => memberName({ ...m, model: m.model?.replace(/-(low|medium|high|xhigh|max)$/i, "") });
export const MEMBER_STATUS_KO: Record<Member["status"], string> = { starting: "시작 중", running: "실행 중", waiting: "전달 대기", done: "완료", failed: "실패", stopped: "중지", handed_over: "인계됨" };
const COMPANY = { claude: "Claude", gpt: "GPT", gemini: "Gemini" } as const;
const TASK_KO = { todo: "대기", doing: "진행", review: "검토", done: "완료", blocked: "막힘" } as const;

/** A card that opens beside the thing touched (a sheet from the bottom on a phone). */
export function Popover({ x, y, r, tint, onClose, children }: { x: number; y: number; r: number; tint: Rgb; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const place = () => {
      const W = el.offsetWidth;
      const H = el.offsetHeight;
      const hw = host.clientWidth;
      const hh = host.clientHeight;
      let left = x + r + 18;
      if (left + W > hw - 12) left = x - r - 18 - W;
      // no room on either side: sit over it
      if (left < 12) left = Math.max(12, Math.min(hw - W - 12, x - W / 2));
      setPos({ left, top: Math.max(12, Math.min(hh - H - 12, y - H / 2)) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y, r]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="vz-pop-back" onClick={onClose} />
      <div ref={ref} className="vz-pop" role="dialog" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden", "--c": css(tint) } as React.CSSProperties}>
        <button className="vz-pop-close" onClick={onClose} aria-label="닫기">✕</button>
        {children}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="vz-sec">
      <div className="vz-sec-title">{title}</div>
      {children}
    </div>
  );
}

interface ChairMenuProps {
  state: RuntimeState;
  project?: ProjectOv;
  firstTurn: boolean;
  chair: ChairActions;
  onStop: () => void;
  onClose: () => void;
  onWorkshop: () => void;
}

export function ChairMenu({ state, project, firstTurn, chair, onStop, onClose, onWorkshop }: ChairMenuProps) {
  const [view, setView] = useState<"main" | "state">("main");
  const provider = state.chair.provider ?? "claude";
  const model = state.chair.model ?? "";
  const effort = state.chair.effort ?? "";
  const busy = state.chair.busy;
  const closed = state.agenda.status === "closed";
  const models = CHAIR_MODELS[provider] ?? CHAIR_MODELS.claude;
  const xhigh = provider === "gemini" && /hydrogen|neon/i.test(model);
  const efforts = xhigh ? [...CHAIR_EFFORTS.gemini, "xhigh"] : CHAIR_EFFORTS[provider] ?? CHAIR_EFFORTS.claude;
  const allDone = state.tasks.length > 0 && state.tasks.every((t) => t.status === "done");
  /** one-shot actions close the card first: most of them ask for confirmation in a dialog */
  const run = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const memberOf = (id?: string) => (id ? state.members.find((m) => m.id === id) : undefined);
  // the companies that could take the chair: the ones with an account to run as
  // (a company switched off for the space, Gemini by default, has its login read "disabled")
  const companies = (["claude", "gpt", "gemini"] as const).filter((p) => p === provider || state.accounts.some((a) => a.provider === p && a.status !== "disabled"));
  // Which company's models the card is showing. Picking another company only shows its models;
  // the chair changes when one of them is picked.
  const [co, setCo] = useState<string>(provider);
  useEffect(() => setCo(provider), [provider]);
  const other = co !== provider;
  const shown = other ? CHAIR_MODELS[co] ?? [] : models;
  const pick = (m: string) => {
    if (!other) return void chair.onSetChair(m, provider === "gemini" && effort === "xhigh" && !/hydrogen|neon/i.test(m) ? "high" : effort);
    // another company: its first usable account takes over, in a new session
    const next = state.accounts.find((a) => a.provider === co && a.status === "ok") ?? state.accounts.find((a) => a.provider === co);
    if (!next) return;
    const name = COMPANY[co as keyof typeof COMPANY] ?? co;
    const level = (CHAIR_EFFORTS[co] ?? []).includes(effort) ? effort : "";
    if (confirm(`${name}의 ${m ? prettyModel(m) : "기본 모델"}이 이 안건의 의장을 맡습니다. 대화 세션이 새로 시작됩니다 (state.md는 유지). 계속할까요?`)) void chair.onSetChair(m, level, next.id);
  };

  if (view === "state") {
    return (
      <>
        <div className="vz-pop-head">
          <button className="vz-back" onClick={() => setView("main")}>‹ 의장</button>
          <span className="vz-pop-sub">state.md</span>
        </div>
        <pre className="vz-state">{state.chairState || "(아직 state.md 가 없습니다)"}</pre>
      </>
    );
  }

  return (
    <>
      <div className="vz-pop-head">
        <span className="vz-pop-kicker">의장 · {PROVIDER_LABEL[provider] ?? provider}</span>
        <span className="vz-pop-title">{prettyModel(model) ?? "기본 모델"}</span>
        <span className={`vz-badge ${busy ? "live" : ""}`}>{closed ? "안건 종료" : busy ? "숙의 중" : state.agenda.waitingForUser ? "결정 대기" : "대기"}</span>
      </div>

      {busy && (
        <button className="vz-stop" onClick={run(onStop)}>
          <span>■</span> 의장 멈추기
          <small>위원은 계속 작업합니다</small>
        </button>
      )}

      {companies.length > 1 && (
        <Section title="회사">
          <div className="vz-chips">
            {companies.map((p) => (
              <button key={p} data-co={p} className={`vz-chip co ${p === co ? "on" : ""}`} style={{ "--c": css(TINT[p]) } as React.CSSProperties} onClick={() => setCo(p)} title={p === provider ? "지금 의장을 맡은 회사" : `${COMPANY[p]}의 모델 보기 · 모델을 고르면 의장이 바뀝니다`}>
                <i />
                {COMPANY[p]}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title={other ? `모델 · 고르면 ${COMPANY[co as keyof typeof COMPANY] ?? co}가 의장을 맡습니다` : "모델"}>
        <div className="vz-chips" key={co}>
          {shown.map((m) => (
            <button key={m || "default"} data-model={m || "default"} className={`vz-chip ${!other && m === model ? "on" : ""}`} onClick={() => pick(m)}>
              {m ? prettyModel(m) : "기본"}
            </button>
          ))}
          {!other && !models.includes(model) && <button className="vz-chip on">{prettyModel(model)}</button>}
        </div>
      </Section>

      <Section title="추론 수준">
        <div className="vz-chips steps">
          {efforts.map((e) => (
            <button key={e || "default"} className={`vz-chip ${e === effort ? "on" : ""}`} onClick={() => void chair.onSetChair(model, e)}>
              {e || "기본"}
            </button>
          ))}
        </div>
      </Section>

      <Section title="계정 · 위원 권한">
        <div className="vz-row">
          <select
            className="vz-select"
            value={state.chair.account ?? "claude"}
            title="의장 계정. GPT·제미나이 계정을 고르면 그 AI가 의장을 맡습니다 (이 안건에만 적용)"
            onChange={(e) => {
              const next = state.accounts.find((a) => a.id === e.target.value);
              const other = next && next.provider !== provider ? `${PROVIDER_LABEL[next.provider] ?? next.provider}가 의장을 맡고 ` : "";
              if (confirm(`이 안건의 의장 계정을 바꾸면 ${other}대화 세션이 새로 시작됩니다 (state.md는 유지). 계속할까요?`)) void chair.onSetChair(model, effort, e.target.value);
            }}
          >
            {!state.accounts.some((a) => a.id === (state.chair.account ?? "claude")) && <option value={state.chair.account ?? "claude"}>{state.chair.account ?? "claude"}</option>}
            {CLI_PROVIDERS.map((p) => {
              const list = state.accounts.filter((a) => a.provider === p);
              return list.length ? (
                <optgroup key={p} label={PROVIDER_LABEL[p]}>
                  {list.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                      {a.status !== "ok" ? ` (${a.status})` : ""}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
          {project && (
            <select className="vz-select" value={project.members.autonomy} title="위원이 권한이 필요한 일을 할 때 누가 허락하는지" onChange={(e) => void chair.onSetAutonomy(e.target.value)}>
              <option value="full">확인 없음</option>
              <option value="chair">의장 승인</option>
              <option value="edits">편집만 자동</option>
            </select>
          )}
          <TelegramAutoButton agendaKey={state.key} on={state.agenda.telegramAuto !== false} closed={closed} onError={(m) => window.alert(m)} />
        </div>
      </Section>

      <div className="vz-acts">
        <button onClick={() => setView("state")}><i>☰</i>의장 상태</button>
        <button onClick={run(chair.onReset)} title="의장 세션을 새로 시작 (state.md 유지)"><i>↺</i>세션 초기화</button>
        <button onClick={run(chair.onRetrospect)} disabled={busy || firstTurn} title="교훈·모델 성향을 공유 기억에 기록"><i>✎</i>회고</button>
        <button onClick={run(chair.onMergeBase)} disabled={closed} title="안건을 닫지 않고 지금까지의 결과를 메인에 합칩니다"><i>⇪</i>메인 반영</button>
        <button className={allDone ? "gold" : ""} onClick={run(chair.onFinish)} disabled={closed}><i>✓</i>안건 종료</button>
        <button className={(state.folders ?? 0) >= FOLDERS_MANY ? "warn" : ""} onClick={run(chair.onTidyFolders)} disabled={!state.folders} title="쌓인 위원 작업 폴더 정리 (브랜치는 남음)"><i>▣</i>폴더 {state.folders ?? 0}</button>
        <button onClick={run(() => onWorkshop())}><i>▤</i>작업실</button>
        <button className="danger" onClick={run(chair.onDelete)} disabled={busy}><i>✕</i>삭제</button>
      </div>

      {state.tasks.length > 0 && (
        <Section title={`과제 ${state.tasks.filter((t) => t.status === "done").length} / ${state.tasks.length}`}>
          <div className="vz-tasks">
            {state.tasks.map((t) => {
              const m = memberOf(t.memberId);
              const fam = m ? familyOf(m) : undefined;
              return (
                <div key={t.id} className={`vz-task ${t.status}`} style={fam ? ({ "--c": css(TINT[fam]) } as React.CSSProperties) : undefined}>
                  <i />
                  <span className="vz-task-title">{t.title}</span>
                  <span className="vz-task-meta">
                    {m ? `${bare(m)} · ` : ""}
                    {TASK_KO[t.status]}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}

/** The card of one member: working (log, stop) or finished (result, merge, hand over). */
export function WorkerMenu({ member, task, actions, onClose }: { member: Member; task: string; actions: MemberActions; onClose: () => void }) {
  const run = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const active = isActive(member);
  const waiting = member.status === "waiting";
  const canMerge = !member.merged && member.status === "done" && (member.commits?.length ?? 0) > 0;
  const canHandover = (member.status === "failed" || member.status === "stopped") && !member.handoverTo;
  return (
    <>
      <div className="vz-pop-head">
        <span className="vz-pop-kicker">
          {active ? "위원" : "끝난 위원"} · {member.id}
        </span>
        <span className="vz-pop-title tint">{bare(member)}</span>
        <span className={`vz-badge ${active ? "live" : member.merged ? "gold" : member.status === "failed" ? "bad" : ""}`}>{member.merged ? "머지됨" : MEMBER_STATUS_KO[member.status]}</span>
      </div>
      <div className="vz-facts">
        <div><span>과제</span><b>{task || member.taskId}</b></div>
        {member.effort && <div><span>추론</span><b>{member.effort}</b></div>}
        {member.advisor && <div><span>advisor</span><b>{member.advisor}</b></div>}
        {member.account && member.account !== member.provider && <div><span>계정</span><b>{member.account}</b></div>}
        {!waiting && <div><span>도구 호출</span><b>{member.toolCalls}회</b></div>}
        {!active && <div><span>커밋</span><b>{member.commits?.length ?? 0}개</b></div>}
        <div><span>브랜치</span><b className="mono">{member.branch}</b></div>
        {member.handoverFrom && <div><span>인계</span><b>{member.handoverFrom}에서 이어받음</b></div>}
        {member.handoverTo && <div><span>인계</span><b>{member.handoverTo}에게 넘김</b></div>}
      </div>
      {waiting && <div className="vz-quote">패킷을 복사해 웹 AI에 붙이고, 답변을 붙여넣으면 이어집니다.{member.relayFiles?.length ? ` (파일 ${member.relayFiles.length}개 포함)` : ""}</div>}
      {active && member.lastText && <div className="vz-quote">{member.lastText.slice(0, 220)}</div>}
      {!active && member.result?.summary && <div className="vz-quote">{member.result.summary.slice(0, 420)}</div>}
      {!active && member.result?.unfinished && member.result.unfinished !== "없음" && <div className="vz-quote warn">미완료: {member.result.unfinished.slice(0, 220)}</div>}
      {member.failure && (
        <div className="vz-quote warn">
          {member.failure.kind === "quota" ? "한도 소진" : member.failure.kind === "auth" ? "로그인 필요" : member.failure.kind === "model" ? "모델 미지원" : "오류"}: {member.failure.message.slice(0, 220)}
        </div>
      )}
      {member.error && !member.failure && <div className="vz-quote warn">{member.error.slice(0, 220)}</div>}
      {active ? (
        <div className="vz-acts two">
          {waiting ? (
            <button className="gold" onClick={run(() => actions.onRelay(member.id))}><i>⇄</i>패킷 · 답변</button>
          ) : (
            <button onClick={run(() => actions.onOpen(member.id))}><i>☰</i>로그 보기</button>
          )}
          <button className="danger" onClick={run(() => actions.onStop(member.id))}><i>■</i>{waiting ? "취소" : "중지"}</button>
        </div>
      ) : (
        <div className="vz-acts two">
          <button onClick={run(() => actions.onOpen(member.id))}><i>☰</i>로그 · diff</button>
          {canMerge && <button className="gold" onClick={run(() => actions.onMerge(member.id))}><i>⇪</i>머지</button>}
          {canHandover && <button onClick={run(() => actions.onHandover(member.id))}><i>↻</i>이어받기</button>}
        </div>
      )}
    </>
  );
}

interface HouseMenuProps {
  house: HouseNode;
  ladder?: Ladder;
  state: RuntimeState | null;
  project?: ProjectOv;
  usage?: UsageSnapshot | null;
  actions: MemberActions;
  projects: ProjectActions;
  onClose: () => void;
}

export function HouseMenu({ house, ladder, state, project, usage, actions, projects, onClose }: HouseMenuProps) {
  const run = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const past = (state?.members ?? []).filter((m) => familyOf(m) === house.id && !isActive(m)).reverse().slice(0, 8);
  const meters = (usage?.items ?? []).filter((u) => u.provider === house.id);
  const taskTitle = (id: string) => state?.tasks.find((t) => t.id === id)?.title ?? id;
  const off = house.id === "gemini" && state?.accounts.some((a) => a.provider === "gemini" && a.status === "disabled");
  return (
    <>
      <div className="vz-pop-head">
        <span className="vz-pop-kicker">회사</span>
        <span className="vz-pop-title tint">{HOUSE_NAME[house.id]}</span>
        <span className={`vz-badge ${house.active > 0 ? "live" : ""}`}>
          실행 {house.active}
          {house.max ? ` / ${house.max}` : ""}
        </span>
      </div>

      {off && <div className="vz-quote warn">꺼져 있습니다. Google 약관상 다른 프로그램이 Antigravity CLI를 띄우는 쓰임은 계정 정지 위험이 있어 기본으로 꺼 둡니다. 설정 › 계정에서 위험 고지를 읽고 직접 켤 수 있습니다.</div>}

      <Section title="모델 사다리 (낮은 단 → 높은 단)">
        <div className="vz-ladder">
          {house.rungs.map((r, i) => (
            <div key={r.id} className={`vz-rung ${r.locked ? "locked" : ""} ${r.active ? "on" : ""}`}>
              <i style={{ width: 7 + i * 2, height: 7 + i * 2 }} />
              <span className="vz-rung-name">{ladder?.models[i]?.label ?? r.word}</span>
              <span className="vz-rung-note">{r.locked ? "한도 밖" : r.active ? `${r.active}명 작업 중` : ladder?.models[i]?.note ?? ""}</span>
            </div>
          ))}
        </div>
      </Section>

      {meters.length > 0 && (
        <Section title="남은 사용량">
          {meters.map((u) => (
            <div key={u.account} className="vz-meter">
              <span className="vz-meter-name">{u.account}</span>
              {u.error ? (
                <span className="vz-meter-err">{u.error.slice(0, 40)}</span>
              ) : (
                <>
                  {u.fiveHour && <Bar label="5시간" used={u.fiveHour.usedPct} />}
                  {u.weekly && <Bar label="주간" used={u.weekly.usedPct} />}
                </>
              )}
            </div>
          ))}
        </Section>
      )}

      {past.length > 0 && (
        <Section title={`끝난 위원 ${house.finished}`}>
          <div className="vz-past">
            {past.map((m) => {
              const canMerge = !m.merged && m.status === "done" && (m.commits?.length ?? 0) > 0;
              const canHandover = (m.status === "failed" || m.status === "stopped") && !m.handoverTo;
              return (
                <div key={m.id} className={`vz-past-row ${m.status}`}>
                  <div className="vz-past-main">
                    <b>{bare(m)}</b>
                    <span>{taskTitle(m.taskId)}</span>
                  </div>
                  <span className={`vz-badge ${m.merged ? "gold" : m.status === "failed" ? "bad" : ""}`}>{m.merged ? "머지됨" : MEMBER_STATUS_KO[m.status]}</span>
                  <span className="vz-past-acts">
                    <button onClick={run(() => actions.onOpen(m.id))} title="로그 · diff">☰</button>
                    {canMerge && <button className="gold" onClick={run(() => actions.onMerge(m.id))} title="안건 브랜치에 머지">머지</button>}
                    {canHandover && <button onClick={run(() => actions.onHandover(m.id))} title="다른 계정·모델로 이어받기">이어받기</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {project && (
        <div className="vz-acts two">
          <button onClick={run(() => projects.onSettings(project.id))}><i>⚙</i>한도 · 설정</button>
          <button onClick={run(() => projects.onGuidelines(project.id))}><i>✎</i>가이드라인</button>
        </div>
      )}
    </>
  );
}

/** what is left of a limit; `wide` gives the label room for a model's name */
export function Bar({ label, used, wide }: { label: string; used: number; wide?: boolean }) {
  const left = Math.max(0, Math.min(100, 100 - used));
  return (
    <span className={`vz-bar ${wide ? "wide" : ""}`} title={`${label}: ${Math.round(left)}% 남음`}>
      <em>{label}</em>
      <span className="vz-bar-track">
        <span style={{ width: `${left}%` }} className={left < 20 ? "low" : ""} />
      </span>
      <b>{Math.round(left)}%</b>
    </span>
  );
}
