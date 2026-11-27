import { ReloadButton } from "./ReloadButton";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Meeting, MeetingSeat, MeetingSeatId, MeetingSettings, MeetingSummary, MeetingTurn, ModelsInfo, UsageSnapshot } from "../types";
import { CAST, type Character, type SeatId } from "../avatar/cast";
import CHIBI_META from "../avatar/chibi.json";
import type { GazeBus } from "../avatar/chest";
import type { Rgb } from "../vision/scene";
import { UsageMini } from "../vision/UsageMini";
import { Bust } from "./AvatarView";
import { ModeSwitch, type Look, type Mode } from "./ModeSwitch";
import { ROOM, SEATED } from "../avatar/meetingArt";
import "../vision/vision.css";
import "../vision/sheet.css";
import "../avatar/avatar.css";
import "../avatar/meeting.css";
import { t, useT } from "../i18n";

/**
 * The meeting room: a glass-walled room with a whiteboard (painted by a GPT member), the chair in the
 * middle behind the table and the four other characters seated at its sides, in profile, facing in
 * (drawn locally). The user gives a topic; the members give their opinions in turn, talk it over, and
 * the chair sums it up (packages/server/src/meeting.ts runs it; this page follows it).
 */
interface Props {
  /** how it is shown: the painted room (avatar), the council's picture (vision), or the record alone (text) */
  look: Look;
  meeting: Meeting | null;
  /** who chairs and who sits in (saved on the server) */
  settings: MeetingSettings;
  /** a null field clears that choice (back to the default) */
  onSettings: (patch: Partial<Record<keyof MeetingSettings, unknown>>) => Promise<void>;
  /** the providers' models and efforts, for the settings' choices */
  loadModels?: () => Promise<ModelsInfo>;
  /** the saved meetings: listed, opened (read only), deleted */
  past?: { list: () => Promise<MeetingSummary[]>; open: (id: string) => Promise<Meeting>; remove: (id: string) => Promise<void> };
  usage?: UsageSnapshot | null;
  onStart: (topic: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onMode: (mode: Mode) => void;
  onWorkshop: () => void;
  notify: (msg: string) => void;
}

const W = ROOM.w;
const H = ROOM.h;
const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const RIG: Record<MeetingSeatId, SeatId> = { claude: "claudechan", gpt: "gpichan", gemini: "gemmini", grok: "grok-x", dots: "dotchan" };
const ORDER: MeetingSeatId[] = ["claude", "gpt", "gemini", "grok", "dots"];
const seatOfProvider = (p?: string): MeetingSeatId => (p === "gpt" ? "gpt" : p === "gemini" ? "gemini" : p === "grok" ? "grok" : "claude");
/** seats with no CLI behind them: they sit in, but say nothing */
const UNWIRED: MeetingSeatId[] = ["dots"];
const CHAIRS: Array<MeetingSettings["chair"]> = ["claude", "gpt", "gemini", "grok"];

/*
 * The room is seen from the near end of the table, a little above seated eyes (one-point perspective).
 * A depth is given as pixels per metre there (p): the table top is CAM_H - 0.72 m below the horizon
 * and seated eyes CAM_H - 1.2 m below it, so both follow from p; the table is taken as 1.4 m wide.
 */
const [VX, VY] = ROOM.vp;
const TABLE_M = 1.4;
const P_END = (ROOM.far[2] - ROOM.far[0]) / TABLE_M;
const CAM_H = 0.72 + (ROOM.far[1] - VY) / P_END;
const HALF_M = TABLE_M / 2;
/** where seated eyes are at a depth */
const eyeAt = (p: number) => VY + (CAM_H - 1.2) * p;
const tableAt = (p: number) => VY + (CAM_H - 0.72) * p;
/** a seated figure's art (head top to the chair's casters) stands for about this many metres */
// life size: the room is painted close (a short table, a small board) so the people are big in it
const GROW = 1;
const SEATED_M = 1.25 * GROW;
/** how far from the table's edge a seated head is, in metres */
const OUT_M = 0.42;
/** the four places along the sides: the first two (who speak, as a rule) nearest the chair */
const PLACES = [
  { p: P_END * ROOM.seatFar, side: "left" },
  { p: P_END * ROOM.seatFar, side: "right" },
  { p: P_END * ROOM.seatNear, side: "left" },
  { p: P_END * ROOM.seatNear, side: "right" },
] as const;
/** the chair, a little beyond the far end; the eye patch of a bust stands for about 13 cm */
const P_CHAIR = P_END * 0.95;
const EYES_M = 0.2 * GROW;
/** the chair's own character sitting in: a chibi on the table, at the right a little before the chair;
 * its sprite's square frame stands for about this many metres (Agentg's chibi-anim-v1) */
const P_DESK = P_END * 1.12;
const DESK_X_M = 0.38;
const CHIBI_M = 0.6;
/** in an empty chair: its seat's height (m) and how big the chibi is there */
const SEAT_M = 0.5;
const CHIBI_SEAT_M = 0.62;
type Act = "write" | "happy";
const ACTS = CHIBI_META.actions as Record<Act, { frames: number; durations: number[]; floor: number }>;
const CHIBI_FLOOR = ACTS.write.floor / CHIBI_META.size;
const statusLabel = (s: string): string => (s === "running" ? t("진행 중") : s === "done" ? t("끝남") : s === "stopped" ? t("중지됨") : t("실패"));
const PHASES: Array<[Meeting["phase"], string]> = [
  ["opinion", "첫 의견"],
  ["debate", "자유 토론"],
  ["summary", "의장 정리"],
];

interface Place {
  seat: MeetingSeat;
  cast: Character;
  /** the head's middle (room units) and where its name plate goes, on the table's edge beside it */
  x: number;
  headTop: number;
  plate: [number, number];
  side: "left" | "right";
  /** the figure's box in room units */
  box: { x: number; y: number; w: number; h: number };
}

function placesOf(seats: MeetingSeat[]): Place[] {
  return seats.slice(0, 4).map((seat, i) => {
    const { p, side } = PLACES[i];
    const rig = RIG[seat.seat];
    const m = SEATED[rig];
    const k = (p * SEATED_M) / m.h;
    const dir = side === "left" ? -1 : 1;
    const edge = VX + dir * HALF_M * p;
    const x = edge + dir * OUT_M * p;
    // a seat on the right is the picture mirrored: the head's middle mirrors too
    const headX = (side === "left" ? m.headX : m.w - m.headX) * k;
    const y = eyeAt(p) - m.eye * k;
    return { seat, cast: CAST[rig], x, headTop: y + m.top * k, plate: [edge - dir * 0.18 * p, tableAt(p) + 0.03 * p], side, box: { x: x - headX, y, w: m.w * k, h: m.h * k } };
  });
}

/** the room on the screen: a tall one shows the table's width under the header; a wide one (less the
 * record at the right) is covered by the room, zoomed no further than the seats at both ends allow */
/** the chibi on the table: writing while it thinks, glad while it talks, else still */
function DeskChibi({ rig, act, still }: { rig: string; act: Act; still: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (still || reduced()) return;
    const m = ACTS[act];
    let k = 0;
    let t = 0;
    const tick = () => {
      k = (k + 1) % m.frames;
      setI(k);
      t = window.setTimeout(tick, m.durations[k]);
    };
    t = window.setTimeout(tick, m.durations[0]);
    return () => clearTimeout(t);
  }, [act, still]);
  const n = ACTS[act].frames;
  return <span className="mt-chibi-sprite" style={{ backgroundImage: `url(/avatar/chibi/${rig}/${act}.webp?v=1)`, backgroundSize: `${n * 100}% 100%`, backgroundPosition: `${(i / (n - 1)) * 100}% 0` }} />;
}

function viewOf(w: number, h: number, portrait: boolean, top: number) {
  // the seats at both sides must show: the room is never zoomed in past them
  const span = ROOM.span;
  if (portrait) {
    // a phone gives the glass walls up for size: the seats near the edges may be cut a little
    const s = w / ROOM.spanTall;
    return { s, ox: w / 2 - VX * s, oy: top - ROOM.portraitTop * s };
  }
  // close on the chair and the two beside it; a screen taller than that still gets covered
  const s = Math.max(w / span, h / H);
  // the heads and the board stay in sight: the room's top may go above the screen, its floor below
  const oy = H * s > h ? clamp(h - ROOM.keepTo * s, h - H * s, 0) : (h - H * s) / 2;
  return { s, ox: w / 2 - VX * s, oy };
}

function plain(text: string, max: number): string {
  const t = text.replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** the chair's summary: "[제목]" lines become headings */
function Summary({ text }: { text: string }) {
  const parts: Array<{ head?: string; lines: string[] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^\**\s*\[(.+?)\]\s*\**$/.exec(line);
    if (h) parts.push({ head: h[1], lines: [] });
    else {
      if (!parts.length) parts.push({ lines: [] });
      parts[parts.length - 1].lines.push(line.replace(/^[-•*]\s*/, ""));
    }
  }
  return (
    <div className="mt-summary">
      {parts.map((p, i) => (
        <section key={i}>
          {p.head && <h4>{p.head}</h4>}
          {p.lines.map((l, j) => (
            <p key={j}>{l}</p>
          ))}
        </section>
      ))}
    </div>
  );
}

/** each member's mark in the vision look (the council picture's marks: no faces, just light) */
const GLYPH: Record<MeetingSeatId, string> = { claude: "✺", gpt: "⬡", gemini: "✦", grok: "✕", dots: "⁘" };

/**
 * The vision look: the chair a ring of light in the middle, the members round it on an ellipse, a thread
 * from each to the chair that lights up while that one thinks or talks.
 */
function Orbit({
  box,
  small,
  chair,
  chairSeat,
  seats,
  speaking,
  talking,
  bubbleOf,
  width,
  onBubble,
}: {
  box: { x: number; y: number; w: number; h: number };
  small: boolean;
  chair: Character;
  chairSeat: MeetingSeatId;
  seats: MeetingSeat[];
  speaking?: MeetingSeatId | "chair";
  talking?: MeetingSeatId | "chair";
  bubbleOf: (who: MeetingSeatId | "chair") => { dots: boolean; text: string } | null;
  width: number;
  onBubble: () => void;
}) {
  const t = useT();
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.5;
  const R = clamp(Math.min(box.w, box.h) * 0.13, 34, 78);
  const r = R * 0.62;
  const rx = Math.min(box.w * 0.36, box.w / 2 - r - 40);
  const ry = Math.min(box.h * 0.36, box.h / 2 - r - 26);
  const n = Math.max(seats.length, 1);
  const nodes = seats.map((s, i) => {
    const a = ((-90 + (360 * (i + 0.5)) / n) * Math.PI) / 180;
    return { s, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
  const stateOf = (id: MeetingSeatId | "chair", available = true) => (speaking === id ? "thinking" : talking === id ? "talking" : available ? "" : "off");
  const half = Math.min(small ? width * 0.4 : 170, 170);
  const bubble = (who: MeetingSeatId | "chair", x: number, top: number, c: Character) => {
    const b = bubbleOf(who);
    if (!b) return null;
    return (
      <div key={`ob${who}`} className={`mt-bubble mo-bubble ${b.dots ? "dots" : ""}`} style={{ left: clamp(x, half + 8, width - half - 8), top, maxWidth: half * 2, "--tail": `${Math.round(x - clamp(x, half + 8, width - half - 8))}px`, "--c": css(c.tint) } as React.CSSProperties} onClick={onBubble}>
        {b.dots ? (
          <span className="vz-dots">
            <i />
            <i />
            <i />
          </span>
        ) : (
          b.text
        )}
      </div>
    );
  };
  return (
    <div className={`mo ${small ? "small" : ""}`}>
      <svg className="mo-threads" width="100%" height="100%">
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} className="mo-path" />
        {nodes.map(({ s, x, y }) => (
          <line key={s.seat} x1={x} y1={y} x2={cx} y2={cy} className={`mo-thread ${stateOf(s.seat, s.available)}`} style={{ "--c": css(CAST[RIG[s.seat]].tint) } as React.CSSProperties} />
        ))}
      </svg>
      <div className={`mo-node chair ${stateOf("chair")}`} style={{ left: cx, top: cy, width: R * 2, height: R * 2, "--c": css(chair.tint) } as React.CSSProperties}>
        <svg className="mo-ring" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="47" />
          <circle cx="50" cy="50" r="40" className="inner" />
        </svg>
        <span className="mo-core">
          <span className="mo-glyph">{GLYPH[chairSeat]}</span>
        </span>
        <span className="mo-label">
          <small>{t("의장")}</small>
          <b>{t(chair.name)}</b>
        </span>
      </div>
      {nodes.map(({ s, x, y }) => {
        const c = CAST[RIG[s.seat]];
        return (
          <div key={s.seat} className={`mo-node ${stateOf(s.seat, s.available)}`} style={{ left: x, top: y, width: r * 2, height: r * 2, "--c": css(c.tint) } as React.CSSProperties} title={s.reason ?? ""}>
            <svg className="mo-ring" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="46" />
            </svg>
            <span className="mo-core">
              <span className="mo-glyph">{GLYPH[s.seat]}</span>
            </span>
            <span className="mo-label">
              <b>{t(s.name)}</b>
              <small>{speaking === s.seat ? t("생각 중") : talking === s.seat ? t("발언") : !s.available ? t(s.reason ?? "연결 안 됨") : s.desk ? t("의장 겸 위원") : t("위원")}</small>
            </span>
          </div>
        );
      })}
      {nodes.map(({ s, x, y }) => bubble(s.seat, x, y - r - 8, CAST[RIG[s.seat]]))}
      {speaking === "chair" && bubble("chair", cx, cy - R - 10, chair)}
    </div>
  );
}

const PHASE_KO: Record<MeetingTurn["phase"], string> ={ opinion: "첫 의견", debate: "자유 토론", summary: "의장 정리" };

/** each wired seat's CLI */
const PROVIDER_OF: Partial<Record<MeetingSeatId, "claude" | "gpt" | "gemini" | "grok">> = { claude: "claude", gpt: "gpt", gemini: "gemini", grok: "grok" };
const EFFORT_KO: Record<string, string> = { low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" };
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function MeetingView({ look, meeting: current, settings, onSettings, loadModels, past, usage, onStart, onStop, onMode, onWorkshop, notify }: Props) {
  const t = useT();
  // a past meeting opened from the list is shown instead (read only) until closed or a new one starts
  const [viewed, setViewed] = useState<Meeting | null>(null);
  useEffect(() => setViewed(null), [current?.id]);
  const meeting = viewed ?? current;
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const [pastList, setPastList] = useState<MeetingSummary[] | null>(null);
  const refreshPast = useCallback(() => {
    if (past) past.list().then(setPastList, (e: Error) => notify(e.message));
  }, [past, notify]);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const portrait = size.h > size.w * 1.05;
  const [logOpenWanted, setLogOpen] = useState(true);
  // the text look is the record itself: it is always open
  const logOpen = look === "text" || logOpenWanted;
  const LOG_W = 360;
  const roomW = portrait || !logOpen ? size.w : Math.max(320, size.w - LOG_W - 16);
  const view = look === "avatar" && size.w ? viewOf(roomW, size.h, portrait, 112) : null;
  // the vision look's picture: under the header, beside the record (or above it on a tall screen)
  const orbitBox = look === "vision" && size.w ? (portrait ? { x: 0, y: 100, w: size.w, h: Math.min(size.w * 0.95, size.h * 0.46) } : { x: 0, y: 72, w: roomW, h: size.h - 72 - 84 }) : null;

  // who sits where: the meeting under way's seats, else the saved settings (the chair's own character,
  // if it sits in, on the table; the rest at the sides)
  const live = current?.status === "running";
  const chairSeat: MeetingSeatId = live ? meeting!.chair.seat : seatOfProvider(settings.chair);
  const seats: MeetingSeat[] = useMemo(
    () =>
      live
        ? meeting!.seats
        : ORDER.filter((s) => settings.members.includes(s)).map((s) => ({
            seat: s,
            name: CAST[RIG[s]].name,
            available: !UNWIRED.includes(s),
            ...(UNWIRED.includes(s) ? { reason: t("연결 안 됨") } : {}),
            ...(s === chairSeat ? { desk: true } : {}),
          })),
    [live, meeting?.seats, settings.members, chairSeat],
  );
  const places = useMemo(() => placesOf(seats.filter((x) => !x.desk)), [seats]);
  const deskSeat = seats.find((x) => x.desk);
  // the chibi sits in the first empty side seat (beside the others); with every seat taken, on the table
  const slot = deskSeat && places.length < PLACES.length ? PLACES[places.length] : null;
  const desk = !deskSeat
    ? null
    : slot
      ? (() => {
          const dir = slot.side === "left" ? -1 : 1;
          const edge = VX + dir * HALF_M * slot.p;
          return { x: edge + dir * OUT_M * slot.p, feet: VY + (CAM_H - SEAT_M) * slot.p, size: CHIBI_SEAT_M * slot.p, plate: [edge - dir * 0.18 * slot.p, tableAt(slot.p) + 0.03 * slot.p] as [number, number], seated: true };
        })()
      : { x: VX + DESK_X_M * P_DESK, feet: tableAt(P_DESK), size: CHIBI_M * P_DESK, plate: [VX + DESK_X_M * P_DESK, tableAt(P_DESK) + 0.05 * P_DESK] as [number, number], seated: false };
  const chairWho: Character = CAST[RIG[chairSeat]];
  // the record and the conclusion name the chair of the meeting they belong to
  const logChair: Character = meeting ? CAST[RIG[meeting.chair.seat]] : chairWho;
  const [setOpen, setSetOpen] = useState(false);
  useEffect(() => {
    if (setOpen && !models && loadModels) loadModels().then(setModels, () => undefined);
  }, [setOpen, models, loadModels]);
  const [cw, ch] = chairWho.canvas;
  const bustK = (EYES_M * P_CHAIR) / chairWho.eyes[2];
  const bust = { x: VX - (chairWho.eyes[0] + chairWho.eyes[2] / 2) * bustK, y: eyeAt(P_CHAIR) - (chairWho.eyes[1] + chairWho.eyes[3] / 2) * bustK, w: cw * bustK, h: ch * bustK };
  const chairHeadTop = bust.y + ch * bustK * 0.04;
  const running = current?.status === "running" && !viewed;
  const turns = meeting?.turns ?? [];
  const last = turns[turns.length - 1];
  const summary = turns.find((t) => t.who === "chair" && !t.error);

  // the latest words stay up until the next ones (a long one is cut short; the record has it whole)
  const [fresh, setFresh] = useState<string>("");
  const lastKey = last ? `${meeting?.id}:${turns.length}` : "";
  useEffect(() => {
    if (!lastKey) return;
    setFresh(lastKey);
    const t = window.setTimeout(() => setFresh(""), 4200);
    return () => clearTimeout(t);
  }, [lastKey]);
  const talkingWho = fresh && last ? last.who : undefined;

  // the summary card: shown when it comes in, closable
  const [card, setCard] = useState<string>("");
  useEffect(() => {
    // not for a past meeting opened from the list: its record is what was asked for
    if (summary && meeting && !viewed) setCard(meeting.id);
  }, [summary, meeting, viewed]);

  // the record follows the talk
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end", behavior: reduced() ? "auto" : "smooth" });
  }, [turns.length, meeting?.speaking]);

  // the chair looks at whoever speaks (or is about to), and at you between turns
  const gazeBus = useRef<GazeBus>({ g: [0, 0], fns: new Set() }).current;
  const lookAt = meeting?.speaking && meeting.speaking !== "chair" ? meeting.speaking : talkingWho && talkingWho !== "chair" ? talkingWho : undefined;
  useEffect(() => {
    const p = places.find((x) => x.seat.seat === lookAt);
    const x = p ? p.x : desk && deskSeat?.seat === lookAt ? desk.x : undefined;
    gazeBus.g = x !== undefined ? [clamp((x - VX) / 520, -1, 1), p ? 0.12 : 0.3] : [0, 0];
    gazeBus.fns.forEach((f) => f());
  }, [lookAt, places, gazeBus, desk?.x, deskSeat?.seat]);

  const [topic, setTopic] = useState("");
  const [sending, setSending] = useState(false);
  const start = useCallback(async () => {
    const t = topic.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onStart(t);
      setTopic("");
      setCard("");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [topic, sending, onStart, notify]);

  // screen point of a spot in the room
  const at = (x: number, y: number) => (view ? { left: view.ox + x * view.s, top: view.oy + y * view.s } : { left: 0, top: 0 });
  // someone's last words still up: the next one's "thinking" waits until they fade, never covering them
  const wordsUp = Boolean(last && fresh === lastKey && last.who !== "chair");
  const bubbleOf = (who: MeetingSeatId | "chair") => {
    if (meeting?.speaking === who) return wordsUp && last?.who !== who ? null : { dots: true as const, text: "" };
    if (last && last.who === who && fresh === lastKey && who !== "chair") return { dots: false as const, text: last.error ? t("…(응답 실패)") : plain(last.text, portrait ? 90 : 170) };
    return null;
  };
  const phaseAt = meeting ? PHASES.findIndex(([p]) => p === meeting.phase) : -1;
  const chibi = desk && deskSeat && (
    <div
      className={`mt-chibi ${talkingWho === deskSeat.seat ? "talking" : ""} ${meeting?.speaking === deskSeat.seat ? "thinking" : ""}`}
      style={{ left: desk.x - desk.size / 2, top: desk.feet - desk.size * CHIBI_FLOOR, width: desk.size, height: desk.size }}
    >
      <DeskChibi rig={RIG[deskSeat.seat]} act={talkingWho === deskSeat.seat ? "happy" : "write"} still={!(talkingWho === deskSeat.seat || meeting?.speaking === deskSeat.seat)} />
    </div>
  );
  /** a bubble's place: over `x` (screen), slid to stay on screen, its tail still pointing at `x` */
  const bubbleAt = (x: number, top: number) => {
    const half = Math.min(portrait ? size.w * 0.36 : 170, 170);
    const left = clamp(x, half + 8, size.w - half - 8);
    return { left, top, maxWidth: half * 2, "--tail": `${Math.round(x - left)}px` };
  };

  return (
    <div className={`vz ${look === "avatar" ? "av" : ""} mt look-${look} ${portrait ? "portrait" : "wide"} ${logOpen ? "mt-log-on" : ""}`}>
      <div className="vz-stage mt-stage" ref={stage}>
        {look === "avatar" ? <div className="mt-backdrop" /> : <div className={`mo-bg ${look}`} />}
        {orbitBox && (
          <Orbit
            box={orbitBox}
            small={portrait}
            chair={chairWho}
            chairSeat={chairSeat}
            seats={seats}
            speaking={meeting?.speaking}
            talking={talkingWho}
            bubbleOf={bubbleOf}
            width={size.w}
            onBubble={() => setLogOpen(true)}
          />
        )}
        {view && (
          <>
            <div className="av-world mt-world" style={{ width: W, height: H, transform: `translate(${view.ox}px, ${view.oy}px) scale(${view.s})` }}>
              <img className="mt-room" src="/avatar/meeting/room.webp?v=3" alt="" draggable={false} />
              {[...places].sort((a, b) => a.box.h - b.box.h).map((p) => (
                <div
                  key={p.seat.seat}
                  className={`mt-seat ${p.side} ${p.seat.available ? "" : "empty"} ${talkingWho === p.seat.seat ? "talking" : ""} ${meeting?.speaking === p.seat.seat ? "thinking" : ""}`}
                  style={{ left: p.box.x, top: p.box.y, width: p.box.w, height: p.box.h }}
                >
                  <img src={`/avatar/meeting/seated/${p.cast.rig}.webp?v=2`} alt={p.cast.name} draggable={false} />
                </div>
              ))}
              <div className={`av-halo ${meeting?.speaking === "chair" ? "busy" : ""}`} style={{ left: VX, top: eyeAt(P_CHAIR) - (30 * bustK) / 0.6, "--halo": css(chairWho.tint), scale: String(bustK / 0.6) } as React.CSSProperties} />
              <Bust cast={chairWho} talking={talkingWho === "chair"} thinking={meeting?.speaking === "chair"} poked={0} on={{}} box={bust} gazeBus={gazeBus} extra="mt-chair" />
              {desk?.seated && chibi}
              <img className="mt-front" src="/avatar/meeting/front.webp?v=3" alt="" draggable={false} style={{ top: ROOM.frontY }} />
              {desk && !desk.seated && chibi}
            </div>

            {/* name plates on the table and the words over the heads: on the screen, not scaled, so they stay readable */}
            {places.map((p) => (
              <div key={`p${p.seat.seat}`} className={`mt-plate ${p.seat.available ? "" : "empty"}`} style={{ ...at(p.plate[0], p.plate[1]), "--c": css(p.cast.tint) } as React.CSSProperties} title={p.seat.reason ?? ""}>
                <b>{p.cast.name}</b>
                {!p.seat.available && <span>{t(p.seat.reason ?? "연결 안 됨")}</span>}
              </div>
            ))}
            {desk && deskSeat && (
              <div className={`mt-plate desk ${deskSeat.available ? "" : "empty"}`} style={{ ...at(desk.plate[0], desk.plate[1]), "--c": css(CAST[RIG[deskSeat.seat]].tint) } as React.CSSProperties} title={deskSeat.reason ?? t("의장의 캐릭터가 위원으로도 앉았어요")}>
                <b>{CAST[RIG[deskSeat.seat]].name}</b>
                {!deskSeat.available && <span>{t(deskSeat.reason ?? "연결 안 됨")}</span>}
              </div>
            )}
            {desk &&
              deskSeat &&
              (() => {
                const b = bubbleOf(deskSeat.seat);
                if (!b) return null;
                const pos = at(desk.x, desk.feet - desk.size * (CHIBI_FLOOR - 0.12));
                return (
                  <div key={`bd${lastKey}`} className={`mt-bubble ${b.dots ? "dots" : ""}`} style={{ ...bubbleAt(pos.left, pos.top), "--c": css(CAST[RIG[deskSeat.seat]].tint) } as React.CSSProperties} onClick={() => setLogOpen(true)}>
                    {b.dots ? (
                      <span className="vz-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      b.text
                    )}
                  </div>
                );
              })()}
            <div className="mt-plate chair" style={{ ...at(VX, ROOM.far[1] + 34), "--c": css(chairWho.tint) } as React.CSSProperties}>
              <b>{t("의장 · {name}", { name: chairWho.name })}</b>
            </div>
            {places.map((p) => {
              const b = bubbleOf(p.seat.seat);
              if (!b) return null;
              const pos = at(p.x, p.headTop - 12);
              return (
                <div key={`b${p.seat.seat}${lastKey}`} className={`mt-bubble ${b.dots ? "dots" : ""}`} style={{ ...bubbleAt(pos.left, pos.top), "--c": css(p.cast.tint) } as React.CSSProperties} onClick={() => setLogOpen(true)}>
                  {b.dots ? (
                    <span className="vz-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    b.text
                  )}
                </div>
              );
            })}
            {meeting?.speaking === "chair" && !wordsUp && (
              <div className="mt-bubble dots" style={{ ...at(VX, chairHeadTop - 6), "--c": css(chairWho.tint) } as React.CSSProperties}>
                <span className="vz-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </>
        )}

        <header className="vz-top">
          <div className="vz-id">
            <div className="vz-brand">
              <span className="vz-mark">✦</span>
              <span className="vz-brand-name">GENCOUNCIL</span>
            </div>
            <div className="vz-nav">
              <ModeSwitch mode={{ room: "meeting", look }} onChange={onMode} />
            </div>
            <nav className="vz-dock" aria-label={t("회의 설정")}>
              <button className={setOpen ? "on" : ""} onClick={() => setSetOpen((o) => !o)} title={t("회의 설정 · 의장과 위원")}>
                <i>⚙</i>
                <span className="vz-dock-label">{t("설정")}</span>
              </button>
              <ReloadButton />
            </nav>
          </div>
          <span className="vz-use-wrap">
            <UsageMini usage={usage ?? null} onOpen={() => onWorkshop()} />
          </span>
        </header>

        {setOpen && (
          <div className="mt-set" role="dialog" aria-label={t("회의 설정")}>
            <div className="mt-set-head">
              <b>{t("회의 설정")}</b>
              <button onClick={() => setSetOpen(false)} title={t("닫기")}>
                ✕
              </button>
            </div>
            <div className="mt-set-label">{t("의장")}</div>
            <div className="mt-set-row">
              {CHAIRS.map((c) => {
                const who = CAST[RIG[seatOfProvider(c)]];
                return (
                  <button key={c} className={settings.chair === c ? "on" : ""} disabled={live} style={{ "--c": css(who.tint) } as React.CSSProperties} onClick={() => void onSettings({ chair: c }).catch((e) => notify((e as Error).message))}>
                    {who.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-set-label">{t("위원")}</div>
            <div className="mt-set-row">
              {ORDER.map((s) => {
                const who = CAST[RIG[s]];
                const on = settings.members.includes(s);
                const note = s === seatOfProvider(settings.chair) ? t("꼬마 위원") : UNWIRED.includes(s) ? t("연결 안 됨") : "";
                return (
                  <button
                    key={s}
                    className={on ? "on" : ""}
                    disabled={live}
                    style={{ "--c": css(who.tint) } as React.CSSProperties}
                    onClick={() => void onSettings({ members: on ? settings.members.filter((x) => x !== s) : [...settings.members, s] }).catch((e) => notify((e as Error).message))}
                  >
                    {on ? "✓ " : ""}
                    {who.name}
                    {note && <small>{note}</small>}
                  </button>
                );
              })}
            </div>
            <div className="mt-set-label">{t("모델 · 추론")}</div>
            <div className="mt-set-models">
              {[{ key: "chair" as const, seat: seatOfProvider(settings.chair), label: t("의장 · {name}", { name: CAST[RIG[seatOfProvider(settings.chair)]].name }) }, ...settings.members.filter((s) => PROVIDER_OF[s]).map((s) => ({ key: s, seat: s, label: CAST[RIG[s]].name }))].map(({ key, seat, label }) => {
                const provider = PROVIDER_OF[seat]!;
                const info = models?.providers.find((p) => p.id === provider);
                const pick = key === "chair" ? { model: settings.chairModel, effort: settings.chairEffort } : settings.seats?.[key] ?? {};
                const save = (field: "model" | "effort", value: string) => {
                  const v = value || null;
                  const patch: Partial<Record<keyof MeetingSettings, unknown>> =
                    key === "chair" ? (field === "model" ? { chairModel: v } : { chairEffort: v }) : { seats: { ...(settings.seats ?? {}), [key]: { ...pick, [field]: v ?? undefined } } };
                  void onSettings(patch).catch((e) => notify((e as Error).message));
                };
                return (
                  <div key={key} className="mt-set-model" style={{ "--c": css(CAST[RIG[seat]].tint) } as React.CSSProperties}>
                    <span>{label}</span>
                    <select value={pick.model ?? ""} disabled={live || !info} onChange={(e) => save("model", e.target.value)} aria-label={t("{label} 모델", { label })}>
                      <option value="">{key === "chair" ? t("기본") : t("기본 (일꾼)")}</option>
                      {info?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    {info?.effort !== false && (
                      <select value={pick.effort ?? ""} disabled={live || !info} onChange={(e) => save("effort", e.target.value)} aria-label={t("{label} 추론", { label })}>
                        <option value="">{t("추론 기본 (낮음)")}</option>
                        {(info?.efforts ?? []).map((e) => (
                          <option key={e} value={e}>
                            {t("추론 {v}", { v: t(EFFORT_KO[e] ?? e) })}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
              {!models && <p className="mt-set-note">{t("모델 목록을 불러오는 중…")}</p>}
            </div>
            <p className="mt-set-note">{live ? t("회의가 끝나면 바꿀 수 있어요.") : t("의장의 캐릭터를 위원에 넣으면 꼬마가 되어 빈자리(없으면 책상 위)에 앉아 한 사람 몫의 의견을 내요. 연결 안 된 위원은 자리만 지켜요. 옆자리는 4개까지, 모델·추론을 비우면 일꾼 모델에 추론 낮음이에요.")}</p>
          </div>
        )}

        {/* the record of the meeting */}
        <aside
          className={`mt-log ${logOpen ? "open" : ""}`}
          aria-label={t("회의록")}
          style={portrait && view ? { top: Math.round(view.oy + (ROOM.keepTo - 20) * view.s) } : portrait && orbitBox ? { top: Math.round(orbitBox.y + orbitBox.h) } : undefined}
        >
          <div className="mt-log-head">
            <b>{viewed ? t("지난 회의") : t("회의록")}</b>
            {meeting && <span>{viewed ? when(viewed.startedAt) + " · " : ""}{statusLabel(meeting.status)}</span>}
            {viewed && (
              <button className="mt-log-back" onClick={() => setViewed(null)} title={t("지금 회의로 돌아가기")}>
                ← {t("지금 회의")}
              </button>
            )}
            {past && (
              <button
                className={`mt-log-past ${pastOpen ? "on" : ""}`}
                onClick={() => {
                  setPastOpen((o) => !o);
                  if (!pastOpen) refreshPast();
                }}
                title={t("지난 회의 보기 · 지우기")}
              >
                {t("지난 회의")}
              </button>
            )}
            {!portrait && look !== "text" && (
              <button onClick={() => setLogOpen(false)} title={t("회의록 접기")}>
                ✕
              </button>
            )}
          </div>
          {pastOpen && past && (
            <div className="mt-past" role="list" aria-label={t("지난 회의")}>
              {pastList === null && <p className="mt-log-empty">{t("불러오는 중…")}</p>}
              {pastList?.length === 0 && <p className="mt-log-empty">{t("지난 회의가 없습니다.")}</p>}
              {pastList?.map((m) => (
                <div key={m.id} role="listitem" className={`mt-past-row ${meeting?.id === m.id ? "on" : ""}`}>
                  <button
                    className="mt-past-open"
                    onClick={() => {
                      past.open(m.id).then(
                        (full) => {
                          setViewed(current?.id === full.id ? null : full);
                          setPastOpen(false);
                          setLogOpen(true);
                        },
                        (e: Error) => notify(e.message),
                      );
                    }}
                  >
                    <b>{m.topic}</b>
                    <small>
                      {t("{when} · 의장 {chair} · 발언 {n} · {status}", { when: when(m.startedAt), chair: m.chair, n: m.turns, status: statusLabel(m.status) })}
                    </small>
                  </button>
                  <button
                    className="mt-past-del"
                    disabled={m.status === "running"}
                    title={m.status === "running" ? t("진행 중인 회의는 지울 수 없어요") : t("이 회의록 지우기")}
                    onClick={() => {
                      if (!confirm(t("\"{topic}\" 회의록을 지울까요? 되돌릴 수 없습니다.", { topic: m.topic }))) return;
                      past.remove(m.id).then(
                        () => {
                          if (viewed?.id === m.id) setViewed(null);
                          setPastList((cur) => cur?.filter((x) => x.id !== m.id) ?? cur);
                        },
                        (e: Error) => notify(e.message),
                      );
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-topic">
            {meeting ? (
              <>
                <span className="mt-topic-key">{t("주제")}</span>
                <span className="mt-topic-text" title={meeting.topic}>
                  {meeting.topic}
                </span>
                <span className="mt-phases">
                  {PHASES.map(([p, label], i) => (
                    <i key={p} className={meeting.phase === "done" || i < phaseAt ? "past" : i === phaseAt ? "now" : ""}>
                      {t(label)}
                    </i>
                  ))}
                </span>
              </>
            ) : (
              <span className="mt-topic-text dim">{t("주제를 던지면 위원들이 차례로 의견을 내고 토론한 뒤, 의장이 결론을 정리합니다.")}</span>
            )}
          </div>
          {look === "text" && (
            <div className="mt-roster" aria-label={t("참석자")}>
              {[{ seat: chairSeat, name: chairWho.name, available: true, chair: true } as MeetingSeat & { chair?: boolean }, ...seats].map((s) => {
                const isChair = "chair" in s && s.chair;
                const id = isChair ? "chair" : s.seat;
                const state = meeting?.speaking === id ? t("생각 중") : talkingWho === id ? t("발언") : !s.available ? t(s.reason ?? "연결 안 됨") : isChair ? t("의장") : s.desk ? t("의장 겸 위원") : t("대기");
                return (
                  <span key={id} className={`mt-chip ${meeting?.speaking === id ? "thinking" : ""} ${talkingWho === id ? "talking" : ""} ${s.available ? "" : "off"}`} style={{ "--c": css(CAST[RIG[s.seat]].tint) } as React.CSSProperties}>
                    <i />
                    <b>{t(s.name)}</b>
                    <small>{state}</small>
                  </span>
                );
              })}
            </div>
          )}
          <div className="mt-log-body">
            {!turns.length && !meeting?.speaking && <p className="mt-log-empty">{t("아직 발언이 없습니다.")}</p>}
            {turns.map((turn, i) => {
              const head = i === 0 || turns[i - 1].phase !== turn.phase || turns[i - 1].round !== turn.round;
              const c = turn.who === "chair" ? logChair : CAST[RIG[turn.who]];
              return (
                <div key={i}>
                  {head && <div className="mt-log-phase">{turn.phase === "debate" ? t("자유 토론 {n}", { n: turn.round }) : t(PHASE_KO[turn.phase])}</div>}
                  <div className={`mt-turn ${turn.who === "chair" ? "chair" : ""} ${turn.error ? "failed" : ""}`} style={{ "--c": css(c.tint) } as React.CSSProperties}>
                    <div className="mt-turn-who">
                      <b>{turn.who === "chair" ? t("의장 · {name}", { name: c.name }) : c.name}</b>
                      {turn.model && <span>{turn.model}</span>}
                    </div>
                    {turn.error ? <p className="mt-turn-err">{t("응답하지 못했습니다 ({err})", { err: turn.error })}</p> : turn.who === "chair" ? <Summary text={turn.text} /> : <p>{turn.text}</p>}
                  </div>
                </div>
              );
            })}
            {meeting?.speaking && (
              <div className="mt-turn waiting">
                <div className="mt-turn-who">
                  <b>{meeting.speaking === "chair" ? t("의장 · {name}", { name: logChair.name }) : CAST[RIG[meeting.speaking]].name}</b>
                </div>
                <span className="vz-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
            {meeting?.error && <p className="mt-turn-err">{meeting.error}</p>}
            <div ref={logEnd} />
          </div>
        </aside>
        {!logOpen && !portrait && (
          <button className="mt-log-tab" onClick={() => setLogOpen(true)}>
            {t("회의록")}{turns.length ? ` ${turns.length}` : ""}
          </button>
        )}

        {/* the chair's conclusion */}
        {summary && card === meeting?.id && (
          <div className="mt-card" role="dialog" aria-label={t("회의 결론")}>
            <div className="mt-card-head" style={{ "--c": css(logChair.tint) } as React.CSSProperties}>
              <b>{t("의장 정리 · {name}", { name: logChair.name })}</b>
              <button onClick={() => setCard("")} title={t("닫기")}>
                ✕
              </button>
            </div>
            <div className="mt-card-topic">{meeting!.topic}</div>
            <Summary text={summary.text} />
          </div>
        )}

        <footer className="vz-bottom mt-bottom">
          <div className="mt-ask">
            {running ? (
              <>
                <span className="mt-ask-now">
                  {meeting!.speaking ? (meeting!.speaking === "chair" ? t("의장이 말을 고르는 중…") : t("{name}이(가) 말을 고르는 중…", { name: CAST[RIG[meeting!.speaking]].name })) : t("회의 진행 중…")}
                </span>
                <button className="mt-stop" onClick={() => void onStop(meeting!.id).catch((e) => notify((e as Error).message))}>
                  {t("회의 중지")}
                </button>
              </>
            ) : (
              <>
                <input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void start();
                  }}
                  placeholder={meeting ? t("다음 회의 주제") : t("회의 주제를 던져 주세요")}
                  aria-label={t("회의 주제")}
                  maxLength={2000}
                />
                <button className="mt-go" disabled={!topic.trim() || sending} onClick={() => void start()}>
                  {t("회의 시작")}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
