// Draws the scene on a canvas: the night sky, the chair's eclipse, the three houses and the light
// that runs between them. Names and buttons are HTML on top of this; nothing here is clickable.
import { HOUSE_NAME, rgba, TINT, type HouseId, type HouseNode, type Rgb, type Scene, type TintId, type WorkerNode } from "./scene";

/** something that just happened, shown as a burst of light */
export type VisionEvent =
  /** the chair stirs: a tool call, an event it reacts to */
  | { type: "chair" }
  /** the user's words reach the chair */
  | { type: "user"; text?: string }
  /** the chair answers the user */
  | { type: "say"; text?: string }
  /** the chair sends a member out */
  | { type: "assign"; house: HouseId; member: string; name?: string; taskId?: string }
  /** a member's log line: a tool call or a sentence */
  | { type: "line"; member: string; text?: string }
  /** another model takes the chair (from one company's colour to another's) */
  | { type: "crown"; from: HouseId; to: HouseId }
  /** a member is finished and reports */
  | { type: "done"; member: string; house?: HouseId; name?: string; ok?: boolean; summary?: string }
  /** the user touched something in the picture */
  | { type: "touch"; x: number; y: number; r: number; tint: TintId }
  | { type: "finish" };

interface Path {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
}
interface Particle {
  p: Path;
  /** 0..1 along the path; negative while it waits its turn in a burst */
  t: number;
  v: number;
  a: Rgb;
  b: Rgb;
  size: number;
}
/** one stretch of a packet's journey; its path is looked up when the packet gets there */
type Leg =
  | { kind: "beam"; house: HouseId; rev: boolean }
  | { kind: "hub"; house: HouseId; member: string; rev: boolean }
  | { kind: "thread"; member: string; rev: boolean }
  | { kind: "port"; rev: boolean };
/** a piece of data on its way: an order going down, a report coming back */
interface Packet {
  legs: Leg[];
  i: number;
  path: Path | null;
  t: number;
  dur: number;
  c: Rgb;
  label: string;
  big: boolean;
  x?: number;
  y?: number;
  trail: Array<[number, number]>;
}
interface Wave {
  x: number;
  y: number;
  r0: number;
  r1: number;
  t: number;
  dur: number;
  c: Rgb;
}
interface Star {
  x: number;
  y: number;
  r: number;
  ph: number;
  sp: number;
}

const TAU = Math.PI * 2;
const WHITE: Rgb = [255, 255, 255];
const USER: Rgb = [196, 186, 255];
const RED: Rgb = [255, 104, 104];
/** seconds the picture takes to slide to a new height; VisionView moves the labels with the same curve */
export const SLIDE = 0.7;
/** seconds the old chair's light takes to be drawn in before the new chair bursts out; VisionView swaps the name at that moment */
export const CROWN = 0.8;
/** seconds a new member takes to step out of its rung */
const BIRTH = 1;
/** seconds a house's dial takes to turn once when it chooses a model */
const SPIN = 1.3;
/** seconds from the order leaving the chair to the new member stepping out: the dial has stopped and the order has reached the rung */
const LOCK = SPIN + 0.15;
const EFFORT_PIPS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const MAX_PARTICLES = 520;
const FONT = 'system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif';

const straight = (x0: number, y0: number, x1: number, y1: number): Path => ({ x0, y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x1, y1 });
const reverse = (p: Path): Path => ({ x0: p.x1, y0: p.y1, cx: p.cx, cy: p.cy, x1: p.x0, y1: p.y0 });
const at = (p: Path, t: number): [number, number] => {
  const k = 1 - t;
  return [k * k * p.x0 + 2 * k * t * p.cx + t * t * p.x1, k * k * p.y0 + 2 * k * t * p.cy + t * t * p.y1];
};
/** the same numbers every time, so the sky does not reshuffle on a resize */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) / 4294967296;
};

export class VisionRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scene: Scene | null = null;
  private bg: HTMLCanvasElement | null = null;
  private twinkle: Star[] = [];
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private beams = new Map<HouseId, Path>();
  private threads = new Map<string, Path>();
  private edges: Array<{ p: Path; a: Rgb; b: Rgb }> = [];
  private sprites = new Map<string, HTMLCanvasElement>();
  private lastLine = new Map<string, number>();
  private packets: Packet[] = [];
  private port: Path | null = null;
  /** when each working member appeared, for growing it out of its rung */
  private born = new Map<string, number>();
  private seen = new Map<string, { x: number; y: number; c: Rgb }>();
  private lastAssign = new Map<HouseId, number>();
  /** a new chair taking over: since when, and the colours of the old and the new chair's company */
  private crown: { at: number; from: Rgb; to: Rgb } | null = null;
  /** the houses that are choosing right now: when the dial started to turn, and for whom */
  private spins = new Map<HouseId, { at: number; picks: Array<{ member: string; name?: string }> }>();
  private lastSay = -1;
  private raf = 0;
  private last = 0;
  private time = 0;
  private sinceDraw = 1;
  private dpr = 1;
  private busy = 0;
  /** the picture moved up or down: how far off its new place it is still drawn, and since when */
  private slide = 0;
  private slideAt = -10;
  /** the user asked the system for less motion: no particles, a redraw now and then */
  private readonly still: boolean;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // a slow frame still moves the clock on: a throttled tab must not fall minutes behind what the page says
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      this.time += dt;
      this.sinceDraw += dt;
      if (this.still && this.sinceDraw < 0.4) return;
      this.frame(this.still ? 0 : dt);
      this.sinceDraw = 0;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setScene(s: Scene): void {
    const prev = this.scene;
    this.scene = s;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!prev || prev.w !== s.w || prev.h !== s.h || dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = Math.round(s.w * dpr);
      this.canvas.height = Math.round(s.h * dpr);
      this.buildSky(s);
      // light already in flight was aimed at the old positions
      this.particles = [];
      this.waves = [];
      this.packets = [];
    }
    // The whole picture moved up or down (a house gained or lost the members above it): slide there
    // instead of jumping, and take the light already in flight along.
    const dy = prev && prev.w === s.w && prev.h === s.h ? s.chair.y - prev.chair.y : 0;
    if (Math.abs(dy) > 0.5) {
      this.buildSky(s);
      const moved = new Set<Path>();
      const move = (p: Path | null) => {
        if (!p || moved.has(p)) return;
        moved.add(p);
        p.y0 += dy;
        p.cy += dy;
        p.y1 += dy;
      };
      for (const q of this.particles) move(q.p);
      for (const k of this.packets) {
        move(k.path);
        if (k.y !== undefined) k.y += dy;
        for (const tr of k.trail) tr[1] += dy;
      }
      for (const wv of this.waves) wv.y += dy;
      for (const v of this.seen.values()) v.y += dy;
      if (!this.still) {
        this.slide = this.slideNow() - dy;
        this.slideAt = this.time;
      }
    }
    const ch = s.chair;
    this.beams.clear();
    for (const h of s.houses) {
      const x0 = ch.x + Math.cos(h.out) * (ch.haloR + 0.08 * s.u);
      const y0 = ch.y + Math.sin(h.out) * (ch.haloR + 0.08 * s.u);
      const x1 = h.x - Math.cos(h.out) * (h.ringR + 0.1 * s.u);
      const y1 = h.y - Math.sin(h.out) * (h.ringR + 0.1 * s.u);
      // the two lower beams sag a little, like hanging threads
      const side = Math.abs(h.x - ch.x) > 1;
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      let nx = -(y1 - y0) / len;
      let ny = (x1 - x0) / len;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      // a short beam barely sags: a deep curve between close neighbours reads as a hook
      const bend = side ? Math.min(0.34 * s.u, len * 0.14) : 0;
      this.beams.set(h.id, { x0, y0, cx: (x0 + x1) / 2 + nx * bend, cy: (y0 + y1) / 2 + ny * bend, x1, y1 });
    }
    // the user's line to the chair
    {
      const a = Math.atan2(s.port.y - ch.y, s.port.x - ch.x);
      const x0 = ch.x + Math.cos(a) * (ch.haloR + 0.08 * s.u);
      const y0 = ch.y + Math.sin(a) * (ch.haloR + 0.08 * s.u);
      this.port = { x0, y0, cx: (x0 + s.port.x) / 2, cy: (y0 + s.port.y) / 2 - (s.portrait ? 0 : 0.5 * s.u), x1: s.port.x, y1: s.port.y };
    }
    // who is new, who has left
    const now = this.workers(s);
    const ids = new Set(now.map((w) => w.id));
    for (const [id, last] of this.seen) {
      if (ids.has(id)) continue;
      this.seen.delete(id);
      this.born.delete(id);
      if (!this.still && prev) this.wave(last.x, last.y, s.workerR, s.workerR * 5, 1.2, last.c);
    }
    for (const w of now) {
      this.seen.set(w.id, { x: w.x, y: w.y, c: TINT[w.house] });
      if (this.born.has(w.id)) continue;
      if (this.still) {
        this.born.set(w.id, -100);
        continue;
      }
      // sent out a moment ago: wait for the order to arrive before stepping out
      const sent = w.house !== "relay" ? this.lastAssign.get(w.house) : undefined;
      const wait = sent !== undefined && this.time - sent < LOCK + 1 ? Math.max(0, sent + LOCK - this.time) : 0;
      this.born.set(w.id, this.time + wait);
      this.waves.push({ x: w.fromX, y: w.fromY, r0: 2, r1: 0.9 * s.u, t: -wait, dur: 1.1, c: TINT[w.house] });
      this.waves.push({ x: w.x, y: w.y, r0: s.workerR, r1: s.workerR * 4.2, t: -wait - BIRTH * 0.8, dur: 1.2, c: TINT[w.house] });
    }
    this.threads.clear();
    for (const w of this.workers(s)) {
      const len = Math.hypot(w.x - w.fromX, w.y - w.fromY) || 1;
      const k = Math.max(0, len - s.workerR - 2) / len;
      this.threads.set(w.id, straight(w.fromX, w.fromY, w.fromX + (w.x - w.fromX) * k, w.fromY + (w.y - w.fromY) * k));
    }
    this.edges = [];
    for (let i = 0; i < s.houses.length; i++) {
      const a = s.houses[i];
      const b = s.houses[(i + 1) % s.houses.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const cut = (a.ringR + 0.14 * s.u) / len;
      this.edges.push({
        p: straight(a.x + (b.x - a.x) * cut, a.y + (b.y - a.y) * cut, b.x - (b.x - a.x) * cut, b.y - (b.y - a.y) * cut),
        a: TINT[a.id],
        b: TINT[b.id],
      });
    }
    if (this.still) this.sinceDraw = 1;
  }

  pulse(ev: VisionEvent): void {
    const s = this.scene;
    if (!s || this.still) return;
    const ch = s.chair;
    const gold = TINT.chair;
    switch (ev.type) {
      case "chair":
        this.wave(ch.x, ch.y, ch.r, ch.haloR * 1.7, 1.5, gold);
        break;
      case "user":
        this.send([{ kind: "port", rev: true }], USER, "요청", true);
        break;
      case "say":
        // a long answer arrives in pieces; one packet is enough for a burst of them
        if (this.time - this.lastSay < 0.7) return;
        this.lastSay = this.time;
        this.wave(ch.x, ch.y, ch.r, ch.haloR * 1.3, 1.1, gold);
        this.send([{ kind: "port", rev: false }], gold, "응답", true);
        break;
      case "crown": {
        const from = TINT[ev.from];
        const to = TINT[ev.to];
        this.crown = { at: this.time, from, to };
        const far = Math.max(s.w, s.h);
        // the old chair's light is drawn in: sparks fall into the disc from all round
        for (let i = 0; i < 46; i++) {
          const a = Math.random() * TAU;
          const d = s.u * (2.2 + Math.random() * 2.8);
          this.spawn(straight(ch.x + Math.cos(a) * d, ch.y + Math.sin(a) * d, ch.x + Math.cos(a) * ch.r * 0.3, ch.y + Math.sin(a) * ch.r * 0.3), from, WHITE, CROWN * (0.55 + Math.random() * 0.45), 0.9 + Math.random(), -Math.random() * 0.3);
        }
        // then the new chair bursts out: rings across the whole sky…
        for (let i = 0; i < 4; i++) this.waves.push({ x: ch.x, y: ch.y, r0: ch.r * (1 + i * 0.25), r1: far * (0.3 + i * 0.14), t: -CROWN - i * 0.13, dur: 1.7 + i * 0.4, c: i % 2 ? gold : to });
        // …sparks thrown out in every direction…
        for (let i = 0; i < 60; i++) {
          const a = Math.random() * TAU;
          const d = s.u * (2.4 + Math.random() * 4);
          const seconds = 0.8 + Math.random() * 0.8;
          this.spawn(straight(ch.x + Math.cos(a) * ch.r, ch.y + Math.sin(a) * ch.r, ch.x + Math.cos(a) * d, ch.y + Math.sin(a) * d), WHITE, i % 3 ? to : gold, seconds, 1 + Math.random() * 1.2, -(CROWN + Math.random() * 0.12) / seconds);
        }
        // …and a surge down each beam that makes every house answer
        for (const h of s.houses) {
          const p = this.beams.get(h.id);
          if (!p) continue;
          for (let i = 0; i < 12; i++) {
            const seconds = 0.95 + Math.random() * 0.3;
            this.spawn(p, gold, TINT[h.id], seconds, 1.2 + Math.random(), -(CROWN + i * 0.04) / seconds);
          }
          this.waves.push({ x: h.x, y: h.y, r0: h.coreR, r1: h.ringR * 1.7, t: -(CROWN + 0.95), dur: 1.3, c: TINT[h.id] });
          this.waves.push({ x: h.x, y: h.y, r0: h.ringR, r1: h.ringR * 2.4, t: -(CROWN + 1.1), dur: 1.5, c: TINT[h.id] });
        }
        break;
      }
      case "touch":
        this.wave(ev.x, ev.y, ev.r * 0.9, ev.r * 1.7, 0.7, TINT[ev.tint]);
        this.wave(ev.x, ev.y, ev.r, ev.r * 2.6, 1.1, TINT[ev.tint]);
        break;
      case "assign": {
        const p = this.beams.get(ev.house);
        if (!p) return;
        // several orders to one house in a row are one turn of its dial: every model chosen lights up when it stops
        const turning = this.spins.get(ev.house);
        if (turning && this.time - turning.at < SPIN) turning.picks.push({ member: ev.member, name: ev.name });
        else {
          this.spins.set(ev.house, { at: this.time, picks: [{ member: ev.member, name: ev.name }] });
          this.lastAssign.set(ev.house, this.time);
        }
        this.wave(ch.x, ch.y, ch.ringR, ch.haloR * 1.35, 1.1, TINT[ev.house]);
        this.burst(p, 8, gold, TINT[ev.house], 1.6);
        this.send(
          [
            { kind: "beam", house: ev.house, rev: false },
            { kind: "hub", house: ev.house, member: ev.member, rev: false },
            { kind: "thread", member: ev.member, rev: false },
          ],
          TINT[ev.house],
          "지시",
          true,
        );
        break;
      }
      case "line": {
        const now = this.time;
        if (now - (this.lastLine.get(ev.member) ?? -1) < 0.8) return;
        const w = this.workers(s).find((x) => x.id === ev.member);
        if (!w || w.house === "relay") return;
        this.lastLine.set(ev.member, now);
        this.send(
          [
            { kind: "thread", member: w.id, rev: true },
            { kind: "hub", house: w.house, member: w.id, rev: true },
            { kind: "beam", house: w.house, rev: true },
          ],
          TINT[w.house],
          "",
          false,
        );
        break;
      }
      case "done": {
        const w = this.workers(s).find((x) => x.id === ev.member);
        const house = (w && w.house !== "relay" ? w.house : undefined) ?? ev.house;
        if (w) this.wave(w.x, w.y, s.workerR, s.workerR * 4.5, 1.3, TINT[w.house]);
        const beam = house ? this.beams.get(house) : undefined;
        if (!house || !beam) {
          this.wave(ch.x, ch.y, ch.r, ch.haloR * 1.5, 2.2, gold);
          return;
        }
        const failed = ev.ok === false;
        this.burst(reverse(beam), 10, TINT[house], gold, 2);
        this.send(
          [
            { kind: "thread", member: ev.member, rev: true },
            { kind: "hub", house, member: ev.member, rev: true },
            { kind: "beam", house, rev: true },
          ],
          failed ? RED : TINT[house],
          failed ? "중단" : "보고",
          true,
        );
        break;
      }
      case "finish":
        for (let i = 0; i < 3; i++) this.wave(ch.x, ch.y, ch.r * (1 + i * 0.4), Math.max(s.w, s.h) * (0.35 + i * 0.12), 2.6 + i * 0.5, gold);
        break;
    }
  }

  /**
   * The dial of a house while it chooses: how far it is turned (one full turn, slow-fast-slow, then a
   * small overshoot as it clicks into place), how long ago it started, and which rungs it is choosing.
   * The rung is the one the new member hangs from; before the member is on the stage, the one its name says.
   */
  private dial(h: HouseNode): { rot: number; age: number; rungs: number[] } | null {
    const sp = this.spins.get(h.id);
    if (!sp) return null;
    const age = this.time - sp.at;
    if (age > SPIN + 1.5) {
      this.spins.delete(h.id);
      return null;
    }
    const dir = h.id === "gpt" ? -1 : 1;
    let rot = 0;
    if (age < SPIN) {
      const k = age / SPIN;
      rot = dir * TAU * (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
    } else {
      const q = (age - SPIN) / 0.4;
      if (q < 1) rot = dir * 0.11 * Math.sin(q * TAU) * (1 - q);
    }
    const rungs = new Set<number>();
    for (const p of sp.picks) {
      const w = h.workers.find((x) => x.id === p.member);
      let i = w ? h.rungs.findIndex((r) => Math.abs(r.x - w.fromX) < 0.5 && Math.abs(r.y - w.fromY) < 0.5) : -1;
      if (i < 0 && !w && p.name) {
        const name = p.name.toUpperCase();
        i = h.rungs.findIndex((r) => name.includes(r.word));
      }
      if (i >= 0) rungs.add(i);
    }
    return { rot, age, rungs: [...rungs] };
  }

  /** how far from its place the picture is drawn right now (the same curve the labels over it follow) */
  private slideNow(): number {
    const k = (this.time - this.slideAt) / SLIDE;
    return k >= 1 || k < 0 ? 0 : this.slide * (1 - k) ** 3;
  }

  private workers(s: Scene): WorkerNode[] {
    return [...s.houses.flatMap((h) => h.workers), ...s.relays];
  }

  private send(legs: Leg[], c: Rgb, label: string, big: boolean): void {
    if (this.packets.length >= 40) return;
    const k: Packet = { legs, i: -1, path: null, t: 0, dur: 1, c, label, big, trail: [] };
    if (this.nextLeg(k)) this.packets.push(k);
  }

  /** move a packet on to its next stretch; false when its journey is over */
  private nextLeg(k: Packet): boolean {
    const s = this.scene!;
    for (k.i++; k.i < k.legs.length; k.i++) {
      const leg = k.legs[k.i];
      let p: Path | null = null;
      let dur = 1;
      if (leg.kind === "beam") {
        const b = this.beams.get(leg.house);
        p = b ? (leg.rev ? reverse(b) : b) : null;
        dur = 1.05;
      } else if (leg.kind === "port") {
        p = this.port ? (leg.rev ? reverse(this.port) : this.port) : null;
        dur = 0.95;
      } else if (leg.kind === "thread") {
        const th = this.threads.get(leg.member);
        p = th ? (leg.rev ? reverse(th) : th) : null;
        dur = 0.5;
      } else {
        // through the house: between where the beam lands and the rung of the member
        const h = s.houses.find((x) => x.id === leg.house);
        const b = this.beams.get(leg.house);
        if (!h || !b) continue;
        const th = this.threads.get(leg.member);
        const rung = th ? { x: th.x0, y: th.y0 } : { x: h.x, y: h.y };
        const here = k.x !== undefined && k.y !== undefined ? { x: k.x, y: k.y } : leg.rev ? rung : { x: b.x1, y: b.y1 };
        const to = leg.rev ? { x: b.x1, y: b.y1 } : rung;
        p = { x0: here.x, y0: here.y, cx: h.x, cy: h.y, x1: to.x, y1: to.y };
        dur = 0.4;
      }
      if (!p) continue;
      k.path = p;
      k.t = 0;
      k.dur = k.big ? dur : dur * 0.8;
      return true;
    }
    return false;
  }

  /** what a packet sets off where it lands */
  private arrive(k: Packet): void {
    const s = this.scene!;
    const leg = k.legs[k.i];
    const ch = s.chair;
    if (leg.kind === "beam") {
      const h = s.houses.find((x) => x.id === leg.house);
      if (leg.rev) this.wave(ch.x, ch.y, ch.r, ch.haloR * (k.big ? 1.6 : 1.2), k.big ? 1.8 : 0.9, k.big ? TINT.chair : k.c);
      else if (h) this.wave(h.x, h.y, h.coreR, h.ringR * 1.35, 1.2, k.c);
    } else if (leg.kind === "thread") {
      if (!leg.rev && k.path) this.wave(k.path.x1, k.path.y1, s.workerR, s.workerR * 3.6, 1, k.c);
    } else if (leg.kind === "port") {
      if (leg.rev) this.wave(ch.x, ch.y, ch.r, ch.haloR * 1.5, 1.6, k.c);
      else this.wave(s.port.x, s.port.y, 2, 0.8 * s.u, 1, k.c);
    } else if (k.big) {
      const h = s.houses.find((x) => x.id === leg.house);
      if (h) this.wave(h.x, h.y, h.coreR * 0.6, h.coreR * 1.6, 0.6, k.c);
    }
  }

  private wave(x: number, y: number, r0: number, r1: number, dur: number, c: Rgb): void {
    this.waves.push({ x, y, r0, r1, t: 0, dur, c });
  }

  private spawn(p: Path, a: Rgb, b: Rgb, seconds: number, size: number, t = 0): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push({ p, t, v: 1 / seconds, a, b, size });
  }

  private burst(p: Path, n: number, a: Rgb, b: Rgb, seconds: number): void {
    for (let i = 0; i < n; i++) this.spawn(p, a, b, seconds * (0.85 + Math.random() * 0.3), 1.1 + Math.random() * 0.9, -i * 0.045);
  }

  private sprite(c: Rgb): HTMLCanvasElement {
    const key = c.join();
    let s = this.sprites.get(key);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.14, rgba(c, 0.85));
    grad.addColorStop(0.45, rgba(c, 0.2));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprites.set(key, s);
    return s;
  }

  /** an additive soft dot */
  private glow(x: number, y: number, r: number, c: Rgb, alpha: number): void {
    if (alpha <= 0.004 || r <= 0) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(this.sprite(c), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private buildSky(s: Scene): void {
    const c = document.createElement("canvas");
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d")!;
    g.scale(this.dpr, this.dpr);
    const lin = g.createLinearGradient(0, 0, 0, s.h);
    lin.addColorStop(0, "#04050d");
    lin.addColorStop(0.55, "#080a1b");
    lin.addColorStop(1, "#0b0717");
    g.fillStyle = lin;
    g.fillRect(0, 0, s.w, s.h);

    const blob = (x: number, y: number, r: number, col: Rgb, a: number) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, rgba(col, a));
      rg.addColorStop(0.5, rgba(col, a * 0.35));
      rg.addColorStop(1, rgba(col, 0));
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    const big = Math.max(s.w, s.h);
    g.globalCompositeOperation = "lighter";
    blob(s.w * 0.14, s.h * 0.18, big * 0.5, [86, 58, 190], 0.2);
    blob(s.w * 0.9, s.h * 0.8, big * 0.5, [24, 104, 170], 0.16);
    blob(s.w * 0.68, s.h * 0.06, big * 0.34, [160, 60, 130], 0.1);
    blob(s.w * 0.1, s.h * 0.95, big * 0.3, [20, 120, 110], 0.1);
    for (const h of s.houses) blob(h.x, h.y, s.u * 4.4, TINT[h.id], 0.1);
    blob(s.chair.x, s.chair.y, s.u * 5.2, TINT.chair, 0.07);

    const rnd = seeded(20261119);
    const n = Math.round(Math.max(140, Math.min(460, (s.w * s.h) / 4600)));
    for (let i = 0; i < n; i++) {
      const x = rnd() * s.w;
      const y = rnd() * s.h;
      const r = 0.25 + rnd() * rnd() * 1.15;
      const tone = rnd();
      const col: Rgb = tone < 0.12 ? [255, 214, 180] : tone < 0.3 ? [180, 200, 255] : [235, 238, 255];
      g.fillStyle = rgba(col, 0.18 + rnd() * 0.6);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
    const vig = g.createRadialGradient(s.w / 2, s.h / 2, Math.min(s.w, s.h) * 0.35, s.w / 2, s.h / 2, Math.hypot(s.w, s.h) * 0.6);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.62)");
    g.fillStyle = vig;
    g.fillRect(0, 0, s.w, s.h);
    this.bg = c;

    const tw = seeded(77);
    this.twinkle = Array.from({ length: Math.round(n / 5) }, () => ({ x: tw(), y: tw(), r: 1.4 + tw() * 3.2, ph: tw() * TAU, sp: 0.4 + tw() * 1.5 }));
  }

  private frame(dt: number): void {
    const s = this.scene;
    const ctx = this.ctx;
    if (!s || !this.bg) return;
    const t = this.time;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0, s.w, s.h);
    this.busy += ((s.chair.busy ? 1 : 0) - this.busy) * Math.min(1, dt * 2.5 + (this.still ? 1 : 0));

    for (const st of this.twinkle) {
      const a = 0.5 + 0.5 * Math.sin(st.ph + t * st.sp);
      this.glow(st.x * s.w, st.y * s.h, st.r * (0.7 + a * 0.6), [225, 232, 255], 0.12 + a * a * 0.7);
    }

    // everything but the sky slides
    const off = this.slideNow();
    if (off) ctx.translate(0, off);
    this.drawOrbit(s, t);
    this.drawLinks(s, t);
    if (dt > 0) this.emit(s, dt);
    this.drawParticles(dt);
    for (const h of s.houses) this.drawHouse(s, h, t);
    for (const w of this.workers(s)) this.drawWorker(s, w, t);
    this.drawChair(s, t);
    this.drawPackets(s, dt);
    this.drawWaves(dt);
  }

  private drawOrbit(s: Scene, t: number): void {
    const ctx = this.ctx;
    const { x, y } = s.chair;
    const { rx, ry } = s.orbit;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(190,200,255,0.075)";
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([1.5, 0.21 * s.u]);
    ctx.lineDashOffset = -t * 7;
    ctx.strokeStyle = "rgba(214,220,255,0.26)";
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 1.04, ry * 1.04, 0, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([0.5 * s.u, 1.4 * s.u]);
    ctx.lineDashOffset = t * 11;
    ctx.strokeStyle = "rgba(255,226,170,0.09)";
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 0.5, ry * 0.5, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** the triangle between the houses and the beams from the chair */
  private drawLinks(s: Scene, t: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = "round";
    for (const e of this.edges) {
      const grad = ctx.createLinearGradient(e.p.x0, e.p.y0, e.p.x1, e.p.y1);
      grad.addColorStop(0, rgba(e.a, 0.5));
      grad.addColorStop(0.5, "rgba(255,255,255,0.14)");
      grad.addColorStop(1, rgba(e.b, 0.5));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 7]);
      ctx.lineDashOffset = -t * 5;
      ctx.beginPath();
      ctx.moveTo(e.p.x0, e.p.y0);
      ctx.lineTo(e.p.x1, e.p.y1);
      ctx.stroke();
    }
    if (this.port) {
      // the line to the user: faint until something travels it
      const p = this.port;
      const grad = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1);
      grad.addColorStop(0, rgba(TINT.chair, 0.42));
      grad.addColorStop(1, rgba(USER, 0.42));
      ctx.strokeStyle = grad;
      ctx.setLineDash([1.5, 6]);
      ctx.lineDashOffset = t * 6;
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.quadraticCurveTo(p.cx, p.cy, p.x1, p.y1);
      ctx.stroke();
      this.glow(p.x1, p.y1, 0.26 * s.u, USER, 0.7);
    }
    ctx.setLineDash([]);
    for (const h of s.houses) {
      const p = this.beams.get(h.id);
      if (!p) continue;
      const live = h.active > 0 ? 1 : 0;
      const grad = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1);
      grad.addColorStop(0, rgba(TINT.chair, 0.26 + live * 0.36));
      grad.addColorStop(1, rgba(TINT[h.id], 0.26 + live * 0.36));
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.16 + live * 0.16;
      ctx.lineWidth = 0.11 * s.u;
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.quadraticCurveTo(p.cx, p.cy, p.x1, p.y1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
  }

  private emit(s: Scene, dt: number): void {
    const gold = TINT.chair;
    const roll = (perSecond: number) => Math.random() < perSecond * dt;
    for (const h of s.houses) {
      const p = this.beams.get(h.id);
      if (!p) continue;
      const c = TINT[h.id];
      // work goes out in the chair's gold and turns the house's color; reports come back the other way
      if (roll(h.active > 0 ? 1.3 + h.active * 0.9 : 0.16 + this.busy * 0.5)) this.spawn(p, gold, c, 2.6 + Math.random() * 1.2, 1 + Math.random() * 0.8);
      if (roll(h.active > 0 ? 0.5 + h.active * 0.45 : 0.06)) this.spawn(reverse(p), c, gold, 3 + Math.random() * 1.2, 0.8 + Math.random() * 0.6);
      for (const w of h.workers) {
        const th = this.threads.get(w.id);
        if (th && w.status !== "waiting" && this.time - (this.born.get(w.id) ?? 0) > BIRTH && roll(0.9 + w.heat * 4)) this.spawn(th, c, WHITE, 1 + Math.random() * 0.7, 0.7 + Math.random() * 0.5);
      }
    }
    for (const e of this.edges) {
      if (roll(0.3)) {
        const fwd = Math.random() < 0.5;
        this.spawn(fwd ? e.p : reverse(e.p), fwd ? e.a : e.b, fwd ? e.b : e.a, 5 + Math.random() * 3, 0.7 + Math.random() * 0.4);
      }
    }
  }

  private drawParticles(dt: number): void {
    const u = this.scene!.u;
    let keep = 0;
    for (const q of this.particles) {
      q.t += q.v * dt;
      if (q.t >= 1) continue;
      this.particles[keep++] = q;
      if (q.t < 0) continue;
      const fade = Math.sin(Math.PI * q.t) ** 0.55;
      const r = q.size * 0.062 * u;
      // a short tail behind the head
      for (let k = 0; k < 5; k++) {
        const tt = q.t - k * 0.011;
        if (tt < 0) break;
        const [x, y] = at(q.p, tt);
        const a = fade * 0.85 * (1 - k * 0.2) ** 2;
        const rr = r * (1 - k * 0.14);
        this.glow(x, y, rr, q.a, a * (1 - tt));
        this.glow(x, y, rr, q.b, a * tt);
      }
    }
    this.particles.length = keep;
  }

  private drawHouse(s: Scene, h: HouseNode, t: number): void {
    const ctx = this.ctx;
    const c = TINT[h.id];
    const u = s.u;
    const live = h.active > 0 ? 1 : 0;
    const breath = 0.5 + 0.5 * Math.sin(t * 1.1 + h.out * 3);
    this.glow(h.x, h.y, u * (2.3 + live * 0.5 + breath * 0.15), c, 0.2 + live * 0.16 + breath * 0.05);

    ctx.save();
    // the instrument: ring, inner band line, a slow dashed ring outside
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(c, 0.55 + live * 0.25);
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.ringR, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(c, 0.16);
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.coreR + 0.12 * u, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([1.5, 0.12 * u]);
    ctx.lineDashOffset = t * (5 + live * 9) * (h.id === "gpt" ? -1 : 1);
    ctx.strokeStyle = rgba(c, 0.34);
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.ringR + 0.1 * u, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // choosing: the line the chosen model will stop on, from the core out past the ring, with a notch
    // outside it. It brightens as the dial turns and gives way to the new branch once it has stopped.
    const dial = this.dial(h);
    const rot = dial?.rot ?? 0;
    if (dial) {
      const k = dial.age < SPIN ? 0.18 + 0.62 * (dial.age / SPIN) : 0.8 * Math.max(0, 1 - (dial.age - SPIN) / 0.9);
      for (const j of dial.rungs) {
        const th = h.rungs[j].angle;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const r0 = h.coreR + 0.16 * u;
        const r1 = h.ringR + 0.2 * u;
        const ray = ctx.createLinearGradient(h.x + cos * r0, h.y + sin * r0, h.x + cos * r1, h.y + sin * r1);
        ray.addColorStop(0, rgba(c, 0));
        ray.addColorStop(0.55, rgba(WHITE, k * 0.9));
        ray.addColorStop(1, rgba(WHITE, k));
        ctx.strokeStyle = ray;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(h.x + cos * r0, h.y + sin * r0);
        ctx.lineTo(h.x + cos * r1, h.y + sin * r1);
        ctx.stroke();
        // the notch: a small arrowhead pointing in at the ring
        const tip = h.ringR + 0.16 * u;
        const back = h.ringR + 0.36 * u;
        const half = 0.09 * u;
        ctx.fillStyle = rgba(WHITE, k);
        ctx.beginPath();
        ctx.moveTo(h.x + cos * tip, h.y + sin * tip);
        ctx.lineTo(h.x + cos * back - sin * half, h.y + sin * back + cos * half);
        ctx.lineTo(h.x + cos * back + sin * half, h.y + sin * back - cos * half);
        ctx.closePath();
        ctx.fill();
        this.glow(h.x + cos * tip, h.y + sin * tip, u * 0.3, c, k * 0.8);
      }
    }

    // the house's name, engraved on the side that faces the chair
    const px = Math.max(7, 0.125 * u);
    ctx.font = `700 ${px}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(c, 0.92);
    const name = HOUSE_NAME[h.id];
    const mid = h.out + Math.PI;
    const lower = Math.sin(mid) > 0;
    const step = (px * 1.3) / h.bandR;
    for (let i = 0; i < name.length; i++) {
      const off = (i - (name.length - 1) / 2) * step;
      const a = (lower ? mid - off : mid + off) + rot;
      ctx.save();
      ctx.translate(h.x + Math.cos(a) * h.bandR, h.y + Math.sin(a) * h.bandR);
      ctx.rotate(lower ? a - Math.PI / 2 : a + Math.PI / 2);
      ctx.fillText(name[i], 0, 0);
      ctx.restore();
    }

    // the ladder: one gem per model, low rungs small, the rung in use lit
    const small = Math.max(6.5, 0.112 * u);
    h.rungs.forEach((r, i) => {
      const size = (0.05 + i * 0.013) * u;
      const on = r.active > 0;
      // where the dial has carried this rung (its own place when the dial is at rest)
      const ang = r.angle + rot;
      const gx = rot ? h.x + Math.cos(ang) * h.ringR : r.x;
      const gy = rot ? h.y + Math.sin(ang) * h.ringR : r.y;
      // while the dial turns, a rung passing a line it is choosing on lights for a moment;
      // once it has stopped, the chosen one flares and fades back
      let pass = 0;
      let flash = 0;
      if (dial && dial.age < SPIN) {
        for (const j of dial.rungs) {
          const d = ang - h.rungs[j].angle;
          pass = Math.max(pass, 1 - Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) / 0.42);
        }
      } else if (dial && dial.rungs.includes(i)) flash = Math.max(0, 1 - (dial.age - SPIN) / 1.3);
      if (on) this.glow(gx, gy, u * (0.42 + 0.08 * Math.sin(t * 4 + i)), c, 0.95);
      if (pass > 0) this.glow(gx, gy, u * 0.34, c, pass * 0.7);
      if (flash > 0) {
        this.glow(gx, gy, u * (0.5 + 0.9 * flash), WHITE, flash * 0.85);
        this.glow(h.x + Math.cos(ang) * h.bandR, h.y + Math.sin(ang) * h.bandR, u * (0.5 + 0.5 * flash), c, flash * 0.9);
      }
      const lit = Math.max(flash, pass * 0.6);
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(ang + Math.PI / 4);
      ctx.fillStyle = on || flash > 0.25 ? "rgba(255,255,255,0.96)" : r.locked ? "#070812" : rgba(c, 0.6 + lit * 0.4);
      ctx.strokeStyle = rgba(c, r.locked ? 0.4 : 0.95);
      ctx.lineWidth = 1;
      const grown = size * (1 + flash * 0.6);
      ctx.fillRect(-grown, -grown, grown * 2, grown * 2);
      ctx.strokeRect(-grown, -grown, grown * 2, grown * 2);
      ctx.restore();

      ctx.save();
      ctx.translate(h.x + Math.cos(ang) * h.bandR, h.y + Math.sin(ang) * h.bandR);
      // the word keeps the way up it has at rest and turns rigidly with the dial
      ctx.rotate((Math.sin(r.angle) > 0.02 ? r.angle - Math.PI / 2 : r.angle + Math.PI / 2) + rot);
      if (flash > 0) {
        ctx.scale(1 + flash * 0.28, 1 + flash * 0.28);
        ctx.shadowColor = "rgba(255,255,255,0.9)";
        ctx.shadowBlur = 12 * flash;
      }
      ctx.font = `600 ${small}px ${FONT}`;
      const tone: Rgb = [c[0] + (255 - c[0]) * lit, c[1] + (255 - c[1]) * lit, c[2] + (255 - c[2]) * lit];
      ctx.fillStyle = on ? "rgba(255,255,255,0.95)" : rgba(tone, r.locked && lit < 0.05 ? 0.26 : 0.62 + lit * 0.38);
      ctx.fillText(r.word, 0, 0);
      ctx.restore();
    });

    // finished members: small, dark, no light of their own. Gold rim once merged, red when it failed.
    ctx.font = `600 ${Math.max(6, s.pastR * 1.05)}px ${FONT}`;
    for (const d of h.past) {
      const col: Rgb = d.kind === "merged" ? TINT.chair : d.kind === "failed" ? RED : c;
      const a = d.kind === "merged" ? 0.7 : d.kind === "other" ? 0.26 : 0.42;
      ctx.strokeStyle = rgba(col, 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(d.fromX, d.fromY);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
      ctx.fillStyle = "#06070f";
      ctx.strokeStyle = rgba(col, a);
      ctx.beginPath();
      ctx.arc(d.x, d.y, s.pastR, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = rgba(col, a);
      ctx.fillText(d.letter, d.x, d.y + 0.5);
    }

    // the core: a dark disc with a lit rim
    const corona = ctx.createRadialGradient(h.x, h.y, h.coreR * 0.9, h.x, h.y, h.coreR * 1.75);
    corona.addColorStop(0, rgba(c, 0.5 + live * 0.3 + breath * 0.08));
    corona.addColorStop(0.3, rgba(c, 0.14 + live * 0.1));
    corona.addColorStop(1, rgba(c, 0));
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.coreR * 1.75, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    const disc = ctx.createRadialGradient(h.x, h.y - h.coreR * 0.3, 0, h.x, h.y, h.coreR);
    disc.addColorStop(0, "#10122a");
    disc.addColorStop(1, "#05060d");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.coreR, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(c, 0.95);
    ctx.stroke();
    this.sigil(h.id, h.x, h.y, h.coreR, c, t, rot);
    ctx.restore();
  }

  /** a plain geometric mark per house, turning slowly */
  private sigil(id: HouseId, x: number, y: number, r: number, c: Rgb, t: number, turn = 0): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 0.09 * (id === "gpt" ? -1 : 1) + turn);
    ctx.strokeStyle = rgba(c, 0.92);
    ctx.lineWidth = Math.max(1, r * 0.065);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (id === "claude") {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        const inner = r * 0.2;
        const outer = r * (i % 2 ? 0.46 : 0.7);
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
      }
    } else if (id === "gpt") {
      for (const [rad, turn] of [[0.66, 0], [0.34, Math.PI / 6]] as const) {
        for (let i = 0; i <= 6; i++) {
          const a = (i / 6) * TAU + turn;
          const px = Math.cos(a) * r * rad;
          const py = Math.sin(a) * r * rad;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
    } else {
      const star = (ox: number, oy: number, R: number) => {
        ctx.moveTo(ox, oy - R);
        ctx.quadraticCurveTo(ox, oy, ox + R, oy);
        ctx.quadraticCurveTo(ox, oy, ox, oy + R);
        ctx.quadraticCurveTo(ox, oy, ox - R, oy);
        ctx.quadraticCurveTo(ox, oy, ox, oy - R);
      };
      star(-r * 0.08, r * 0.06, r * 0.62);
      star(r * 0.42, -r * 0.4, r * 0.24);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawWorker(s: Scene, w: WorkerNode, t: number): void {
    const ctx = this.ctx;
    const c = TINT[w.house];
    const seed = hash(w.id) * TAU;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.6 + seed);
    // a new member grows out of its rung along the thread
    const age = this.time - (this.born.get(w.id) ?? -100);
    if (age < 0) return;
    const g = age >= BIRTH ? 1 : 1 - (1 - age / BIRTH) ** 3;
    const R = s.workerR * (0.3 + 0.7 * g);
    if (g < 1) w = { ...w, x: w.fromX + (w.x - w.fromX) * g, y: w.fromY + (w.y - w.fromY) * g };
    const len = Math.hypot(w.x - w.fromX, w.y - w.fromY) || 1;
    const reach = Math.max(0, len - R - 2) / len;
    ctx.save();
    ctx.strokeStyle = rgba(c, 0.38 + (1 - g) * 0.5);
    ctx.lineWidth = 1 + (1 - g) * 1.2;
    ctx.beginPath();
    ctx.moveTo(w.fromX, w.fromY);
    ctx.lineTo(w.fromX + (w.x - w.fromX) * reach, w.fromY + (w.y - w.fromY) * reach);
    ctx.stroke();
    if (age < BIRTH * 1.6) {
      const f = 1 - age / (BIRTH * 1.6);
      this.glow(w.x, w.y, R * (3 + 5 * f), WHITE, f * f * 0.7);
    }
    this.glow(w.x, w.y, R * (3 + w.heat * 1.6 + pulse * 0.5), c, 0.5 + w.heat * 0.3 + pulse * 0.1);
    ctx.fillStyle = "#070812";
    ctx.beginPath();
    ctx.arc(w.x, w.y, R, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(c, w.status === "starting" ? 0.4 + pulse * 0.55 : 0.95);
    ctx.stroke();
    ctx.lineCap = "round";
    if (w.status === "waiting") {
      // a relay waits for a person: a slow dashed ring, no spin
      ctx.setLineDash([3, 5]);
      ctx.lineDashOffset = -t * 4;
      ctx.strokeStyle = rgba(c, 0.5 + pulse * 0.3);
      ctx.beginPath();
      ctx.arc(w.x, w.y, R + 4.5, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const a = t * (1.5 + w.heat * 2.6) + seed;
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = rgba(c, 0.95);
      ctx.beginPath();
      ctx.arc(w.x, w.y, R + 3.5, a, a + 1.7);
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = rgba(c, 0.42);
      ctx.beginPath();
      ctx.arc(w.x, w.y, R + 7, -a * 0.6, -a * 0.6 + 0.9);
      ctx.stroke();
    }
    // reasoning level: one pip per step
    const pips = EFFORT_PIPS[w.effort ?? ""] ?? 0;
    const pr = Math.max(1, R * 0.09);
    const gap = R * 0.3;
    ctx.fillStyle = rgba(c, 0.95);
    for (let i = 0; i < pips; i++) {
      ctx.beginPath();
      ctx.arc(w.x + (i - (pips - 1) / 2) * gap, w.y, pr, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawChair(s: Scene, t: number): void {
    const ctx = this.ctx;
    const ch = s.chair;
    const u = s.u;
    const gold = TINT.chair;
    const busy = this.busy;
    const pulse = 0.5 + 0.5 * Math.sin(t * (1.2 + busy * 2.2));
    // a new chair taking over: `charge` rises 0..1 while the old light is drawn in, then `burst` falls 1..0
    const cr = this.crown;
    const since = cr ? this.time - cr.at : 0;
    if (cr && since > CROWN + 2.4) this.crown = null;
    const charge = cr && since < CROWN ? (since / CROWN) ** 2 : 0;
    const burst = cr && since >= CROWN ? Math.max(0, 1 - (since - CROWN) / 1.7) : 0;
    const tint = cr && since < CROWN ? cr.from : ch.tint;
    this.glow(ch.x, ch.y, u * (3.3 + busy * 0.9 + pulse * 0.2) * (1 - 0.5 * charge + 1.5 * burst * burst), gold, (0.3 + busy * 0.22 + pulse * 0.06) * (1 - 0.6 * charge) + burst * 0.45);
    if (burst > 0) {
      this.glow(ch.x, ch.y, u * (4 + 8 * burst), WHITE, burst ** 3 * 0.9);
      this.glow(ch.x, ch.y, u * (5 + 6 * burst), ch.tint, burst * 0.5);
    }

    ctx.save();
    // corona: uneven streamers around a dark disc
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineWidth = 1.3;
    const rays = 64;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + t * 0.025;
      const n = 0.5 + 0.5 * Math.sin(i * 12.9898 + t * (0.6 + busy * 1.5) + Math.sin(i * 4.1) * 2);
      const len = u * (0.08 + n * (0.16 + busy * 0.26)) * (1 - 0.85 * charge + 6 * burst * burst);
      ctx.strokeStyle = rgba(gold, Math.min(1, 0.1 + n * 0.3 + burst * 0.5));
      ctx.beginPath();
      ctx.moveTo(ch.x + Math.cos(a) * ch.r * 1.02, ch.y + Math.sin(a) * ch.r * 1.02);
      ctx.lineTo(ch.x + Math.cos(a) * (ch.r * 1.02 + len), ch.y + Math.sin(a) * (ch.r * 1.02 + len));
      ctx.stroke();
    }
    const reach = ch.r * 1.9 * (1 - 0.3 * charge + 0.9 * burst * burst);
    const corona = ctx.createRadialGradient(ch.x, ch.y, ch.r * 0.9, ch.x, ch.y, reach);
    corona.addColorStop(0, `rgba(255,246,222,${Math.min(1, 0.7 + busy * 0.25 + burst * 0.3) * (1 - 0.5 * charge)})`);
    corona.addColorStop(0.1, rgba(gold, 0.42 + busy * 0.2 + burst * 0.3));
    corona.addColorStop(0.42, rgba(tint, 0.1 + busy * 0.06 + charge * 0.25 + burst * 0.3));
    corona.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(ch.x, ch.y, reach, 0, TAU);
    ctx.fill();
    if (cr && since < CROWN) {
      // rings in the old chair's colour closing in on the disc, faster and brighter as they near it
      ctx.lineWidth = 1.4;
      for (let j = 0; j < 3; j++) {
        const ph = ((since / CROWN) * 1.7 + j / 3) % 1;
        ctx.strokeStyle = rgba(cr.from, ph * 0.75);
        ctx.beginPath();
        ctx.arc(ch.x, ch.y, ch.r + (1 - ph) ** 1.6 * u * 3, 0, TAU);
        ctx.stroke();
      }
    }
    if (burst > 0) {
      // the crown: long spokes thrown out past the halo, turning slowly as they fade
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * TAU + t * 0.35;
        const r0 = ch.haloR + 0.1 * u;
        const r1 = r0 + u * (0.5 + (i % 2 ? 1.6 : 2.8) * burst);
        const spoke = ctx.createLinearGradient(ch.x + Math.cos(a) * r0, ch.y + Math.sin(a) * r0, ch.x + Math.cos(a) * r1, ch.y + Math.sin(a) * r1);
        spoke.addColorStop(0, rgba(WHITE, burst * 0.85));
        spoke.addColorStop(1, rgba(i % 2 ? gold : ch.tint, 0));
        ctx.strokeStyle = spoke;
        ctx.beginPath();
        ctx.moveTo(ch.x + Math.cos(a) * r0, ch.y + Math.sin(a) * r0);
        ctx.lineTo(ch.x + Math.cos(a) * r1, ch.y + Math.sin(a) * r1);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = "source-over";

    const disc = ctx.createRadialGradient(ch.x, ch.y - ch.r * 0.35, 0, ch.x, ch.y, ch.r);
    disc.addColorStop(0, "#12132b");
    disc.addColorStop(1, "#04050b");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(ch.x, ch.y, ch.r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.6 + burst * 2.4;
    ctx.strokeStyle = "rgba(255,242,210,0.95)";
    ctx.stroke();
    // the moment the new chair arrives the disc itself is white
    if (burst > 0.55) {
      ctx.fillStyle = rgba(WHITE, ((burst - 0.55) / 0.45) * 0.92);
      ctx.fill();
    }
    // inside the rim, a thin ring in the color of the chair's own house
    ctx.setLineDash([2, 5]);
    ctx.lineDashOffset = -t * (4 + busy * 14 + burst * 60);
    ctx.lineWidth = 1 + burst * 1.6;
    ctx.strokeStyle = rgba(tint, Math.min(1, 0.55 + charge * 0.4 + burst * 0.45));
    ctx.beginPath();
    ctx.arc(ch.x, ch.y, ch.r * 0.86, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // the tasks, one arc each: grey to do, the worker's color in progress, white for review, gold when settled
    ctx.lineCap = "butt";
    if (s.tasks.length === 0) {
      ctx.setLineDash([2, 6]);
      ctx.lineDashOffset = t * 3;
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ch.x, ch.y, ch.ringR, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // the ring of tasks winds back a little while the light is drawn in and turns once as it bursts
    const q = cr && since >= CROWN ? Math.min(1, (since - CROWN) / 1.3) : 1;
    const turn = cr ? (since < CROWN ? -charge * 0.7 : (1 - q) ** 3 * (TAU - 0.7) * -1) : 0;
    for (const k0 of s.tasks) {
      const k = turn ? { ...k0, a0: k0.a0 + turn, a1: k0.a1 + turn } : k0;
      const col: Rgb = k.status === "done" ? gold : k.status === "blocked" ? [255, 92, 92] : k.status === "doing" ? k.tint ?? gold : WHITE;
      const alpha = k.status === "todo" ? 0.16 : k.status === "review" ? 0.5 + 0.45 * Math.sin(t * 3.2) ** 2 : 0.95;
      ctx.strokeStyle = rgba(col, alpha);
      ctx.lineWidth = Math.max(2, 0.075 * u);
      ctx.beginPath();
      ctx.arc(ch.x, ch.y, ch.ringR, k.a0, k.a1);
      ctx.stroke();
      if (k.status === "doing") {
        const span = k.a1 - k.a0;
        const a = k.a0 + span * (0.5 + 0.5 * Math.sin(t * 1.7 + k.a0));
        this.glow(ch.x + Math.cos(a) * ch.ringR, ch.y + Math.sin(a) * ch.ringR, 0.3 * u, col, 0.9);
      } else if (k.status === "done") {
        const a = (k.a0 + k.a1) / 2;
        this.glow(ch.x + Math.cos(a) * ch.ringR, ch.y + Math.sin(a) * ch.ringR, 0.2 * u, gold, 0.35 + 0.15 * pulse);
      }
    }

    // the halo: where the three beams leave, each marked in its house's color
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(gold, s.closed ? 0.7 : 0.2);
    ctx.beginPath();
    ctx.arc(ch.x, ch.y, ch.haloR, 0, TAU);
    ctx.stroke();
    // the three marks joined: one council, three houses
    ctx.strokeStyle = rgba(gold, 0.16 + busy * 0.14);
    ctx.beginPath();
    s.houses.forEach((h, i) => {
      const px = ch.x + Math.cos(h.out) * ch.haloR;
      const py = ch.y + Math.sin(h.out) * ch.haloR;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.lineCap = "round";
    for (const h of s.houses) {
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = rgba(TINT[h.id], 0.95);
      ctx.beginPath();
      ctx.arc(ch.x, ch.y, ch.haloR, h.out - 0.17, h.out + 0.17);
      ctx.stroke();
      this.glow(ch.x + Math.cos(h.out) * ch.haloR, ch.y + Math.sin(h.out) * ch.haloR, 0.2 * u, TINT[h.id], 0.55);
    }
    if (ch.waiting) {
      // the chair is waiting for the user's word
      ctx.setLineDash([4, 7]);
      ctx.lineDashOffset = -t * 12;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `rgba(255,190,96,${0.4 + 0.5 * Math.sin(t * 3) ** 2})`;
      ctx.beginPath();
      ctx.arc(ch.x, ch.y, ch.haloR + 0.17 * u, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPackets(s: Scene, dt: number): void {
    const ctx = this.ctx;
    let keep = 0;
    for (const k of this.packets) {
      k.t += dt / k.dur;
      let alive = true;
      while (k.t >= 1 && alive) {
        const over = k.t - 1;
        this.arrive(k);
        alive = this.nextLeg(k);
        if (alive) k.t = over * 0.5;
      }
      if (!alive || !k.path) continue;
      this.packets[keep++] = k;
      const [x, y] = at(k.path, k.t);
      k.x = x;
      k.y = y;
      k.trail.push([x, y]);
      const max = k.big ? 22 : 12;
      if (k.trail.length > max) k.trail.shift();
      const r = (k.big ? 0.15 : 0.085) * s.u;
      k.trail.forEach(([tx, ty], i) => {
        const f = (i + 1) / k.trail.length;
        this.glow(tx, ty, r * (0.35 + 0.65 * f), k.c, f * f * 0.75);
      });
      this.glow(x, y, r * 2.6, k.c, 0.9);
      this.glow(x, y, r * 1.2, WHITE, 0.95);
      if (!k.label) continue;
      // a small square for the thing carried, and what it is
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4 + this.time * 3);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      const q = Math.max(2, 0.045 * s.u);
      ctx.fillRect(-q, -q, q * 2, q * 2);
      ctx.restore();
      ctx.save();
      ctx.font = `700 ${Math.max(9, 0.135 * s.u)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(4,5,12,0.85)";
      ctx.strokeText(k.label, x, y - r * 1.5);
      ctx.fillStyle = rgba(k.c, 1);
      ctx.fillText(k.label, x, y - r * 1.5);
      ctx.restore();
    }
    this.packets.length = keep;
  }

  private drawWaves(dt: number): void {
    const ctx = this.ctx;
    let keep = 0;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const w of this.waves) {
      w.t += dt;
      const p = w.t / w.dur;
      if (p >= 1) continue;
      this.waves[keep++] = w;
      if (p < 0) continue;
      const e = 1 - (1 - p) ** 3;
      ctx.strokeStyle = rgba(w.c, (1 - p) ** 2 * 0.85);
      ctx.lineWidth = 1 + (1 - p) * 2.4;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r0 + (w.r1 - w.r0) * e, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    this.waves.length = keep;
  }
}
