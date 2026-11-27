// The meeting room: the user gives a topic, the members round the table each give a first opinion in
// turn (each hearing the ones before), then talk it over for two rounds (anyone may pass), and the
// chair sums up what they agreed, where they differ and what to do next. Every turn is a one-shot,
// tool-less call to that member's CLI (Claude Code, Codex, Antigravity) on the account that is free;
// seats with no connection (Grok, Dots) stay silent. Who chairs and who sits in is a saved setting
// (meetings/settings.json); the chair's own character may sit in as well, as a chibi on the table. A meeting is saved after every turn and its
// state is broadcast, so the page follows it live and finds it again after a reload.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AccountRegistry, geminiEnabled, oneShot, PREDECESSOR, WORKHORSE, type CliProvider } from "@gencouncil/council";
import { gencouncilHome } from "@gencouncil/core";

export type SeatId = "claude" | "gpt" | "gemini" | "grok" | "dots";
const SEATS: SeatId[] = ["claude", "gpt", "gemini", "grok", "dots"];

/** each seat's character and manner of speaking (Agentg's personas) */
const CHARACTER: Record<SeatId, { name: string; manner: string }> = {
  claude: { name: "클로드", manner: "다정한 비서. 부드러운 해요체 존댓말로 차분하고 세심하게, 짧게 둥글게 끝낸다" },
  gpt: { name: "지피티", manner: "간결한 보고형. 합니다체로 결론부터 짧게, 감정 표현과 군더더기 없이" },
  gemini: { name: "제미나이", manner: "쾌활한 후배. 존댓말에 반말이 섞이고 리액션이 크며 다른 위원을 '선배'라고 부른다" },
  grok: { name: "그록", manner: "장난스러운 친구. 반말로 농담을 섞는다" },
  dots: { name: "닷츠", manner: "차분한 집사. 격식 있는 하십시오체" },
};
const PROVIDER: Partial<Record<SeatId, CliProvider>> = { claude: "claude", gpt: "gpt", gemini: "gemini", grok: "grok" };
const seatOf = (p: string): SeatId => (p === "gpt" ? "gpt" : p === "gemini" ? "gemini" : p === "grok" ? "grok" : "claude");

export interface MeetingSeat {
  seat: SeatId;
  name: string;
  /** can speak: a CLI and a usable account */
  available: boolean;
  reason?: string;
  /** the chair's own character sitting in as a member: a chibi on the table, not a chair at the side */
  desk?: boolean;
  /** the model and reasoning effort it speaks with (the settings'; the workhorse and "low" when unset) */
  model?: string;
  effort?: string;
}
/** who chairs and who sits in (saved, so every device holds the same meeting) */
export interface MeetingSettings {
  chair: CliProvider;
  chairModel?: string;
  chairEffort?: string;
  members: SeatId[];
  /** each member seat's model and reasoning effort */
  seats?: Partial<Record<SeatId, { model?: string; effort?: string }>>;
}
/** a past meeting in the list */
export interface MeetingSummary {
  id: string;
  topic: string;
  startedAt: string;
  status: Meeting["status"];
  chair: string;
  turns: number;
}
const DEFAULT_SETTINGS: MeetingSettings = { chair: "claude", members: ["claude", "gpt", "gemini", "grok"] };
export interface MeetingTurn {
  who: SeatId | "chair";
  name: string;
  model?: string;
  phase: "opinion" | "debate" | "summary";
  round: number;
  text: string;
  at: string;
  seconds?: number;
  error?: string;
}
export interface Meeting {
  id: string;
  topic: string;
  chair: { seat: SeatId; name: string; provider: CliProvider; model?: string; effort?: string };
  seats: MeetingSeat[];
  turns: MeetingTurn[];
  phase: "opinion" | "debate" | "summary" | "done";
  /** who is thinking now */
  speaking?: SeatId | "chair";
  status: "running" | "done" | "stopped" | "failed";
  startedAt: string;
  endedAt?: string;
  error?: string;
}

const word = (v: unknown, max = 80) => (typeof v === "string" && /^[\w.:-]+$/.test(v.trim()) ? v.trim().slice(0, max) : undefined);
const EFFORT_WORDS = ["low", "medium", "high", "xhigh", "max"];
const effortOf = (v: unknown) => (typeof v === "string" && EFFORT_WORDS.includes(v) ? v : undefined);

function clean(s: Partial<MeetingSettings>): MeetingSettings {
  const chair: CliProvider = s.chair === "gpt" || s.chair === "gemini" || s.chair === "grok" ? s.chair : "claude";
  const members = Array.isArray(s.members) ? SEATS.filter((x) => s.members!.includes(x)) : [...DEFAULT_SETTINGS.members];
  const model = word(s.chairModel);
  const effort = effortOf(s.chairEffort);
  const seats: NonNullable<MeetingSettings["seats"]> = {};
  for (const id of SEATS) {
    const v = s.seats?.[id];
    const m = word(v?.model);
    const e = effortOf(v?.effort);
    if (m || e) seats[id] = { ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) };
  }
  return { chair, members, ...(model ? { chairModel: model } : {}), ...(effort ? { chairEffort: effort } : {}), ...(Object.keys(seats).length ? { seats } : {}) };
}

const DEBATE_ROUNDS = 2;
const PASS = /^\s*\(?패스\)?[.!。]?\s*$/;

export class Meetings {
  private current?: Meeting;
  private stopRequested = false;
  private readonly dir = path.join(gencouncilHome(), "meetings");

  constructor(
    private readonly accounts: AccountRegistry,
    private readonly broadcast: (msg: Record<string, unknown>) => void,
    private readonly log: (msg: string) => void,
  ) {}

  /** the meeting under way, or the last one held */
  latest(): Meeting | null {
    if (this.current) return this.current;
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "settings.json").sort();
      const last = files[files.length - 1];
      return last ? (JSON.parse(fs.readFileSync(path.join(this.dir, last), "utf8")) as Meeting) : null;
    } catch {
      return null;
    }
  }

  settings(): MeetingSettings {
    try {
      return clean(JSON.parse(fs.readFileSync(path.join(this.dir, "settings.json"), "utf8")) as Partial<MeetingSettings>);
    } catch {
      return { ...DEFAULT_SETTINGS, members: [...DEFAULT_SETTINGS.members] };
    }
  }

  saveSettings(patch: { chair?: string; chairModel?: string | null; chairEffort?: string | null; members?: string[]; seats?: MeetingSettings["seats"] }): MeetingSettings {
    // null clears a choice (back to the default)
    const next = clean({ ...this.settings(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v === null ? undefined : v])) } as Partial<MeetingSettings>);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "settings.json"), JSON.stringify(next, null, 1));
    this.broadcast({ type: "meeting-settings", settings: next });
    return next;
  }

  start(topic: string): Meeting {
    if (this.current?.status === "running") throw new Error("회의가 이미 진행 중입니다");
    const t = topic.trim().slice(0, 2000);
    if (!t) throw new Error("회의 주제가 비어 있습니다");
    const set = this.settings();
    const chairProvider = set.chair;
    const chairSeat = seatOf(chairProvider);
    // in the usual order; the chair's own character, if it sits in too, on the table
    const seats: MeetingSeat[] = SEATS.filter((s) => set.members.includes(s)).map((s) => {
      const pick = set.seats?.[s];
      const base = { seat: s, name: CHARACTER[s].name, ...(s === chairSeat ? { desk: true } : {}), ...(pick?.model ? { model: pick.model } : {}), ...(pick?.effort ? { effort: pick.effort } : {}) };
      const p = PROVIDER[s];
      if (!p) return { ...base, available: false, reason: "연결 안 됨" };
      if (p === "gemini" && !geminiEnabled()) return { ...base, available: false, reason: "제미나이 꺼짐" };
      if (!this.accounts.pick(p)) return { ...base, available: false, reason: "쓸 수 있는 계정 없음" };
      return { ...base, available: true };
    });
    const m: Meeting = {
      id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`,
      topic: t,
      chair: { seat: chairSeat, name: CHARACTER[chairSeat].name, provider: chairProvider, model: set.chairModel, ...(set.chairEffort ? { effort: set.chairEffort } : {}) },
      seats,
      turns: [],
      phase: "opinion",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.current = m;
    this.stopRequested = false;
    this.save();
    void this.run(m);
    return m;
  }

  /** the saved meetings, newest first */
  list(): MeetingSummary[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "settings.json");
    } catch {
      return [];
    }
    const out: MeetingSummary[] = [];
    for (const f of files.sort().reverse().slice(0, 200)) {
      try {
        const m = (this.current && `${this.current.id}.json` === f ? this.current : JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"))) as Meeting;
        out.push({ id: m.id, topic: m.topic, startedAt: m.startedAt, status: m.status, chair: m.chair?.name ?? "", turns: m.turns?.length ?? 0 });
      } catch {
        /* a broken file is left out */
      }
    }
    return out;
  }

  get(id: string): Meeting | null {
    if (!/^[\w-]+$/.test(id)) return null;
    if (this.current?.id === id) return this.current;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as Meeting;
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    if (!/^[\w-]+$/.test(id)) throw new Error("회의를 찾을 수 없습니다");
    if (this.current?.id === id && this.current.status === "running") throw new Error("진행 중인 회의는 지울 수 없습니다. 먼저 중지하세요");
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error("회의를 찾을 수 없습니다");
    fs.unlinkSync(file);
    if (this.current?.id === id) this.current = undefined;
    this.broadcast({ type: "meeting-removed", id });
  }

  stop(id: string): Meeting | null {
    if (this.current?.id !== id || this.current.status !== "running") return this.latest();
    this.stopRequested = true;
    return this.current;
  }

  private save(): void {
    const m = this.current;
    if (!m) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${m.id}.json`), JSON.stringify(m, null, 1));
    } catch (e) {
      this.log(`meeting: could not save (${(e as Error).message})`);
    }
    this.broadcast({ type: "meeting", meeting: m });
  }

  private transcript(m: Meeting): string {
    return m.turns.filter((t) => !t.error).map((t) => `- ${t.name}: ${t.text}`).join("\n");
  }

  /** one member's (or the chair's) turn: a tool-less one-shot call on a free account */
  private async ask(provider: CliProvider, model: string | undefined, prompt: string, effort = "low"): Promise<{ text: string; model: string; seconds: number; error?: string }> {
    const account = this.accounts.pick(provider);
    if (!account) return { text: "", model: model ?? "", seconds: 0, error: "쓸 수 있는 계정 없음" };
    let want = this.accounts.fitModel(account.id, model ?? WORKHORSE[provider]) ?? WORKHORSE[provider];
    const cwd = path.join(this.dir, "work");
    fs.mkdirSync(cwd, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      this.accounts.touch(account.id);
      const r = await oneShot({ provider, model: want, effort, cwd, env: this.accounts.env(account), prompt, tools: "none", timeoutMs: 240_000 });
      // a login that does not offer the model: the previous generation of the same rung, once
      if (r.error && /model[^\n]{0,80}is not supported|model_not_found/i.test(r.error + r.text) && PREDECESSOR[want]) {
        want = this.accounts.markUnsupported(account.id, want, r.error) ?? PREDECESSOR[want];
        continue;
      }
      return { text: r.text.trim(), model: want, seconds: r.seconds, error: r.error };
    }
    return { text: "", model: want, seconds: 0, error: "모델을 쓸 수 없음" };
  }

  private async turn(m: Meeting, seat: MeetingSeat, phase: "opinion" | "debate", round: number): Promise<void> {
    const c = CHARACTER[seat.seat];
    const provider = PROVIDER[seat.seat]!;
    const heard = this.transcript(m);
    const others = m.seats.filter((s) => s.available && s.seat !== seat.seat).map((s) => s.name).join(", ") || "없음";
    const task =
      phase === "opinion"
        ? "지금은 '첫 의견' 차례다. 이 주제에 대한 너의 의견을 3~5문장으로 말하라. 앞사람과 겹치면 다른 관점이나 구체적인 근거를 더하라."
        : `지금은 자유 토론 ${round}번째 차례다. 다른 위원의 발언 가운데 동의하거나 반박할 점을 이름을 들어 짚고 2~4문장으로 말하라. 새로 보탤 말이 없으면 '패스' 한 단어만 답하라.`;
    const prompt = [
      `너는 AI 위원회 회의실에 앉은 위원 "${c.name}"이다. 말투: ${c.manner}.`,
      `함께 앉은 위원: ${others}. 의장: ${m.chair.name}.`,
      ...(seat.desk ? ["의장과 같은 캐릭터지만 지금은 책상 위의 꼬마 위원으로서 한 사람 몫의 의견을 낸다. 정리는 의장이 하니 너는 네 의견만 말하라."] : []),
      `회의 주제: ${m.topic}`,
      heard ? `지금까지 나온 발언:\n${heard}` : "아직 아무도 발언하지 않았다. 네가 처음이다.",
      task,
      "마크다운·목록·머리말·이름표 없이, 말하듯 한 단락으로만 답하라. 도구를 쓰지 말고 바로 답하라.",
    ].join("\n\n");
    m.speaking = seat.seat;
    this.save();
    const r = await this.ask(provider, seat.model, prompt, seat.effort);
    m.speaking = undefined;
    if (r.error && !r.text) {
      m.turns.push({ who: seat.seat, name: c.name, model: r.model, phase, round, text: "", at: new Date().toISOString(), seconds: r.seconds, error: r.error });
      this.log(`meeting ${m.id}: ${c.name} failed (${r.error})`);
    } else if (!(phase === "debate" && PASS.test(r.text))) {
      m.turns.push({ who: seat.seat, name: c.name, model: r.model, phase, round, text: r.text.slice(0, 1500), at: new Date().toISOString(), seconds: r.seconds });
    }
    this.save();
  }

  private async run(m: Meeting): Promise<void> {
    const speakers = m.seats.filter((s) => s.available);
    this.log(`meeting ${m.id}: "${m.topic.slice(0, 60)}" — chair ${m.chair.name}, speakers ${speakers.map((s) => s.name).join(", ") || "none"}`);
    try {
      for (const s of speakers) {
        if (this.stopRequested) break;
        await this.turn(m, s, "opinion", 1);
      }
      m.phase = "debate";
      for (let r = 1; r <= DEBATE_ROUNDS && !this.stopRequested; r++) {
        const before = m.turns.length;
        for (const s of speakers) {
          if (this.stopRequested) break;
          await this.turn(m, s, "debate", r);
        }
        // everyone passed: the talk is over
        if (m.turns.length === before) break;
      }
      if (!this.stopRequested) {
        m.phase = "summary";
        const c = CHARACTER[m.chair.seat];
        const prompt = [
          `너는 AI 위원회 회의의 의장 "${c.name}"이다. 말투: ${c.manner}.`,
          `회의 주제: ${m.topic}`,
          `위원들의 발언:\n${this.transcript(m) || "(발언 없음)"}`,
          "이 토론을 정리하라. 아래 세 제목을 그대로 쓰고 각 아래에 1~3줄씩:\n[합의한 점]\n[의견이 갈린 점]\n[결론과 다음 할 일]",
          "발언하지 않은 빈자리는 언급하지 마라. 도구를 쓰지 말고 바로 답하라.",
        ].join("\n\n");
        m.speaking = "chair";
        this.save();
        const r = await this.ask(m.chair.provider, m.chair.model, prompt, m.chair.effort);
        m.speaking = undefined;
        m.turns.push({ who: "chair", name: c.name, model: r.model, phase: "summary", round: 1, text: r.text.slice(0, 3000), at: new Date().toISOString(), seconds: r.seconds, ...(r.error && !r.text ? { error: r.error } : {}) });
      }
      m.phase = "done";
      m.status = this.stopRequested ? "stopped" : "done";
    } catch (e) {
      m.status = "failed";
      m.error = (e as Error).message;
      this.log(`meeting ${m.id}: ${m.error}`);
    }
    m.speaking = undefined;
    m.endedAt = new Date().toISOString();
    this.save();
  }
}
