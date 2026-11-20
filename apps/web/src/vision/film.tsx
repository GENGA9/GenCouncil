// A scripted scene for a short clip of the visualization: /vision-demo.html?film
// In a made-up project the chair is touched, Claude is picked in its card and the chair changes from
// GPT-6.2 Astra to Opus 5.5; a made-up
// order is typed into the input; the new chair hands it to five different models and they set to
// work. About fourteen seconds, with a rest after every beat so each can be taken in; played once
// (reload to play again). Nothing here talks to a server.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VisionView } from "../components/VisionView";
import type { ChatItem, Member, ModelsInfo, Overview, RuntimeState, Task, UsageSnapshot } from "../types";
import type { ChairActions, MemberActions, ProjectActions } from "./actions";
import type { VisionEvent } from "./renderer";

const KEY = "aurora/booking";
const ORDER = "예약부터 결제까지 한 번에 끝나게 새로 만들자";

interface Role {
  id: string;
  provider: "claude" | "gpt" | "gemini";
  model: string;
  effort: string;
  name: string;
  task: string;
}
/** five different models, in the order the chair sends them out */
const CAST: Role[] = [
  { id: "claude-1", provider: "claude", model: "claude-sonnet-5-5", effort: "high", name: "Sonnet 5.5", task: "예약 화면 구현" },
  { id: "gpt-1", provider: "gpt", model: "gpt-6.2-sol", effort: "high", name: "GPT-6.2 Sol", task: "결제 연동" },
  { id: "gemini-1", provider: "gemini", model: "gemini-4-neon-xhigh", effort: "xhigh", name: "Gemini 4 Neon", task: "화면 시안" },
  { id: "claude-2", provider: "claude", model: "claude-haiku-5-5", effort: "low", name: "Haiku 5.5", task: "테스트 작성" },
  { id: "gpt-2", provider: "gpt", model: "gpt-6.1-terra", effort: "medium", name: "GPT-6.1 Terra", task: "안내 문구 정리" },
];

/** when things happen, in milliseconds from the start */
const T = {
  // the chair's card stays open long enough to read whose chair it is…
  touch: 500,
  // …then Claude is picked in it (its models come up), then Opus, and each is seen for a moment
  pick: 1500,
  model: 2300,
  change: 2950,
  // the order is typed quickly, letter by letter
  type: 5700,
  perChar: 40,
  // the finished order sits in the input for a beat before it is sent
  sendAfter: 450,
  answer: 7500,
  // one at a time, far enough apart that each house's dial turns on its own
  assign: 7750,
  between: 500,
  settled: 11300,
};
/** what is heard while they work: when, who (by place in CAST), what */
const LINES: Array<[number, number, string]> = [
  [12200, 0, "tool Edit"],
  [12500, 2, "tool Read"],
  [12800, 1, "tool Bash"],
  [13100, 3, "tool Write"],
  [13400, 4, "tool Edit"],
];

const OVERVIEW: Overview = {
  projects: [
    {
      id: "aurora",
      name: "오로라 여행 제작위원회",
      repo: "",
      baseBranch: "main",
      chair: { model: "opus", effort: "high" },
      members: { autonomy: "chair", defaultProvider: "claude" },
      agendas: [{ slug: "booking", title: "예약 흐름 새로 만들기", goals: [], status: "open", branch: "", key: KEY, taskCounts: { total: 0, done: 0 }, running: 0, runningFamilies: [], chairBusy: false, open: true }],
    },
  ],
  memory: { verified: 0, proposed: 0 },
  accounts: [],
  server: { host: "", port: 0, tailscale: {} },
};

let seq = 1;
const iso = () => new Date().toISOString();
const say = (role: ChatItem["role"], text: string): ChatItem => ({ id: seq++, role, text, ts: iso() });

export function Film({ models, usage }: { models: ModelsInfo; usage: UsageSnapshot }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [seat, setSeat] = useState<{ provider: "claude" | "gpt"; model: string }>({ provider: "gpt", model: "gpt-6.2-astra" });
  const listeners = useRef(new Set<(e: VisionEvent) => void>());
  const fire = useCallback((e: VisionEvent) => listeners.current.forEach((fn) => fn(e)), []);

  const state = useMemo<RuntimeState>(
    () => ({
      key: KEY,
      project: { id: "aurora", name: "오로라 여행 제작위원회", repo: "", baseBranch: "main" },
      agenda: { slug: "booking", title: "예약 흐름 새로 만들기", goals: ["예약부터 결제까지 한 번에 끝나는 새 예약 흐름"], branch: "agenda/aurora/booking", status: "open" },
      tasks,
      members,
      integrationWorktree: "",
      chairState: "",
      chair: { provider: seat.provider, model: seat.model, effort: "high", account: seat.provider, busy },
      activity: Object.fromEntries(members.map((m, i) => [m.id, [1, 2, 3, 2 + (i % 3), 4 + (i % 2)]])),
      accounts: [
        { id: "claude", provider: "claude", status: "ok" },
        { id: "gpt", provider: "gpt", status: "ok" },
        { id: "gemini", provider: "gemini", status: "ok" },
      ],
      limits: { claude: { maxMembers: 3, maxModel: "opus" }, gpt: { maxMembers: 3, maxModel: "gpt-6.2-sol" }, gemini: { maxMembers: 2, maxModel: "gemini-4-neon" } },
      active: {},
      mode: "git",
    }),
    [tasks, members, busy, seat],
  );

  // the script, on one clock from the moment the page is up
  useEffect(() => {
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const box = () => document.querySelector<HTMLTextAreaElement>(".vz-composer textarea");
    const type = (text: string) => {
      const el = box();
      if (!el) return;
      // the input is React's: set the value the way typing does, then tell it
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    // the chair is touched (its card opens) and another model is put in it
    at(T.touch, () => document.querySelector<HTMLButtonElement>(".vz-chair")?.click());
    const press = (el?: HTMLElement | null) => el?.animate([{ transform: "scale(1)" }, { transform: "scale(0.86)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 460, easing: "ease-out" });
    // Claude is pressed in the card's row of companies: its models come up
    at(T.pick, () => {
      const to = document.querySelector<HTMLButtonElement>('.vz-pop .vz-chip.co[data-co="claude"]');
      to?.click();
      press(to);
    });
    // Opus is pressed. The real button asks first in a dialog, which a film cannot show, so the
    // press is drawn here and the change follows from the script.
    at(T.model, () => {
      const to = document.querySelector<HTMLButtonElement>('.vz-pop .vz-chip[data-model="opus"]');
      to?.classList.add("on");
      press(to);
    });
    at(T.change, () => setSeat({ provider: "claude", model: "claude-opus-5-5" }));

    // the order is typed and sent
    at(T.type - 60, () => box()?.focus());
    for (let i = 1; i <= ORDER.length; i++) at(T.type + i * T.perChar, () => type(ORDER.slice(0, i)));
    at(T.type + ORDER.length * T.perChar + T.sendAfter, () => document.querySelector<HTMLButtonElement>(".vz-send")?.click());
    at(T.type + ORDER.length * T.perChar + T.sendAfter + 80, () => box()?.blur());

    // the new chair answers at once and sends five out, one after another
    at(T.answer, () => {
      setChat((c) => [...c, say("assistant", "다섯 갈래로 나눠, 일마다 가장 잘 맞는 모델에게 맡깁니다.")]);
      fire({ type: "say" });
    });
    CAST.forEach((r, i) => {
      const t = T.assign + i * T.between;
      at(t, () => {
        setTasks((ts) => [...ts, { id: `t${i + 1}`, title: r.task, description: "", status: "doing", memberId: r.id }]);
        fire({ type: "assign", house: r.provider, member: r.id, name: r.name, taskId: `t${i + 1}` });
      });
      // the member is on the books a moment later, as it is with a real server
      at(t + 700, () =>
        setMembers((ms) => [...ms, { id: r.id, provider: r.provider, model: r.model, effort: r.effort, taskId: `t${i + 1}`, branch: `agenda/aurora/${r.id}`, worktree: "", status: "running", toolCalls: 3 + i, startedAt: iso() }]),
      );
    });
    at(T.settled, () => setBusy(false));

    // they work
    for (const [t, i, text] of LINES) {
      at(t, () => {
        fire({ type: "line", member: CAST[i].id, text });
        setMembers((ms) => ms.map((m) => (m.id === CAST[i].id ? { ...m, toolCalls: m.toolCalls + 7 } : m)));
      });
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [fire]);

  const nothing = async () => undefined;
  const chair: ChairActions = { onSetChair: nothing, onSetAutonomy: nothing, onReset: nothing, onRetrospect: nothing, onResume: nothing, onDismissResume: nothing, onDelete: nothing, onApproveFinish: nothing, onMergeBase: nothing, onDismissFinish: nothing, onFinish: nothing, onTidyFolders: () => undefined };
  const memberActions: MemberActions = { onOpen: () => undefined, onMerge: nothing, onStop: nothing, onRelay: () => undefined, onHandover: () => undefined };
  const projects: ProjectActions = { onNewProject: () => undefined, onNewAgenda: () => undefined, onGuidelines: () => undefined, onSettings: () => undefined };

  return (
    <VisionView
      state={state}
      overview={OVERVIEW}
      selected={KEY}
      chat={chat}
      wsUp
      loading={false}
      firstTurn={chat.length === 0}
      usage={usage}
      models={models}
      onSelect={() => undefined}
      onWorkshop={() => undefined}
      notify={() => undefined}
      onSettingsSaved={() => undefined}
      subscribe={useCallback((fn: (e: VisionEvent) => void) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      }, [])}
      onSend={async (message) => {
        setChat((c) => [...c, say("user", message)]);
        fire({ type: "user", text: message });
        setBusy(true);
      }}
      chair={chair}
      members={memberActions}
      projects={projects}
    />
  );
}
