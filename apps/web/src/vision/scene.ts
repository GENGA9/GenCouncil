// Where everything in the visualization sits: the chair in the middle, the three houses around it,
// each house's model ladder on its ring, and its working members beyond the ring. Pure geometry —
// no canvas, no DOM — so the drawing code and the labels on top of it agree on every position.
import { familyOf, memberName } from "../model";
import type { Member, ModelsInfo, RuntimeState, TaskStatus } from "../types";

export type HouseId = "claude" | "gpt" | "gemini";
export const HOUSE_IDS: HouseId[] = ["claude", "gpt", "gemini"];
export const HOUSE_NAME: Record<HouseId, string> = { claude: "CLAUDE", gpt: "GPT", gemini: "GEMINI" };
/** the companies the usage bars list: the three houses, and Grok once it has a login */
export type UsageId = HouseId | "grok";
export const USAGE_NAME: Record<UsageId, string> = { ...HOUSE_NAME, grok: "GROK" };
export const usageIds = (items: Array<{ provider: string }>): UsageId[] => [...HOUSE_IDS, ...(items.some((u) => u.provider === "grok") ? (["grok"] as const) : [])];

export type Rgb = [number, number, number];
export type TintId = HouseId | "chair" | "relay" | "grok";
export const TINT: Record<TintId, Rgb> = {
  claude: [255, 150, 104],
  gpt: [62, 226, 178],
  gemini: [122, 152, 255],
  chair: [255, 224, 158],
  relay: [196, 156, 255],
  // a fuller yellow than the chair's pale gold, so a Grok member by the chair reads as its own
  grok: [250, 206, 58],
};
export const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export interface Ladder {
  id: HouseId;
  /** lowest rung first */
  models: Array<{ id: string; label: string; note?: string }>;
}

/** shown until /api/models answers, and when it cannot be reached */
export const FALLBACK_LADDERS: Ladder[] = [
  { id: "claude", models: [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "fable", label: "Fable" }] },
  { id: "gpt", models: [{ id: "gpt-6-luna", label: "Luna" }, { id: "gpt-6.1-terra", label: "Terra" }, { id: "gpt-6.2-sol", label: "Sol" }, { id: "gpt-6.2-astra", label: "Astra" }] },
  { id: "gemini", models: [{ id: "gemini-3.8-flash", label: "Flash" }, { id: "gemini-4-hydrogen", label: "Hydrogen" }, { id: "gemini-4-neon", label: "Neon" }, { id: "gemini-4-argon", label: "Argon" }] },
];

export function laddersFrom(models: ModelsInfo | null): Ladder[] {
  return HOUSE_IDS.map((id) => {
    const p = models?.providers.find((x) => x.id === id);
    return p && p.models.length ? { id, models: p.models.map((m) => ({ id: m.id, label: m.label, note: m.note })) } : FALLBACK_LADDERS.find((l) => l.id === id)!;
  });
}

/** the word a rung is known by: "gemini-4-neon" -> "neon", "gpt-6.2-sol" -> "sol", "opus" -> "opus" */
export const rungWord = (id: string) => id.split(/[-.]/).pop()!.toLowerCase();

/** which rung a member's model sits on; -1 when the model is not on the ladder */
export function rungIndex(ladder: Ladder, model?: string): number {
  if (!model) return -1;
  const m = model.toLowerCase();
  const exact = ladder.models.findIndex((r) => r.id.toLowerCase() === m);
  if (exact >= 0) return exact;
  // "claude-sonnet-5-5", "gemini-4-neon-xhigh": the rung's word appears as one of the id's parts
  const parts = m.split(/[-.]/);
  return ladder.models.findIndex((r) => parts.includes(rungWord(r.id)));
}

export const isActive = (m: Pick<Member, "status">) => m.status === "running" || m.status === "starting" || m.status === "waiting";

export interface RungNode {
  id: string;
  /** engraved on the ring: "SONNET" */
  word: string;
  x: number;
  y: number;
  angle: number;
  /** above this project's limit */
  locked: boolean;
  /** members working on this rung now */
  active: number;
}

export interface WorkerNode {
  id: string;
  /** grok has no house of its own yet: its members stand by the chair like relays, in its own colour */
  house: HouseId | "relay" | "grok";
  x: number;
  y: number;
  /** direction from its house (or the chair), for placing the label on the far side */
  angle: number;
  fromX: number;
  fromY: number;
  name: string;
  task: string;
  effort?: string;
  status: Member["status"];
  /** 0..1: how busy it was in the last minutes */
  heat: number;
  toolCalls: number;
  startedAt: string;
  /** which way its name hangs: the way it stands from its house */
  labelAngle: number;
}

/** a member that is finished: it stays by its house, small and dim */
export interface PastNode {
  id: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  kind: "merged" | "done" | "failed" | "other";
  /** first letter of its rung, drawn inside */
  letter: string;
  name: string;
  task: string;
}

export interface HouseNode {
  id: HouseId;
  x: number;
  y: number;
  /** direction away from the chair */
  out: number;
  coreR: number;
  bandR: number;
  ringR: number;
  rungs: RungNode[];
  workers: WorkerNode[];
  past: PastNode[];
  active: number;
  max: number;
  finished: number;
}

export interface TaskArc {
  id: string;
  title: string;
  status: TaskStatus;
  a0: number;
  a1: number;
  tint: Rgb | null;
}

export interface Scene {
  w: number;
  h: number;
  /** the length everything is measured in */
  u: number;
  portrait: boolean;
  chair: { x: number; y: number; r: number; ringR: number; haloR: number; busy: boolean; waiting: boolean; tint: Rgb };
  houses: HouseNode[];
  relays: WorkerNode[];
  tasks: TaskArc[];
  orbit: { rx: number; ry: number };
  workerR: number;
  /** radius of a finished member */
  pastR: number;
  /** where the user's words enter and the chair's answers leave: the edge next to the conversation */
  port: { x: number; y: number };
  /** free width between the two lower houses, where the chair's words go */
  gap: number;
  closed: boolean;
  /** nothing to show yet: no agenda is open */
  dormant: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const RUNG_STEP = (52 * Math.PI) / 180;
const MAX_PAST = 16;
/** half the arc working members may spread over, measured from straight away from the chair */
const FAN = (100 * Math.PI) / 180;
/** how far apart along that arc two members like to stand */
const SPREAD = (42 * Math.PI) / 180;
/** closer than this to a neighbour, in a house with three or more out, and every other one steps back */
const CROWDED = (50 * Math.PI) / 180;
/** how much further out that is, in units */
const FAR = 0.85;

function heatOf(buckets: number[] | undefined): number {
  if (!buckets || buckets.length === 0) return 0;
  const last = buckets[buckets.length - 1] ?? 0;
  const prev = buckets[buckets.length - 2] ?? 0;
  return clamp((last + prev * 0.5) / 6, 0, 1);
}

/** On a tall stage (a phone): where the title card ends, so nothing of the picture, labels included, goes above it. */
export const TALL_CARD_BOTTOM = 118;
/** a member's label on a tall stage: three short lines, and the gap between it and the member */
export const TALL_LABEL = { h: 40, gap: 12 };

/** on a tall stage the chair's words are a panel fixed over the input: its height (three lines) and the gap between the two */
export const TALL_WORDS = { h: 74, gap: 8 };
/** on a tall stage the input floats this far up from the bottom */
export const TALL_INPUT = { top: 124 };
/** where a tall picture has to end: the top of the chair's panel */
export const tallFloor = (h: number): number => h - TALL_INPUT.top - TALL_WORDS.gap - TALL_WORDS.h;

/**
 * How far a tall picture really reaches, top and bottom: the houses, the finished members beside them,
 * the working members with their labels, and the line under the chair that says what it is doing.
 */
export function tallExtent(s: Scene): { top: number; bottom: number } {
  const label = TALL_LABEL.h + TALL_LABEL.gap;
  let top = s.chair.y - s.chair.haloR;
  let bottom = s.chair.y + s.chair.haloR + s.u * 0.3 + 28;
  for (const h of s.houses) {
    top = Math.min(top, h.y - h.ringR);
    bottom = Math.max(bottom, h.y + h.ringR);
    for (const p of h.past) {
      top = Math.min(top, p.y - s.pastR);
      bottom = Math.max(bottom, p.y + s.pastR);
    }
    for (const w of h.workers) {
      // a member above its house carries its label over it, one below under it; beside, the label is level with it
      top = Math.min(top, w.y - s.workerR - (w.y < h.y - 0.4 * s.u ? label : 0));
      bottom = Math.max(bottom, w.y + s.workerR + (w.y > h.y + 0.4 * s.u ? label : 0));
    }
  }
  for (const w of s.relays) bottom = Math.max(bottom, w.y + s.workerR + label);
  return { top, bottom };
}

/** the sky left over a tall picture (under the title card) and under it (down to the chair's panel) */
export function tallSpace(s: Scene): { above: number; below: number } {
  const { top, bottom } = tallExtent(s);
  return { above: top - TALL_CARD_BOTTOM, below: tallFloor(s.h) - bottom };
}

export function buildScene(w: number, h: number, state: RuntimeState | null, ladders: Ladder[]): Scene {
  // The tall picture is laid out once as high as it could ever need to be, measured, then moved so the
  // sky above it is as deep as the sky under it, between the title card and the chair's panel. With a
  // full house it sits right under the title card (never closer than a sliver).
  const first = layout(w, h, state, ladders, 0);
  if (!first.portrait) return first;
  const { above, below } = tallSpace(first);
  const shift = Math.max(6, (above + below) / 2) - above;
  return Math.abs(shift) < 0.5 ? first : layout(w, h, state, ladders, shift);
}

function layout(w: number, h: number, state: RuntimeState | null, ladders: Ladder[], shift: number): Scene {
  // Two layouts of the same triangle, wide and tall. Whichever draws larger wins.
  // Tall (a phone): GPT and Gemini stand just below the chair's level and Claude close above it, so the
  // picture is as wide as the screen allows and ends early, leaving the bottom of the screen for the
  // input, questions and labels. It starts right under the title card: the label of a member standing
  // straight above Claude just clears the card, whatever the size of the picture.
  const tallTop = TALL_CARD_BOTTOM + 4 + TALL_LABEL.h + TALL_LABEL.gap;
  const tallRoom = Math.max(120, tallFloor(h) - 4 - tallTop);
  const workerDist = 1.62;
  // in units: how far the tall picture reaches above the chair (Claude, a member on a rung, its disc)
  // and below it (a side house, a member under it, its disc). The label over the topmost member is not
  // in units: tallTop has room for it. A label under the lowest member finds a place beside it instead.
  const TALL = { top: 2.75, dx: 2.75, dy: 1.2, up: 2.75 + workerDist + 0.23, down: 1.2 + workerDist + 0.2 };
  const tall = Math.min((w / 2 - 6) / (TALL.dx + workerDist + 0.2), tallRoom / (TALL.up + TALL.down));
  const wide = Math.min(w / 14.5, h / 10);
  const portrait = tall > wide;
  const u = portrait ? clamp(tall, 22, 78) : clamp(wide, 28, 112);
  const cx = w / 2;
  // tall: as if a member stood above Claude, then moved by what buildScene measured
  const cy = portrait ? tallTop + TALL.up * u + shift : h * 0.525;
  const topDy = (portrait ? TALL.top : 2.6) * u;
  const sideDx = portrait ? TALL.dx * u : Math.max(3.4 * u, Math.min(5.4 * u, w / 2 - 2.0 * u - clamp(w * 0.09, 60, 150)));
  const sideDy = (portrait ? TALL.dy : 1.75) * u;
  const workerR = Math.max(8, 0.2 * u);
  // on a phone the chair is drawn a little larger, so its name still fits inside
  const chairR = (portrait ? 0.78 : 0.62) * u;

  const members = state?.members ?? [];
  const taskTitle = (id: string) => state?.tasks.find((t) => t.id === id)?.title ?? "";
  const toWorker = (m: Member, house: HouseId | "relay" | "grok", x: number, y: number, angle: number, fromX: number, fromY: number, labelAngle = angle): WorkerNode => ({
    id: m.id,
    house,
    x,
    y,
    angle,
    fromX,
    fromY,
    // agy model ids carry the reasoning level ("gemini-4-neon-xhigh"); the label shows it separately
    name: memberName({ ...m, model: m.model?.replace(/-(low|medium|high|xhigh|max)$/i, "") }),
    task: taskTitle(m.taskId),
    effort: m.effort,
    status: m.status,
    heat: heatOf(state?.activity[m.id]),
    toolCalls: m.toolCalls,
    startedAt: m.startedAt,
    labelAngle,
  });

  const centers: Record<HouseId, { x: number; y: number }> = {
    claude: { x: cx, y: cy - topDy },
    gpt: { x: cx - sideDx, y: cy + sideDy },
    gemini: { x: cx + sideDx, y: cy + sideDy },
  };

  const houses: HouseNode[] = HOUSE_IDS.map((id) => {
    const { x, y } = centers[id];
    const out = Math.atan2(y - cy, x - cx);
    const ladder = ladders.find((l) => l.id === id) ?? FALLBACK_LADDERS.find((l) => l.id === id)!;
    const ringR = 1.0 * u;
    const limit = state?.limits[id];
    const top = limit?.maxModel ? rungIndex(ladder, limit.maxModel) : -1;
    // the right-hand house runs its ladder the other way round, so low rungs sit at the bottom on both sides
    const dir = x > cx + 1 ? -1 : 1;
    const n = ladder.models.length;
    const mine = members.filter((m) => familyOf(m) === id);
    const activeMine = mine.filter(isActive);

    const rungs: RungNode[] = ladder.models.map((r, i) => {
      const angle = out + dir * (i - (n - 1) / 2) * RUNG_STEP;
      return {
        id: r.id,
        word: rungWord(r.id).toUpperCase(),
        x: x + Math.cos(angle) * ringR,
        y: y + Math.sin(angle) * ringR,
        angle,
        locked: limit?.maxMembers === 0 || (top >= 0 && i > top),
        active: 0,
      };
    });

    // Working members fan out over the side of the house that faces away from the chair. Each starts in
    // line with its own rung; where they would crowd they are pushed apart along the arc, and when the
    // arc itself is crowded every other one stands further out. The thread back to the rung gets
    // longer; the members and their labels get room.
    const spots = activeMine
      .map((m) => {
        const ri = rungIndex(ladder, m.model);
        return { m, ri, at: ri >= 0 ? dir * (ri - (n - 1) / 2) * RUNG_STEP : 0 };
      })
      // stable: members of one rung keep the order they were sent out in
      .sort((a, b) => a.at - b.at);
    for (const s of spots) if (s.ri >= 0) rungs[s.ri].active++;
    const count = spots.length;
    const sep = count > 1 ? Math.min(SPREAD, (2 * FAN) / (count - 1)) : 0;
    for (let pass = 0; pass < 40; pass++) {
      for (let i = 1; i < count; i++) {
        const lack = sep - (spots[i].at - spots[i - 1].at);
        if (lack > 0) {
          spots[i - 1].at -= lack / 2;
          spots[i].at += lack / 2;
        }
      }
      // never off the fan: the i-th has to leave room for the ones on either side of it
      spots.forEach((s, i) => (s.at = clamp(s.at, -FAN + i * sep, FAN - (count - 1 - i) * sep)));
    }
    const close = (i: number) => (i > 0 && spots[i].at - spots[i - 1].at < CROWDED) || (i < count - 1 && spots[i + 1].at - spots[i].at < CROWDED);
    // how far out a member may stand before it leaves the stage or runs under the title card
    const minX = workerR + 8;
    const maxX = w - workerR - 8;
    const minY = (portrait ? TALL_CARD_BOTTOM + 30 : 42) + workerR;
    const maxY = (portrait ? tallFloor(h) - 4 : h - 48) - workerR;
    const workers: WorkerNode[] = spots.map((s, i) => {
      const rung = s.ri >= 0 ? rungs[s.ri] : undefined;
      const angle = out + s.at;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const fits = (d: number) => x + cos * d >= minX && x + cos * d <= maxX && y + sin * d >= minY && y + sin * d <= maxY;
      // off the ladder (a web relay, an unknown model) stands a little further out; so does every other one in a crowd
      let dist = (workerDist + (rung ? 0 : 0.44) + (count >= 3 && i % 2 === 1 && close(i) ? FAR : 0)) * u;
      while (dist > workerDist * u && !fits(dist)) dist -= 0.1 * u;
      dist = Math.max(dist, workerDist * u);
      return toWorker(s.m, id, x + cos * dist, y + sin * dist, angle, rung ? rung.x : x + cos * ringR, rung ? rung.y : y + sin * ringR);
    });

    // finished members stay on the two flanks that face the chair, newest closest to the working side;
    // four to a flank, a second row behind when there are more
    const done = mine.filter((m) => !isActive(m) && m.status !== "handed_over").slice(-MAX_PAST).reverse();
    const past: PastNode[] = done.map((m, k) => {
      const a = out + (k % 2 ? -1 : 1) * (((110 + (Math.floor(k / 2) % 4) * 14.5) * Math.PI) / 180);
      const dist = (1.38 + Math.floor(k / 8) * 0.34) * u;
      const ri = rungIndex(ladder, m.model);
      const name = memberName({ ...m, model: m.model?.replace(/-(low|medium|high|xhigh|max)$/i, "") });
      return {
        id: m.id,
        x: x + Math.cos(a) * dist,
        y: y + Math.sin(a) * dist,
        fromX: x + Math.cos(a) * ringR,
        fromY: y + Math.sin(a) * ringR,
        kind: m.merged ? "merged" : m.status === "done" ? "done" : m.status === "failed" ? "failed" : "other",
        letter: (ri >= 0 ? rungs[ri].word : name).charAt(0).toUpperCase(),
        name,
        task: taskTitle(m.taskId),
      };
    });

    return {
      id,
      x,
      y,
      out,
      coreR: 0.4 * u,
      bandR: 0.74 * u,
      ringR,
      rungs,
      workers,
      past,
      active: activeMine.length,
      max: limit?.maxMembers ?? 0,
      finished: mine.filter((m) => !isActive(m)).length,
    };
  });

  // a relay member whose AI cannot be told from its name stays by the chair
  const strays = members.filter((m) => isActive(m) && (familyOf(m) === "relay" || familyOf(m) === "grok"));
  const relays = strays.map((m, k) => {
    const angle = Math.PI / 2 + (k - (strays.length - 1) / 2) * ((30 * Math.PI) / 180);
    const dist = chairR + 1.33 * u;
    return toWorker(m, familyOf(m) === "grok" ? "grok" : "relay", cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, angle, cx + Math.cos(angle) * (chairR + 0.63 * u), cy + Math.sin(angle) * (chairR + 0.63 * u));
  });

  const all = state?.tasks ?? [];
  // the space between arcs shrinks with them: a hundred tasks must still be a hundred arcs
  const gap = all.length > 1 ? Math.min(0.07, ((Math.PI * 2) / all.length) * 0.3) : 0;
  const tasks: TaskArc[] = all.map((t, i) => {
    const span = (Math.PI * 2) / all.length;
    const owner = t.memberId ? members.find((m) => m.id === t.memberId) : undefined;
    const fam = owner ? familyOf(owner) : undefined;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      a0: -Math.PI / 2 + i * span + gap / 2,
      a1: -Math.PI / 2 + (i + 1) * span - gap / 2,
      tint: fam ? TINT[fam] : null,
    };
  });

  // the ellipse through the three houses, centered on the chair
  const k = Math.sqrt(Math.max(0.05, 1 - (sideDy / topDy) ** 2));
  const chairFam = state?.chair.provider;

  return {
    w,
    h,
    u,
    portrait,
    chair: {
      x: cx,
      y: cy,
      r: chairR,
      ringR: chairR + 0.38 * u,
      haloR: chairR + 0.6 * u,
      busy: Boolean(state?.chair.busy),
      waiting: Boolean(state?.agenda.waitingForUser && !state.chair.busy && state.agenda.status !== "closed"),
      tint: chairFam ? TINT[chairFam] : TINT.claude,
    },
    houses,
    relays,
    tasks,
    orbit: { rx: sideDx / k, ry: topDy },
    workerR,
    pastR: Math.max(5, 0.14 * u),
    port: portrait ? { x: cx, y: h - 4 } : { x: w - 4, y: h * 0.34 },
    gap: Math.min(620, Math.max(220, 2 * sideDx - 196)),
    closed: state?.agenda.status === "closed",
    dormant: !state,
  };
}

export type Stage = "assign" | "work" | "review" | "decide";
export const STAGES: Array<{ id: Stage; title: string; text: string }> = [
  { id: "assign", title: "배분", text: "의장이 일을 나눕니다" },
  { id: "work", title: "작업", text: "회사마다 알맞은 모델이 동시에 맡습니다" },
  { id: "review", title: "검토", text: "결과가 의장에게 모입니다" },
  { id: "decide", title: "결정", text: "의장이 최종 판단합니다" },
];

/** which steps of the council's loop are happening now */
export function stagesOf(state: RuntimeState | null): Set<Stage> {
  const on = new Set<Stage>();
  if (!state) return on;
  const working = state.members.some(isActive);
  const unreviewed = state.tasks.some((t) => t.status === "review") || state.members.some((m) => m.status === "done" && !m.merged && (m.commits?.length ?? 0) > 0);
  const allDone = state.tasks.length > 0 && state.tasks.every((t) => t.status === "done");
  if (state.agenda.status === "closed" || state.agenda.waitingForUser?.kind === "finish" || (allDone && !working)) on.add("decide");
  if (working) on.add("work");
  if (state.chair.busy) on.add(unreviewed ? "review" : "assign");
  else if (unreviewed && !on.has("decide")) on.add("review");
  return on;
}
