import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { familyOf, memberName, prettyModel } from "../model";
import type { ChatItem, Member, ModelsInfo, Overview, RuntimeState, UsageSnapshot } from "../types";
import type { ChairActions, MemberActions, ProjectActions, SendFn } from "../vision/actions";
import { AgendaCard, Composer, Console, type Report } from "../vision/Console";
import { ChairMenu, HouseMenu, MEMBER_STATUS_KO, Popover, WorkerMenu } from "../vision/Menus";
import { CROWN, SLIDE, VisionRenderer, type VisionEvent } from "../vision/renderer";
import { VisionSheet, type SheetAt, type SheetTab } from "../vision/Sheet";
import { TALL_CARD_BOTTOM, TALL_LABEL, tallFloor } from "../vision/scene";
import { buildScene, HOUSE_NAME, isActive, laddersFrom, STAGES, stagesOf, TINT, type HouseId, type Rgb, type Scene, type TintId, type WorkerNode } from "../vision/scene";
import { ModeSwitch } from "./ModeSwitch";
import "../vision/vision.css";
// after vision.css: it adjusts a few of its rules (the top row on a phone)
import "../vision/sheet.css";

interface Props {
  state: RuntimeState | null;
  overview: Overview | null;
  selected: string;
  chat: ChatItem[];
  wsUp: boolean;
  loading: boolean;
  firstTurn: boolean;
  usage?: UsageSnapshot | null;
  /** the model ladders, when the caller already has them; fetched otherwise */
  models?: ModelsInfo | null;
  onSelect: (key: string) => void;
  onWorkshop: () => void;
  /** a short message for the user (the app's toast) */
  notify: (msg: string) => void;
  /** a project's settings were saved from the sheet: say so and reload what they change */
  onSettingsSaved: (msg: string) => void;
  subscribe: (fn: (e: VisionEvent) => void) => () => void;
  onSend: SendFn;
  chair: ChairActions;
  members: MemberActions;
  projects: ProjectActions;
}

type Menu = null | { kind: "chair" } | { kind: "house"; id: HouseId } | { kind: "member"; id: string };

/** what a member just said, shown beside it for a few seconds */
interface Bubble {
  id: number;
  member: string;
  house: TintId;
  text: string;
  kind: "say" | "tool" | "done" | "fail";
  /** tool calls folded into this bubble */
  count: number;
  /** seconds it stays; fixed at birth, so a redraw never moves its fade */
  life: number;
  until: number;
  /** a newer bubble needs the room: this one is on its way out */
  leaving?: boolean;
}

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
const LOG_KEY = "gc.vision.log";
/** how wide a member's bubble may get: narrower on a tall stage, where the houses stand close */
const bubbleWidth = (scene: Scene) => Math.min(scene.portrait ? 184 : 232, scene.w - 16);
const bareModel = (m: Pick<Member, "id" | "provider" | "model" | "label">) => memberName({ ...m, model: m.model?.replace(/-(low|medium|high|xhigh|max)$/i, "") });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setM(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return m;
}

/** markdown and line breaks flattened: a bubble is a few plain lines */
function plain(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** where a member's bubble goes: above it, or below when there is no room or its name is up there */
function bubbleSpot(scene: Scene, id: string, house: TintId, text: string, nameAbove: boolean): { left: number; top: number; below: boolean; tail: number } | null {
  const w = [...scene.houses.flatMap((h) => h.workers), ...scene.relays].find((x) => x.id === id);
  const past = w ? undefined : scene.houses.flatMap((h) => h.past).find((p) => p.id === id);
  const home = w || past ? undefined : scene.houses.find((h) => h.id === house);
  const ax = w?.x ?? past?.x ?? home?.x;
  const ay = w?.y ?? past?.y ?? home?.y;
  if (ax === undefined || ay === undefined) return null;
  const r = w ? scene.workerR : past ? scene.pastR : home!.ringR;
  const width = bubbleWidth(scene);
  // how tall the bubble will be, near enough: about 30 letters to a line, four lines at most
  const tall = 20 + 18 * Math.min(4, Math.ceil(text.length / Math.max(8, (width - 24) / 7)));
  const below = nameAbove || ay - r - 11 - tall < 6;
  const left = clamp(ax, width / 2 + 8, scene.w - width / 2 - 8);
  return { left, top: below ? ay + r + 11 : ay - r - 11, below, tail: clamp(ax - left, -width / 2 + 16, width / 2 - 16) };
}

interface Placed {
  left: number;
  top: number;
  transform: string;
  side: "left" | "right" | "mid";
  /** the label ended up over its member */
  above: boolean;
  /** how far down the stage it reaches */
  bottom: number;
  /** narrower than usual, to fit beside its member */
  width?: number;
  /** no room for the three lines without covering something: the name alone */
  compact?: boolean;
}
type Rect = [number, number, number, number];

/** Where the chair speaks on a wide stage: up and to the right of its disc. (On a tall one its words have a panel over the input.) */
function chairSpot(scene: Scene): { x: number; y: number; width: number } {
  const ch = scene.chair;
  const a = (-36 * Math.PI) / 180;
  const x = ch.x + Math.cos(a) * (ch.haloR + 12);
  return { x, y: ch.y + Math.sin(a) * (ch.haloR + 12), width: Math.max(140, Math.min(310, scene.w - x - 12)) };
}

interface ChairSays {
  key: string;
  text: string;
  ask: boolean;
  dots: boolean;
}

/**
 * The chair's latest words on a tall stage: a panel fixed over the input and as wide as it, always
 * there and always the same height, so the picture above never has to make room for it.
 */
function ChairWords({ says, onOpen }: { says: ChairSays | null; onOpen: () => void }) {
  const quiet = !says?.text;
  return (
    <button className={`vz-words ${quiet ? "quiet" : ""}`} onClick={onOpen} title="대화 기록 열기">
      <span className="vz-words-body" key={says?.key ?? "none"}>
        <span className="vz-words-tag">의장</span>
        {says?.text || (says?.dots ? "생각하는 중입니다" : "아직 의장의 말이 없습니다. 아래에 첫 지시를 적어 보세요.")}
      </span>
      {says?.dots && (
        <span className="vz-dots">
          <i />
          <i />
          <i />
        </span>
      )}
    </button>
  );
}

/**
 * Where each member's label goes. It hangs on the side it leans to when there is room; otherwise it
 * tries over, under and beside, then over or under its whole house, and takes the spot on the stage
 * that covers least of the houses, the chair, the other members and the labels already placed.
 * Where every such spot would cover a good deal (a member squeezed between its house, a neighbour and
 * the chair's panel), the label shrinks to the name alone, right over or under its member.
 * `keep` is where the chair's words are showing: labels stay out from under them when they can.
 */
function placeLabels(scene: Scene, workers: WorkerNode[], keep?: Rect): Map<string, Placed> {
  const W = scene.portrait ? 118 : 140;
  const H = scene.portrait ? TALL_LABEL.h : 44;
  const R = scene.workerR;
  const d = R + TALL_LABEL.gap;
  const NARROW = 84;
  // on a tall stage the title card is above and the input below
  const top = scene.portrait ? TALL_CARD_BOTTOM : 2;
  const bottom = scene.portrait ? tallFloor(scene.h) - 2 : scene.h - 2;
  const area = (p: Rect, q: Rect) => Math.max(0, Math.min(p[2], q[2]) - Math.max(p[0], q[0])) * Math.max(0, Math.min(p[3], q[3]) - Math.max(p[1], q[1]));
  const round: Array<[number, number, number]> = [...scene.houses.map((h): [number, number, number] => [h.x, h.y, h.ringR + 2]), [scene.chair.x, scene.chair.y, scene.chair.haloR]];
  const touches = (p: Rect, x: number, y: number, r: number) => Math.hypot(clamp(x, p[0], p[2]) - x, clamp(y, p[1], p[3]) - y) < r;
  const taken: Rect[] = [];
  const out = new Map<string, Placed>();
  for (const w of workers) {
    const c = Math.cos(w.labelAngle);
    const s = Math.sin(w.labelAngle);
    const mid = clamp(w.x, W / 2 + 4, scene.w - W / 2 - 4);
    const ax = w.x + c * d;
    const ay = w.y + s * d;
    // a label hanging to one side may be narrower than usual when the edge is near, down to NARROW
    const fit = (room: number) => (room >= W ? W : room >= NARROW ? room : W);
    const share = c < -0.35 ? (1 - c) / 2 : c > 0.35 ? (1 + c) / 2 : 0;
    const rw = share ? fit((c < 0 ? ax - 4 : scene.w - 4 - ax) / share) : W;
    const radial = { left: ax, top: ay, transform: `translate(${-50 + c * 50}%, ${-50 + s * 50}%)`, side: c < -0.35 ? ("left" as const) : c > 0.35 ? ("right" as const) : ("mid" as const), width: rw, rect: [ax + (c - 1) * 0.5 * rw, ay + (s - 1) * 0.5 * H, ax + (c + 1) * 0.5 * rw, ay + (s + 1) * 0.5 * H] as Rect };
    const under = { left: mid, top: w.y + d, transform: "translate(-50%, 0)", side: "mid" as const, width: W, rect: [mid - W / 2, w.y + d, mid + W / 2, w.y + d + H] as Rect };
    const over = { left: mid, top: w.y - d, transform: "translate(-50%, -100%)", side: "mid" as const, width: W, rect: [mid - W / 2, w.y - d - H, mid + W / 2, w.y - d] as Rect };
    const wr = fit(scene.w - 4 - (w.x + d));
    const right = { left: w.x + d, top: w.y, transform: "translate(0, -50%)", side: "right" as const, width: wr, rect: [w.x + d, w.y - H / 2, w.x + d + wr, w.y + H / 2] as Rect };
    const wl = fit(w.x - d - 4);
    const left = { left: w.x - d, top: w.y, transform: "translate(-100%, -50%)", side: "left" as const, width: wl, rect: [w.x - d - wl, w.y - H / 2, w.x - d, w.y + H / 2] as Rect };
    // last resort for a member squeezed between its house and the edge: clear of the whole ring
    const home = scene.houses.find((h) => h.id === w.house);
    const beyond = home
      ? [
          { left: mid, top: home.y - home.ringR - 8, transform: "translate(-50%, -100%)", side: "mid" as const, width: W, rect: [mid - W / 2, home.y - home.ringR - 8 - H, mid + W / 2, home.y - home.ringR - 8] as Rect },
          { left: mid, top: home.y + home.ringR + 8, transform: "translate(-50%, 0)", side: "mid" as const, width: W, rect: [mid - W / 2, home.y + home.ringR + 8, mid + W / 2, home.y + home.ringR + 8 + H] as Rect },
        ]
      : [];
    // the name alone, close under or over the member: one line, for when the three lines fit nowhere
    const WC = Math.min(W, 96);
    const HC = 15;
    const dc = R + 5;
    const midC = clamp(w.x, WC / 2 + 4, scene.w - WC / 2 - 4);
    const underC = { left: midC, top: w.y + dc, transform: "translate(-50%, 0)", side: "mid" as const, width: WC, compact: true, rect: [midC - WC / 2, w.y + dc, midC + WC / 2, w.y + dc + HC] as Rect };
    const overC = { left: midC, top: w.y - dc, transform: "translate(-50%, -100%)", side: "mid" as const, width: WC, compact: true, rect: [midC - WC / 2, w.y - dc - HC, midC + WC / 2, w.y - dc] as Rect };
    const full = [radial, ...(s < 0.25 ? [over, under] : [under, over]), ...(c < 0 ? [left, right] : [right, left]), ...(home && w.y > home.y ? beyond.reverse() : beyond)].map((o) => ({ ...o, compact: false }));
    const order = [...full, ...(s < 0.25 ? [overC, underC] : [underC, overC])];
    const others = workers.filter((o) => o.id !== w.id).map((o): Rect => [o.x - R - 3, o.y - R - 3, o.x + R + 3, o.y + R + 3]);
    const onStage = (r: Rect) => r[0] >= 2 && r[2] <= scene.w - 2 && r[1] >= top && r[3] <= bottom;
    // Each spot is charged for what it would cover: another label, another member, a house, the chair.
    // The cheapest wins, earlier spots first among equals, so a crowded corner gets the least bad overlap
    // rather than the first spot that happens to be empty of one kind of thing.
    const cost = (r: Rect, i: number) =>
      (onStage(r) ? 0 : 1e7) +
      i * 30 +
      taken.reduce((sum, t) => sum + area(r, t) * 3, 0) +
      others.reduce((sum, t) => sum + area(r, t) * 4, 0) +
      (keep ? area(r, keep) * 3 : 0) +
      round.reduce((sum, [x, y, rr], k) => sum + (touches(r, x, y, rr) ? area(r, [x - rr, y - rr, x + rr, y + rr]) * (k === round.length - 1 ? 2 : 1) : 0), 0);
    // the short label says less, so it has to be a good deal cheaper than the best full one to win
    const pick = order.map((o, i) => ({ o, c: cost(o.rect, i) + (o.compact ? 900 : 0) })).reduce((best, x) => (x.c < best.c ? x : best)).o;
    taken.push(pick.rect);
    out.set(w.id, { left: pick.left, top: pick.top, transform: pick.transform, side: pick.side, above: pick.rect[3] <= w.y - R, bottom: pick.rect[3], width: pick.width < W ? pick.width : undefined, compact: pick.compact });
  }
  return out;
}

/** how a member's work is going, in a few words: tool calls so far and how long it has been at it */
function progress(w: WorkerNode, now: number): string {
  if (w.status === "starting") return "시작하는 중";
  if (w.status === "waiting") return "답변 전달을 기다리는 중";
  const min = Math.round((now - Date.parse(w.startedAt)) / 60000);
  const time = !Number.isFinite(min) || min < 0 ? "" : min < 1 ? "방금 시작" : min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분째` : `${min}분째`;
  return [`도구 ${w.toolCalls}회`, time].filter(Boolean).join(" · ");
}

let seq = 1;

export function VisionView({ state, overview, selected, chat, wsUp, loading, firstTurn, usage, models: given, onSelect, onWorkshop, notify, onSettingsSaved, subscribe, onSend, chair, members, projects: baseProjects }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<VisionRenderer | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fetched, setFetched] = useState<ModelsInfo | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  // the wiki, the memory, the accounts and the settings open over the picture
  const [sheet, setSheet] = useState<SheetAt | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const narrow = useMedia("(max-width: 760px)");
  // the record of everything said is tucked away until asked for: what is said shows beside who said it
  const [logOpen, setLogOpen] = useState(() => {
    try {
      return localStorage.getItem(LOG_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleLog = useCallback(() => {
    setLogOpen((v) => {
      try {
        localStorage.setItem(LOG_KEY, v ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !v;
    });
  }, []);
  const models = given ?? fetched;
  // the clock the labels count minutes by
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;
  // how many members may speak at once: a phone's picture has room for two bubbles, a wide one for five
  const roomRef = useRef(5);

  useEffect(() => {
    if (given !== undefined) return;
    let alive = true;
    api.models().then(
      (m) => alive && setFetched(m),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [given]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ladders = useMemo(() => laddersFrom(models), [models]);
  const scene = useMemo(() => (size.w > 0 && size.h > 0 ? buildScene(size.w, size.h, state, ladders) : null), [size, state, ladders]);
  roomRef.current = scene?.portrait ? 2 : 5;

  useEffect(() => {
    if (!canvas.current) return;
    const r = new VisionRenderer(canvas.current);
    renderer.current = r;
    r.start();
    return () => {
      r.stop();
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    if (scene) renderer.current?.setScene(scene);
  }, [scene]);
  // Another model takes the chair (same agenda, different model or company): the picture gathers the
  // old chair's light and bursts into the new one. The disc keeps the old name while the light is
  // drawn in, shrinks with it, and shows the new name as it bursts. The chair's card closes so it is seen.
  const chairEl = useRef<HTMLButtonElement>(null);
  const lastChair = useRef<{ key: string; provider: HouseId; model: string } | null>(null);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const [crowned, setCrowned] = useState(0);
  const chairKey = state?.key;
  const chairProvider = state?.chair.provider ?? "claude";
  const chairModel = state?.chair.model ?? "";
  useEffect(() => {
    const now = chairKey ? { key: chairKey, provider: chairProvider, model: chairModel } : null;
    const prev = lastChair.current;
    lastChair.current = now;
    setOutgoing(null);
    if (!now || !prev || prev.key !== now.key || (prev.provider === now.provider && prev.model === now.model)) return;
    setMenu((m) => (m?.kind === "chair" ? null : m));
    renderer.current?.pulse({ type: "crown", from: prev.provider, to: now.provider });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setOutgoing(prev.model);
    const total = CROWN + 1.1;
    const at = CROWN / total;
    chairEl.current?.animate(
      [
        { transform: "translate(-50%, -50%) scale(1)", filter: "brightness(1)", offset: 0 },
        { transform: "translate(-50%, -50%) scale(0.78)", filter: "brightness(0.5)", offset: at, easing: "cubic-bezier(0.2, 1.5, 0.4, 1)" },
        { transform: "translate(-50%, -50%) scale(1.3)", filter: "brightness(3.2)", offset: Math.min(0.98, at + 0.09) },
        { transform: "translate(-50%, -50%) scale(0.97)", filter: "brightness(1.5)", offset: Math.min(0.99, at + 0.3) },
        { transform: "translate(-50%, -50%) scale(1)", filter: "brightness(1)", offset: 1 },
      ],
      { duration: total * 1000, easing: "ease-in" },
    );
    const timer = window.setTimeout(() => {
      setOutgoing(null);
      setCrowned((c) => c + 1);
    }, CROWN * 1000);
    return () => clearTimeout(timer);
  }, [chairKey, chairProvider, chairModel]);

  // When the picture moves up or down (a house gained or lost the members above it) everything laid
  // over it slides to the new place with it, on the renderer's curve, instead of jumping.
  const sceneEl = useRef<HTMLDivElement>(null);
  const lastScene = useRef<Scene | null>(null);
  useLayoutEffect(() => {
    const prev = lastScene.current;
    lastScene.current = scene;
    const el = sceneEl.current;
    if (!el || !scene || !prev || prev.w !== scene.w || prev.h !== scene.h) return;
    const dy = prev.chair.y - scene.chair.y;
    if (Math.abs(dy) < 0.5 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // a slide still under way carries on from where it is
    const now = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ transform: `translateY(${now + dy}px)` }, { transform: "translateY(0)" }], { duration: SLIDE * 1000, easing: "cubic-bezier(0.215, 0.61, 0.355, 1)" });
  }, [scene]);

  // every event flashes in the picture; what a member says appears beside it and goes into the record
  useEffect(
    () =>
      subscribe((e) => {
        renderer.current?.pulse(e);
        if (e.type !== "assign" && e.type !== "line" && e.type !== "done") return;
        const st = stateRef.current;
        const m = st?.members.find((x) => x.id === e.member);
        const name = m ? bareModel(m) : (e.type !== "line" && e.name) || e.member;
        const house: TintId = m ? familyOf(m) : (e.type !== "line" && e.house) || "relay";
        const now = Date.now();
        const base = { id: seq++, ts: now, member: e.member, name, house };
        const say = (text: string, kind: Bubble["kind"], seconds: number) =>
          setBubbles((cur) => {
            const prev = cur.find((b) => b.member === e.member);
            const count = kind === "tool" && prev?.kind === "tool" ? prev.count + 1 : 1;
            let rest = cur.filter((b) => b.member !== e.member);
            // the oldest make way for the new one, fading out quickly instead of piling up over the picture
            const staying = rest.filter((b) => !b.leaving);
            const over = staying.length - (roomRef.current - 1);
            if (over > 0) {
              const out = new Set(staying.slice(0, over).map((b) => b.id));
              rest = rest.map((b) => (out.has(b.id) ? { ...b, leaving: true, until: Math.min(b.until, now + 450) } : b));
            }
            return [...rest, { id: seq++, member: e.member, house, text, kind, count, life: seconds, until: now + seconds * 1000 }];
          });
        if (e.type === "assign") {
          const task = st?.tasks.find((t) => t.id === e.taskId)?.title;
          setReports((cur) => [...cur, { ...base, kind: "spawn" as const, text: task ?? "작업을 시작합니다" }].slice(-120));
        } else if (e.type === "done") {
          const text = e.summary?.trim() || (e.ok === false ? "작업이 중단되었습니다" : "작업을 마쳤습니다");
          setReports((cur) => [...cur, { ...base, kind: "done" as const, ok: e.ok, text }].slice(-120));
          say(plain(text, 170), e.ok === false ? "fail" : "done", 11);
        } else {
          const raw = (e.text ?? "").trim();
          if (!raw) return;
          const tool = /^tool\s+/.test(raw);
          const text = tool ? raw.replace(/^tool\s+/, "").replace(/^mcp__\w+?__/, "") : raw;
          say(tool ? text : plain(text, 150), tool ? "tool" : "say", tool ? 3.5 : 7.5);
          setReports((cur) => {
            const last = cur[cur.length - 1];
            // a run of tool calls by one member is one line with a count
            if (tool && last && last.kind === "line" && last.member === e.member && last.count) return [...cur.slice(0, -1), { ...last, text: `도구 ${text}`, count: last.count + 1 }];
            return [...cur, { ...base, kind: "line" as const, text: tool ? `도구 ${text}` : text, count: tool ? 1 : undefined }].slice(-120);
          });
        }
      }),
    [subscribe],
  );
  // bubbles go when their time is up
  useEffect(() => {
    if (bubbles.length === 0) return;
    const next = Math.min(...bubbles.map((b) => b.until));
    const t = window.setTimeout(() => setBubbles((cur) => cur.filter((b) => b.until > Date.now())), Math.max(50, next - Date.now() + 20));
    return () => clearTimeout(t);
  }, [bubbles]);
  useEffect(() => {
    setReports([]);
    setBubbles([]);
    setMenu(null);
  }, [selected]);

  const project = overview?.projects.find((p) => selected.startsWith(p.id + "/"));
  const stages = useMemo(() => stagesOf(state), [state]);
  const tasksDone = state?.tasks.filter((t) => t.status === "done").length ?? 0;
  const tasksAll = state?.tasks.length ?? 0;
  const working = state?.members.filter(isActive).length ?? 0;
  const busy = state?.chair.busy ?? false;
  const ask = state?.agenda.waitingForUser && !busy && state.agenda.status !== "closed" ? state.agenda.waitingForUser : undefined;
  const status = !state
    ? loading
      ? "불러오는 중"
      : "안건을 고르면 깨어납니다"
    : state.agenda.status === "closed"
      ? "안건 종료 · 결정 완료"
      : busy
        ? "숙의 중"
        : ask
          ? "당신의 결정을 기다립니다"
          : working > 0
            ? `위원 ${working}명이 작업 중`
            : "대기";

  // what the chair is saying now: its question, or its latest words; while it thinks about something newer, just the dots
  const chairSays = useMemo<ChairSays | null>(() => {
    if (!state) return null;
    if (ask) return { key: `ask${ask.at}`, text: plain(ask.question, 220), ask: true, dots: false };
    let said = -1;
    let asked = -1;
    for (let i = chat.length - 1; i >= 0 && (said < 0 || asked < 0); i--) {
      if (said < 0 && chat[i].role === "assistant" && chat[i].text.trim()) said = i;
      if (asked < 0 && (chat[i].role === "user" || chat[i].role === "event")) asked = i;
    }
    if (busy && said < asked) return { key: "thinking", text: "", ask: false, dots: true };
    if (said < 0) return busy ? { key: "thinking", text: "", ask: false, dots: true } : null;
    return { key: `c${chat[said].id}`, text: plain(chat[said].text, 240), ask: false, dots: busy };
  }, [state, ask, chat, busy]);

  const workers = scene ? [...scene.houses.flatMap((h) => h.workers), ...scene.relays] : [];
  const labels = useMemo(() => (scene ? placeLabels(scene, [...scene.houses.flatMap((h) => h.workers), ...scene.relays]) : new Map<string, Placed>()), [scene]);
  // a wide stage only: on a tall one the chair's words are the panel over the input
  const chairAt = useMemo(() => (scene && !scene.portrait ? chairSpot(scene) : null), [scene]);
  const pasts = scene ? scene.houses.flatMap((h) => h.past.map((p) => ({ ...p, house: h.id }))) : [];
  const openSheet = (at: SheetAt) => {
    setMenu(null);
    setSheet(at);
  };
  /** the settings land on the open agenda's project; the rest are the same for every project */
  const openTab = (tab: SheetTab) => openSheet({ tab, project: tab === "settings" ? project?.id : undefined });
  // a project's settings and guidelines open in the sheet here, not in the workshop's dialogs
  const projects: ProjectActions = {
    ...baseProjects,
    onSettings: (id) => openSheet({ tab: "settings", project: id, view: "settings" }),
    onGuidelines: (id) => openSheet({ tab: "settings", project: id, view: "guidelines" }),
  };
  const card = { overview, state, project, selected, loading, projects, onSelect, onPage: openTab };
  const proposed = overview?.memory.proposed ?? 0;
  const badAccounts = overview?.accounts.filter((a) => a.status !== "ok").length ?? 0;
  /** a dock button answers like the rest of the picture: rings spread from it as the sheet opens */
  const dock = (e: React.MouseEvent<HTMLElement>, tab: SheetTab) => {
    const host = stage.current?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (host) renderer.current?.pulse({ type: "touch", x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top, r: 14, tint: "chair" });
    openTab(tab);
  };

  /** the picture answers a touch: rings spread from the spot and the thing itself gives a little */
  const touch = (e: React.MouseEvent<HTMLElement>, x: number, y: number, r: number, tint: TintId) => {
    renderer.current?.pulse({ type: "touch", x, y, r, tint });
    e.currentTarget.animate(
      [{ transform: "translate(-50%, -50%) scale(1)" }, { transform: "translate(-50%, -50%) scale(0.9)" }, { transform: "translate(-50%, -50%) scale(1.07)" }, { transform: "translate(-50%, -50%) scale(1)" }],
      { duration: 420, easing: "ease-out" },
    );
  };

  const menuMember = menu?.kind === "member" ? state?.members.find((m) => m.id === menu.id) : undefined;
  const menuSpot = menu?.kind === "member" ? workers.find((w) => w.id === menu.id) ?? pasts.find((p) => p.id === menu.id) : undefined;
  const menuHouse = menu?.kind === "house" ? scene?.houses.find((h) => h.id === menu.id) : undefined;

  return (
    <div className={`vz ${narrow ? "narrow" : "wide"} ${logOpen ? "log-open" : "log-shut"} ${scene?.portrait ? "portrait" : ""}`}>
      <div className="vz-stage" ref={stage}>
        <canvas ref={canvas} className="vz-canvas" aria-hidden />

        {scene && (
          <div className="vz-scene" ref={sceneEl} style={{ fontSize: Math.max(9, scene.u * 0.15) }}>
            <button
              ref={chairEl}
              className={`vz-chair ${scene.chair.busy ? "busy" : ""}`}
              style={{ left: scene.chair.x, top: scene.chair.y, width: scene.chair.r * 2, height: scene.chair.r * 2 }}
              onClick={(e) => {
                touch(e, scene.chair.x, scene.chair.y, scene.chair.haloR, "chair");
                if (state) setMenu({ kind: "chair" });
              }}
              title="의장: 모델·추론 수준·멈춤·안건 종료"
            >
              <span className="vz-chair-role">의장</span>
              <span key={outgoing !== null ? "out" : `in${crowned}`} className={`vz-chair-model ${outgoing !== null ? "leaving" : crowned ? "arriving" : ""} ${(prettyModel(outgoing ?? state?.chair.model) ?? "").length > 10 ? "long" : ""}`}>
                {state ? prettyModel(outgoing ?? state.chair.model) ?? "Claude" : "—"}
              </span>
              {state?.chair.effort && <span className="vz-chair-effort">{state.chair.effort}</span>}
            </button>
            <div className={`vz-status ${ask ? "ask" : ""}`} style={{ left: scene.chair.x, top: scene.chair.y + scene.chair.haloR + scene.u * 0.3 }}>
              <span>{status}</span>
              {tasksAll > 0 && (
                <span className="vz-status-sub">
                  결정 {tasksDone} / {tasksAll}
                </span>
              )}
            </div>

            {scene.houses.map((h) => (
              <button
                key={h.id}
                className="vz-house"
                style={{ left: h.x, top: h.y, width: h.coreR * 2 + scene.u * 0.2, height: h.coreR * 2 + scene.u * 0.2 }}
                onClick={(e) => {
                  touch(e, h.x, h.y, h.ringR, h.id);
                  setMenu({ kind: "house", id: h.id });
                }}
                title={`${HOUSE_NAME[h.id]}: 모델 사다리 · 끝난 위원 · 사용량`}
                aria-label={HOUSE_NAME[h.id]}
              />
            ))}

            {pasts.map((p) => (
              <button
                key={p.id}
                className="vz-past-node"
                style={{ left: p.x, top: p.y, width: scene.pastR * 2 + 8, height: scene.pastR * 2 + 8 }}
                onClick={(e) => {
                  touch(e, p.x, p.y, scene.pastR + 3, p.house);
                  setMenu({ kind: "member", id: p.id });
                }}
                title={`${p.name} · ${p.kind === "merged" ? "머지됨" : p.kind === "done" ? "완료" : p.kind === "failed" ? "실패" : "중지"}\n${p.task}`}
                aria-label={`끝난 위원 ${p.name}: ${p.task}`}
              />
            ))}

            {workers.map((w) => {
              const place = labels.get(w.id)!;
              return (
                <div key={w.id} className="vz-member" style={{ "--c": css(TINT[w.house]) } as React.CSSProperties}>
                  <button
                    className="vz-worker"
                    style={{ left: w.x, top: w.y, width: scene.workerR * 2 + 16, height: scene.workerR * 2 + 16 }}
                    onClick={(e) => {
                      touch(e, w.x, w.y, scene.workerR + 4, w.house);
                      setMenu({ kind: "member", id: w.id });
                    }}
                    title={`${w.name} · ${MEMBER_STATUS_KO[w.status]}${w.effort ? ` · 추론 ${w.effort}` : ""} · 도구 호출 ${w.toolCalls}회\n${w.task}`}
                    aria-label={`${w.name}: ${w.task}`}
                  />
                  <div className={`vz-label ${place.side} ${place.compact ? "compact" : ""}`} style={{ left: place.left, top: place.top, transform: place.transform, maxWidth: place.width }}>
                    <b>
                      {w.name}
                      {w.effort && <i>{w.effort}</i>}
                    </b>
                    {w.task && <span className="vz-label-task">{w.task}</span>}
                    <span className="vz-label-prog">{progress(w, now)}</span>
                  </div>
                </div>
              );
            })}

            {/* what each one is saying, right where it is */}
            {chairAt && chairSays && (
              <button
                key={chairSays.key}
                className={`vz-bubble chair ${chairSays.ask ? "ask" : ""} ${chairSays.dots && !chairSays.text ? "thinking" : ""}`}
                style={{ left: chairAt.x, top: chairAt.y, maxWidth: chairAt.width, "--c": "var(--gold)" } as React.CSSProperties}
                onClick={toggleLog}
                title="대화 기록 열기"
              >
                {chairSays.text && <span className="vz-bubble-text">{chairSays.text}</span>}
                {chairSays.dots && <span className="vz-dots"><i /><i /><i /></span>}
              </button>
            )}
            {bubbles.map((b) => {
              const spot = bubbleSpot(scene, b.member, b.house, b.text, labels.get(b.member)?.above ?? false);
              if (!spot) return null;
              return (
                <div
                  key={b.id}
                  className={`vz-bubble ${b.kind} ${spot.below ? "below" : "above"} ${b.leaving ? "leaving" : ""}`}
                  style={{ left: spot.left, top: spot.top, maxWidth: bubbleWidth(scene), "--c": css(TINT[b.house]), "--tail": `${spot.tail}px`, "--life": `${b.life}s` } as React.CSSProperties}
                >
                  <span className="vz-bubble-text">
                    {b.kind === "tool" ? `⚙ ${b.text}${b.count > 1 ? ` ×${b.count}` : ""}` : b.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <header className="vz-top">
          <div className="vz-id">
            <div className="vz-brand">
              <span className="vz-mark">✦</span>
              <span className="vz-brand-name">GENCOUNCIL</span>
            </div>
            <div className="vz-nav">
              <ModeSwitch mode="vision" onChange={(m) => m === "work" && onWorkshop()} />
              <nav className="vz-dock" aria-label="위키와 설정">
                <button className={sheet && sheet.tab !== "settings" && sheet.tab !== "accounts" ? "on" : ""} onClick={(e) => dock(e, "wiki")} title="Gen Wiki · 공유 기억">
                  <i>❖</i>위키
                  {proposed > 0 && <em title="위키 등록을 기다리는 제안">{proposed}</em>}
                </button>
                <button className={sheet && (sheet.tab === "settings" || sheet.tab === "accounts") ? "on" : ""} onClick={(e) => dock(e, "settings")} title="설정 · 계정 · 남은 사용량">
                  <i>⚙</i>설정
                  {badAccounts > 0 && <em title="문제가 있는 계정">{badAccounts}</em>}
                </button>
              </nav>
            </div>
          </div>
          {(narrow || !logOpen) && <AgendaCard {...card} />}
        </header>

        {scene && (
          <aside className="vz-roster" aria-label="회사별 위원">
            {scene.houses.map((h) => {
              const slots = Math.min(8, Math.max(h.max, h.active));
              return (
                <div key={h.id} className="vz-roster-row" style={{ "--c": css(TINT[h.id]) } as React.CSSProperties}>
                  <span className="vz-roster-name">{HOUSE_NAME[h.id]}</span>
                  <span className="vz-pips">
                    {Array.from({ length: slots }, (_, i) => (
                      <i key={i} className={i < h.active ? "on" : ""} />
                    ))}
                  </span>
                  <span className="vz-roster-count">
                    {h.active}
                    {h.max ? ` / ${h.max}` : ""}
                  </span>
                </div>
              );
            })}
            <div className="vz-roster-foot">
              <span>
                과제 <b>{tasksDone}</b> / {tasksAll}
              </span>
              <span className={`vz-conn ${wsUp ? "up" : ""}`} title={wsUp ? "실시간 연결됨" : "연결 끊김"} />
            </div>
          </aside>
        )}

        <footer className="vz-bottom">
          {(narrow || !logOpen) && (
            <div className="vz-float" style={{ maxWidth: narrow ? undefined : Math.max(360, scene?.gap ?? 480) }}>
              {/* the question, when the chair has one, is the card the input shows with its answers */}
              {scene?.portrait && state && !ask && <ChairWords says={chairSays} onOpen={toggleLog} />}
              <Composer state={state} compact onSend={onSend} chair={chair} onLog={toggleLog} />
            </div>
          )}
          <ol className="vz-stages">
            {STAGES.map((st, i) => (
              <li key={st.id} className={stages.has(st.id) ? "on" : ""}>
                <span className="vz-stage-n">{i + 1}</span>
                <b>{st.title}</b>
                <span className="vz-stage-text">{st.text}</span>
              </li>
            ))}
          </ol>
        </footer>

        {scene && menu?.kind === "chair" && state && (
          <Popover x={scene.chair.x} y={scene.chair.y} r={scene.chair.haloR} tint={TINT.chair} onClose={() => setMenu(null)}>
            <ChairMenu
              state={state}
              project={project}
              firstTurn={firstTurn}
              chair={chair}
              onStop={() => {
                if (confirm("의장의 이번 작업을 멈출까요? (위원은 계속 작업합니다)")) void api.stopChair(state.key).catch(() => undefined);
              }}
              onClose={() => setMenu(null)}
              onWorkshop={onWorkshop}
            />
          </Popover>
        )}
        {scene && menuHouse && (
          <Popover x={menuHouse.x} y={menuHouse.y} r={menuHouse.ringR} tint={TINT[menuHouse.id]} onClose={() => setMenu(null)}>
            <HouseMenu house={menuHouse} ladder={ladders.find((l) => l.id === menuHouse.id)} state={state} project={project} usage={usage} actions={members} projects={projects} onClose={() => setMenu(null)} />
          </Popover>
        )}
        {scene && menuSpot && menuMember && (
          <Popover x={menuSpot.x} y={menuSpot.y} r={scene.workerR + 6} tint={TINT[menuSpot.house]} onClose={() => setMenu(null)}>
            <WorkerMenu member={menuMember} task={menuSpot.task} actions={members} onClose={() => setMenu(null)} />
          </Popover>
        )}
      </div>

      {logOpen && <Console {...card} chat={chat} reports={reports} firstTurn={firstTurn} narrow={narrow} onClose={toggleLog} onSend={onSend} chair={chair} />}

      {sheet && (
        <VisionSheet
          at={sheet}
          onAt={setSheet}
          onClose={() => setSheet(null)}
          overview={overview}
          selected={selected}
          usage={usage}
          wsUp={wsUp}
          notify={notify}
          projects={baseProjects}
          onSelect={onSelect}
          onSettingsSaved={onSettingsSaved}
          onWorkshop={onWorkshop}
        />
      )}
    </div>
  );
}
