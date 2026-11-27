// A stand-in council for looking at the visualization without a server or a login:
// open /vision-demo.html on the dev server (`npm run dev --workspace @gencouncil/web`).
// It plays a loop: the chair sends a member out, members report, one finishes, the chair answers.
// ?empty shows the scene before an agenda is chosen, ?ask the chair waiting for an answer,
// ?quiet stops the loop (what you type is still answered), ?twin puts two members on one rung,
// ?idle starts with nobody working.
// ?avatar opens the avatar study instead of the picture (the mode switch goes between them).
// ?float=1 shows the desktop app's floating chair window; ?lang=en or ?lang=ja the screens in that language.
// ?film plays a short scripted scene instead (film.tsx): an order typed in, five models sent out, their reports.
import "./demoLang";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import { d } from "./demoText";
import { IS_FLOAT } from "../desktop";
import { FloatingChair } from "../components/FloatingChair";
import { VisionView } from "../components/VisionView";
import { AvatarView } from "../components/AvatarView";
import type { Mode } from "../components/ModeSwitch";
import { DemoMeeting } from "./demoMeeting";
import { FolderTidyModal } from "../components/Modals";
import "../styles.css";
import type { ChatItem, Member, ModelsInfo, Overview, RuntimeState, Task, UsageSnapshot } from "../types";
import type { ChairActions, MemberActions, ProjectActions } from "./actions";
import { DEMO_ACCOUNTS, installDemoApi } from "./demoApi";
import { Film } from "./film";
import type { VisionEvent } from "./renderer";

const q = new URLSearchParams(location.search);
// ?chair=grok (or gpt, gemini) shows another company in the chair
const DEMO_CHAIR = ((["gpt", "gemini", "grok"] as const).find((p) => p === q.get("chair")) ?? "claude") as "claude" | "gpt" | "gemini" | "grok";
const iso = () => new Date().toISOString();

const member = (id: string, provider: Member["provider"], model: string, effort: string, taskId: string, status: Member["status"], extra: Partial<Member> = {}): Member => ({
  id,
  provider,
  model,
  effort,
  taskId,
  branch: `agenda/demo/${id}`,
  worktree: "",
  status,
  toolCalls: 8 + ((id.length * 7) % 40),
  startedAt: iso(),
  ...extra,
});

const TASKS: Task[] = [
  { id: "t1", title: d("결제 모듈 리팩터링"), description: "", status: "doing", memberId: "claude-3" },
  { id: "t2", title: d("회귀 테스트 작성"), description: "", status: "doing", memberId: "claude-4" },
  { id: "t3", title: d("API 문서 갱신"), description: "", status: "doing", memberId: "gpt-2" },
  { id: "t4", title: d("동시성 버그 원인 분석"), description: "", status: "doing", memberId: "gpt-3" },
  { id: "t5", title: d("이미지 파이프라인 설계"), description: "", status: "doing", memberId: "gemini-2" },
  { id: "t6", title: d("번역 문자열 정리"), description: "", status: "todo" },
  { id: "t7", title: d("마이그레이션 스크립트"), description: "", status: "review", memberId: "claude-2" },
  { id: "t8", title: d("스키마 초안"), description: "", status: "done", memberId: "claude-1" },
  { id: "t9", title: d("의존성 조사"), description: "", status: "done", memberId: "gpt-1" },
  { id: "t10", title: d("배포 점검표"), description: "", status: "todo" },
];

const START: Member[] = [
  member("claude-1", "claude", "claude-opus-5-5", "high", "t8", "done", { merged: true, commits: ["a"], result: { summary: d("스키마 초안을 정리했습니다."), unfinished: d("없음") } }),
  member("claude-2", "claude", "sonnet", "medium", "t7", "done", { commits: ["b"], result: { summary: d("마이그레이션 스크립트 작성 완료. 롤백 경로 포함."), unfinished: d("없음") } }),
  // ?twin puts two members on one rung, to see their labels keep apart
  member("claude-3", "claude", q.has("twin") ? "claude-sonnet-5-5" : "claude-opus-5-5", "high", "t1", "running", { lastText: d("PaymentGateway 인터페이스를 새 구조로 옮기는 중입니다. 기존 호출부 14곳 중 9곳을 바꿨습니다.") }),
  member("claude-4", "claude", "sonnet", "medium", "t2", "running"),
  // ?crowd (with ?twin: four on one rung) to see a full house spread out
  ...(q.has("crowd") ? [member("claude-5", "claude", "sonnet", "medium", "t10", "running"), member("claude-6", "claude", "sonnet", "medium", "t6", "running")] : []),
  member("gpt-1", "gpt", "gpt-6.1-terra", "low", "t9", "done", { merged: true, commits: ["c"] }),
  member("gpt-0", "gpt", "gpt-6.2-sol", "high", "t9", "failed", { failure: { kind: "quota", message: d("주간 한도 소진") } }),
  member("gpt-2", "gpt", "gpt-6.1-terra", "low", "t3", "running"),
  member("gpt-3", "gpt", "gpt-6.2-sol", "high", "t4", "running"),
  member("gemini-1", "gemini", "gemini-3.8-flash", "low", "t9", "done", { merged: true, commits: ["d"] }),
  member("gemini-2", "gemini", "gemini-4-neon-xhigh", "xhigh", "t5", "running"),
  // ?grok adds a Grok member (it stands by the chair in its own colour)
  ...(q.has("grok") ? [member("grok-1", "grok", "grok-4.7", "medium", "t10", "running")] : []),
];
const NEWCOMER = member("gemini-3", "gemini", "gemini-3.8-flash-low", "low", "t6", "running");
// ?idle: nobody working, to see the picture with only the houses and the finished members
const FIRST = q.has("idle") ? START.filter((m) => m.status !== "running") : START;

const MODELS: ModelsInfo = {
  providers: [
    { id: "claude", effort: true, models: [{ id: "haiku", label: "Haiku 5.5", note: d("탐색·기계적 작업") }, { id: "sonnet", label: "Sonnet 5.5", note: d("주력") }, { id: "opus", label: "Opus 5.5", note: d("어려운 설계·디버깅") }, { id: "fable", label: "Fable 5.2", note: d("최상위") }] },
    { id: "gemini", effort: true, models: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: d("빠른 작업") }, { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", note: d("일상 작업") }, { id: "gemini-4-neon", label: "Gemini 4 Neon", note: d("기본 배정") }, { id: "gemini-4-argon", label: "Gemini 4 Argon", note: d("최상위") }] },
    { id: "gpt", effort: true, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", note: d("가벼운 작업") }, { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", note: d("일상 작업") }, { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", note: d("주력") }, { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", note: d("최상위") }] },
  ],
  sites: [],
  efforts: [],
  defaults: {},
};

const USAGE: UsageSnapshot = {
  at: Date.now(),
  items: [
    { provider: "claude", account: "claude", fiveHour: { usedPct: 38 }, weekly: { usedPct: 61 }, checkedAt: iso() },
    { provider: "gpt", account: "gpt", fiveHour: { usedPct: 12 }, weekly: { usedPct: 86 }, checkedAt: iso() },
    { provider: "gemini", account: "gemini", weekly: { usedPct: 24 }, checkedAt: iso() },
    ...(q.has("grok") ? [{ provider: "grok" as const, account: "grok", weekly: { usedPct: 1, resetsAt: new Date(Date.now() + 6.5 * 86400000).toISOString() }, noFiveHour: true, checkedAt: iso() }] : []),
  ],
};

const OVERVIEW: Overview = {
  projects: [
    {
      id: "demo",
      name: d("데모 제작위원회"),
      repo: "D:\\work\\demo",
      baseBranch: "main",
      localGit: true,
      chair: { model: "opus", effort: "high" },
      members: { autonomy: "chair", defaultProvider: "claude" },
      agendas: [
        { slug: "agenda", title: d("결제 시스템 개편"), goals: [], status: "open", branch: "", key: "demo/agenda", taskCounts: { total: 10, done: 2 }, running: 5, runningFamilies: ["claude"], chairBusy: true, open: true },
        { slug: "other", title: d("검색 품질 개선"), goals: [], status: "open", branch: "", key: "demo/other", taskCounts: { total: 4, done: 1 }, running: 0, runningFamilies: [], chairBusy: false, open: true },
        { slug: "old", title: d("로그인 흐름 정리"), goals: [], status: "closed", branch: "", key: "demo/old", taskCounts: { total: 6, done: 6 }, running: 0, runningFamilies: [], chairBusy: false, open: false },
      ],
    },
  ],
  memory: { verified: 14, proposed: 3 },
  accounts: DEMO_ACCOUNTS,
  server: { host: "127.0.0.1", port: 7700, tailscale: { dnsName: "demo.tailnet.ts.net" } },
};

// the wiki, memory, accounts and settings pages ask the server: answer them from here
installDemoApi(MODELS, USAGE);

const LINES: Array<[string, string]> = [
  ["claude-3", "tool Edit"],
  ["gpt-3", d("재현 스크립트로 경합 조건을 확인했습니다. 락 순서가 두 경로에서 반대입니다.")],
  ["claude-4", "tool Bash"],
  ["gemini-2", d("썸네일 단계와 원본 저장 단계를 분리하는 구조로 설계하고 있습니다.")],
  ["claude-3", "tool Read"],
  ["claude-4", d("환불 경로 회귀 테스트 6개를 추가했습니다.")],
  ["gpt-2", "tool mcp__gencouncil__wiki_search"],
  ["gemini-3", d("ko·ja 문자열 파일에서 쓰이지 않는 키 31개를 찾았습니다.")],
];

let chatSeq = 1;
const say = (role: ChatItem["role"], text: string): ChatItem => ({ id: chatSeq++, role, text, ts: iso() });

function Demo() {
  const [selected, setSelected] = useState(q.has("empty") ? "" : "demo/agenda");
  const [members, setMembers] = useState<Member[]>(FIRST);
  const [chairSet, setChairSet] = useState({ model: "claude-opus-5-5", effort: "high" });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [tidy, setTidy] = useState(false);
  // the room and the look, as in the app (the text workshop is not part of the demo)
  const [mode, setMode] = useState<Mode>({ room: q.has("meeting") ? "meeting" : "work", look: q.has("text") ? "text" : q.has("avatar") ? "avatar" : "vision" });
  const view = mode.look === "avatar" ? "avatar" : "vision";
  const Shown = view === "avatar" ? AvatarView : VisionView;
  const toView = (m: Mode) => {
    if (m.room === "work" && m.look === "text") note(t("텍스트 작업실은 데모에 없습니다"));
    else setMode(m);
  };
  const [chat, setChat] = useState<ChatItem[]>(() => [
    say("user", d("결제 시스템을 새 구조로 옮기자. 회귀 없이 배포 가능한 상태까지.")),
    say("assistant", d("결제 모듈은 Opus에게, 테스트는 Sonnet에게 맡겼습니다. 동시성 버그는 Sol이 high로 보고 있고, 결과가 오면 제가 합칠지 판단하겠습니다.")),
  ]);
  const listeners = useRef(new Set<(e: VisionEvent) => void>());
  const fire = useCallback((e: VisionEvent) => listeners.current.forEach((fn) => fn(e)), []);
  const subscribe = useCallback((fn: (e: VisionEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  // for trying one event by hand from the browser console: __fire({ type: "assign", house: "claude", member: "x", name: "Opus 5.5" })
  useEffect(() => {
    (window as unknown as { __fire?: typeof fire }).__fire = fire;
  }, [fire]);
  const note = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const state = useMemo<RuntimeState | null>(() => {
    if (selected !== "demo/agenda") return null;
    const ask = q.has("ask");
    const tasks = TASKS.map((t) => (t.id === "t6" && members.some((m) => m.id === "gemini-3") ? { ...t, status: "doing" as const, memberId: "gemini-3" } : t));
    return {
      key: "demo/agenda",
      project: { id: "demo", name: d("데모 제작위원회"), repo: "", baseBranch: "main" },
      agenda: {
        slug: "agenda",
        title: d("결제 시스템 개편"),
        goals: [d("결제 모듈을 새 구조로 옮기고, 회귀 없이 배포 가능한 상태로 만든다")],
        branch: "agenda/demo/payments",
        status: "open",
        waitingForUser: ask ? { question: d("마이그레이션을 이번 배포에 포함할까요, 다음 배포로 미룰까요?"), options: [d("이번에 포함"), d("다음으로 미룸")], at: iso() } : undefined,
      },
      tasks,
      members,
      integrationWorktree: "",
      chairState: d("# 상태\n\n- 결제 모듈: Opus 진행 중\n- 테스트: Sonnet 진행 중\n- 동시성 버그: Sol 분석 중\n"),
      chair: { provider: DEMO_CHAIR, model: DEMO_CHAIR === "grok" ? "grok-4.7" : chairSet.model, effort: chairSet.effort, account: DEMO_CHAIR, busy: busy && !ask },
      activity: Object.fromEntries(members.map((m, i) => [m.id, [0, 1, 2, i % 4, (i * 3) % 7]])),
      accounts: [],
      limits: { claude: { maxMembers: 3, maxModel: "opus" }, gpt: { maxMembers: 3, maxModel: "gpt-6.2-sol" }, gemini: { maxMembers: 2, maxModel: "gemini-4-argon" } },
      active: {},
      mode: "git",
      folders: 23,
    };
  }, [selected, members, busy, chairSet]);

  // the loop: send one out, hear the reports, take one result in, answer
  useEffect(() => {
    if (q.has("quiet") || q.has("empty")) return;
    const timers: number[] = [];
    const at = (sec: number, fn: () => void) => timers.push(window.setTimeout(fn, sec * 1000));
    const round = () => {
      setMembers(START);
      at(3, () => {
        setBusy(true);
        fire({ type: "chair" });
        setChat((c) => [...c, say("tool", 'council_assign {"provider":"gemini","model":"gemini-3.8-flash","kind":"mechanical"}')]);
        fire({ type: "assign", house: "gemini", member: "gemini-3", name: "Gemini 3.8 Flash", taskId: "t6" });
      });
      at(3.8, () => setMembers((m) => [...m, NEWCOMER]));
      at(5, () => setBusy(false));
      LINES.forEach(([id, text], i) => at(6 + i * 1.7, () => fire({ type: "line", member: id, text })));
      at(15, () => {
        fire({ type: "done", member: "gpt-2", house: "gpt", name: "GPT-6.1 Terra", ok: true, summary: d("API 문서 12개 엔드포인트를 새 구조에 맞게 갱신했습니다. 예제 요청도 모두 바꿨습니다.") });
        window.setTimeout(() => setMembers((m) => m.map((x) => (x.id === "gpt-2" ? { ...x, status: "done" as const, commits: ["e"] } : x))), 800);
        setChat((c) => [...c, say("event", d("[council event] 위원 gpt-2 완료: API 문서 갱신"))]);
        setBusy(true);
      });
      at(18, () => {
        setChat((c) => [...c, say("assistant", d("Terra의 문서 갱신을 검토했습니다. 문제없어 안건 브랜치에 합칩니다. 남은 것은 결제 모듈과 동시성 버그입니다."))]);
        fire({ type: "say" });
        setBusy(false);
      });
      at(22, () => {
        fire({ type: "done", member: "gemini-3", house: "gemini", name: "Gemini 3.8 Flash", ok: true, summary: d("쓰이지 않는 번역 키 31개를 정리했습니다.") });
        window.setTimeout(() => setMembers((m) => m.map((x) => (x.id === "gemini-3" ? { ...x, status: "done" as const, commits: ["f"] } : x))), 800);
      });
      at(27, round);
    };
    round();
    return () => timers.forEach((t) => clearTimeout(t));
  }, [fire]);

  const chair: ChairActions = {
    onSetChair: async (model, effort) => setChairSet({ model, effort }),
    onSetAutonomy: async () => note(t("위원 권한을 바꿨습니다 (데모)")),
    onReset: async () => note(t("의장 세션을 초기화했습니다 (데모)")),
    onRetrospect: async () => note(t("회고를 시작합니다 (데모)")),
    onResume: async () => note(t("이어서 시작 (데모)")),
    onDismissResume: async () => undefined,
    onDelete: async () => note(t("안건 삭제 (데모)")),
    onApproveFinish: async () => note(t("안건 종료 승인 (데모)")),
    onMergeBase: async () => note(t("메인에 반영했습니다 (데모)")),
    onDismissFinish: async () => undefined,
    onFinish: async () => note(t("안건 종료 (데모)")),
    onTidyFolders: () => setTidy(true),
  };
  const memberActions: MemberActions = {
    onOpen: (id) => note(t("{id}의 로그 창 (데모)", { id })),
    onMerge: async (id) => {
      setMembers((m) => m.map((x) => (x.id === id ? { ...x, merged: true } : x)));
      note(t("{id} 머지 완료 (데모)", { id }));
    },
    onStop: async (id) => {
      fire({ type: "done", member: id, ok: false, summary: d("사용자가 중지했습니다.") });
      setMembers((m) => m.map((x) => (x.id === id ? { ...x, status: "stopped" as const } : x)));
    },
    onRelay: (id) => note(t("{id} 패킷 창 (데모)", { id })),
    onHandover: (id) => note(t("{id} 이어받기 창 (데모)", { id })),
  };
  const projects: ProjectActions = {
    onNewProject: () => note(t("제작위원회 추가 창 (데모)")),
    onNewAgenda: () => note(t("새 안건 (데모)")),
    onGuidelines: () => note(t("가이드라인 창 (데모)")),
    onSettings: () => note(t("설정 창 (데모)")),
  };

  // ?float=1: the desktop app's floating chair window, over the same made-up council
  if (IS_FLOAT)
    return (
      <FloatingChair
        overview={OVERVIEW}
        onPick={setSelected}
        state={state}
        chat={chat}
        subscribe={subscribe}
        onSend={async (message) => {
          setChat((c) => [...c, say("user", message)]);
          setBusy(true);
          window.setTimeout(() => {
            setChat((c) => [...c, say("assistant", d("알겠습니다. \"{msg}\" 건은 지금 맡은 위원들의 결과와 함께 판단하겠습니다.", { msg: message.slice(0, 40) }))]);
            setBusy(false);
          }, 1800);
        }}
        chair={chair}
        toast={toast}
      />
    );

  return (
    <>
      {mode.room === "meeting" ? (
        <DemoMeeting look={mode.look} usage={USAGE} onMode={toView} note={note} />
      ) : (
      <Shown
        key={view}
        onMode={toView}
        state={state}
        overview={OVERVIEW}
        selected={selected}
        chat={state ? chat : []}
        wsUp
        loading={false}
        firstTurn={false}
        usage={USAGE}
        models={MODELS}
        onSelect={setSelected}
        onWorkshop={() => note(t("작업실로 이동 (데모)"))}
        notify={note}
        onSettingsSaved={note}
        subscribe={subscribe}
        onSend={async (message) => {
          setChat((c) => [...c, say("user", message)]);
          fire({ type: "user", text: message });
          setBusy(true);
          window.setTimeout(() => {
            setChat((c) => [...c, say("assistant", d("알겠습니다. \"{msg}\" 건은 지금 맡은 위원들의 결과와 함께 판단하겠습니다.", { msg: message.slice(0, 40) }))]);
            fire({ type: "say" });
            setBusy(false);
          }, 1800);
        }}
        chair={chair}
        members={memberActions}
        projects={projects}
      />
      )}
      {tidy && <FolderTidyModal agendaKey="demo/agenda" onClose={() => setTidy(false)} onDone={note} />}
      {toast && <div className="toast" style={{ zIndex: 50 }}>{toast}</div>}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {q.has("film") ? <Film models={MODELS} usage={USAGE} look={q.has("avatar") ? "avatar" : "vision"} /> : <Demo />}
  </React.StrictMode>,
);
