import fs from "node:fs";
/**
 * Telegram bridge: pushes council events to one chat and relays messages from that chat
 * to the chair of the bound agenda. Plain fetch against api.telegram.org, long polling.
 */
import type { AgendaRuntime, RuntimeEvent } from "@gencouncil/council";
import { memberDisplayName } from "@gencouncil/council";

export interface TelegramConfig {
  botToken: string;
  /** numeric chat id as string; only this chat is served */
  chatId: string;
  /** agenda key (project/slug) that plain messages go to */
  agenda?: string;
}

export interface TelegramDeps {
  fetch?: typeof fetch;
  log: (line: string) => void;
  listAgendas: () => Array<{ key: string; title: string; status: string }>;
  getRuntime: (key: string) => Promise<AgendaRuntime>;
  /** persist a new bound agenda */
  onBind: (key: string | undefined) => void;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number | string }; from?: { username?: string; first_name?: string } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number | string } } };
}

interface PendingAsk {
  key: string;
  question: string;
  options: string[];
}

const MAX_ASKS = 50;
const BUTTON_LEN = 60;

const MAX_LEN = 3900;

export class TelegramBridge {
  private offset = 0;
  private running = false;
  private asks = new Map<string, PendingAsk>();
  private askSeq = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private cfg: TelegramConfig,
    private readonly deps: TelegramDeps,
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  private api(method: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.fetchImpl(`https://api.telegram.org/bot${this.cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then(async (r) => {
      const j = (await r.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
      if (!j?.ok) throw new Error(`telegram ${method}: ${j?.description ?? r.status}`);
      return j.result;
    });
  }

  async verify(): Promise<string> {
    const me = (await this.api("getMe")) as { username?: string };
    return me.username ?? "?";
  }

  /** Send text to the bound chat, chunked. Never throws (notifications must not break the server). */
  /** the chair showed drafts: images go as photos, other files as a short note */
  async sendShown(key: string, caption: string, files: Array<{ name: string; type: string; path?: string }>): Promise<void> {
    const tag = `[${key.split("/")[1] ?? key}]`;
    const images = files.filter((f) => f.path && /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    for (const [i, f] of images.entries()) {
      try {
        const form = new FormData();
        form.append("chat_id", String(this.cfg.chatId));
        if (i === 0) form.append("caption", `${tag} 의장 시안: ${caption}`.slice(0, 1000));
        form.append("photo", new Blob([fs.readFileSync(f.path!)], { type: f.type }), f.name);
        await this.fetchImpl(`https://api.telegram.org/bot${this.cfg.botToken}/sendPhoto`, { method: "POST", body: form });
      } catch {
        /* a failed photo must not stop the chair */
      }
    }
    const others = files.filter((f) => !images.includes(f));
    if (others.length || images.length === 0) await this.send(`${tag} 의장 시안: ${caption}${others.length ? "\n파일: " + others.map((f) => f.name).join(", ") + " (웹 화면에서 보기)" : ""}`);
  }

  async send(text: string, extra?: Record<string, unknown>): Promise<void> {
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
      try {
        await this.api("sendMessage", { chat_id: this.cfg.chatId, text: c, disable_web_page_preview: true, ...(i === chunks.length - 1 ? extra : {}) });
      } catch (e) {
        this.deps.log(`telegram send failed: ${(e as Error).message}`);
        return;
      }
    }
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
      void this.send(text, { reply_markup: { inline_keyboard } });
      return;
    }
    void this.send(text);
  }

  private async handleCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<string | undefined> {
    if (String(cq.message?.chat.id) !== String(this.cfg.chatId)) {
      this.deps.log(`telegram: ignored callback from chat ${cq.message?.chat.id}`);
      return undefined;
    }
    const answer = async (t: string) => {
      await this.api("answerCallbackQuery", { callback_query_id: cq.id, text: t }).catch(() => {});
      return t;
    };
    const clearButtons = async () => {
      if (cq.message) await this.api("editMessageReplyMarkup", { chat_id: this.cfg.chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
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
    await this.send(`선택: ${choice} → 의장에게 전달했습니다`);
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

  /** Exposed for tests. Returns the reply text that was sent (if any). */
  async handleUpdate(u: TgUpdate): Promise<string | undefined> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.text) return undefined;
    if (String(msg.chat.id) !== String(this.cfg.chatId)) {
      this.deps.log(`telegram: ignored message from chat ${msg.chat.id}`);
      return undefined;
    }
    const text = msg.text.trim();
    const reply = async (t: string) => {
      await this.send(t);
      return t;
    };
    if (text === "/start" || text === "/help") {
      return reply("GenCouncil 봇입니다.\n/list 안건 목록\n/agenda <project/slug> 대화할 안건 선택\n/status 현재 안건 상태\n그 외 텍스트는 의장에게 전달됩니다.");
    }
    if (text === "/list") {
      const all = this.deps.listAgendas();
      return reply(all.length ? all.map((a) => `${a.key === this.cfg.agenda ? "▶ " : ""}${a.key} [${a.status}] ${a.title}`).join("\n") : "안건이 없습니다.");
    }
    if (text.startsWith("/agenda")) {
      const key = text.slice(7).trim();
      const hit = this.deps.listAgendas().find((a) => a.key === key || a.key.endsWith("/" + key) || a.title === key);
      if (!hit) return reply(`모르는 안건: ${key}\n/list 로 확인하세요.`);
      this.cfg.agenda = hit.key;
      this.deps.onBind(hit.key);
      return reply(`대화 대상: ${hit.key} (${hit.title})`);
    }
    if (!this.cfg.agenda) return reply("먼저 /agenda <project/slug> 로 안건을 고르세요. /list 로 목록을 봅니다.");
    let rt: AgendaRuntime;
    try {
      rt = await this.deps.getRuntime(this.cfg.agenda);
    } catch (e) {
      return reply(`안건을 열 수 없습니다: ${(e as Error).message}`);
    }
    if (text === "/status") {
      const s = rt.state();
      const tasks = s.tasks.map((t) => `${t.id}[${t.status}] ${t.title}${t.memberId ? " ← " + t.memberId : ""}`).join("\n") || "(작업 없음)";
      const members = s.members.filter((m) => m.status === "running" || m.status === "waiting").map((m) => `${memberDisplayName(m)}(${m.id}) ${m.status}`).join(", ") || "없음";
      return reply(`${s.agenda.title}\n목표: ${s.agenda.goals.length}개\n${tasks}\n실행 중: ${members}\n의장: ${s.chair.busy ? "작업 중" : "대기"}`);
    }
    if (rt.chair.isBusy()) return reply("의장이 아직 이전 턴을 처리 중입니다. 끝나면 알림이 옵니다.");
    void rt.send(text).catch((e) => this.deps.log(`telegram → chair failed: ${(e as Error).message}`));
    return reply("의장에게 전달했습니다.");
  }
}
