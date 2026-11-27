// A scripted scene for a short clip of the visualization: /vision-demo.html?film
// In a made-up project the chair is touched, Claude is picked in its card and the chair changes from
// GPT-6.2 Astra to Opus 5.5; a made-up
// order is typed into the input; the new chair hands it to five different models and they set to
// work. About fourteen seconds, with a rest after every beat so each can be taken in; played once
// (reload to play again). Nothing here talks to a server.
// /vision-demo.html?avatar&film plays the avatar look's scene (A below): the chair is poked, GPT's
// character in the chair gives way to Claude's, the order goes out, five members land on the desk,
// one is picked up and dropped, one reports, and the chair walks out in front of the desk to dance.
// The made-up project, order and tasks are in the screen language (?lang=en, ?lang=ja).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarView } from "../components/AvatarView";
import { VisionView } from "../components/VisionView";
import { getLang } from "../i18n";
import type { ChatItem, Member, ModelsInfo, Overview, RuntimeState, Task, UsageSnapshot } from "../types";
import type { ChairActions, MemberActions, ProjectActions } from "./actions";
import type { VisionEvent } from "./renderer";

const KEY = "aurora/booking";
/** the made-up project's words, in the screen language */
const TEXT = {
  ko: {
    order: "예약부터 결제까지 한 번에 끝나게 새로 만들자",
    project: "오로라 여행 제작위원회",
    agenda: "예약 흐름 새로 만들기",
    goal: "예약부터 결제까지 한 번에 끝나는 새 예약 흐름",
    tasks: ["예약 화면 구현", "결제 연동", "화면 시안", "테스트 작성", "안내 문구 정리"],
    answer: "다섯 갈래로 나눠, 일마다 가장 잘 맞는 모델에게 맡깁니다.",
    done: "예약·결제 테스트 14개를 추가했고 모두 통과합니다.",
  },
  en: {
    order: "Rebuild booking so reserving and paying is one smooth flow",
    project: "Aurora Travel council",
    agenda: "New booking flow",
    goal: "A booking flow that goes from reservation to payment in one go",
    tasks: ["Booking screen", "Payment integration", "Screen mockups", "Write tests", "Polish the copy"],
    answer: "I'll split it five ways and give each part to the model that fits it best.",
    done: "Added 14 booking and payment tests; all of them pass.",
  },
  ja: {
    order: "予約から決済まで一度で終わるように作り直そう",
    project: "オーロラ旅行 製作委員会",
    agenda: "予約フローの作り直し",
    goal: "予約から決済まで一度で終わる新しい予約フロー",
    tasks: ["予約画面の実装", "決済連携", "画面デザイン案", "テスト作成", "案内文の整理"],
    answer: "5つに分けて、それぞれに一番合うモデルへ任せます。",
    done: "予約・決済のテストを14件追加し、すべて通りました。",
  },
}[getLang()];
const ORDER = TEXT.order;

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
  { id: "claude-1", provider: "claude", model: "claude-sonnet-5-5", effort: "high", name: "Sonnet 5.5", task: TEXT.tasks[0] },
  { id: "gpt-1", provider: "gpt", model: "gpt-6.2-sol", effort: "high", name: "GPT-6.2 Sol", task: TEXT.tasks[1] },
  { id: "gemini-1", provider: "gemini", model: "gemini-4-neon-xhigh", effort: "xhigh", name: "Gemini 4 Neon", task: TEXT.tasks[2] },
  { id: "claude-2", provider: "claude", model: "claude-haiku-5-5", effort: "low", name: "Haiku 5.5", task: TEXT.tasks[3] },
  { id: "gpt-2", provider: "gpt", model: "gpt-6.1-terra", effort: "medium", name: "GPT-6.1 Terra", task: TEXT.tasks[4] },
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
/** the avatar scene's beats (ms): slower than the picture's, since the characters talk */
const A = {
  poke: 600,
  menu: 1900,
  pick: 2600,
  model: 3300,
  // the menu closes first, so the change of character is seen
  close: 3800,
  change: 4100,
  type: 5000,
  perChar: 40,
  sendAfter: 400,
  answer: 7500,
  assign: 7800,
  between: 500,
  settled: 10600,
  lines: 10700,
  lift: 12900,
  drop: 14100,
  done: 14700,
  danceMenu: 17200,
  dance: 17800,
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
      name: TEXT.project,
      repo: "",
      baseBranch: "main",
      chair: { model: "opus", effort: "high" },
      members: { autonomy: "chair", defaultProvider: "claude" },
      agendas: [{ slug: "booking", title: TEXT.agenda, goals: [], status: "open", branch: "", key: KEY, taskCounts: { total: 0, done: 0 }, running: 0, runningFamilies: [], chairBusy: false, open: true }],
    },
  ],
  memory: { verified: 0, proposed: 0 },
  accounts: [],
  server: { host: "", port: 0, tailscale: {} },
};

let seq = 1;
const iso = () => new Date().toISOString();
const say = (role: ChatItem["role"], text: string): ChatItem => ({ id: seq++, role, text, ts: iso() });

export function Film({ models, usage, look = "vision" }: { models: ModelsInfo; usage: UsageSnapshot; look?: "vision" | "avatar" }) {
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
      project: { id: "aurora", name: TEXT.project, repo: "", baseBranch: "main" },
      agenda: { slug: "booking", title: TEXT.agenda, goals: [TEXT.goal], branch: "agenda/aurora/booking", status: "open" },
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
    if (look !== "vision") return;
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
      setChat((c) => [...c, say("assistant", TEXT.answer)]);
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
  }, [fire, look]);

  // the avatar look's script
  useEffect(() => {
    if (look !== "avatar") return;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const box = () => document.querySelector<HTMLTextAreaElement>(".vz-composer textarea");
    const type = (text: string) => {
      const el = box();
      if (!el) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const bust = () => document.querySelector<HTMLButtonElement>(".av-bust");
    const press = (el?: HTMLElement | null) => el?.animate([{ transform: "scale(1)" }, { transform: "scale(0.86)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 460, easing: "ease-out" });
    /** the chair's menu, as a right click opens it */
    const menu = () => {
      const el = bust();
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.3 }));
    };
    const close = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // poked: she reacts
    at(A.poke, () => bust()?.click());
    // her menu, Claude, Opus: GPT's character gives the chair to Claude's
    at(A.menu, menu);
    at(A.pick, () => {
      const to = document.querySelector<HTMLButtonElement>('.vz-pop .vz-chip.co[data-co="claude"]');
      to?.click();
      press(to);
    });
    at(A.model, () => {
      const to = document.querySelector<HTMLButtonElement>('.vz-pop .vz-chip[data-model="opus"]');
      to?.classList.add("on");
      press(to);
    });
    at(A.change, () => setSeat({ provider: "claude", model: "claude-opus-5-5" }));
    at(A.close, close);

    // the order
    at(A.type - 60, () => box()?.focus());
    for (let i = 1; i <= ORDER.length; i++) at(A.type + i * A.perChar, () => type(ORDER.slice(0, i)));
    at(A.type + ORDER.length * A.perChar + A.sendAfter, () => document.querySelector<HTMLButtonElement>(".vz-send")?.click());
    at(A.type + ORDER.length * A.perChar + A.sendAfter + 80, () => box()?.blur());

    // the answer, and five members onto the desk
    at(A.answer, () => {
      setChat((c) => [...c, say("assistant", TEXT.answer)]);
      fire({ type: "say" });
    });
    CAST.forEach((r, i) => {
      const t = A.assign + i * A.between;
      at(t, () => setMembers((ms) => [...ms, { id: r.id, provider: r.provider, model: r.model, effort: r.effort, taskId: `t${i + 1}`, branch: `agenda/aurora/${r.id}`, worktree: "", status: "running", toolCalls: 3 + i, startedAt: iso() }]));
      at(t + 60, () => {
        setTasks((ts) => [...ts, { id: `t${i + 1}`, title: r.task, description: "", status: "doing", memberId: r.id }]);
        fire({ type: "assign", house: r.provider, member: r.id, name: r.name, taskId: `t${i + 1}` });
      });
    });
    at(A.settled, () => setBusy(false));
    LINES.forEach(([, i, text], k) =>
      at(A.lines + k * 420, () => {
        fire({ type: "line", member: CAST[i].id, text });
        setMembers((ms) => ms.map((m) => (m.id === CAST[i].id ? { ...m, toolCalls: m.toolCalls + 7 } : m)));
      }),
    );

    // one of them is picked up and carried a little, then dropped back on the desk
    const held: { el?: HTMLElement; x: number; y: number } = { x: 0, y: 0 };
    const pointer = (type: string, x: number, y: number) =>
      held.el?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, isPrimary: true }));
    at(A.lift, () => {
      const vw = window.innerWidth;
      // the one nearest the middle, so it stays in the picture
      held.el = [...document.querySelectorAll<HTMLElement>(".av-chibi-body")].sort((a, b) => Math.abs(a.getBoundingClientRect().x - vw / 2) - Math.abs(b.getBoundingClientRect().x - vw / 2))[0];
      if (!held.el) return;
      const r = held.el.getBoundingClientRect();
      held.x = r.left + r.width / 2;
      held.y = r.top + r.height * 0.35;
      pointer("pointerdown", held.x, held.y);
    });
    const steps = 14;
    for (let k = 1; k <= steps; k++) at(A.lift + 300 + k * 60, () => pointer("pointermove", held.x + Math.sin((k / steps) * Math.PI) * 30, held.y - (k / steps) * 110));
    at(A.drop, () => pointer("pointerup", held.x, held.y - 110));

    // a report: the tests are done
    at(A.done, () => {
      fire({ type: "done", member: CAST[3].id, house: CAST[3].provider, name: CAST[3].name, ok: true, summary: TEXT.done });
      window.setTimeout(() => setMembers((ms) => ms.map((m) => (m.id === CAST[3].id ? { ...m, status: "done" as const, commits: ["a"] } : m))), 800);
    });

    // and the chair walks out in front of the desk to dance
    at(A.danceMenu, menu);
    const danceChip = (tries: number) => {
      const chip = [...document.querySelectorAll<HTMLButtonElement>(".av-menu button")].find((b) => b.textContent?.trim().startsWith("♪"));
      if (!chip) {
        if (tries > 0) window.setTimeout(() => danceChip(tries - 1), 100);
        return;
      }
      press(chip);
      window.setTimeout(() => chip.click(), 250);
    };
    at(A.dance, () => danceChip(10));
    return () => timers.forEach((t) => clearTimeout(t));
  }, [fire, look]);

  const nothing = async () => undefined;
  const chair: ChairActions = { onSetChair: nothing, onSetAutonomy: nothing, onReset: nothing, onRetrospect: nothing, onResume: nothing, onDismissResume: nothing, onDelete: nothing, onApproveFinish: nothing, onMergeBase: nothing, onDismissFinish: nothing, onFinish: nothing, onTidyFolders: () => undefined };
  const memberActions: MemberActions = { onOpen: () => undefined, onMerge: nothing, onStop: nothing, onRelay: () => undefined, onHandover: () => undefined };
  const projects: ProjectActions = { onNewProject: () => undefined, onNewAgenda: () => undefined, onGuidelines: () => undefined, onSettings: () => undefined };

  const View = look === "avatar" ? AvatarView : VisionView;
  return (
    <View
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
      onMode={() => undefined}
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
