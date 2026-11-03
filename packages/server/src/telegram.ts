import fs from "node:fs";
/**
 * Telegram bridge: pushes council events to one chat and relays messages from that chat
 * to the chair of the bound agenda. Plain fetch against api.telegram.org, long polling.
 * With a forum (topics) group connected, every agenda gets its own topic: its notifications
 * go there and what the owner writes in it goes to that agenda's chair.
 */
import type { AgendaRuntime, Attachment, RuntimeEvent } from "@gencouncil/council";
import { memberDisplayName } from "@gencouncil/council";

export interface TelegramConfig {
  botToken: string;
  /** numeric chat id as string; the private chat is also the owner's user id */
  chatId: string;
  /** agenda key (project/slug) that plain messages go to */
  agenda?: string;
  /** supergroup with topics enabled; when set, agenda notifications go to per-agenda topics instead of the DM */
  forumChatId?: string;
  /** agenda key -> message_thread_id of its topic */
  topics?: Record<string, number>;
  /** force automatic sending (chair replies, drafts, ...) for every agenda; default off: an agenda opts in by itself (isAuto) or the chair sends when the user asks (council_telegram) */
  autoNotify?: boolean;
}

/** what the chair's council_telegram tool asks the bridge to send */
export interface TelegramSendRequest {
  text: string;
  files: Array<{ name: string; type: string; path: string }>;
  /** attach the agenda's current question as buttons */
  ask?: { question: string; options: string[] };
}

export interface TelegramSendResult {
  ok: boolean;
  detail: string;
}

export interface TelegramDeps {
  fetch?: typeof fetch;
  log: (line: string) => void;
  listAgendas: () => Array<{ key: string; title: string; status: string }>;
  getRuntime: (key: string) => Promise<AgendaRuntime>;
  /** persist a new bound agenda */
  onBind: (key: string | undefined) => void;
  /** persist forum settings (forumChatId, topics) */
  onConfig?: (patch: Pick<TelegramConfig, "forumChatId" | "topics">) => void;
  /** the agenda has its own automatic Telegram sending switched on (web button / /auto) */
  isAuto?: (key: string) => boolean;
  /** switch an agenda's automatic Telegram sending (same path as the web button) */
  setAuto?: (key: string, on: boolean) => Promise<void>;
}

interface TgChat {
  id: number | string;
  type?: string;
  is_forum?: boolean;
}

interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

interface TgPhotoSize extends TgFile {
  width?: number;
  height?: number;
}

interface TgMessage {
  message_id: number;
  text?: string;
  /** the text of a message that carries a photo/video/file */
  caption?: string;
  photo?: TgPhotoSize[];
  video?: TgFile;
  document?: TgFile;
  animation?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
  video_note?: TgFile;
  /** messages of one album share this id */
  media_group_id?: string;
  chat: TgChat;
  message_thread_id?: number;
  from?: { id?: number | string; username?: string; first_name?: string };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; from?: { id?: number | string }; message?: Pick<TgMessage, "message_id" | "chat" | "message_thread_id"> };
}

interface PendingAsk {
  key: string;
  question: string;
  options: string[];
}

/** prefix of messages relayed to the chair, so it knows they came from Telegram */
const TG_MARK = "[텔레그램] ";
const MAX_ASKS = 50;
const BUTTON_LEN = 60;
const TOPIC_NAME_LEN = 128;

const MAX_LEN = 3900;
/** Telegram bot upload limits: 10MB for photos, 50MB for any file */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/** Bot API getFile/download limit */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const TOO_BIG_NOTICE = "20MB 넘는 파일은 텔레그램 봇으로 받을 수 없습니다. 웹 화면으로 올려 주세요";
/** quiet time before collected messages go to the chair as one, how often a busy chair is looked at, and how long it is waited for */
const DEFAULT_BATCH_MS = 4000;
const DEFAULT_BUSY_POLL_MS = 3000;
const DEFAULT_BUSY_MAX_MS = 30 * 60 * 1000;

export interface TelegramOptions {
  batchMs?: number;
  busyPollMs?: number;
  busyMaxMs?: number;
}

/** the file of a Telegram message, before it is downloaded */
interface MediaRef {
  fileId: string;
  size?: number;
  name: string;
  type: string;
}

/** messages (text and files) of one agenda collected until they go to the chair together */
interface Batch {
  key: string;
  parts: string[];
  files: Attachment[];
  reply: (t: string) => Promise<string>;
  timer?: ReturnType<typeof setTimeout>;
  /** the quiet period is over: the batch is being delivered or waits for a busy chair */
  flushing: boolean;
}

/** Telegram errors that mean the topic no longer exists (deleted by hand) */
const TOPIC_GONE = /message thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i;

export class TelegramBridge {
  private offset = 0;
  private running = false;
  private asks = new Map<string, PendingAsk>();
  private askSeq = 0;
  private readonly fetchImpl: typeof fetch;
  /** topic creations in flight, so two notifications for one agenda make one topic */
  private creating = new Map<string, Promise<number>>();
  /** agenda key -> messages waiting to go to its chair together */
  private batches = new Map<string, Batch>();
  private readonly batchMs: number;
  private readonly busyPollMs: number;
  private readonly busyMaxMs: number;

  constructor(
    private cfg: TelegramConfig,
    private readonly deps: TelegramDeps,
    opts: TelegramOptions = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.batchMs = opts.batchMs ?? DEFAULT_BATCH_MS;
    this.busyPollMs = opts.busyPollMs ?? DEFAULT_BUSY_POLL_MS;
    this.busyMaxMs = opts.busyMaxMs ?? DEFAULT_BUSY_MAX_MS;
  }

  private async call(method: string, body?: Record<string, unknown> | FormData): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.cfg.botToken}/${method}`;
    const r = await this.fetchImpl(url, body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!j?.ok) throw new Error(`telegram ${method}: ${j?.description ?? r.status}`);
    return j.result;
  }

  private api(method: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.call(method, body);
  }

  async verify(): Promise<string> {
    const me = (await this.api("getMe")) as { username?: string };
    return me.username ?? "?";
  }

  private forumChat(): string | undefined {
    return this.cfg.forumChatId ? String(this.cfg.forumChatId) : undefined;
  }

  private applyConfig(patch: Pick<TelegramConfig, "forumChatId" | "topics">): void {
    Object.assign(this.cfg, patch);
    this.deps.onConfig?.({ ...patch, ...(patch.topics ? { topics: { ...patch.topics } } : {}) });
  }

  private keyForThread(thread: number | undefined): string | undefined {
    if (thread === undefined) return undefined;
    return Object.entries(this.cfg.topics ?? {}).find(([, t]) => t === thread)?.[0];
  }

  /** Topic (message_thread_id) of an agenda, created on first use. */
  private ensureTopic(key: string): Promise<number> {
    const known = this.cfg.topics?.[key];
    if (known !== undefined) return Promise.resolve(known);
    let p = this.creating.get(key);
    if (!p) {
      const forum = this.forumChat();
      if (!forum) return Promise.reject(new Error("no forum chat"));
      const title = this.deps.listAgendas().find((a) => a.key === key)?.title;
      const name = (title || key.split("/")[1] || key).slice(0, TOPIC_NAME_LEN);
      p = (async () => {
        const r = (await this.api("createForumTopic", { chat_id: forum, name })) as { message_thread_id?: number };
        if (typeof r?.message_thread_id !== "number") throw new Error("telegram createForumTopic: no message_thread_id");
        this.applyConfig({ topics: { ...this.cfg.topics, [key]: r.message_thread_id } });
        return r.message_thread_id;
      })().finally(() => this.creating.delete(key));
      this.creating.set(key, p);
    }
    return p;
  }

  private forgetTopic(key: string): void {
    const topics = { ...this.cfg.topics };
    delete topics[key];
    this.applyConfig({ topics });
  }

  /**
   * Run `fn` against the destination of an agenda's messages: its forum topic when a forum is
   * connected (recreating a topic that was deleted by hand), else the private chat. Never throws.
   */
  private async route(key: string, fn: (chat: string, thread?: number) => Promise<void>): Promise<boolean> {
    const forum = this.forumChat();
    if (!forum) {
      try {
        await fn(String(this.cfg.chatId));
        return true;
      } catch (e) {
        this.deps.log(`telegram send failed: ${(e as Error).message}`);
        return false;
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let thread: number;
      try {
        thread = await this.ensureTopic(key);
      } catch (e) {
        this.deps.log(`telegram topic failed: ${(e as Error).message}`);
        return false;
      }
      try {
        await fn(forum, thread);
        return true;
      } catch (e) {
        if (attempt === 0 && TOPIC_GONE.test((e as Error).message)) {
          this.forgetTopic(key);
          continue;
        }
        this.deps.log(`telegram send failed: ${(e as Error).message}`);
        return false;
      }
    }
    return false;
  }

  /** a leading "[slug] " tag is only useful in the shared DM */
  private static untag(text: string): string {
    return text.replace(/^\[[^\]\n]+\] ?/, "");
  }

  /** Send files to an agenda's destination: images as photos, other files as documents; what cannot be sent is returned by name. */
  private async deliverFiles(
    key: string,
    files: Array<{ name: string; type: string; path?: string }>,
    captionFor: (inTopic: boolean) => string | undefined,
  ): Promise<{ sent: string[]; unsent: string[] }> {
    const sent: string[] = [];
    const unsent: string[] = [];
    for (const f of files) {
      let data: Buffer<ArrayBuffer> | undefined;
      let asPhoto = false;
      try {
        if (f.path) {
          const size = fs.statSync(f.path).size;
          if (size <= MAX_DOCUMENT_BYTES) {
            data = fs.readFileSync(f.path);
            asPhoto = /^image\/(png|jpeg|gif|webp)$/.test(f.type) && size <= MAX_PHOTO_BYTES;
          }
        }
      } catch {
        data = undefined;
      }
      if (!data) {
        unsent.push(f.name);
        continue;
      }
      const first = sent.length === 0;
      const ok = await this.route(key, async (chat, thread) => {
        const form = new FormData();
        form.append("chat_id", chat);
        if (thread !== undefined) form.append("message_thread_id", String(thread));
        const caption = first ? captionFor(thread !== undefined) : undefined;
        if (caption) form.append("caption", caption.slice(0, 1000));
        form.append(asPhoto ? "photo" : "document", new Blob([data!], { type: f.type }), f.name);
        await this.call(asPhoto ? "sendPhoto" : "sendDocument", form);
      });
      if (ok) sent.push(f.name);
      else unsent.push(f.name);
    }
    return { sent, unsent };
  }

  private static tag(key: string): string {
    return `[${key.split("/")[1] ?? key}]`;
  }

  /** automatic sending is on for this agenda: server-wide force (autoNotify) or the agenda's own switch (default on; the server's isAuto reports it) */
  private isAuto(key: string): boolean {
    if (this.cfg.autoNotify) return true;
    try {
      return Boolean(this.deps.isAuto?.(key));
    } catch {
      return false;
    }
  }

  /** (auto mode) the chair showed drafts: images go as photos, other files as documents; what cannot be sent is only named */
  async sendShown(key: string, caption: string, files: Array<{ name: string; type: string; path?: string }>): Promise<void> {
    if (!this.isAuto(key)) return;
    const tag = TelegramBridge.tag(key);
    const { sent, unsent } = await this.deliverFiles(key, files, (inTopic) => `${inTopic ? "" : tag + " "}의장 시안: ${caption}`);
    if (unsent.length || !sent.length) await this.sendFor(key, `${tag} 의장 시안: ${caption}${unsent.length ? "\n파일: " + unsent.join(", ") + " (웹 화면에서 보기)" : ""}`);
  }

  /**
   * The user told the chair to send something to Telegram (council_telegram): text, files and the
   * pending question as buttons, to the agenda's topic (forum) or the private chat. Reports what happened.
   */
  async sendRequested(key: string, req: TelegramSendRequest): Promise<TelegramSendResult> {
    const tag = TelegramBridge.tag(key);
    const parts: string[] = [];
    const problems: string[] = [];
    let sentFiles = 0;
    let captionUsed = false;
    // a short text with files and no question rides as the first file's caption
    const canCaption = req.files.length > 0 && !req.ask && req.text.length <= 1000;
    if (req.files.length) {
      const r = await this.deliverFiles(key, req.files, (inTopic) => {
        if (!canCaption) return undefined;
        captionUsed = true;
        return `${inTopic ? "" : tag + " "}${req.text}`;
      });
      sentFiles = r.sent.length;
      if (r.sent.length) parts.push(`파일 ${r.sent.length}개`);
      if (r.unsent.length) problems.push(`못 보낸 파일: ${r.unsent.join(", ")}`);
      if (!r.sent.length) captionUsed = false;
    }
    let textOk = true;
    if (!captionUsed) {
      let body = req.text;
      if (req.ask && !body.includes(req.ask.question)) body += `\n\n${req.ask.question}`;
      const buttons = Boolean(req.ask?.options.length);
      if (req.ask && buttons) body += `\n선택지: ${req.ask.options.join(" / ")}`;
      const extra = req.ask && buttons ? { reply_markup: { inline_keyboard: this.registerAsk(key, req.ask.question, req.ask.options) } } : undefined;
      textOk = await this.sendFor(key, `${tag} ${body}`, extra);
      if (textOk) parts.push(buttons ? "글+선택 버튼" : "글");
      else problems.push("글 전송 실패");
    }
    const ok = textOk && sentFiles === req.files.length;
    const where = this.forumChat() ? "포럼 토픽" : "텔레그램 DM";
    return { ok, detail: `${ok ? "보냈다" : "일부만 보냈거나 실패했다"} (${where}): ${parts.join(", ") || "없음"}${problems.length ? ". " + problems.join("; ") : ""}` };
  }

  private async sendChunks(chat: string, thread: number | undefined, text: string, extra?: Record<string, unknown>): Promise<void> {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > MAX_LEN) {
      let cut = rest.lastIndexOf("\n", MAX_LEN);
      if (cut < MAX_LEN / 2) cut = MAX_LEN;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    chunks.push(rest);
    for (const [i, c] of chunks.entries()) {
      await this.api("sendMessage", {
        chat_id: chat,
        ...(thread !== undefined ? { message_thread_id: thread } : {}),
        text: c,
        disable_web_page_preview: true,
        ...(i === chunks.length - 1 ? extra : {}),
      });
    }
  }

  /** Send text to one chat (and topic), chunked. Never throws (notifications must not break the server). */
  private async say(chat: string, thread: number | undefined, text: string, extra?: Record<string, unknown>): Promise<void> {
    try {
      await this.sendChunks(chat, thread, text, extra);
    } catch (e) {
      this.deps.log(`telegram send failed: ${(e as Error).message}`);
    }
  }

  /** Send text to the private chat. */
  async send(text: string, extra?: Record<string, unknown>): Promise<void> {
    await this.say(String(this.cfg.chatId), undefined, text, extra);
  }

  /** Send text about an agenda: to its forum topic when a forum is connected, else to the private chat. Resolves to whether it was sent. */
  async sendFor(key: string, text: string, extra?: Record<string, unknown>): Promise<boolean> {
    if (!this.forumChat()) return this.route(key, (chat) => this.sendChunks(chat, undefined, text, extra));
    return this.route(key, (chat, thread) => this.sendChunks(chat, thread, TelegramBridge.untag(text), extra));
  }

  /** An agenda ended: close its topic (a failure to close is ignored); the closing message goes out only in auto mode. */
  async finishFor(key: string, text: string): Promise<void> {
    if (this.isAuto(key)) await this.sendFor(key, text);
    const forum = this.forumChat();
    const thread = this.cfg.topics?.[key];
    if (forum && thread !== undefined) await this.api("closeForumTopic", { chat_id: forum, message_thread_id: thread }).catch(() => {});
  }

  /** Turn a runtime event into a notification line, or undefined for noise. */
  static format(key: string, e: RuntimeEvent): string | undefined {
    const tag = `[${key.split("/")[1] ?? key}]`;
    switch (e.type) {
      case "chair:done":
        return e.isError ? `${tag} 의장 오류: ${e.text.slice(0, 1500)}` : `${tag} 의장:\n${e.text.slice(0, 3000)}`;
      case "member:done": {
        const m = e.member;
        const head = `${tag} 위원 ${memberDisplayName(m)}(${m.id}) ${m.status}${m.handoverTo ? ` → ${m.handoverTo} 인계` : ""}`;
        const body = m.result?.summary ? `\n${m.result.summary.slice(0, 600)}` : m.error ? `\n${m.error.slice(0, 300)}` : "";
        return head + body;
      }
      case "member:start":
        return e.member.status === "waiting" ? `${tag} 릴레이 위원 ${memberDisplayName(e.member)} 패킷 대기 중 (웹 UI에서 복사)` : undefined;
      case "chair:ask":
        return `${tag} 의장이 결정을 기다립니다: ${e.question}${e.options?.length ? "\n선택지: " + e.options.join(" / ") : ""}`;
      case "chair:handover":
        return `${tag} 의장 계정 전환 ${e.from} → ${e.to} (${e.reason})`;
      default:
        return undefined;
    }
  }

  /** remember a question so a button press can be matched to it; returns the inline keyboard */
  private registerAsk(key: string, question: string, options: string[]): Array<Array<{ text: string; callback_data: string }>> {
    const id = (++this.askSeq).toString(36);
    this.asks.set(id, { key, question, options });
    while (this.asks.size > MAX_ASKS) this.asks.delete(this.asks.keys().next().value as string);
    return options.map((o, i) => [{ text: o.length > BUTTON_LEN ? o.slice(0, BUTTON_LEN - 1) + "…" : o, callback_data: `a:${id}:${i}` }]);
  }

  /** push a runtime event: a question waiting for the user's decision always goes out; everything else only when automatic sending is on for the agenda */
  notify(key: string, e: RuntimeEvent): void {
    if (!this.isAuto(key) && e.type !== "chair:ask") return;
    const text = TelegramBridge.format(key, e);
    if (!text) return;
    if (e.type === "chair:ask" && e.options?.length) {
      void this.sendFor(key, text, { reply_markup: { inline_keyboard: this.registerAsk(key, e.question, e.options) } });
      return;
    }
    void this.sendFor(key, text);
  }

  private async handleCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<string | undefined> {
    const chat = cq.message ? String(cq.message.chat.id) : undefined;
    const inDm = chat === String(this.cfg.chatId);
    const inForum = chat !== undefined && chat === this.forumChat();
    if (!inDm && !(inForum && String(cq.from?.id) === String(this.cfg.chatId))) {
      this.deps.log(`telegram: ignored callback from chat ${cq.message?.chat.id}`);
      return undefined;
    }
    const answer = async (t: string) => {
      await this.api("answerCallbackQuery", { callback_query_id: cq.id, text: t }).catch(() => {});
      return t;
    };
    const clearButtons = async () => {
      if (cq.message) await this.api("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    };
    const m = /^a:([^:]+):(\d+)$/.exec(cq.data ?? "");
    const ask = m ? this.asks.get(m[1]) : undefined;
    const choice = ask?.options[Number(m?.[2])];
    if (!m || !ask || choice === undefined) {
      await clearButtons();
      return answer("이미 지난 질문입니다");
    }
    let rt: AgendaRuntime;
    try {
      rt = await this.deps.getRuntime(ask.key);
    } catch (e) {
      return answer(`안건을 열 수 없습니다: ${(e as Error).message}`);
    }
    const waiting = rt.state().agenda.waitingForUser;
    if (waiting?.question !== ask.question) {
      this.asks.delete(m[1]);
      await clearButtons();
      return answer("이미 지난 질문입니다");
    }
    if (rt.chair.isBusy()) return answer("의장이 처리 중입니다");
    this.asks.delete(m[1]);
    if (waiting.kind === "finish" && choice === "계속 진행") rt.council.clearWaiting();
    else void rt.send(choice).catch((e) => this.deps.log(`telegram → chair failed: ${(e as Error).message}`));
    await answer("의장에게 전달했습니다");
    await clearButtons();
    const thread = inForum ? (cq.message?.message_thread_id ?? this.cfg.topics?.[ask.key]) : undefined;
    await this.say(chat!, thread, `선택: ${choice} → 의장에게 전달했습니다`);
    return choice;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.batches.clear();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = (await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] })) as TgUpdate[];
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u);
        }
      } catch (e) {
        this.deps.log(`telegram poll error: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private statusText(rt: AgendaRuntime): string {
    const s = rt.state();
    const tasks = s.tasks.map((t) => `${t.id}[${t.status}] ${t.title}${t.memberId ? " ← " + t.memberId : ""}`).join("\n") || "(작업 없음)";
    const members = s.members.filter((m) => m.status === "running" || m.status === "waiting").map((m) => `${memberDisplayName(m)}(${m.id}) ${m.status}`).join(", ") || "없음";
    return `${s.agenda.title}\n목표: ${s.agenda.goals.length}개\n${tasks}\n실행 중: ${members}\n의장: ${s.chair.busy ? "작업 중" : "대기"}`;
  }

  private listText(): string {
    const all = this.deps.listAgendas();
    return all.length ? all.map((a) => `${a.key === this.cfg.agenda ? "▶ " : ""}${a.key} [${a.status}] ${a.title}`).join("\n") : "안건이 없습니다.";
  }

  /** the chair's answers come here by themselves while the agenda's auto sending is on (the default) */
  private autoHint(key?: string): string {
    if (this.cfg.autoNotify) return "";
    if (key && this.isAuto(key)) return "\n이 안건은 자동 전송이 켜져 있어(기본) 의장 답과 진행 알림이 모두 옵니다. (/auto off 로 끔)";
    return "\n이 안건은 자동 전송이 꺼져 있어 결정을 묻는 질문만 옵니다. 그 밖의 의장 답은 의장에게 '텔레그램으로 보내 줘'라고 하거나, /auto on 으로 자동 전송을 켜세요.";
  }

  /** `/auto`, `/auto on`, `/auto off`: show or switch the agenda's automatic sending */
  private async autoCommand(key: string, text: string, reply: (t: string) => Promise<string>): Promise<string> {
    const arg = text.slice(5).trim().toLowerCase();
    if (this.cfg.autoNotify) return reply("서버 설정(--auto on)으로 모든 안건의 자동 전송이 강제로 켜져 있습니다. (끄려면 gencouncil web telegram --auto off 후 서버 재시작)");
    if (arg === "") return reply(`${this.isAuto(key) ? "자동 전송 켜짐(기본): 이 안건의 모든 알림을 보냅니다." : "자동 전송 꺼짐: 결정 대기 질문만 보냅니다."}\n/auto on 또는 /auto off`);
    if (arg !== "on" && arg !== "off") return reply("/auto on 또는 /auto off 로 보내세요. (/auto 는 현재 상태)");
    if (!this.deps.setAuto) return reply("이 서버에서는 /auto 를 쓸 수 없습니다.");
    try {
      await this.deps.setAuto(key, arg === "on");
    } catch (e) {
      return reply(`안건을 열 수 없습니다: ${(e as Error).message}`);
    }
    return reply(arg === "on" ? "자동 전송을 켰습니다. 이 안건의 모든 알림을 보냅니다." : "자동 전송을 껐습니다. 이제 결정 대기 질문만 보냅니다.");
  }

  /** `/forum` sent inside a group: the owner connects that group as the forum. */
  private connectForum(msg: TgMessage, reply: (t: string) => Promise<string>): Promise<string | undefined> {
    if (String(msg.from?.id) !== String(this.cfg.chatId)) {
      this.deps.log(`telegram: ignored /forum from user ${msg.from?.id} in chat ${msg.chat.id}`);
      return Promise.resolve(undefined);
    }
    if (msg.chat.type !== "supergroup" || !msg.chat.is_forum) {
      return reply("이 그룹은 토픽이 꺼져 있습니다. 그룹 설정에서 '토픽'을 켠 뒤 다시 /forum 을 보내세요.");
    }
    const id = String(msg.chat.id);
    this.applyConfig({ forumChatId: id, topics: id === this.forumChat() ? { ...this.cfg.topics } : {} });
    return reply("이 그룹을 GenCouncil 포럼으로 연결했습니다. 이제 안건마다 토픽이 만들어집니다.");
  }

  /** The file of a message (one per message): the largest photo size, else the video/animation/... object. */
  private static mediaOf(msg: TgMessage): MediaRef | undefined {
    const pick = (f: TgFile | undefined, name: string, type: string): MediaRef | undefined =>
      f?.file_id ? { fileId: f.file_id, size: f.file_size, name: f.file_name || name, type: f.mime_type || type } : undefined;
    if (msg.photo?.length) {
      const area = (p: TgPhotoSize) => (p.width ?? 0) * (p.height ?? 0) || p.file_size || 0;
      const best = msg.photo.reduce((a, b) => (area(b) >= area(a) ? b : a));
      return pick(best, "photo.jpg", "image/jpeg");
    }
    return (
      pick(msg.video, "video.mp4", "video/mp4") ??
      pick(msg.animation, "animation.mp4", "video/mp4") ??
      pick(msg.video_note, "video_note.mp4", "video/mp4") ??
      pick(msg.audio, "audio.mp3", "audio/mpeg") ??
      pick(msg.voice, "voice.ogg", "audio/ogg") ??
      pick(msg.document, "document", "application/octet-stream")
    );
  }

  /** Download a file through the Bot API; "toobig" when it is over the 20MB limit. */
  private async download(m: MediaRef): Promise<Buffer | "toobig"> {
    if (m.size !== undefined && m.size > MAX_DOWNLOAD_BYTES) return "toobig";
    let info: { file_path?: string; file_size?: number };
    try {
      info = (await this.api("getFile", { file_id: m.fileId })) as { file_path?: string; file_size?: number };
    } catch (e) {
      if (/too big/i.test((e as Error).message)) return "toobig";
      throw e;
    }
    if (info.file_size !== undefined && info.file_size > MAX_DOWNLOAD_BYTES) return "toobig";
    if (!info.file_path) throw new Error("telegram getFile: no file_path");
    const r = await this.fetchImpl(`https://api.telegram.org/file/bot${this.cfg.botToken}/${info.file_path}`);
    if (r.ok === false) throw new Error(`telegram file download: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > MAX_DOWNLOAD_BYTES ? "toobig" : buf;
  }

  /** A message with a file: download it, save it to the agenda and collect it (with its caption) into the agenda's batch. */
  private async relayMedia(key: string, caption: string, media: MediaRef, reply: (t: string) => Promise<string>): Promise<string | undefined> {
    let rt: AgendaRuntime;
    try {
      rt = await this.deps.getRuntime(key);
    } catch (e) {
      return reply(`안건을 열 수 없습니다: ${(e as Error).message}`);
    }
    let file: Attachment | undefined;
    let notice: string | undefined;
    try {
      const data = await this.download(media);
      if (data === "toobig") notice = `${media.name}: ${TOO_BIG_NOTICE}`;
      else file = rt.saveAttachment(media.name, media.type, data);
    } catch (e) {
      this.deps.log(`telegram file failed: ${(e as Error).message}`);
      notice = `${media.name}: 파일을 받지 못했습니다 (${(e as Error).message})`;
    }
    if (notice) await reply(notice);
    if (!file && !caption) return notice;
    const existing = this.batches.get(key);
    this.addToBatch(existing ?? this.openBatch(key, reply), caption, file ? [file] : []);
    if (existing) return notice;
    return reply(`받았습니다${file ? "(파일 1개)" : ""}. 잠시 뒤 의장에게 함께 전달합니다.`);
  }

  private openBatch(key: string, reply: (t: string) => Promise<string>): Batch {
    const b: Batch = { key, parts: [], files: [], reply, flushing: false };
    this.batches.set(key, b);
    return b;
  }

  private addToBatch(b: Batch, text: string, files: Attachment[]): void {
    if (text) b.parts.push(text);
    b.files.push(...files);
    if (b.flushing) return;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => void this.flush(b), this.batchMs);
  }

  /** The quiet period is over: hand the batch to the chair, or wait (up to busyMaxMs) until it is free. */
  private async flush(b: Batch): Promise<void> {
    b.flushing = true;
    b.timer = undefined;
    let rt: AgendaRuntime;
    try {
      rt = await this.deps.getRuntime(b.key);
    } catch (e) {
      this.batches.delete(b.key);
      await b.reply(`안건을 열 수 없어 전달하지 못했습니다: ${(e as Error).message}`);
      return;
    }
    if (this.batches.get(b.key) !== b) return;
    if (!rt.chair.isBusy()) return this.deliver(b, rt);
    await b.reply("의장이 처리 중이라 끝나면 전달합니다.");
    const deadline = Date.now() + this.busyMaxMs;
    const poll = () => {
      b.timer = undefined;
      if (this.batches.get(b.key) !== b) return;
      if (!rt.chair.isBusy()) return void this.deliver(b, rt);
      if (Date.now() >= deadline) {
        this.batches.delete(b.key);
        void b.reply("의장이 30분 넘게 처리 중이라 전달하지 못했습니다. 다시 보내 주세요.");
        return;
      }
      b.timer = setTimeout(poll, this.busyPollMs);
    };
    b.timer = setTimeout(poll, this.busyPollMs);
  }

  private async deliver(b: Batch, rt: AgendaRuntime): Promise<void> {
    this.batches.delete(b.key);
    const n = b.files.length;
    const text = TG_MARK + (b.parts.join("\n") || `첨부 파일 ${n}개`);
    void rt.send(text, "user", b.files).catch((e) => this.deps.log(`telegram → chair failed: ${(e as Error).message}`));
    await b.reply(`의장에게 전달했습니다${n ? `(파일 ${n}개)` : ""}.`);
  }

  private async relayToChair(key: string, text: string, reply: (t: string) => Promise<string>): Promise<string | undefined> {
    // a batch is collecting (or waits for a busy chair): plain text joins it so the order is kept
    const open = this.batches.get(key);
    if (open && !text.startsWith("/")) {
      this.addToBatch(open, text, []);
      return undefined;
    }
    let rt: AgendaRuntime;
    try {
      rt = await this.deps.getRuntime(key);
    } catch (e) {
      return reply(`안건을 열 수 없습니다: ${(e as Error).message}`);
    }
    if (text === "/status") return reply(this.statusText(rt));
    if (rt.chair.isBusy()) return reply(this.isAuto(key) ? "의장이 아직 이전 턴을 처리 중입니다. 끝나면 알림이 옵니다." : "의장이 아직 이전 턴을 처리 중입니다. 잠시 뒤 다시 보내세요.");
    void rt.send(TG_MARK + text).catch((e) => this.deps.log(`telegram → chair failed: ${(e as Error).message}`));
    return reply("의장에게 전달했습니다.");
  }

  /** Exposed for tests. Returns the reply text that was sent (if any). */
  async handleUpdate(u: TgUpdate): Promise<string | undefined> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    const media = msg ? TelegramBridge.mediaOf(msg) : undefined;
    if (!msg || (!msg.text && !media)) return undefined;
    const chat = String(msg.chat.id);
    const inDm = chat === String(this.cfg.chatId);
    const inForum = !inDm && chat === this.forumChat();
    // in groups commands arrive as /cmd@botname
    const text = (msg.text ?? "").trim().replace(/^(\/\w+)@\w+/, "$1");
    const thread = inForum ? msg.message_thread_id : undefined;
    const reply = async (t: string) => {
      await this.say(chat, thread, t);
      return t;
    };

    if (media) {
      // a file with its caption: same owner/chat rules as text, but never a command
      if (!inDm && !inForum) {
        this.deps.log(`telegram: ignored file from chat ${msg.chat.id}`);
        return undefined;
      }
      if (inForum && String(msg.from?.id) !== String(this.cfg.chatId)) {
        this.deps.log(`telegram: ignored forum file from user ${msg.from?.id}`);
        return undefined;
      }
      const key = inForum ? this.keyForThread(thread) : this.cfg.agenda;
      if (!key) return reply(inForum ? "안건 토픽 안에 쓰세요. 일반 토픽의 글과 파일은 의장에게 전달되지 않습니다." : "먼저 /agenda <project/slug> 로 안건을 고르세요. /list 로 목록을 봅니다.");
      return this.relayMedia(key, (msg.caption ?? "").trim(), media, reply);
    }

    if (!inDm && !inForum) {
      // the only thing a not-yet-connected group may say is /forum
      if (text === "/forum") {
        const groupReply = async (t: string) => {
          await this.say(chat, msg.message_thread_id, t);
          return t;
        };
        return this.connectForum(msg, groupReply);
      }
      this.deps.log(`telegram: ignored message from chat ${msg.chat.id}`);
      return undefined;
    }

    if (inForum) {
      if (String(msg.from?.id) !== String(this.cfg.chatId)) {
        this.deps.log(`telegram: ignored forum message from user ${msg.from?.id}`);
        return undefined;
      }
      if (text === "/forum") return this.connectForum(msg, reply);
      if (text === "/start" || text === "/help") {
        return reply("GenCouncil 봇입니다.\n안건 토픽 안에 쓴 글은 그 안건 의장에게 전달됩니다.\n/status 그 안건 상태\n/auto on|off 그 안건 자동 전송 켜기/끄기 (/auto 는 상태)\n/list 안건 목록" + this.autoHint(this.keyForThread(thread) ?? this.cfg.agenda));
      }
      if (text === "/list") return reply(this.listText());
      const key = this.keyForThread(thread);
      if (text === "/auto" || text.startsWith("/auto ")) return key ? this.autoCommand(key, text, reply) : reply("/auto 는 안건 토픽 안에서 보내세요.");
      if (key) return this.relayToChair(key, text, reply);
      if (text === "/status" && this.cfg.agenda) return this.relayToChair(this.cfg.agenda, text, reply);
      return reply("안건 토픽 안에 쓰세요. 일반 토픽의 글은 의장에게 전달되지 않습니다. (/list /help /forum /status 만 쓸 수 있습니다)");
    }

    if (text === "/forum") return reply("/forum 은 포럼으로 쓸 그룹(토픽 켬) 안에서 보내세요. 봇을 그 그룹의 관리자(토픽 관리 권한)로 추가해야 합니다.");
    if (text === "/start" || text === "/help") {
      return reply("GenCouncil 봇입니다.\n/list 안건 목록\n/agenda <project/slug> 대화할 안건 선택\n/status 현재 안건 상태\n/auto on|off 현재 안건 자동 전송 켜기/끄기 (/auto 는 상태)\n그 외 텍스트는 의장에게 전달됩니다." + this.autoHint(this.cfg.agenda));
    }
    if (text === "/list") return reply(this.listText());
    if (text.startsWith("/agenda")) {
      const key = text.slice(7).trim();
      const hit = this.deps.listAgendas().find((a) => a.key === key || a.key.endsWith("/" + key) || a.title === key);
      if (!hit) return reply(`모르는 안건: ${key}\n/list 로 확인하세요.`);
      this.cfg.agenda = hit.key;
      this.deps.onBind(hit.key);
      return reply(`대화 대상: ${hit.key} (${hit.title})`);
    }
    if (!this.cfg.agenda) return reply("먼저 /agenda <project/slug> 로 안건을 고르세요. /list 로 목록을 봅니다.");
    if (text === "/auto" || text.startsWith("/auto ")) return this.autoCommand(this.cfg.agenda, text, reply);
    return this.relayToChair(this.cfg.agenda, text, reply);
  }
}
