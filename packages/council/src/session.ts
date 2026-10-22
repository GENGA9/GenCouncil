/**
 * AgendaRuntime: one open agenda = Council + Chair + the glue the REPL used to own
 * (member-finished events are forwarded to the chair, queued while the chair is busy,
 * per-member activity counters for the UI). Terminal REPL and web server both use it.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { MemoryStore } from "@gencouncil/core";
import { Chair, type ChairOptions, type ChairTurnResult } from "./chair.js";
import { Council, type CouncilState } from "./council.js";
import type { ClaudeEvent } from "./drivers.js";
import { memberDisplayName, type AgendaStore, type MemberRecord } from "./model.js";
import { firstTurnPreamble, retrospectivePrompt } from "./prompts.js";
import { stopLeftover } from "./interrupt.js";

/** last thing the user (not a council event) said to the chair */
function lastUserText(store: AgendaStore): string | undefined {
  const f = path.join(store.dir, "transcript.jsonl");
  if (!fs.existsSync(f)) return undefined;
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).reverse();
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { role?: string; text?: string };
      if (e.role === "user" && e.text && !e.text.startsWith("[council event]")) return e.text;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

export interface Attachment {
  /** stored file name inside the agenda's attachments folder */
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface TranscriptEntry {
  ts: string;
  role: "user" | "assistant" | "event";
  text: string;
  attachments?: Attachment[];
  isError?: boolean;
  costUsd?: number;
}

/** what was cut off by a shutdown/close and can be continued */
export interface ResumeInfo {
  members: Array<{ id: string; provider: string; model?: string; taskId: string; taskTitle: string }>;
  chair?: { at: string; message: string };
}

export interface RuntimeState extends CouncilState {
  key: string;
  resume?: ResumeInfo;
  chair: { model?: string; effort?: string; advisor?: string; account?: string; sessionId?: string; busy: boolean };
  /** tool/text events per minute for the last ACTIVITY_MINUTES minutes, per member */
  activity: Record<string, number[]>;
}

export type RuntimeEvent =
  | { type: "chair:start"; role: "user" | "event"; text: string; attachments?: Attachment[] }
  | { type: "chair:text"; text: string }
  | { type: "chair:tool"; name: string; input: unknown }
  | { type: "chair:done"; text: string; isError: boolean; costUsd?: number }
  | { type: "chair:handover"; from: string; to: string; reason: string }
  | { type: "member:start"; member: MemberRecord }
  | { type: "member:line"; member: string; line: string }
  | { type: "member:done"; member: MemberRecord }
  | { type: "log"; line: string }
  | { type: "state" };

const ACTIVITY_MINUTES = 20;

export function memberEventText(m: MemberRecord): string {
  const r = m.result;
  if (m.handoverTo) {
    return [
      `[council event] 위원 ${m.id} ${m.status} (task ${m.taskId}) → 핸드오버됨 ${m.handoverTo}`,
      m.failure ? `원인: ${m.failure.kind} - ${m.failure.message}${m.failure.resetAt ? ` (계정 ${m.account} 리셋 예상 ${m.failure.resetAt})` : ""}` : "",
      `같은 worktree/브랜치에서 ${m.handoverTo}가 이어서 작업 중이다. 검토·재배정 불필요. ${m.handoverTo}의 완료 이벤트를 기다려라.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `[council event] 위원 ${m.id} (${memberDisplayName(m)}) ${m.status} (task ${m.taskId}, ${m.commits?.length ?? 0} commits, ${m.toolCalls} tool calls${m.handoverFrom ? `, ${m.handoverFrom}에서 인계받음` : ""}${m.provider === "relay" ? ", 릴레이" : ""})`,
    r?.summary ? `결과: ${r.summary.slice(0, 800)}` : "",
    r?.unfinished && r.unfinished !== "없음" ? `미완료/막힌 점: ${r.unfinished.slice(0, 400)}` : "",
    m.failure ? `실패 원인(${m.failure.kind}): ${m.failure.message}` : m.error ? `오류: ${m.error}` : "",
    m.status === "failed" && m.failure && m.failure.kind !== "other"
      ? "자동 핸드오버가 불가능했다(쓸 수 있는 계정 없음). 사용자에게 계정 추가/리셋 대기를 알리거나 council_handover로 다른 provider에 맡겨라."
      : "council_member(diff:true)로 검토하고 머지 여부를 정하라.",
  ]
    .filter(Boolean)
    .join("\n");
}

export class AgendaRuntime extends EventEmitter {
  readonly key: string;
  private queue: string[] = [];
  private activityLog = new Map<string, number[]>();
  private closed = false;

  constructor(
    readonly council: Council,
    readonly chair: Chair,
  ) {
    super();
    this.key = `${council.project.id}/${council.store.slug}`;
    council.on("log", (line: string) => this.emitEvent({ type: "log", line }));
    council.on("agenda", () => this.emitEvent({ type: "state" }));
    council.on("member:start", (m: MemberRecord) => {
      this.emitEvent({ type: "member:start", member: m });
      this.emitEvent({ type: "state" });
    });
    council.on("member:line", (m: MemberRecord, line: string) => {
      this.bump(m.id);
      this.emitEvent({ type: "member:line", member: m.id, line });
    });
    council.on("member:done", (m: MemberRecord) => {
      council.takeFinished();
      this.emitEvent({ type: "member:done", member: m });
      this.emitEvent({ type: "state" });
      this.enqueue(memberEventText(m));
    });
  }

  static async open(store: AgendaStore, memory: MemoryStore, chairOpts: ChairOptions): Promise<AgendaRuntime> {
    const council = new Council(store, memory);
    await council.open();
    const chair = new Chair(council, chairOpts);
    // a chair turn that was cut off by an app shutdown leaves its marker file behind
    const marker = chair.runningFile();
    if (fs.existsSync(marker)) {
      try {
        const m = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid?: number; startedAt?: string; message?: string };
        await stopLeftover(m.pid, m.startedAt);
        const agenda = store.agenda();
        agenda.chairInterrupted = { at: m.startedAt ?? new Date().toISOString(), message: lastUserText(store) ?? m.message ?? "" };
        store.saveAgenda(agenda);
      } catch {
        /* unreadable marker: ignore */
      }
      fs.rmSync(marker, { force: true });
    }
    return new AgendaRuntime(council, chair);
  }

  /** members and chair turn that were cut off and not continued yet */
  resumeInfo(): ResumeInfo | undefined {
    const tasks = this.council.store.tasks();
    const members = this.council.interruptedMembers().map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      taskId: m.taskId,
      taskTitle: tasks.find((t) => t.id === m.taskId)?.title ?? m.taskId,
    }));
    const chair = this.council.store.agenda().chairInterrupted;
    if (!members.length && !chair) return undefined;
    return { members, chair };
  }

  /** Continue what was cut off: restart interrupted members from their notes and tell the chair. */
  async resume(): Promise<{ resumed: Array<{ from: string; to: string }>; failed: Array<{ id: string; error: string }> }> {
    const info = this.resumeInfo();
    const resumed: Array<{ from: string; to: string }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    if (!info) return { resumed, failed };
    for (const m of info.members) {
      try {
        const next = await this.council.handover(m.id, { resume: true, reason: "중단된 작업 이어서 하기" });
        resumed.push({ from: m.id, to: next.id });
      } catch (e) {
        failed.push({ id: m.id, error: (e as Error).message });
      }
    }
    const agenda = this.council.store.agenda();
    delete agenda.chairInterrupted;
    this.council.store.saveAgenda(agenda);
    const lines = [
      "[council event] 앱이나 안건이 중간에 꺼졌다가 다시 열렸고, 사용자가 이어서 하기를 눌렀다.",
      resumed.length ? `이어서 시작한 위원: ${resumed.map((r) => `${r.from} → ${r.to}`).join(", ")} (같은 worktree·브랜치, STATE.md와 HANDOVER.md로 이어감). 완료 이벤트를 기다려라.` : "",
      failed.length ? `이어가지 못한 위원: ${failed.map((f) => `${f.id} (${f.error})`).join(", ")}. council_state로 확인하고 다시 배정하거나 사용자에게 알려라.` : "",
      info.chair ? `네 응답도 중간에 끊겼다. 끊기기 전 요청: "${info.chair.message.slice(0, 1500)}". council_state로 상태를 확인하고 그 일을 이어서 해라.` : "council_state로 상태를 확인하고 하던 일을 이어서 해라.",
    ].filter(Boolean);
    this.enqueue(lines.join("\n"));
    this.emitEvent({ type: "state" });
    return { resumed, failed };
  }

  /** forget the interruption without continuing */
  dismissResume(): void {
    for (const m of this.council.interruptedMembers()) m.interrupted = false;
    this.council.persistMembers();
    const agenda = this.council.store.agenda();
    delete agenda.chairInterrupted;
    this.council.store.saveAgenda(agenda);
    this.emitEvent({ type: "state" });
  }

  private emitEvent(e: RuntimeEvent): void {
    this.emit("event", e);
  }

  private bump(memberId: string): void {
    const arr = this.activityLog.get(memberId) ?? [];
    arr.push(Date.now());
    const cutoff = Date.now() - ACTIVITY_MINUTES * 60_000;
    while (arr.length && arr[0] < cutoff) arr.shift();
    this.activityLog.set(memberId, arr);
  }

  activity(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const now = Date.now();
    for (const m of this.council.members()) {
      const buckets = new Array<number>(ACTIVITY_MINUTES).fill(0);
      for (const t of this.activityLog.get(m.id) ?? []) {
        const i = ACTIVITY_MINUTES - 1 - Math.floor((now - t) / 60_000);
        if (i >= 0 && i < ACTIVITY_MINUTES) buckets[i]++;
      }
      out[m.id] = buckets;
    }
    return out;
  }

  state(): RuntimeState {
    const s = this.council.state();
    const session = this.council.store.chairSession();
    return {
      ...s,
      key: this.key,
      chair: {
        model: this.chair.model(),
        effort: this.chair.effort(),
        advisor: this.council.project.chair.advisor,
        account: this.chair.account(),
        sessionId: session.sessionId,
        busy: this.chair.isBusy(),
      },
      activity: this.activity(),
      resume: this.resumeInfo(),
    };
  }

  transcript(limit = 200): TranscriptEntry[] {
    const f = path.join(this.council.store.dir, "transcript.jsonl");
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as TranscriptEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is TranscriptEntry => Boolean(x))
      .map((e) => (e.role === "user" && e.text.startsWith("[council event]") ? { ...e, role: "event" as const } : e));
  }

  isFirstTurn(): boolean {
    return !this.council.store.chairSession().sessionId;
  }

  /** Change chair model/effort (persisted on the project; takes effect next turn, session continues). */
  setChair(cfg: { model?: string; effort?: string; advisor?: string; account?: string }): void {
    this.chair.setOverrides({});
    const p = this.council.project;
    if (cfg.model !== undefined) p.chair.model = cfg.model || undefined;
    if (cfg.effort !== undefined) p.chair.effort = cfg.effort || undefined;
    if (cfg.advisor !== undefined) p.chair.advisor = cfg.advisor;
    if (cfg.account !== undefined && cfg.account !== (p.chair.account ?? "")) {
      p.chair.account = cfg.account || undefined;
      // a Claude Code session lives in one config dir; the new account starts fresh from state.md
      this.chair.resetSession();
    }
    this.council.registry.save(p);
    this.emitEvent({ type: "state" });
  }

  resetChair(): void {
    this.chair.resetSession();
    this.emitEvent({ type: "state" });
  }

  /** Send a user message (or the first-turn preamble) to the chair. Rejects while busy. */
  attachmentsDir(): string {
    return path.join(this.council.store.dir, "attachments");
  }

  /** Save an uploaded file for this agenda. */
  saveAttachment(name: string, type: string, data: Buffer): Attachment {
    const dir = this.attachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = (name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(-80) || "file";
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
    fs.writeFileSync(path.join(dir, id), data);
    return { id, name: safe, type: type || "application/octet-stream", size: data.length };
  }

  attachmentPath(id: string): string | undefined {
    const p = path.join(this.attachmentsDir(), path.basename(id));
    return fs.existsSync(p) ? p : undefined;
  }

  async send(message: string, role: "user" | "event" = "user", attachments: Attachment[] = []): Promise<ChairTurnResult> {
    if (this.chair.isBusy()) throw new Error("chair is busy");
    let text = message || (attachments.length ? "첨부한 파일을 확인해 주세요." : this.isFirstTurn() ? firstTurnPreamble() : "");
    if (!text) throw new Error("empty message");
    if (attachments.length) {
      const lines = attachments.map((a) => `- ${path.join(this.attachmentsDir(), a.id)} (${a.name}, ${a.type}, ${Math.max(1, Math.round(a.size / 1024))}KB)`);
      text +=
        "\n\n[첨부 파일] 사용자가 붙인 파일이다. Read 도구로 열어 본다(이미지도 읽을 수 있다). 위원이 써야 하면 지시에 이 경로를 적어 준다.\n" +
        lines.join("\n");
    }
    this.emitEvent({ type: "chair:start", role, text: message || text, attachments });
    const onEvent = (e: ClaudeEvent) => {
      if (e.kind === "text") this.emitEvent({ type: "chair:text", text: e.text });
      else if (e.kind === "tool") this.emitEvent({ type: "chair:tool", name: e.name, input: e.input });
      else if (e.kind === "handover") this.emitEvent({ type: "chair:handover", from: e.from, to: e.to, reason: e.reason });
    };
    let res: ChairTurnResult;
    try {
      res = await this.chair.turn(text, onEvent, attachments, message);
    } catch (e) {
      res = { text: (e as Error).message, isError: true };
    }
    this.emitEvent({ type: "chair:done", text: res.text, isError: res.isError, costUsd: res.costUsd });
    this.emitEvent({ type: "state" });
    void this.flush();
    return res;
  }

  /** Chair retrospective turn (memory + persona notes + proposal review). No-op if the chair never ran. */
  async retrospect(): Promise<ChairTurnResult | undefined> {
    if (this.isFirstTurn()) return undefined;
    if (this.council.runningCount()) throw new Error("members still running");
    return this.send(retrospectivePrompt(), "user");
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.closed || this.chair.isBusy() || this.queue.length === 0) return;
    const batch = this.queue.splice(0).join("\n\n");
    await this.send(batch, "event");
  }

  close(opts: { closeMemory?: boolean } = {}): void {
    this.closed = true;
    if (this.chair.isBusy()) {
      // remember the cut-off turn so the user can continue it next time
      const agenda = this.council.store.agenda();
      agenda.chairInterrupted = { at: new Date().toISOString(), message: lastUserText(this.council.store) ?? "" };
      this.council.store.saveAgenda(agenda);
      this.chair.stop();
    }
    this.council.stopAll();
    if (opts.closeMemory ?? true) this.council.memory.close();
  }
}
