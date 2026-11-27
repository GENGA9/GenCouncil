import { ReloadButton } from "./ReloadButton";
import { t, useT } from "../i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { familyOf, memberName, prettyModel } from "../model";
import type { ChatItem, Member, ModelsInfo, Overview, RuntimeState, UsageSnapshot } from "../types";
import type { ChairActions, MemberActions, ProjectActions, SendFn } from "../vision/actions";
import { AgendaCard, Composer, Console, type Report } from "../vision/Console";
import { ChairMenu, MEMBER_STATUS_KO, Popover, WorkerMenu } from "../vision/Menus";
import type { VisionEvent } from "../vision/renderer";
import { VisionSheet, type SheetAt, type SheetTab } from "../vision/Sheet";
import { UsageMini } from "../vision/UsageMini";
import { isActive, type TintId, type Rgb } from "../vision/scene";
import { artUrl, castOf, chairCast, feetOf, pick, STANDING, topOf, type Character } from "../avatar/cast";
import { AvatarMenu, chairFigure, useAvatarPrefs, useVoice, type Seat } from "../avatar/settings";
import { ChestArt, type GazeBus } from "../avatar/chest";
import { DanceArt, danceVideo, type Dance } from "../avatar/dance";
import CHIBI_META from "../avatar/chibi.json";
import { dialogue, eventLine, monologue, reactionLine, type Dialogue, type Spoken } from "../avatar/lines";
import { press } from "../avatar/press";
import { useFloatMirror } from "../avatar/floatLink";
import { DESK_FRONT, DESK_PANEL_BOTTOM, DESK_Y, DeskFront, FLOOR_BACK, FLOOR_FRONT, roomArt, seasonOf, Study, timeOf, WIDE, WORLD_H, WORLD_W } from "../avatar/Room";
import { ModeSwitch, type Mode } from "./ModeSwitch";
import { GridSpinner } from "./GridSpinner";
import "../vision/vision.css";
import "../vision/sheet.css";
import "../avatar/avatar.css";

interface Props {
  state: RuntimeState | null;
  overview: Overview | null;
  selected: string;
  chat: ChatItem[];
  wsUp: boolean;
  loading: boolean;
  firstTurn: boolean;
  usage?: UsageSnapshot | null;
  models?: ModelsInfo | null;
  onSelect: (key: string) => void;
  onWorkshop: () => void;
  onMode: (mode: Mode) => void;
  notify: (msg: string) => void;
  onSettingsSaved: (msg: string) => void;
  subscribe: (fn: (e: VisionEvent) => void) => () => void;
  onSend: SendFn;
  chair: ChairActions;
  members: MemberActions;
  projects: ProjectActions;
}

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
// open by default on a wide screen (closing it is remembered); a phone starts with it shut
const LOG_KEY = "gc.vision.log2";
const bareModel = (m: Pick<Member, "id" | "provider" | "model" | "label">) => memberName({ ...m, model: m.model?.replace(/-(low|medium|high|xhigh|max)$/i, "") });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** the bust in world units: its top at BUST_Y and its foot just under the desk, so it shows down to the waist */
const BUST_Y = 96;
const BUST_H = DESK_Y + 36 - BUST_Y;
/** where a character's bust stands: as wide as its art (some are widened to draw the arms whole), centred */
function bustOf(cast: Character) {
  const [cw, ch] = cast.canvas;
  const k = BUST_H / ch;
  const w = cw * k;
  return { x: WORLD_W / 2 - w / 2, y: BUST_Y, w, h: BUST_H, k };
}
/** a member on the desk: the chibi sprite's square frame in world units (Agentg's chibi-anim-v1) */
const CHIBI = 230;
/** picked: dangling while held up (by the top of the head); dropped: the fall, the landing, getting up */
type Act = "walk" | "run" | "write" | "happy" | "sulk" | "sleep" | "fall" | "getup" | "picked" | "dropped";
const ACTS = CHIBI_META.actions as Record<Act, { frames: number; durations: number[]; loop: boolean; flip: boolean; floor: number; root: number; grab?: number[] }>;
/** a character's own frame count and timing where it differs (dropped: 9 frames for some, 8 for others) */
const RIG_ACTS = (CHIBI_META as { rigs?: Record<string, Partial<Record<Act, { frames: number; durations: number[] }>>> }).rigs ?? {};
const timingOf = (rig: string, a: Act) => RIG_ACTS[rig]?.[a] ?? ACTS[a];
/** where the feet are in the frame (0..1 down) and the frame's centre */
const FLOOR = ACTS.walk.floor / CHIBI_META.size;
/** where a held member is held: the top of its head (0..1 down the frame) */
const GRAB = (ACTS.picked?.grab?.[1] ?? 18) / CHIBI_META.size;
/** how long a non-looping action runs */
const actLength = (a: Act, rig = "") => timingOf(rig, a).durations.reduce((x, y) => x + y, 0);
/** which frame an action shows after `ms` */
function frameAt(a: Act, ms: number, rig = ""): number {
  const m = timingOf(rig, a);
  const total = actLength(a, rig);
  let t = ACTS[a].loop ? ((ms % total) + total) % total : Math.min(ms, total - 1);
  for (let i = 0; i < m.frames; i++) {
    t -= m.durations[i];
    if (t < 0) return i;
  }
  return m.frames - 1;
}
const sheetUrl = (rig: string, a: Act) => `/avatar/chibi/${rig}/${a}.webp?v=3`;
/** on a tall screen the chair's words and the input sit under the picture */
const UNDER = 196;

/**
 * A bubble no taller than `limit` (its content box): what does not fit scrolls inside it (drag or wheel),
 * starting from the top for each new message.
 */
function fitBubble(el: HTMLElement, limit: number) {
  const cs = getComputedStyle(el);
  // a border-box bubble's max-height counts its padding and border too
  const frame = cs.boxSizing === "border-box" ? parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.paddingBottom) : 0;
  el.style.maxHeight = `${limit + frame}px`;
}

/** a steady number for a string (a member's own spinner phase) */
const hashOf = (t: string) => [...t].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0, 2166136261);

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

function plain(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** how the stage maps the study's world units onto the screen */
interface View {
  s: number;
  ox: number;
  oy: number;
  w: number;
  h: number;
  portrait: boolean;
}

function viewOf(w: number, h: number): View {
  const portrait = h > w * 1.05;
  // A wide screen is covered by the painting (not zoomed in much past its height; the blurred room
  // fills what is left at the sides). A tall one shows the chair and the middle of the desk, and keeps
  // room under the desk for the chair's words and the input.
  if (portrait) {
    const s = Math.min((h - UNDER) / DESK_FRONT, Math.max(w / (WORLD_W * 0.56), ((h - UNDER) / WORLD_H) * 0.8));
    // the chair in the middle of the screen
    return { s, ox: (w - WORLD_W * s) / 2, oy: h - UNDER - DESK_FRONT * s - 6, w, h, portrait };
  }
  const s = Math.min(Math.max(w / WORLD_W, h / WORLD_H), (h / WORLD_H) * 1.2);
  // keep the top of the room (the name over the chair) on screen; the desk front gives way first
  return { s, ox: (w - WORLD_W * s) / 2, oy: Math.max(h - WORLD_H * s, -16 * s), w, h, portrait };
}

/** the camera pulled back to show the chair standing in front of the desk, head to toe */
function zoomedOut(v: View, inputTop?: number, top = 110): View {
  const cx = WORLD_W / 2;
  // what is above her (a dance's captions, raised arms) stays below the header's buttons
  const head = 64;
  if (v.portrait) {
    // a tall screen is filled by her, her feet just above the input box
    const feet = (inputTop ?? v.h - 90) - 10;
    const s = Math.min((feet - head) / (FLOOR_FRONT - top), v.w / 760);
    return { ...v, s, ox: v.w / 2 - cx * s, oy: feet - FLOOR_FRONT * s };
  }
  // a wide screen sees the room around her, head to toe
  const bottom = FLOOR_FRONT + 30;
  const s = Math.min((v.h - head) / (bottom - top), v.w / Math.min(WIDE.w, 2400));
  return { ...v, s, ox: v.w / 2 - cx * s, oy: head + (v.h - head) / 2 - ((top + bottom) / 2) * s };
}

// ---------------------------------------------------------------- the chair

type Eyes = string;
type Mouth = string;

/**
 * A touch reaction (Agentg's AvatarDirector presets): a face held for a moment and a move of the whole
 * body (a hop, a shake, a flinch back), the chest swinging with it. Only the faces a rig has are used.
 */
export type Preset = "surprised" | "happy" | "embarrassed";
const PRESETS: Record<Preset, { eyes: string; set: "normal" | "smile"; rest: string; skin: "normal" | "blush" }> = {
  surprised: { eyes: "wide", set: "normal", rest: "o", skin: "normal" },
  happy: { eyes: "smile", set: "smile", rest: "smile_closed", skin: "normal" },
  embarrassed: { eyes: "smile", set: "smile", rest: "smile_closed", skin: "blush" },
};
export interface Mood {
  key: number;
  preset: Preset;
  motion: "hop" | "shake" | "flinch";
  ms: number;
}
/** the reactions a character's rig can show */
export function presetsOf(c: Character): Preset[] {
  const st = c.expr?.states;
  if (!st) return [];
  return (Object.keys(PRESETS) as Preset[]).filter((p) => st.eyes.includes(PRESETS[p].eyes) && (PRESETS[p].skin === "normal" || st.skin.includes(PRESETS[p].skin)) && (PRESETS[p].set === "normal" || Boolean(c.expr?.sets[PRESETS[p].set]?.length)));
}

/** the chair's bust: blinks now and then, moves its mouth while its words come in */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Handlers = Partial<React.DOMAttributes<HTMLButtonElement>>;
export function Bust({ cast, talking, thinking, poked, on, box, extra, style, walking = false, gazeBus, blinkKey = 0, body, mood }: { cast: Character; talking: boolean; thinking: boolean; poked: number; on: Handlers; box?: Box; extra?: string; style?: React.CSSProperties; walking?: boolean; gazeBus?: GazeBus; blinkKey?: number; body?: { hip: number }; mood?: Mood | null }) {
  const t = useT();
  const [eyes, setEyes] = useState<Eyes>("open");
  // a quick blink as the eyes move a long way (people often blink on a big glance)
  useEffect(() => {
    if (!blinkKey || reduced()) return;
    setEyes("half");
    const a = window.setTimeout(() => setEyes("closed"), 45);
    const b = window.setTimeout(() => setEyes("half"), 130);
    const c = window.setTimeout(() => setEyes("open"), 185);
    return () => [a, b, c].forEach(clearTimeout);
  }, [blinkKey]);
  // touched: the eyes close in a smile for a moment (a rig with expressions shows its reaction instead)
  useEffect(() => {
    if (!poked || cast.expr) return;
    setEyes("closed");
    const t = window.setTimeout(() => setEyes("open"), 520);
    return () => clearTimeout(t);
  }, [poked]);
  const [mouth, setMouth] = useState<Mouth>("rest");
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [cast.rig]);

  // blinking: half, closed, half, every few seconds (a double blink now and then)
  useEffect(() => {
    if (reduced()) return;
    let alive = true;
    const timers: number[] = [];
    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(() => alive && fn(), ms));
    const blink = () => {
      setEyes("half");
      later(55, () => setEyes("closed"));
      later(150, () => setEyes("half"));
      later(210, () => setEyes("open"));
    };
    const next = () =>
      later(2200 + Math.random() * 3800, () => {
        blink();
        if (Math.random() < 0.18) later(330, blink);
        next();
      });
    next();
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, []);

  // thinking: the eyes go half-shut for a moment now and then
  useEffect(() => {
    if (!thinking || reduced()) return;
    const t = window.setInterval(() => {
      setEyes("half");
      window.setTimeout(() => setEyes("open"), 900);
    }, 4200);
    return () => clearInterval(t);
  }, [thinking]);

  // talking: the mouth opens and closes in an uneven rhythm
  useEffect(() => {
    if (!talking || reduced()) {
      setMouth("rest");
      return;
    }
    const steps: Mouth[] = ["open_m", "open_l", "closed", "open_m", "rest", "open_l", "open_m", "closed"];
    let i = 0;
    const t = window.setInterval(() => {
      i = (i + 1 + (Math.random() < 0.3 ? 1 : 0)) % steps.length;
      setMouth(steps[i]);
    }, 105);
    return () => clearInterval(t);
  }, [talking]);

  const [cw, ch] = cast.canvas;
  const bust = box ?? bustOf(cast);
  // a reaction holds its face: its eyes (no blinking), its mouth at rest or its smile set while talking
  const face = mood ? PRESETS[mood.preset] : null;
  const states = cast.expr?.states;
  const eyesShown = face ? face.eyes : eyes;
  const mouthShown = !face
    ? mouth
    : face.set === "smile"
      ? talking && (mouth === "open_m" || mouth === "open_l") ? "smile_open_l" : "smile_closed"
      : talking
        ? mouth
        : states?.mouth.includes(face.rest)
          ? face.rest
          : "closed";
  const eyeStates = states ? states.eyes.filter((e) => e !== "open") : ["half", "closed"];
  const mouthStates = states ? states.mouth : ["open_m", "open_l", "closed"];
  const blush = Boolean(states?.skin.includes("blush"));
  const patch = (box: [number, number, number, number]): React.CSSProperties => ({ left: `${(box[0] / cw) * 100}%`, top: `${(box[1] / ch) * 100}%`, width: `${(box[2] / cw) * 100}%`, height: `${(box[3] / ch) * 100}%` });
  return (
    <button className={`av-bust ${talking ? "talking" : ""} ${broken ? "broken" : ""} ${extra ?? ""}`} style={{ left: bust.x, top: bust.y, width: bust.w, height: bust.h, "--c": css(cast.tint), ...style } as React.CSSProperties} {...on} title={`${t("의장")} · ${cast.name} — ${t("누르기: 반응 · 길게 누르기/오른쪽 클릭: 메뉴")}`}>
      {broken ? (
        <span className="av-bust-fallback" />
      ) : (
        <>
          {/* the chest swings on a touch and with each step (Agentg's physics) */}
          <span key={mood?.key ?? 0} className={`av-bust-body ${mood ? `mood-${mood.motion}` : ""}`} style={mood ? ({ "--mood-ms": `${mood.ms}ms` } as React.CSSProperties) : undefined}>
          <ChestArt className="av-bust-base" src={artUrl(cast.rig, "base")} cw={cw} ch={ch} regions={cast.chest} irises={cast.irises} gazeBus={gazeBus} body={body} kick={poked} walking={walking} talking={talking} onError={() => setBroken(true)} />
          {/* every patch is always there and only shown when used, so switching never waits for a download */}
          {blush && cast.expr && (
            <img className="av-patch av-blush" src={artUrl(cast.rig, "skin-blush")} alt="" draggable={false} style={{ ...patch(cast.expr.regions.skin as [number, number, number, number]), opacity: face?.skin === "blush" ? 1 : 0 }} />
          )}
          {eyeStates.map((e) => (
            <img key={e} className="av-patch" src={artUrl(cast.rig, `eyes-${e}`)} alt="" draggable={false} style={{ ...patch(cast.eyes), opacity: eyesShown === e ? 1 : 0 }} />
          ))}
          {mouthStates.map((m) => (
            <img key={m} className="av-patch" src={artUrl(cast.rig, `mouth-${m}`)} alt="" draggable={false} style={{ ...patch(cast.mouth), opacity: mouthShown === m ? 1 : 0 }} />
          ))}
          </span>
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- standing up and walking out

/** where the standing figure is: which side of the desk, its centre, its feet and height (world units) */
interface Figure {
  layer: "back" | "front";
  cx: number;
  feet: number;
  h: number;
  /** how long the move to this pose takes */
  ms: number;
  walking: boolean;
  /** fading in (just stood up) or out (sitting back down) */
  fade?: "in" | "out";
}

/** the full-body art's box for a pose: 832 × 1664, its feet (the rig's anchor) at (cx, feet) */
function figureBox(f: Figure, c: Character): Box {
  const [ax, ay] = feetOf(c);
  const k = f.h / 1664;
  return { x: f.cx - ax * k, y: f.feet - ay * k, w: 832 * k, h: f.h };
}

/** the chair on its feet: the full-body rig, bobbing while it walks */
function Standing({ cast, figure, talking, thinking, shift, poked = 0, on, gazeBus, blinkKey, mood }: { cast: Character; figure: Figure; talking: boolean; thinking: boolean; shift: [number, number]; poked?: number; on: Handlers; gazeBus?: GazeBus; blinkKey?: number; mood?: Mood | null }) {
  // laid out once at a fixed size with its feet at (0, 0), and moved and sized by transform alone:
  // the GPU composites it, nothing is laid out again while it walks (Safari stutters otherwise)
  const W0 = (STAND_H * 832) / 1664;
  const [ax, ay] = feetOf(cast);
  const feet = ay / 1664;
  const across = ax / 832;
  // the hips: a little below halfway from the top of the head to the feet
  const hip = useMemo(() => ({ hip: topOf(cast) + (ay - topOf(cast)) * 0.48 }), [cast, ay]);
  const k = figure.h / STAND_H;
  const ease = figure.walking ? "linear" : "ease-in-out";
  return (
    <Bust
      cast={cast}
      talking={talking && !figure.walking}
      thinking={thinking}
      poked={poked}
      gazeBus={gazeBus}
      blinkKey={blinkKey}
      mood={figure.walking ? null : mood}
      walking={figure.walking}
      body={hip}
      box={{ x: -W0 * across, y: -STAND_H * feet, w: W0, h: STAND_H }}
      extra={`av-standing ${figure.walking ? "walking" : ""} ${figure.fade ?? ""}`}
      style={{
        transformOrigin: `${across * 100}% ${feet * 100}%`,
        transform: `translate(${figure.cx + shift[0]}px, ${figure.feet + shift[1]}px) scale(${k})`,
        transition: `transform ${figure.ms}ms ${ease}, opacity 260ms`,
        willChange: "transform",
      }}
      on={on}
    />
  );
}

/** the size the standing figure is laid out at; its real size is a scale of it */
const STAND_H = 1270;
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
/** walking pace, world units a second */
const PACE = 620;
/** the figure's height standing behind the desk and on the rug in front of it */
const H_BACK = 1170;
const H_FRONT = 1270;

/**
 * The chair stands up, walks behind the desk to the edge of the picture, comes back round in front of
 * it to the middle, and the camera pulls back to show it head to toe; then its menu opens. When the
 * menu closes it goes back the same way and sits down.
 */
function useStroll(full: Character | undefined, seatedCast: Character, bustK: number, eyes: { x: number; y: number }, viewRef: React.MutableRefObject<View | null>, menuOpen: boolean, setMenuOpen: (open: boolean) => void, onDanceFailed: (why: string) => void) {
  /** dancing (or on her way to): closing the menu does not send her back */
  const hold = useRef(false);
  const [dancing, setDancing] = useState<{ dance: Dance; video: HTMLVideoElement } | null>(null);
  const strollRef = useRef<typeof stroll>(null);
  const [stroll, setStroll] = useState<null | "going" | "out" | "returning">(null);
  const [figure, setFigure] = useState<Figure | null>(null);
  const [bustLift, setBustLift] = useState({ lift: 0, hidden: false, ms: 0 });
  const [zoom, setZoom] = useState(false);
  const run = useRef(0);
  // the size at which the standing art's eyes match the seated bust's, so the one turns into the other
  const seat = (): Figure | null => {
    if (!full) return null;
    const k = (seatedCast.eyes[2] * bustK) / full.eyes[2];
    const [ax, ay] = feetOf(full);
    const eyeX = full.eyes[0] + full.eyes[2] / 2;
    const eyeY = full.eyes[1] + full.eyes[3] / 2;
    return { layer: "back", cx: eyes.x - (eyeX - ax) * k, feet: eyes.y - 36 + (ay - eyeY) * k, h: 1664 * k, ms: 0, walking: false };
  };
  /** just past the left edge of the picture as it is shown now */
  const offLeft = (h: number) => {
    const v = viewRef.current;
    const w = (h * 832) / 1664;
    return v ? Math.min(-v.ox / v.s - w / 2 - 40, WIDE.x + w / 2) : -400;
  };

  const walkOut = useCallback(async () => {
    const start = seat();
    if (!start) return;
    const id = ++run.current;
    const live = () => run.current === id;
    const still = reduced();
    setStroll("going");
    // up from the chair
    setBustLift({ lift: -36, hidden: false, ms: 320 });
    await wait(still ? 0 : 320);
    if (!live()) return;
    // the seated bust turns into the standing figure, which steps back a little behind the desk
    setFigure({ ...start, fade: "in" });
    setBustLift({ lift: -36, hidden: true, ms: 0 });
    await frame();
    setFigure({ ...start, feet: FLOOR_BACK, h: H_BACK, ms: still ? 0 : 520 });
    await wait(still ? 0 : 560);
    if (!live()) return;
    // behind the desk to the edge of the picture
    const off = offLeft(H_FRONT);
    const d1 = still ? 0 : (Math.abs(start.cx - off) / PACE) * 1000;
    setFigure({ layer: "back", cx: off, feet: FLOOR_BACK, h: H_BACK, ms: d1, walking: true });
    await wait(d1);
    if (!live()) return;
    // round the end of the desk and back in front of it, to the middle
    setFigure({ layer: "front", cx: off, feet: FLOOR_FRONT, h: H_FRONT, ms: 0, walking: true });
    await frame();
    const d2 = still ? 0 : (Math.abs(WORLD_W / 2 - off) / PACE) * 1000;
    setFigure({ layer: "front", cx: WORLD_W / 2, feet: FLOOR_FRONT, h: H_FRONT, ms: d2, walking: true });
    await wait(d2);
    if (!live()) return;
    setFigure({ layer: "front", cx: WORLD_W / 2, feet: FLOOR_FRONT, h: H_FRONT, ms: 0, walking: false });
    // the camera pulls back: head to toe
    setZoom(true);
    await wait(still ? 0 : 950);
    if (!live()) return;
    setStroll("out");
    // on a phone the menu is a sheet over the picture: she stays in view until she is tapped
    return true;
  }, [full, seatedCast, bustK, eyes.x, eyes.y]);

  const walkBack = useCallback(async () => {
    const start = seat();
    if (!start) return;
    const id = ++run.current;
    const live = () => run.current === id;
    const still = reduced();
    setStroll("returning");
    setZoom(false);
    await wait(still ? 0 : 750);
    if (!live()) return;
    const off = offLeft(H_FRONT);
    const d1 = still ? 0 : (Math.abs(WORLD_W / 2 - off) / PACE) * 1000;
    setFigure({ layer: "front", cx: off, feet: FLOOR_FRONT, h: H_FRONT, ms: d1, walking: true });
    await wait(d1);
    if (!live()) return;
    setFigure({ layer: "back", cx: off, feet: FLOOR_BACK, h: H_BACK, ms: 0, walking: true });
    await frame();
    const d2 = still ? 0 : (Math.abs(start.cx - off) / PACE) * 1000;
    setFigure({ layer: "back", cx: start.cx, feet: FLOOR_BACK, h: H_BACK, ms: d2, walking: true });
    await wait(d2);
    if (!live()) return;
    // sits back down: the figure grows back into the bust's size and the bust takes over
    setFigure({ ...start, ms: still ? 0 : 420 });
    await wait(still ? 0 : 440);
    if (!live()) return;
    setBustLift({ lift: -36, hidden: false, ms: 0 });
    setFigure({ ...start, fade: "out" });
    await wait(still ? 0 : 260);
    if (!live()) return;
    setFigure(null);
    setBustLift({ lift: 0, hidden: false, ms: 320 });
    setStroll(null);
  }, [full, seatedCast, bustK, eyes.x, eyes.y]);

  strollRef.current = stroll;
  void menuOpen;

  /** out in front of the desk (walking out first if need be), then the dance; back to the seat after */
  const dance = useCallback(
    async (d: Dance, video: HTMLVideoElement) => {
      hold.current = true;
      setMenuOpen(false);
      if (strollRef.current !== "out" && !(await walkOut())) {
        hold.current = false;
        return;
      }
      setDancing({ dance: d, video });
    },
    [walkOut, setMenuOpen],
  );
  /** the dance is over (back to the seat), or its video would not play (she stays out and says so) */
  const endDance = useCallback(
    (failed?: string) => {
      setDancing(null);
      hold.current = false;
      if (failed) onDanceFailed(failed);
      else void walkBack();
    },
    [walkBack, onDanceFailed],
  );
  // another model took the chair: sit down at once
  useEffect(() => {
    run.current++;
    setFigure(null);
    setZoom(false);
    setStroll(null);
    setBustLift({ lift: 0, hidden: false, ms: 0 });
  }, [full]);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  return { stroll, figure, bustLift, zoom, walkOut, walkBack, dancing, dance, endDance };
}

// ---------------------------------------------------------------- the members on the desk

interface Walker {
  id: string;
  x: number;
  /** how far its bubble is stepped up to clear the others' (world px, eased toward the target) */
  by?: number;
  /** the bubble element that step belongs to: a new bubble takes its place at once, without the glide */
  byEl?: HTMLElement;
  /** how far back on the desk it stands: 0 at the edge, up to 1 at the back */
  depth: number;
  target: number;
  speed: number;
  face: 1 | -1;
  /** walk, stop to work, a nap while waiting, a trip (fall, lie, get up), or a hop on the spot */
  mode: "walk" | "work" | "drop" | "cheer" | "slump" | "nap" | "trip" | "held" | "dropped";
  /** held up: where the pointer holds it (world units); dropped: when it landed */
  grab?: [number, number];
  landed?: number;
  /** where in its working loop it is, so the members never move in step (ms) */
  offset: number;
  /** the animation shown, since when, and what is on the page (so styles change only when needed) */
  act: Act;
  actAt: number;
  shownKey: string;
  until: number;
  phase: number;
  /** the height of the hop or drop under way */
  lift: number;
  vy: number;
  /** on its way to report (a finished or failed task) before it cheers or slumps there; set once handled */
  report?: "cheer" | "slump";
  reported?: boolean;
}

interface Shown {
  member: Member;
  cast: Character;
  name: string;
  /** finished: still on the desk for a moment to say so */
  leaving?: "done" | "fail";
}

interface Bubble {
  id: number;
  text: string;
  kind: "say" | "tool" | "done" | "fail" | "idle" | "start" | "talk";
  count: number;
  until: number;
}

let seq = 1;

/** what a member is at, in a few words */
function progress(m: Member, now: number): string {
  if (m.status === "starting") return t("시작하는 중");
  if (m.status === "waiting") return t("전달 대기");
  const min = Math.round((now - Date.parse(m.startedAt)) / 60000);
  const time = !Number.isFinite(min) || min < 0 ? "" : min < 1 ? t("방금 시작") : min >= 60 ? t("{h}시간 {m}분째", { h: Math.floor(min / 60), m: min % 60 }) : t("{m}분째", { m: min });
  return [t("도구 {n}회", { n: m.toolCalls }), time].filter(Boolean).join(" · ");
}

export function AvatarView({ state, overview, selected, chat, wsUp, loading, firstTurn, usage, models: given, onSelect, onWorkshop, onMode, notify, onSettingsSaved, subscribe, onSend, chair, members, projects: baseProjects }: Props) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [menu, setMenu] = useState<null | { kind: "chair" } | { kind: "member"; id: string }>(null);
  const [sheet, setSheet] = useState<SheetAt | null>(null);
  // the picture answers a touch, as in the visualization: rings spread from the spot and the thing gives a little
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; c: string; big: boolean }>>([]);
  const [poked, setPoked] = useState(0);
  // a touch reaction: a face and a move for a moment (presetsOf the chair's rig)
  const [mood, setMood] = useState<Mood | null>(null);
  const moodTimer = useRef(0);
  const [flare, setFlare] = useState(0);
  const ripple = useCallback((e: { clientX: number; clientY: number }, c: string, big: boolean) => {
    const host = stage.current?.getBoundingClientRect();
    if (!host) return;
    const id = seq++;
    setRipples((cur) => [...cur, { id, x: e.clientX - host.left, y: e.clientY - host.top, c, big }]);
    window.setTimeout(() => setRipples((cur) => cur.filter((r) => r.id !== id)), 900);
  }, []);
  /** the bust gives a little where it is touched (its own transform origin: the bottom middle) */
  const give = (el: Element) =>
    !reduced() &&
    el.animate([{ transform: "scale(1)" }, { transform: "scale(0.96, 0.94)" }, { transform: "scale(1.03, 1.04)" }, { transform: "scale(1)" }], { duration: 460, easing: "ease-out" });
  const [reports, setReports] = useState<Report[]>([]);
  const [bubbles, setBubbles] = useState<Map<string, Bubble>>(new Map());
  const narrow = useMedia("(max-width: 760px)");
  const [logOpen, setLogOpen] = useState(() => {
    try {
      const v = localStorage.getItem(LOG_KEY);
      return v === null ? !window.matchMedia("(max-width: 760px)").matches : v === "1";
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
  void given;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const clock = new Date(now);
  const season = seasonOf(clock.getMonth());
  const daytime = timeOf(clock.getHours());
  const [noArt, setNoArt] = useState(false);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const view = useMemo(() => (size.w > 0 && size.h > 0 ? viewOf(size.w, size.h) : null), [size]);
  const viewRef = useRef(view);
  viewRef.current = view;

  // ---- who is on the desk: the working members, and for a few seconds those who just finished
  const [leaving, setLeaving] = useState<Map<string, "done" | "fail">>(new Map());
  const wasActive = useRef(new Set<string>());
  useEffect(() => {
    const act = new Set((state?.members ?? []).filter(isActive).map((m) => m.id));
    const gone: Array<[string, "done" | "fail"]> = [];
    for (const id of wasActive.current) {
      if (act.has(id)) continue;
      const m = state?.members.find((x) => x.id === id);
      if (m) gone.push([id, m.status === "done" ? "done" : "fail"]);
    }
    wasActive.current = act;
    if (!gone.length) return;
    setLeaving((cur) => new Map([...cur, ...gone]));
    const t = window.setTimeout(() => setLeaving((cur) => new Map([...cur].filter(([id]) => !gone.some(([g]) => g === id)))), 5200);
    return () => clearTimeout(t);
  }, [state?.members]);
  useEffect(() => {
    wasActive.current = new Set();
    setLeaving(new Map());
    setBubbles(new Map());
    setReports([]);
    setMenu(null);
  }, [selected]);

  const shown: Shown[] = useMemo(() => {
    const list = (state?.members ?? []).filter((m) => isActive(m) || leaving.has(m.id));
    return list.map((m) => ({ member: m, cast: castOf(m), name: bareModel(m), leaving: isActive(m) ? undefined : leaving.get(m.id) }));
  }, [state?.members, leaving]);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // ---- the walkers: a little physics per member, moved straight on the page (no re-render per frame)
  const walkers = useRef(new Map<string, Walker>());
  const els = useRef(new Map<string, HTMLDivElement>());
  const span = useCallback((): [number, number] => {
    const v = viewRef.current;
    if (!v) return [200, WORLD_W - 200];
    const lo = (-v.ox + 24) / v.s + CHIBI / 2;
    const hi = (v.w - v.ox - 24) / v.s - CHIBI / 2;
    return [clamp(lo, 110, 700), clamp(hi, 830, WORLD_W - 110)];
  }, []);
  const spawn = useCallback(
    (id: string, drop: boolean): Walker => {
      const [lo, hi] = span();
      const taken = [...walkers.current.values()].map((o) => o.x);
      let x = lo + Math.random() * (hi - lo);
      for (let k = 0; k < 8 && taken.some((o) => Math.abs(o - x) < CHIBI * 1.1); k++) x = lo + Math.random() * (hi - lo);
      // sitting still (motion off) they appear at their place, not dropping in
      if (prefsRef.current.memberMotion === "off") drop = false;
      return { id, x, depth: Math.random(), target: x, speed: 0, face: Math.random() < 0.5 ? 1 : -1, mode: drop ? "drop" : "work", until: performance.now() + 20000 + Math.random() * 10000, phase: Math.random() * 10, offset: Math.random() * 6000, lift: drop ? 520 : 0, vy: 0, act: drop ? "happy" : "write", actAt: performance.now(), shownKey: "" };
    },
    [span],
  );
  useEffect(() => {
    const ids = new Set(shown.map((s) => s.member.id));
    for (const s of shown) {
      const w = walkers.current.get(s.member.id);
      if (w && (w.mode === "held" || w.mode === "dropped")) continue;
      if (!w) walkers.current.set(s.member.id, spawn(s.member.id, s.member.status === "starting" || Date.now() - Date.parse(s.member.startedAt) < 15000));
      else if (!s.leaving && s.member.status === "waiting" && (w.mode === "work" || w.mode === "walk") && prefsRef.current.memberMotion !== "off") w.mode = "nap";
      else if (!s.leaving && s.member.status !== "waiting" && w.mode === "nap") {
        w.mode = "work";
        w.until = performance.now() + 800;
      } else if (s.leaving && !w.reported) {
        // done or failed: off, it just fades where it sits; otherwise it walks over toward the chair to
        // report, then cheers or slumps there
        w.reported = true;
        const how = s.leaving === "done" ? "cheer" : "slump";
        if (prefsRef.current.memberMotion === "off") {
          w.mode = "work";
        } else {
          const side = w.x < WORLD_W / 2 ? -1 : 1;
          const [lo, hi] = span();
          w.target = clamp(WORLD_W / 2 + side * (150 + Math.random() * 90), lo, hi);
          w.speed = 320;
          w.face = w.target > w.x ? 1 : -1;
          w.report = how;
          w.mode = Math.abs(w.target - w.x) > 30 ? "walk" : how;
          w.until = performance.now() + 6000;
        }
      }
    }
    for (const id of walkers.current.keys()) if (!ids.has(id)) walkers.current.delete(id);
  }, [shown, spawn]);

  /** a member's rig (its sprite's), for the frame counts that differ */
  const rigOf = (id: string) => ((els.current.get(id)?.firstElementChild as HTMLElement | null)?.dataset.rig ?? "");
  const onLandRef = useRef<(id: string) => void>(() => undefined);
  useEffect(() => {
    let raf = 0;
    /*
     * Members' bubbles that would overlap step up out of each other's way: the one standing furthest
     * forward (lowest on screen) keeps its place, and each next one rises just above any it would cover.
     * Measured in world px (the bubbles' layout size inside the scaled layer); the step eases in.
     */
    const unstackBubbles = (dt: number) => {
      const GAP = 6;
      const items: Array<{ w: Walker; el: HTMLElement; b: HTMLElement; left: number; right: number; base: number; h: number; lift: number }> = [];
      for (const w of walkers.current.values()) {
        const el = els.current.get(w.id);
        const b = el?.querySelector<HTMLElement>(".av-bubble");
        if (!el || !b) {
          w.by = 0;
          continue;
        }
        const feet = DESK_FRONT - 10 - w.depth * (DESK_FRONT - DESK_Y - 30) - w.lift;
        const bx = parseFloat(el.style.getPropertyValue("--bx")) || 0;
        const cx = w.x + bx;
        const width = b.offsetWidth;
        // offsetTop is measured from the member's anchor (its feet): this is the bubble's bottom, unstepped
        items.push({ w, el, b, left: cx - width / 2, right: cx + width / 2, base: feet + b.offsetTop + b.offsetHeight, h: b.offsetHeight, lift: 0 });
      }
      items.sort((a, b) => b.base - a.base);
      const placed: typeof items = [];
      for (const it of items) {
        for (let pass = 0; pass < 8; pass++) {
          let moved = false;
          for (const p of placed) {
            if (it.left >= p.right + GAP || it.right <= p.left - GAP) continue;
            const bottom = it.base - it.lift;
            const top = bottom - it.h;
            const pTop = p.base - p.lift - p.h;
            const pBottom = p.base - p.lift;
            if (bottom <= pTop - GAP || top >= pBottom + GAP) continue;
            it.lift = it.base - (pTop - GAP);
            moved = true;
          }
          if (!moved) break;
        }
        placed.push(it);
      }
      for (const it of items) {
        const fresh = it.w.byEl !== it.b;
        it.w.byEl = it.b;
        const cur = it.w.by ?? 0;
        const next = fresh || Math.abs(it.lift - cur) < 0.5 ? it.lift : cur + (it.lift - cur) * Math.min(1, dt * 14);
        it.w.by = next;
        it.el.style.setProperty("--by", `${-Math.round(next)}px`);
      }
    };
    let last = performance.now();
    const still = reduced();
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const [lo, hi] = span();
      for (const w of walkers.current.values()) {
        w.phase += dt;
        if (still) {
          w.lift = 0;
        } else if (w.mode === "drop") {
          // falling onto the desk from above, a bounce or two
          w.vy += 2600 * dt;
          w.lift -= w.vy * dt;
          if (w.lift <= 0) {
            w.lift = 0;
            w.vy = Math.abs(w.vy) > 300 ? -Math.abs(w.vy) * 0.35 : 0;
            if (w.vy === 0) {
              w.mode = "work";
              w.until = t + 20000 + Math.random() * 10000;
            }
          }
        } else if (w.mode === "held") {
          // held up: the top of its head at the pointer, kept over the desk
          const g = w.grab ?? [w.x, 0];
          w.x = clamp(g[0], lo, hi);
          const base = DESK_FRONT - 10 - w.depth * (DESK_FRONT - DESK_Y - 30);
          w.lift = Math.max(0, base - (g[1] + (FLOOR - GRAB) * CHIBI));
          w.vy = 0;
        } else if (w.mode === "dropped") {
          // let go: it falls to the desk, lands, gets up and goes back to work
          if (w.landed === undefined) {
            w.vy += 2600 * dt;
            w.lift -= w.vy * dt;
            if (w.lift <= 0) {
              w.lift = 0;
              w.vy = 0;
              w.landed = t;
              onLandRef.current(w.id);
            }
          } else if (t - w.landed > actLength("dropped", rigOf(w.id)) + 200) {
            w.mode = "work";
            w.landed = undefined;
            w.until = t + 20000 + Math.random() * 10000;
          }
        } else if (w.mode === "cheer" || w.mode === "slump" || w.mode === "nap") {
          w.lift = 0;
        } else if (w.mode === "trip") {
          // fall, lie there a moment, get up, carry on
          w.lift = 0;
          if (t > w.until) {
            w.mode = "work";
            w.until = t + 20000 + Math.random() * 10000;
          }
        } else {
          if (w.lift > 0 || w.vy !== 0) {
            w.vy += 2600 * dt;
            w.lift = Math.max(0, w.lift - w.vy * dt);
            if (w.lift === 0) w.vy = 0;
          }
          if (w.mode === "walk") {
            const d = w.target - w.x;
            const step = Math.sign(d) * w.speed * dt;
            if (Math.abs(d) <= Math.abs(step) + 1 && w.report) {
              // arrived to report: the joy or the sulk, facing the chair
              w.x = w.target;
              w.mode = w.report;
              w.face = w.x < WORLD_W / 2 ? 1 : -1;
              w.report = undefined;
              w.until = t + 6000;
            } else if (Math.abs(d) <= Math.abs(step) + 1) {
              w.x = w.target;
              w.mode = "work";
              // 20-30 s at the new spot before moving again
              w.until = t + 20000 + Math.random() * 10000;
            } else if (!w.report && w.speed > 360 && Math.abs(d) > 120 && Math.random() < dt * 0.25) {
              // running too fast: a trip now and then
              w.mode = "trip";
              w.until = t + actLength("fall") + 1100 + actLength("getup");
              w.actAt = t;
              onTripRef.current(w.id);
            } else w.x += step;
          } else if (t > w.until && prefsRef.current.memberMotion !== "on") {
            // minimal or off: they keep working where they sit
            w.until = t + 2000;
          } else if (t > w.until) {
            // off to somewhere else on the desk: now and then, and mostly at a walk
            // a few spots to choose from: the one furthest from where the others are and are headed
            const others = [...walkers.current.values()].filter((o) => o !== w).flatMap((o) => [o.x, o.target]);
            let best = w.x;
            let room = -1;
            for (let k = 0; k < 6; k++) {
              const x = clamp(w.x + (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 380), lo, hi);
              const near = others.length ? Math.min(...others.map((o) => Math.abs(o - x))) : 999;
              const score = Math.min(near, 260) + (Math.abs(x - w.x) > 80 ? 40 : 0) + Math.random() * 30;
              if (score > room) {
                room = score;
                best = x;
              }
            }
            w.target = best;
            w.speed = 200 + Math.random() * 180;
            w.face = w.target > w.x ? 1 : -1;
            w.depth = clamp(w.depth + (Math.random() - 0.5) * 0.6, 0, 1);
            w.mode = "walk";
          }
        }
        w.x = clamp(w.x, lo, hi);
        const el = els.current.get(w.id);
        if (!el) continue;
        // which animation: walking or running, writing at a stop, joy, sulking, dozing, a trip
        const want: Act =
          w.mode === "held" ? "picked" : w.mode === "dropped" ? "dropped" : w.mode === "walk" ? (w.speed > 360 ? "run" : "walk") : w.mode === "drop" ? "happy" : w.mode === "cheer" ? "happy" : w.mode === "slump" ? "sulk" : w.mode === "nap" ? "sleep" : w.mode === "trip" ? (t < w.until - actLength("getup") ? "fall" : "getup") : "write";
        if (want !== w.act) {
          w.act = want;
          w.actAt = t;
        }
        // working: the (redrawn) working loop at half speed, each member at its own point in it, only with
        // motion on (minimal and off: one pose); falling: the first frame of the drop until it lands, then the rest
        const rig = rigOf(w.id);
        const idx = still
          ? 0
          : w.mode === "work"
            ? prefsRef.current.memberMotion !== "on"
              ? 0
              : frameAt(w.act, (t - w.actAt) / 2 + w.offset, rig)
            : w.mode === "dropped"
              ? w.landed === undefined
                ? 0
                : frameAt("dropped", t - w.landed + timingOf(rig, "dropped").durations[0], rig)
              : frameAt(w.act, t - w.actAt, rig);
        // feet on the desk: from near its front edge (depth 0) back toward the wall (depth 1)
        const y = DESK_FRONT - 10 - w.depth * (DESK_FRONT - DESK_Y - 30) - w.lift;
        el.style.transform = `translate(${w.x}px, ${y}px)`;
        // the bubble over it stays on screen: slid sideways near an edge (its tail keeps pointing down at the member)
        const v = viewRef.current;
        if (v) {
          // half the widest bubble (28 characters of its font, see .av-bubble), in world units
          const half = Math.max(15, 12 / v.s) * 14 + 16;
          const shift = clamp(w.x, (-v.ox + 8) / v.s + half, (v.w - v.ox - 8) / v.s - half) - w.x;
          el.style.setProperty("--bx", `${Math.round(shift)}px`);
        }
        el.style.zIndex = w.mode === "held" ? "200" : String(100 - Math.round(w.depth * 20));
        const body = el.firstElementChild as HTMLElement | null;
        // the sprites face right: walking left shows them mirrored (only the moves that may be)
        const flip = ACTS[w.act].flip && w.face < 0 ? -1 : 1;
        const key = `${w.act}:${idx}:${flip}`;
        if (body && key !== w.shownKey) {
          w.shownKey = key;
          const sprite = body.firstElementChild as HTMLElement | null;
          if (sprite) {
            const n = timingOf(rig, w.act).frames;
            sprite.style.backgroundImage = `url(${sheetUrl(rig, w.act)})`;
            sprite.style.backgroundSize = `${n * 100}% 100%`;
            sprite.style.backgroundPosition = `${n > 1 ? (idx / (n - 1)) * 100 : 0}% 0`;
          }
          body.style.transform = `translate(-50%, -${FLOOR * 100}%) scaleX(${flip})`;
        }
      }
      unstackBubbles(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [span]);

  // ---- what they say
  const say = useCallback((member: string, text: string, kind: Bubble["kind"], seconds: number) => {
    if (kind !== "tool" && Math.random() < 0.6) lookRef.current({ kind: "member", id: member });
    setBubbles((cur) => {
      const next = new Map(cur);
      const prev = cur.get(member);
      const count = kind === "tool" && prev?.kind === "tool" && prev.until > Date.now() ? prev.count + 1 : 1;
      next.set(member, { id: seq++, text, kind, count, until: Date.now() + seconds * 1000 });
      return next;
    });
  }, []);
  /*
   * A member on the desk: a tap is a reaction; holding it (a moment, or dragging) picks it up by the top
   * of its head, and letting go drops it onto the desk there. The menu is a right click (on a phone, a
   * double tap): picking up never opens it.
   */
  const held = useRef<{ id: string; pid: number; at: [number, number]; timer: number; up: boolean } | null>(null);
  const lastTap = useRef({ id: "", at: 0 });
  const worldOf = (el: HTMLElement, cx: number, cy: number): [number, number] => {
    const layer = (el.closest(".av-front") as HTMLElement | null) ?? el;
    const r = layer.getBoundingClientRect();
    const k = r.width / WORLD_W || 1;
    return [(cx - r.left) / k, (cy - r.top) / k];
  };
  const liftUp = (id: string, el: HTMLElement, cx: number, cy: number) => {
    const w = walkers.current.get(id);
    if (!w) return;
    w.grab = worldOf(el, cx, cy);
    w.mode = "held";
    w.landed = undefined;
    w.vy = 0;
    navigator.vibrate?.(12);
  };
  const letGo = (id: string) => {
    const w = walkers.current.get(id);
    if (!w || w.mode !== "held") return;
    w.mode = "dropped";
    w.landed = undefined;
    w.vy = 0;
  };
  const grabbing = (id: string, onTap: (e: React.PointerEvent<HTMLButtonElement>) => void, onMenu: (p: { clientX: number; clientY: number }) => void) => ({
    onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer already gone: the drag just ends at the edge */
      }
      const { clientX, clientY } = e;
      const g = { id, pid: e.pointerId, at: [clientX, clientY] as [number, number], up: false, timer: 0 };
      g.timer = window.setTimeout(() => {
        g.up = true;
        liftUp(id, el, g.at[0], g.at[1]);
      }, 220);
      held.current = g;
    },
    onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
      const g = held.current;
      if (!g || g.pid !== e.pointerId) return;
      if (!g.up && Math.hypot(e.clientX - g.at[0], e.clientY - g.at[1]) > 8) {
        window.clearTimeout(g.timer);
        g.up = true;
        liftUp(id, e.currentTarget, e.clientX, e.clientY);
      }
      g.at = [e.clientX, e.clientY];
      if (g.up) {
        const w = walkers.current.get(id);
        if (w) w.grab = worldOf(e.currentTarget, e.clientX, e.clientY);
      }
    },
    onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
      const g = held.current;
      if (!g || g.pid !== e.pointerId) return;
      window.clearTimeout(g.timer);
      held.current = null;
      if (g.up) {
        letGo(id);
        return;
      }
      // a tap: on a phone a second tap soon after opens the menu instead
      const now = Date.now();
      if (e.pointerType === "touch" && lastTap.current.id === id && now - lastTap.current.at < 380) {
        lastTap.current = { id: "", at: 0 };
        onMenu(e);
        return;
      }
      lastTap.current = { id, at: now };
      onTap(e);
    },
    onPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
      const g = held.current;
      if (!g || g.pid !== e.pointerId) return;
      window.clearTimeout(g.timer);
      held.current = null;
      if (g.up) letGo(id);
    },
    onContextMenu(e: React.MouseEvent<HTMLButtonElement>) {
      e.preventDefault();
      if (held.current?.up) return;
      onMenu(e);
    },
  });
  const hop = useCallback((member: string, v = -420) => {
    const w = walkers.current.get(member);
    if (w && (w.mode === "walk" || w.mode === "work") && w.lift === 0) w.vy = v;
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;
  const voiceRef = useRef<{ say: (text: string, who: Seat) => void }>({ say: () => undefined });
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== "assign" && e.type !== "line" && e.type !== "done") return;
        const st = stateRef.current;
        const m = st?.members.find((x) => x.id === e.member);
        const name = m ? bareModel(m) : (e.type !== "line" && e.name) || e.member;
        const house: TintId = m ? familyOf(m) : (e.type !== "line" && e.house) || "relay";
        const who = m ? castOf(m) : castOf({ provider: house === "relay" ? "relay" : house, label: name, model: name });
        const ts = Date.now();
        const base = { id: seq++, ts, member: e.member, name, house };
        if (e.type === "assign") {
          const task = st?.tasks.find((t) => t.id === e.taskId)?.title;
          setReports((cur) => [...cur, { ...base, kind: "spawn" as const, text: task ?? t("작업을 시작합니다") }].slice(-120));
          const spoken = eventLine(who.rig, "task_started");
          const line = spoken?.text ?? pick(who.lines.start);
          say(e.member, line, "start", 4.5);
          speakRef.current(spoken, line, who.rig as Seat, "member");
        } else if (e.type === "done") {
          const text = e.summary?.trim() || (e.ok === false ? t("작업이 중단되었습니다") : t("작업을 마쳤습니다"));
          setReports((cur) => [...cur, { ...base, kind: "done" as const, ok: e.ok, text }].slice(-120));
          const kind = m?.failure?.kind;
          const event = e.ok === false ? (kind === "quota" ? "usage_limit" : kind === "auth" ? "login_required" : "task_failed") : "task_done";
          const spoken = eventLine(who.rig, event);
          const line = spoken?.text ?? pick(e.ok === false ? who.lines.fail : who.lines.done);
          // the others on the desk may have something to say about it
          window.setTimeout(() => sceneRef.current(e.ok === false ? "peer_failed" : "peer_done", e.member), 6500);
          say(e.member, `${line} ${plain(text, 260)}`, e.ok === false ? "fail" : "done", 9);
          speakRef.current(spoken, line, who.rig as Seat, "member");
        } else {
          const raw = (e.text ?? "").trim();
          if (!raw) return;
          const tool = /^tool\s+/.test(raw);
          const text = tool ? raw.replace(/^tool\s+/, "").replace(/^mcp__\w+?__/, "") : raw;
          say(e.member, tool ? text : plain(text, 300), tool ? "tool" : "say", tool ? 3 : 9);
          hop(e.member, tool ? -300 : -460);
          setReports((cur) => {
            const last = cur[cur.length - 1];
            if (tool && last && last.kind === "line" && last.member === e.member && last.count) return [...cur.slice(0, -1), { ...last, text: t("도구 {text}", { text }), count: last.count + 1 }];
            return [...cur, { ...base, kind: "line" as const, text: tool ? t("도구 {text}", { text }) : text, count: tool ? 1 : undefined }].slice(-120);
          });
        }
      }),
    [subscribe, say, hop],
  );
  // ---- banter (Agentg's scripts): monologues, and short conversations when the scene fits
  const talkingUntil = useRef(0);
  /** a conversation among the members on the desk: each turn in its speaker's bubble, facing each other */
  const converse = useCallback(
    (d: Dialogue, prefer?: string) => {
      const present = shownRef.current.filter((x) => !x.leaving || x.member.id === prefer);
      const who = new Map<string, string>();
      for (const c of d.chars) {
        const pickOne = present.find((x) => x.cast.rig === c && x.member.id === prefer) ?? present.find((x) => x.cast.rig === c && ![...who.values()].includes(x.member.id));
        if (!pickOne) return;
        who.set(c, pickOne.member.id);
      }
      const now = performance.now();
      let at = 0;
      const ids = [...who.values()];
      const length = d.turns.reduce((n, t) => n + 1600 + t.text.length * 70, 0);
      talkingUntil.current = Date.now() + length + 1000;
      // they stop where they are and turn to each other
      const xs = ids.map((id) => walkers.current.get(id)?.x ?? 0);
      const mid = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      for (const id of ids) {
        const w = walkers.current.get(id);
        if (!w || w.mode === "trip" || w.mode === "drop") continue;
        if (w.mode === "walk" || w.mode === "work") {
          w.mode = "work";
          w.until = now + length + 600;
        }
        w.face = w.x <= mid ? 1 : -1;
      }
      for (const t of d.turns) {
        const id = who.get(t.char);
        const secs = 1.6 + t.text.length * 0.07;
        window.setTimeout(() => {
          if (!id || !shownRef.current.some((x) => x.member.id === id)) return;
          say(id, t.text, "talk", secs + 0.4);
          if (prefsRef.current.memberVoice && prefsRef.current.readAloud) voiceRef.current.say(t.text, t.char as Seat);
        }, at);
        at += secs * 1000;
      }
    },
    [say],
  );
  /** a scene happened (someone finished, failed, fell): maybe the others talk about it */
  const sceneRef = useRef<(trigger: string, member: string) => void>(() => undefined);
  sceneRef.current = (trigger, member) => {
    if (Date.now() < talkingUntil.current) return;
    const subject = shownRef.current.find((x) => x.member.id === member);
    const present = new Set(shownRef.current.map((x) => x.cast.rig as string));
    if (!subject || present.size < 2) return;
    const d = dialogue(trigger, present, subject.cast.rig);
    if (d) converse(d, member);
  };
  const onTripRef = useRef<(member: string) => void>(() => undefined);
  onTripRef.current = (member) => {
    const s = shownRef.current.find((x) => x.member.id === member);
    if (s && Math.random() < 0.5) say(member, s.cast.rig === "grok-x" ? t("아얏…") : t("앗…!"), "idle", 1.6);
    window.setTimeout(() => sceneRef.current("peer_fell", member), 700);
  };
  // dropped onto the desk: the same little cry as a fall, and the others may remark on it
  onLandRef.current = (member) => onTripRef.current(member);
  // now and then (a chance every 20-30 s, often passed up): a monologue for the moment, or a conversation
  // between those who are free
  useEffect(() => {
    let t = 0;
    const next = () => {
      t = window.setTimeout(chatter, 20000 + Math.random() * 10000);
    };
    const chatter = () => {
      next();
      if (Date.now() < talkingUntil.current) return;
      const here = shownRef.current.filter((x) => !x.leaving);
      if (!here.length) return;
      const present = new Set(here.map((x) => x.cast.rig as string));
      const sleeper = here.find((x) => x.member.status === "waiting");
      // two or more characters: sometimes they talk
      if (present.size >= 2 && Math.random() < 0.3) {
        const d = sleeper && Math.random() < 0.5 ? dialogue("peer_sleeping", present, sleeper.cast.rig) : dialogue("both_idle", present);
        if (d) {
          converse(d, sleeper?.member.id);
          return;
        }
      }
      // and often nobody says anything this time
      if (Math.random() < 0.45) return;
      const x = pick(here);
      const hour = new Date().getHours();
      const minutes = (Date.now() - Date.parse(x.member.startedAt)) / 60000;
      const tags = [...(hour >= 23 || hour < 5 ? ["late_night"] : []), ...(x.member.status === "waiting" ? ["waiting"] : []), ...(minutes > 20 ? ["long_wait"] : []), "idle", "random"];
      const text = monologue(x.cast.rig, tags) ?? pick(x.cast.lines.idle);
      setBubbles((cur) => {
        if ((cur.get(x.member.id)?.until ?? 0) > Date.now()) return cur;
        const next = new Map(cur);
        next.set(x.member.id, { id: seq++, text, kind: "idle", count: 1, until: Date.now() + 4200 });
        return next;
      });
    };
    next();
    return () => clearTimeout(t);
  }, [converse]);
  const bubblesRef = useRef(bubbles);
  bubblesRef.current = bubbles;
  // bubbles go when their time is up
  useEffect(() => {
    if (bubbles.size === 0) return;
    const next = Math.min(...[...bubbles.values()].map((b) => b.until));
    const t = window.setTimeout(() => setBubbles((cur) => new Map([...cur].filter(([, b]) => b.until > Date.now()))), Math.max(50, next - Date.now() + 20));
    return () => clearTimeout(t);
  }, [bubbles]);

  // ---- the chair
  const busy = state?.chair.busy ?? false;
  const ask = state?.agenda.waitingForUser && !busy && state.agenda.status !== "closed" ? state.agenda.waitingForUser : undefined;
  // where the input box starts on the stage: a phone stands the walked-out chair right on it
  const floatEl = useRef<HTMLDivElement>(null);
  const [inputTop, setInputTop] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = floatEl.current;
    const host = stage.current;
    if (!el || !host) return;
    const measure = () => {
      const t = el.getBoundingClientRect().top - host.getBoundingClientRect().top;
      setInputTop((cur) => (cur !== undefined && Math.abs(cur - t) < 1 ? cur : t));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(host);
    return () => ro.disconnect();
  }, [narrow, logOpen]);
  const [prefs, setPrefs] = useAvatarPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const voice = useVoice(prefs.voice);
  voiceRef.current = voice;
  /** say a line aloud: its recording, or (if reading aloud is on) the TTS; members only with their switch */
  const speakRef = useRef<(spoken: Spoken | undefined, text: string, who: Seat, as: "chair" | "member") => void>(() => undefined);
  speakRef.current = (spoken, text, who, as) => {
    const p = prefsRef.current;
    if (!p.voice || (as === "member" && !p.memberVoice)) return;
    // the chair's lines carry their words: its bubble shows them for as long as they are heard
    const as_ = as === "chair" ? { chair: true, shown: text } : {};
    if (spoken?.url) voice.play(spoken.url, who, p.readAloud ? text : "", as_);
    else if (p.readAloud) voice.say(text, who, as_);
  };
  /** the chair says one of its recorded lines for an event, shown in its bubble too (with `show` off, the
   * bubble comes only while the line is heard: a quick acknowledgement would otherwise cover the thinking dots) */
  const chairLine = (event: string | string[], show = true) => {
    const events = Array.isArray(event) ? event : [event];
    const spoken = eventLine(chairWho.rig, events[Math.floor(Math.random() * events.length)]);
    if (!spoken) return;
    if (show) setReaction({ id: seq++, text: spoken.text });
    speakRef.current(spoken, spoken.text, chairWho.rig as Seat, "chair");
  };
  const chairLineRef = useRef(chairLine);
  chairLineRef.current = chairLine;
  // the company's character, or the one the viewer fixed in the menu (the halo keeps the company's colour)
  const company = chairCast(state?.chair.provider, state?.chair.model);
  const chairWho: Character = chairFigure(prefs, company);
  const seat = chairWho.rig as Seat;
  // a short line in character when the chair is touched
  const [reaction, setReaction] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!reaction) return;
    // at least 3 s, longer for longer words
    const t = window.setTimeout(() => setReaction(null), Math.max(3200, 1500 + reaction.text.length * 100));
    return () => clearTimeout(t);
  }, [reaction]);
  const greeted = useRef(false);
  const lastVoice = useRef(0);
  const react = (rigCast: Character) => {
    lookRef.current({ kind: "front" });
    // the face and the move (no more often than every 1.5 s, as in Agentg); the chest swings as it
    // starts and again as a hop lands
    const presets = presetsOf(rigCast);
    if (presets.length && !reduced() && (!mood || Date.now() - mood.key > 1500)) {
      const ms = 800 + Math.random() * 700;
      const m: Mood = { key: Date.now(), preset: pick(presets), motion: pick(["hop", "shake", "flinch"] as const), ms };
      setMood(m);
      clearTimeout(moodTimer.current);
      moodTimer.current = window.setTimeout(() => setMood(null), ms);
      if (m.motion === "hop") window.setTimeout(() => setPoked((n) => n + 1), ms * 0.42);
      if (m.motion === "shake") window.setTimeout(() => setPoked((n) => n + 1), ms * 0.35);
    }
    if (!prefs.reactions) return;
    // the words: a greeting the first time, then the character's touch lines (Agentg's reaction presets)
    // or a short answer, all recorded; spoken at most every 8 s
    const quiet = Date.now() - lastVoice.current < 8000;
    const hour = new Date().getHours();
    const recorded = !greeted.current ? eventLine(chairWho.rig, hour >= 5 && hour < 11 ? "good_morning" : hour >= 18 && hour < 23 ? "good_evening" : "greeting_start") : Math.random() < 0.35 ? eventLine(chairWho.rig, pick(["ack", "user_returned", "processing"])) : undefined;
    greeted.current = true;
    const spoken = recorded ?? reactionLine(chairWho.rig);
    const text = spoken?.text ?? pick([...chairWho.lines.idle, ...chairWho.lines.start]);
    setReaction({ id: seq++, text });
    if (!prefs.voice || quiet) return;
    lastVoice.current = Date.now();
    if (spoken?.url) speakRef.current(spoken, text, seat, "chair");
    else voice.say(text, seat, { chair: true, shown: text });
  };
  // the version it runs as (an alias like "opus" as the CLI resolved it), else the setting
  const chairName = state ? prettyModel(state.chair.modelId ?? state.chair.model) ?? "Claude" : t("의장");
  // the chair's bubble closed by hand: hidden until it says something new
  const [closedSay, setClosedSay] = useState<string | null>(null);
  const chairSays = useMemo(() => {
    if (!state) return null;
    if (ask) return { key: `ask${ask.at}`, text: plain(ask.question, 900), ask: true, dots: false };
    let said = -1;
    let asked = -1;
    for (let i = chat.length - 1; i >= 0 && (said < 0 || asked < 0); i--) {
      if (said < 0 && chat[i].role === "assistant" && chat[i].text.trim()) said = i;
      if (asked < 0 && (chat[i].role === "user" || chat[i].role === "event")) asked = i;
    }
    if (busy && said < asked) return { key: "thinking", text: "", ask: false, dots: true };
    if (said < 0) return busy ? { key: "thinking", text: "", ask: false, dots: true } : null;
    return { key: `c${chat[said].id}`, text: plain(chat[said].text, 900), ask: false, dots: busy };
  }, [state, ask, chat, busy]);
  // the mouth moves for as long as it would take to say the new words
  const seatRef = useRef<Seat>("claudechan");
  const saidKey = useRef<string | null>(null);
  const openedWords = useRef(false);
  useEffect(() => {
    const key = chairSays?.text ? chairSays.key : null;
    if (key === saidKey.current) return;
    // only the words already there when the view opened count as "first" (not words after a pause to think)
    const first = !openedWords.current && key !== null && chat.length > 0;
    if (key !== null) openedWords.current = true;
    saidKey.current = key;
    if (!key || !chairSays?.text) return;
    // words already there when the view opened are not spoken again
    if (first && !busy) return;
    if (prefsRef.current.voice && prefsRef.current.readAloud) voice.say(chairSays.text, seatRef.current, { chair: true });
  }, [chairSays, chat.length, busy]);

  // ---- where the chair looks: mostly at you, now and then at a member on the desk (one who speaks,
  // moves or has just done something), following it while it walks; a quick blink on a long glance
  const gazeBus = useRef<GazeBus>({ g: [0, 0], fns: new Set() }).current;
  const [blinkKey, setBlinkKey] = useState(0);
  const look = useRef<{ kind: "front" } | { kind: "member"; id: string } | { kind: "point"; g: [number, number] }>({ kind: "front" });
  const headRef = useRef({ x: 0, y: 0 });
  const setGaze = useCallback((g: [number, number], glance = false) => {
    const [ox, oy] = gazeBus.g;
    if (Math.abs(g[0] - ox) < 0.03 && Math.abs(g[1] - oy) < 0.03) return;
    if (glance && Math.hypot(g[0] - ox, g[1] - oy) > 0.7 && Math.random() < 0.35) setBlinkKey((n) => n + 1);
    gazeBus.g = g;
    gazeBus.fns.forEach((f) => f());
  }, [gazeBus]);
  const gazeAt = useCallback((id: string): [number, number] | null => {
    const w = walkers.current.get(id);
    if (!w) return null;
    const dx = w.x - headRef.current.x;
    const dy = DESK_FRONT - 60 - w.depth * 40 - headRef.current.y;
    return [clamp(dx / 560, -1, 1), clamp(dy / 760, -0.5, 0.75)];
  }, []);
  const lookAt = useCallback(
    (target: typeof look.current) => {
      look.current = target;
      const g = target.kind === "front" ? ([0, 0] as [number, number]) : target.kind === "point" ? target.g : gazeAt(target.id);
      if (g) setGaze(g, true);
    },
    [gazeAt, setGaze],
  );
  const lookRef = useRef(lookAt);
  lookRef.current = lookAt;
  // the dev server only: point her eyes from the console, to look at the warp (__avatarGaze([1, 0]))
  if (import.meta.env.DEV) (window as unknown as { __avatarGaze?: (g: [number, number]) => void }).__avatarGaze = (g) => {
    look.current = { kind: "point", g };
    setGaze(g);
  };
  useEffect(() => {
    if (reduced()) return;
    let next = 0;
    const t = window.setInterval(() => {
      const now = Date.now();
      // following a member as it moves
      if (look.current.kind === "member") {
        const g = gazeAt(look.current.id);
        if (g) setGaze(g);
        else lookAt({ kind: "front" });
      }
      if (now < next) return;
      const here = shownRef.current.filter((x) => !x.leaving || x.leaving === "done");
      const r = Math.random();
      if (look.current.kind !== "front" || !here.length || r < 0.4) {
        lookAt({ kind: "front" });
        next = now + 2000 + Math.random() * 3500;
      } else if (r < 0.88) {
        // someone with something on: a bubble up, or on the move
        const busy = here.filter((x) => (bubblesRef.current.get(x.member.id)?.until ?? 0) > now || walkers.current.get(x.member.id)?.mode === "walk");
        const who = pick(busy.length && Math.random() < 0.7 ? busy : here);
        lookAt({ kind: "member", id: who.member.id });
        next = now + 1200 + Math.random() * 2200;
      } else {
        lookAt({ kind: "point", g: [(Math.random() - 0.5) * 1.2, (Math.random() - 0.3) * 0.4] });
        next = now + 700 + Math.random() * 900;
      }
    }, 160);
    return () => clearInterval(t);
  }, [gazeAt, lookAt, setGaze]);

  // the chair's moments: it asks you to decide, proposes to close, everything is done, the agenda closed
  const moment = useRef<{ key?: string; ask?: string; done?: boolean; closed?: boolean }>({});
  useEffect(() => {
    const m = moment.current;
    const key = state?.key;
    const askAt = ask ? `${ask.at}` : undefined;
    const allDone = Boolean(state && state.tasks.length > 0 && state.tasks.every((t) => t.status === "done"));
    const closed = state?.agenda.status === "closed";
    // a new agenda on screen: take its state as it is, say nothing about the past
    if (m.key !== key) {
      moment.current = { key, ask: askAt, done: allDone, closed };
      return;
    }
    if (askAt && askAt !== m.ask) chairLineRef.current(ask?.kind === "finish" ? "close_proposal" : ["decision_needed", "approval_request"]);
    else if (closed && !m.closed) chairLineRef.current("agenda_closed");
    else if (allDone && !m.done) chairLineRef.current("all_done");
    moment.current = { key, ask: askAt, done: allDone, closed };
  }, [state, ask]);

  const working = state?.members.filter(isActive).length ?? 0;
  const tasksDone = state?.tasks.filter((t) => t.status === "done").length ?? 0;
  const tasksAll = state?.tasks.length ?? 0;
  const status = !state ? (loading ? t("불러오는 중") : t("안건을 고르면 서재에 불이 켜집니다")) : state.agenda.status === "closed" ? t("안건 종료 · 결정 완료") : busy ? t("숙의 중") : ask ? t("당신의 결정을 기다립니다") : working > 0 ? t("위원 {n}명이 작업 중", { n: working }) : t("대기");

  const project = overview?.projects.find((p) => selected.startsWith(p.id + "/"));
  const openSheet = (at: SheetAt) => {
    setMenu(null);
    setSheet(at);
  };
  const openTab = (tab: SheetTab) => openSheet({ tab, project: tab === "settings" ? project?.id : undefined });
  const projects: ProjectActions = {
    ...baseProjects,
    onSettings: (id) => openSheet({ tab: "settings", project: id, view: "settings" }),
    onGuidelines: (id) => openSheet({ tab: "settings", project: id, view: "guidelines" }),
  };
  const card = { overview, state, project, selected, loading, projects, onSelect, onPage: openTab };
  const proposed = overview?.memory.proposed ?? 0;
  const badAccounts = overview?.accounts.filter((a) => a.status !== "ok").length ?? 0;

  // ---- the chair stands up and walks out in front of the desk (characters with a full-body rig)
  const chairBust = bustOf(chairWho);
  const seated = { x: chairBust.x + (chairWho.eyes[0] + chairWho.eyes[2] / 2) * chairBust.k, y: chairBust.y + (chairWho.eyes[1] + chairWho.eyes[3] / 2) * chairBust.k };
  seatRef.current = seat;
  const full = STANDING[chairWho.rig];
  // the mouth moves while the voice is speaking, too
  // the mouth moves only while its voice is heard (a recording, or the TTS reading its words); new words
  // with no sound just appear in the bubble
  // (the chair's own words only: a member of the same character speaking does not move the chair's mouth)
  const chairTalking = voice.speaking === seat && Boolean(voice.heard?.chair);
  // what the chair's short bubble says: the line being heard (so the mouth never moves with no words on
  // screen, whatever else has set the bubble since), else the last short line set (an event, a touch)
  const heardLine = chairTalking && voice.heard?.shown ? voice.heard : null;
  // (the bubble keeps its key when the line it already shows starts to be heard, or its timer runs out
  // while it is still heard: it is not drawn anew in the middle of a sentence)
  const lastReaction = useRef(reaction);
  if (reaction) lastReaction.current = reaction;
  const shownSay = heardLine ? { id: lastReaction.current?.text === heardLine.shown ? `r${lastReaction.current.id}` : `v${heardLine.id}`, text: heardLine.shown } : reaction ? { id: `r${reaction.id}`, text: reaction.text } : null;
  // the desktop app's floating chair (shown while this window is minimized) says the same short lines;
  // what is sent from it is acknowledged here as from this view's own input box (the sound stays here)
  useFloatMirror(shownSay, chairTalking, prefs.voice, () => chairLineRef.current(["ack", "processing"], false));
  const { stroll, figure, bustLift, zoom, walkOut, walkBack, dancing, dance, endDance } = useStroll(full, chairWho, chairBust.k, seated, viewRef, menu?.kind === "chair", (open) => setMenu(open ? { kind: "chair" } : null), (why) => setReaction({ id: seq++, text: t("춤 영상을 틀지 못했어요 ({why}).", { why }) }));
  // dancing: where the video stands (its feet on the standing figure's) and room above for raised arms
  const danceBox = dancing && figure ? (() => {
    const d = dancing.dance;
    const k = (H_FRONT * ((feetOf(full!)[1] - topOf(full!)) / 1664)) / d.height;
    return { x: figure.cx - d.feet[0] * k, y: figure.feet - d.feet[1] * k, w: d.w * k, h: d.h * k };
  })() : null;
  const cam = view && zoom ? zoomedOut(view, inputTop, danceBox ? Math.min(110, danceBox.y - 10) : 110) : view;
  // world → screen, for the menus and the chair's words
  const toScreen = (x: number, y: number) => (cam ? { x: cam.ox + x * cam.s, y: cam.oy + y * cam.s } : { x: 0, y: 0 });
  const figBox = figure && full ? figureBox(figure, full) : null;
  // where the chair's head is now: at the desk, or out on its feet
  const head = figBox && full ? { x: figBox.x + ((full.eyes[0] + full.eyes[2] / 2) / full.canvas[0]) * figBox.w, y: figBox.y + ((full.eyes[1] + full.eyes[3] / 2) / full.canvas[1]) * figBox.h } : seated;
  const headS = toScreen(head.x, head.y);
  headRef.current = head;
  // over the head, but never off the top of the picture
  const nameY = figBox && full ? Math.max(figBox.y + (topOf(full) / 1664) * figBox.h, (zoom ? -40 : 0) + 70) : BUST_Y + 4;
  // the chair's words: beside its head on a wide screen, over the desk on a tall one; as wide and as
  // many lines as the room there allows; a longer one scrolls inside the bubble (fitBubble)
  const sayAt = cam
    ? cam.portrait
      ? (() => {
          // standing on the input box and growing upward over the desk, stopping just under the name tag of
          // the frontmost member on it (members sit at random depths; a tag hangs about 37px below its
          // chibi's feet), or at the desk line when nobody sits there, so the face and the members stay clear
          const bottom = (inputTop ?? cam.h - 90) - 8;
          const feet = [...walkers.current.values()].filter((w) => w.lift === 0 && w.mode !== "held").map((w) => DESK_FRONT - 10 - w.depth * (DESK_FRONT - DESK_Y - 30));
          const ceiling = feet.length ? cam.oy + Math.max(...feet) * cam.s + 37 + 4 : cam.oy + DESK_Y * cam.s + 8;
          const room = bottom - ceiling;
          // padding 7 + 8 and a 2px border (see .av-say.portrait)
          const frame = 19;
          const lines = clamp(Math.floor((room - frame) / (13 * 1.5)), 3, 12);
          return { left: 12, top: undefined as number | undefined, bottom: cam.h - bottom, width: cam.w - 24, below: true, lines, maxH: Math.max(60, Math.round(room - frame)) };
        })()
      : (() => {
          const x = toScreen(head.x + (figBox ? 150 : 190), 0).x;
          const top = toScreen(0, head.y - 40).y;
          // centred on that line: as tall as fits above it (under the header) and below it (over the input)
          const half = Math.min(top - 70, (inputTop ?? cam.h - 90) - 12 - top);
          const lines = clamp(Math.floor((half * 2 - 26) / (14 * 1.55)), 4, 16);
          return { left: x, top: top as number | undefined, bottom: undefined as number | undefined, width: clamp(cam.w - x - 24, 160, 620), below: false, lines, maxH: Math.max(80, Math.round(half * 2 - 26)) };
        })()
    : null;
  const sayRef = useRef<HTMLElement | null>(null);
  const sayLimit = sayAt?.maxH;
  const sayWidth = sayAt?.width;
  useLayoutEffect(() => {
    const el = sayRef.current;
    if (el && sayLimit) fitBubble(el, sayLimit);
  }, [sayLimit, sayWidth, shownSay?.id, shownSay?.text, chairSays?.key, chairSays?.text, chairSays?.dots]);
  // a new message starts at its top
  useLayoutEffect(() => {
    if (sayRef.current) sayRef.current.scrollTop = 0;
  }, [shownSay?.id, chairSays?.key]);
  // standing out front she covers the middle: her words go beside her instead, one bubble each, the
  // chair's words in a tall one at her left and anything else at the same time (a reaction) at her right
  const sides = (() => {
    if (!cam || !figBox || !full || figure?.layer !== "front" || stroll !== "out") return null;
    const top = figBox.y + (topOf(full) / 1664) * figBox.h;
    const tall = figure.feet - top;
    // the bubbles may cover her arms a little: only her body and head stay clear
    const half = figBox.w * 0.19;
    const left = toScreen(head.x - half, 0).x - 6;
    const right = toScreen(head.x + half, 0).x + 6;
    const edge = 10;
    const wL = Math.min(left - edge, 300);
    const wR = Math.min(cam.w - edge - right, 300);
    if (wL < 64 || wR < 64) return null;
    const a = Math.max(toScreen(0, top + tall * 0.2).y, 64);
    const b = Math.min(toScreen(0, top + tall * 0.9).y, (inputTop ?? cam.h) - 10);
    const lines = Math.max(2, Math.floor((b - a - 22) / ((cam.portrait ? 12.5 : 14) * 1.5)));
    return [
      { x: left - wL, w: wL, top: a, h: b - a, lines, side: "left" as const },
      { x: right, w: wR, top: a, h: b - a, lines, side: "right" as const },
    ];
  })();
  const menuMember = menu?.kind === "member" ? state?.members.find((m) => m.id === menu.id) : undefined;
  const menuWalker = menu?.kind === "member" ? walkers.current.get(menu.id) : undefined;

  return (
    <div className={`vz av ${narrow ? "narrow" : "wide"} ${logOpen ? "log-open" : "log-shut"} ${view?.portrait ? "portrait" : ""} ${state ? "" : "dark"} ${dancing ? "is-dancing" : ""}`}>
      <div className={`vz-stage av-stage ${daytime}`} ref={stage} style={{ "--halo": css(chairWho.tint) } as React.CSSProperties}>
        {!noArt && <div className="av-backdrop" style={{ backgroundImage: `url(${roomArt})` }} />}
        {view && (
          <>
            <div className="av-world" style={{ width: WORLD_W, height: WORLD_H, transform: `translate(${cam!.ox}px, ${cam!.oy}px) scale(${cam!.s})` }}>
              {!noArt && <Study season={season} time={daytime} onMissing={() => setNoArt(true)} />}
              <div key={`halo${flare}`} className={`av-halo ${busy ? "busy" : ""} ${flare ? "flare" : ""}`} style={{ left: head.x, top: head.y - 30 }} />

              <Bust
                cast={chairWho}
                talking={chairTalking && !figure}
                thinking={busy}
                poked={poked}
                gazeBus={gazeBus}
                blinkKey={blinkKey}
                mood={figure ? null : mood}
                extra={bustLift.hidden ? "gone" : ""}
                style={{ translate: `0 ${bustLift.lift}px`, transition: `translate ${bustLift.ms}ms ease-out, opacity 260ms` }}
                on={press(
                  (e) => {
                    if (stroll) return;
                    ripple(e, css(chairWho.tint), true);
                    give(e.currentTarget);
                    setPoked((n) => n + 1);
                    setFlare((n) => n + 1);
                    react(chairWho);
                  },
                  (p) => {
                    if (stroll && stroll !== "out") return;
                    ripple(p, css(chairWho.tint), true);
                    if (state) setMenu({ kind: "chair" });
                  },
                )}
              />
              {/* standing behind the desk: hidden below the desk's front panel */}
              {figure?.layer === "back" && full && (
                <div className="av-clip" style={{ left: WIDE.x, top: WIDE.y, width: WIDE.w, height: DESK_PANEL_BOTTOM - WIDE.y }}>
                  <Standing cast={full} figure={figure} talking={chairTalking} thinking={busy} shift={[-WIDE.x, -WIDE.y]} on={{}} />
                </div>
              )}
            </div>
            <div className="av-world av-front" style={{ width: WORLD_W, height: WORLD_H, transform: `translate(${cam!.ox}px, ${cam!.oy}px) scale(${cam!.s})`, "--bub": `${Math.max(15, 12 / cam!.s)}px` } as React.CSSProperties}>
              {!noArt && <DeskFront time={daytime} />}
              <div className={`av-name ${figure ? "moving" : ""} ${prefs.badge && !dancing ? "" : "hidden"}`} style={{ left: figure ? figure.cx : WORLD_W / 2, top: nameY, transition: figure ? `left ${figure.ms}ms linear, top ${figure.ms}ms ease` : undefined }} key={chairName}>
                <span>{chairName}</span>
                {state?.chair.effort && <i>{state.chair.effort}</i>}
              </div>
              {shown.map((s) => {
                const b = bubbles.get(s.member.id);
                return (
                  <div
                    key={s.member.id}
                    className={`av-chibi ${s.leaving ?? ""} ${s.member.status}`}
                    ref={(el) => {
                      if (el) els.current.set(s.member.id, el);
                      else els.current.delete(s.member.id);
                    }}
                    style={{ "--c": css(s.cast.tint) } as React.CSSProperties}
                  >
                    <button
                      className="av-chibi-body"
                      style={{ width: CHIBI, height: CHIBI }}
                      data-rig={s.cast.rig}
                      {...grabbing(
                        s.member.id,
                        (e) => {
                          ripple(e, css(s.cast.tint), false);
                          hop(s.member.id, -520);
                          const hour = new Date().getHours();
                          const line = monologue(s.cast.rig, [...(hour >= 23 || hour < 5 ? ["late_night"] : []), "random", "idle"]) ?? pick(s.cast.lines.idle);
                          say(s.member.id, line, "idle", 3.6);
                          if (prefs.memberVoice && prefs.readAloud) voice.say(line, s.cast.rig as Seat);
                        },
                        (p) => {
                          ripple(p, css(s.cast.tint), false);
                          setMenu({ kind: "member", id: s.member.id });
                        },
                      )}
                      title={`${s.name} (${s.cast.name}) · ${t("누르기: 반응 · 누른 채로: 집어 들기 · 오른쪽 클릭(폰은 두 번 누르기): 메뉴")} · ${t(MEMBER_STATUS_KO[s.member.status])}${s.member.effort ? ` · ${t("추론 {effort}", { effort: s.member.effort })}` : ""} · ${t("도구 호출 {n}회", { n: s.member.toolCalls })}\n${state?.tasks.find((t) => t.id === s.member.taskId)?.title ?? ""}`}
                    >
                      <span className="av-sprite" role="img" aria-label={s.cast.name} />
                    </button>
                    {/* at work: the workshop's loader in the member's colour, over its head */}
                    {s.member.status === "running" && !s.leaving && (
                      <span className="av-working" aria-label={t("작업 중")} style={{ "--off": `-${(hashOf(s.member.id) % 1600) / 1000}s` } as React.CSSProperties}>
                        <GridSpinner color="var(--c)" size={26} />
                      </span>
                    )}
                    <div className="av-tag">
                      <b>{s.name}</b>
                      <span>{s.leaving === "done" ? t("완료!") : s.leaving === "fail" ? t("중단") : progress(s.member, now)}</span>
                    </div>
                    {b && prefs.bubbles && (
                      <div key={b.id} className={`av-bubble ${b.kind}`}>
                        {b.kind === "tool" ? `⚙ ${b.text}${b.count > 1 ? ` ×${b.count}` : ""}` : b.text}
                      </div>
                    )}
                    {s.leaving === "done" && <div className="av-sparkle">✦</div>}
                    {s.leaving === "fail" && <div className="av-sweat">💧</div>}
                  </div>
                );
              })}
            </div>

            {sides && prefs.bubbles && (() => {
              const items: Array<{ key: string; text: string; ask: boolean; dots: boolean; log: boolean }> = [];
              if (chairSays) items.push({ key: chairSays.key, text: chairSays.text, ask: chairSays.ask, dots: chairSays.dots, log: true });
              if (shownSay) items.push({ key: shownSay.id, text: shownSay.text, ask: false, dots: false, log: false });
              return items.map((it, i) => {
                const z = sides[i];
                return (
                  <div
                    key={it.key}
                    className={`av-say spread ${z.side} ${it.ask ? "ask" : ""} ${view.portrait ? "portrait" : ""}`}
                    style={{ left: z.side === "right" ? z.x : undefined, right: z.side === "left" ? view.w - z.x - z.w : undefined, top: z.top, maxWidth: z.w, maxHeight: z.h, WebkitLineClamp: z.lines }}
                    onClick={it.log ? toggleLog : undefined}
                  >
                    <span className="av-say-tag">{chairWho.name}</span>
                    {it.text && <span className="av-say-text">{it.text}</span>}
                    {it.dots && (
                      <span className="vz-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                );
              });
            })()}
            {!sides && sayAt && (shownSay || chairSays) && prefs.bubbles && (shownSay || !(stroll && stroll !== "out")) && (shownSay ? (
              <div key={shownSay.id} className={`av-say react fit ${view.portrait ? "portrait" : ""}`} ref={(el: HTMLElement | null) => { sayRef.current = el; }} style={{ left: sayAt.left, top: sayAt.top, bottom: sayAt.bottom, maxWidth: sayAt.width, maxHeight: sayAt.maxH }}>
                <span className="av-say-tag">{chairWho.name}</span>
                <span className="av-say-text">{shownSay.text}</span>
              </div>
            ) : chairSays && chairSays.key !== closedSay && (
              <button
                key={chairSays.key}
                className={`av-say fit ${chairSays.ask ? "ask" : ""} ${view.portrait ? "portrait" : ""}`}
                ref={(el: HTMLElement | null) => { sayRef.current = el; }} style={{ left: sayAt.left, top: sayAt.top, bottom: sayAt.bottom, maxWidth: sayAt.width, maxHeight: sayAt.maxH }}
                onClick={toggleLog}
                title={t("대화 기록 열기")}
              >
                <span
                  className="say-x"
                  role="button"
                  aria-label={t("말풍선 닫기")}
                  title={t("말풍선 닫기 (다음 말이 오면 다시 뜹니다)")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setClosedSay(chairSays.key);
                  }}
                >
                  ✕
                </span>
                <span className="av-say-tag">{chairWho.name}</span>
                {chairSays.text && <span className="av-say-text">{chairSays.text}</span>}
                {chairSays.dots && (
                  <span className="vz-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </button>
            ))}
            <div className={`av-status ${ask ? "ask" : ""}`} style={{ left: view.w / 2, top: Math.min(view.h - 8, view.oy + (DESK_FRONT + 40) * view.s) }}>
              <span>{status}</span>
              {tasksAll > 0 && (
                <span className="vz-status-sub">
                  {t("결정")} {tasksDone} / {tasksAll}
                </span>
              )}
            </div>
          </>
        )}

        {ripples.map((r) => (
          <span key={r.id} className={`av-ripple ${r.big ? "big" : ""}`} style={{ left: r.x, top: r.y, "--c": r.c } as React.CSSProperties}>
            <i />
            <i />
          </span>
        ))}

        <header className="vz-top">
          <div className="vz-id">
            <div className="vz-brand">
              <span className="vz-mark">✦</span>
              <span className="vz-brand-name">GENCOUNCIL</span>
            </div>
            <div className="vz-nav">
              <ModeSwitch mode={{ room: "work", look: "avatar" }} onChange={onMode} />
              <nav className="vz-dock" aria-label={t("위키와 설정")}>
                <button className={sheet && sheet.tab !== "settings" && sheet.tab !== "accounts" ? "on" : ""} onClick={() => openTab("wiki")} title={t("Gen Wiki · 공유 기억")}>
                  <i>❖</i><span className="vz-dock-label">{t("위키")}</span>
                  {proposed > 0 && <em title={t("위키 등록을 기다리는 제안")}>{proposed}</em>}
                </button>
                <button className={sheet && (sheet.tab === "settings" || sheet.tab === "accounts") ? "on" : ""} onClick={() => openTab("settings")} title={t("설정 · 계정 · 남은 사용량")}>
                  <i>⚙</i><span className="vz-dock-label">{t("설정")}</span>
                  {badAccounts > 0 && <em title={t("문제가 있는 계정")}>{badAccounts}</em>}
                </button>
                <ReloadButton />
              </nav>
            </div>
          </div>
          {(narrow || !logOpen) && <AgendaCard {...card} />}
          <span className="vz-use-wrap">
            <UsageMini usage={usage} onOpen={() => openSheet({ tab: "settings" })} />
          </span>
        </header>

        <footer className="vz-bottom av-bottom">
          {(narrow || !logOpen) && (
            <div className="vz-float" ref={floatEl}>
              <Composer
                state={state}
                compact
                onSend={(...args) => {
                  chairLineRef.current(["ack", "processing"], false);
                  return onSend(...args);
                }}
                chair={chair}
                onLog={toggleLog}
              />
            </div>
          )}
        </footer>

        {/* in front of the desk she is closest of all: over the input, the menus and the bubbles */}
        {cam && figure?.layer === "front" && full && (
          <>
            <div className={`av-world av-top ${menu?.kind === "chair" ? "under-sheet" : ""} ${dancing ? "dancing" : ""}`} style={{ width: WORLD_W, height: WORLD_H, transform: `translate(${cam.ox}px, ${cam.oy}px) scale(${cam.s})` }}>
              <Standing
                cast={full}
                figure={figure}
                talking={chairTalking}
                thinking={busy}
                shift={[0, 0]}
                poked={poked}
                gazeBus={gazeBus}
                blinkKey={blinkKey}
                mood={mood}
                on={press(
                  (e) => {
                    ripple(e, css(chairWho.tint), true);
                    setPoked((n) => n + 1);
                    react(full);
                  },
                  (p) => {
                    ripple(p, css(chairWho.tint), true);
                    if (stroll === "out") setMenu({ kind: "chair" });
                  },
                )}
              />
              {/* the dance, over the standing figure (hidden meanwhile); a tap stops it */}
              {dancing && danceBox && (
                <button className="av-dance" style={{ left: danceBox.x, top: danceBox.y, width: danceBox.w, height: danceBox.h }} onClick={() => endDance()} title={t("춤 멈추기")}>
                  <DanceArt dance={dancing.dance} video={dancing.video} onEnd={endDance} />
                </button>
              )}
            </div>
          </>
        )}

        {view && menu?.kind === "chair" && state && (
          <Popover x={headS.x} y={headS.y} r={(figBox ? figBox.w * 0.42 : 150) * (cam ?? view).s} tint={chairWho.tint} onClose={() => setMenu(null)}>
            <AvatarMenu
              company={company}
              prefs={prefs}
              set={setPrefs}
              current={chairWho}
              voiceAvailable={voice.available}
              onClearBubbles={() => {
                setBubbles(new Map());
                setReaction(null);
              }}
              dances={full?.dances}
              canStand={Boolean(full)}
              out={stroll === "out"}
              onWalkOut={() => {
                setMenu(null);
                void walkOut();
              }}
              onWalkBack={() => {
                setMenu(null);
                void walkBack();
              }}
              // the video is made here, in the click, so the phone lets it play with sound
              onDance={(d) => void dance(d, danceVideo(d, prefs.voice))}
            />
            <ChairMenu
              state={state}
              project={project}
              firstTurn={firstTurn}
              chair={chair}
              onStop={() => {
                if (confirm(t("의장의 이번 작업을 멈출까요? (위원은 계속 작업합니다)"))) void api.stopChair(state.key).catch(() => undefined);
              }}
              onClose={() => setMenu(null)}
              onWorkshop={onWorkshop}
            />
          </Popover>
        )}
        {view && menuMember && menuWalker && (
          <Popover x={toScreen(menuWalker.x, 0).x} y={toScreen(0, DESK_FRONT - 20 - CHIBI / 2).y} r={(CHIBI / 2) * view.s + 6} tint={castOf(menuMember).tint} onClose={() => setMenu(null)}>
            <WorkerMenu member={menuMember} task={state?.tasks.find((t) => t.id === menuMember.taskId)?.title ?? ""} actions={members} onClose={() => setMenu(null)} />
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
