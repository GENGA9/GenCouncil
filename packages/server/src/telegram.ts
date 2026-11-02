import fs from "node:fs";
/**
 * Telegram bridge: pushes council events to one chat and relays messages from that chat
 * to the chair of the bound agenda. Plain fetch against api.telegram.org, long polling.
 * With a forum (topics) group connected, every agenda gets its own topic: its notifications
 * go there and what the owner writes in it goes to that agenda's chair.
 */
import type { AgendaRuntime, RuntimeEvent } from "@gencouncil/council";
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
}

interface TgChat {
  id: number | string;
  type?: string;
  is_forum?: boolean;
}

interface TgMessage {
  message_id: number;
  text?: string;
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

const MAX_ASKS = 50;
const BUTTON_LEN = 60;
const TOPIC_NAME_LEN = 128;

const MAX_LEN = 3900;

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

  constructor(
    private cfg: TelegramConfig,
    private readonly deps: TelegramDeps,
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
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

  /** the chair showed drafts: images go as photos, other files as a short note */
  async sendShown(key: string, caption: string, files: Array<{ name: string; type: string; path?: string }>): Promise<void> {
    const tag = `[${key.split("/")[1] ?? key}]`;
    const images = files.filter((f) => f.path && /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    for (const [i, f] of images.entries()) {
      try {
        const data = fs.readFileSync(f.path!);
        await this.route(key, async (chat, thread) => {
          const form = new FormData();
          form.append("chat_id", chat);
          if (thread !== undefined) form.append("message_thread_id", String(thread));
          if (i === 0) form.append("caption", `${thread !== undefined ? "" : tag + " "}의장 시안: ${caption}`.slice(0, 1000));
          form.append("photo", new Blob([data], { type: f.type }), f.name);
          await this.call("sendPhoto", form);
        });
      } catch {
        /* a failed photo must not stop the chair */
      }
    }
    const others = files.filter((f) => !images.includes(f));
    if (others.length || images.length === 0) await this.sendFor(key, `${tag} 의장 시안: ${caption}${others.length ? "\n파일: " + others.map((f) => f.name).join(", ") + " (웹 화면에서 보기)" : ""}`);
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

  /** Send text about an agenda: to its forum topic when a forum is connected, else to the private chat. */
  async sendFor(key: string, text: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.forumChat()) return this.send(text, extra);
    await this.route(key, (chat, thread) => this.sendChunks(chat, thread, TelegramBridge.untag(text), extra));
  }

  /** Send the closing message of an agenda, then close its topic (a failure to close is ignored). */
  async finishFor(key: string, text: string): Promise<void> {
    await this.sendFor(key, text);
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

  notify(key: string, e: RuntimeEvent): void {
    const text = TelegramBridge.format(key, e);
    if (!text) return;
    if (e.type === "chair:ask" && e.options?.length) {
      const id = (++this.askSeq).toString(36);
      this.asks.set(id, { key, question: e.question, options: e.options });
      while (this.asks.size > MAX_ASKS) this.asks.delete(this.asks.keys().next().value as string);
      const inline_keyboard = e.options.map((o, i) => [{ text: o.length > BUTTON_LEN ? o.slice(0, BUTTON_LEN - 1) + "…" : o, callback_data: `a:${id}:${i}` }]);
      void this.sendFor(key, text, { reply_markup: { inline_keyboard } });
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

  private async relayToChair(key: string, text: string, reply: (t: string) => Promise<string>): Promise<string> {
    let rt: AgendaRuntime;
    try {
      rt = await this.deps.getRuntime(key);
    } catch (e) {
      return reply(`안건을 열 수 없습니다: ${(e as Error).message}`);
    }
    if (text === "/status") return reply(this.statusText(rt));
    if (rt.chair.isBusy()) return reply("의장이 아직 이전 턴을 처리 중입니다. 끝나면 알림이 옵니다.");
    void rt.send(text).catch((e) => this.deps.log(`telegram → chair failed: ${(e as Error).message}`));
    return reply("의장에게 전달했습니다.");
  }

  /** Exposed for tests. Returns the reply text that was sent (if any). */
  async handleUpdate(u: TgUpdate): Promise<string | undefined> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.text) return undefined;
    const chat = String(msg.chat.id);
    const inDm = chat === String(this.cfg.chatId);
    const inForum = !inDm && chat === this.forumChat();
    // in groups commands arrive as /cmd@botname
    const text = msg.text.trim().replace(/^(\/\w+)@\w+/, "$1");
    const thread = inForum ? msg.message_thread_id : undefined;
    const reply = async (t: string) => {
      await this.say(chat, thread, t);
      return t;
    };

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
        return reply("GenCouncil 봇입니다.\n안건 토픽 안에 쓴 글은 그 안건 의장에게 전달됩니다.\n/status 그 안건 상태\n/list 안건 목록");
      }
      if (text === "/list") return reply(this.listText());
      const key = this.keyForThread(thread);
      if (key) return this.relayToChair(key, text, reply);
      if (text === "/status" && this.cfg.agenda) return this.relayToChair(this.cfg.agenda, text, reply);
      return reply("안건 토픽 안에 쓰세요. 일반 토픽의 글은 의장에게 전달되지 않습니다. (/list /help /forum /status 만 쓸 수 있습니다)");
    }

    if (text === "/forum") return reply("/forum 은 포럼으로 쓸 그룹(토픽 켬) 안에서 보내세요. 봇을 그 그룹의 관리자(토픽 관리 권한)로 추가해야 합니다.");
    if (text === "/start" || text === "/help") {
      return reply("GenCouncil 봇입니다.\n/list 안건 목록\n/agenda <project/slug> 대화할 안건 선택\n/status 현재 안건 상태\n그 외 텍스트는 의장에게 전달됩니다.");
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
    return this.relayToChair(this.cfg.agenda, text, reply);
  }
}
