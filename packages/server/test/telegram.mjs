// Telegram bridge test with a fake Telegram API: formatting, chat filtering, commands, relay to the chair.
import { TelegramBridge } from "@gencouncil/server";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const sent = [];
const fakeFetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = JSON.parse(init.body);
  if (method === "getMe") return { json: async () => ({ ok: true, result: { username: "gencouncil_bot" } }) };
  if (method === "sendMessage") {
    sent.push(body);
    return { json: async () => ({ ok: true, result: {} }) };
  }
  return { json: async () => ({ ok: false, description: "unknown method" }), status: 400 };
};

const chairMessages = [];
let busy = false;
const fakeRuntime = {
  chair: { isBusy: () => busy },
  state: () => ({
    agenda: { title: "밸런스 안건", goals: ["a", "b"] },
    tasks: [{ id: "T1", status: "doing", title: "x", memberId: "claude-1" }],
    members: [{ id: "claude-1", provider: "claude", model: "claude-sonnet-5-5", status: "running" }],
    chair: { busy },
  }),
  send: async (t) => {
    chairMessages.push(t);
    return { text: "ok", isError: false };
  },
};
let bound;
const bridge = new TelegramBridge(
  { botToken: "T", chatId: "123" },
  {
    fetch: fakeFetch,
    log: () => {},
    listAgendas: () => [{ key: "proj/agenda", title: "밸런스 안건", status: "open" }],
    getRuntime: async (key) => (key === "proj/agenda" ? fakeRuntime : Promise.reject(new Error("unknown"))),
    onBind: (k) => (bound = k),
  },
);

check("verify returns username", (await bridge.verify()) === "gencouncil_bot");

// formatting
const f1 = TelegramBridge.format("proj/agenda", { type: "chair:done", text: "분장 완료", isError: false });
check("chair:done formatted", f1 === "[agenda] 의장:\n분장 완료", f1);
const f2 = TelegramBridge.format("proj/agenda", {
  type: "member:done",
  member: { id: "claude-1", provider: "claude", model: "claude-sonnet-5-5", status: "done", result: { summary: "다 했음", unfinished: "없음" } },
});
check("member:done uses model name", f2.includes("Sonnet 5.5(claude-1) done") && f2.includes("다 했음"), f2);
check("member:line is noise", TelegramBridge.format("k", { type: "member:line", member: "x", line: "y" }) === undefined);
check("chair:handover formatted", TelegramBridge.format("p/a", { type: "chair:handover", from: "claude", to: "claude-b", reason: "quota" }).includes("claude → claude-b"));

// long message chunking
await bridge.send("x".repeat(9000));
check("long text chunked", sent.length === 3 && sent.every((m) => m.text.length <= 3900));
sent.length = 0;

// updates
const upd = (text, chat = 123) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: chat } } });
check("other chats ignored", (await bridge.handleUpdate(upd("hi", 999))) === undefined && sent.length === 0);
check("/help answers", (await bridge.handleUpdate(upd("/help"))).includes("/agenda"));
check("plain text before binding asks for /agenda", (await bridge.handleUpdate(upd("안녕"))).includes("/agenda") && chairMessages.length === 0);
check("/list shows agendas", (await bridge.handleUpdate(upd("/list"))).includes("proj/agenda"));
check("/agenda binds by slug suffix", (await bridge.handleUpdate(upd("/agenda agenda"))).includes("proj/agenda") && bound === "proj/agenda");
check("/status reports", (await bridge.handleUpdate(upd("/status"))).includes("Sonnet 5.5(claude-1) running"));
const r = await bridge.handleUpdate(upd("목표 2를 배정해줘"));
check("plain text relayed to chair", r === "의장에게 전달했습니다." && chairMessages[0] === "목표 2를 배정해줘");
busy = true;
check("busy chair rejects", (await bridge.handleUpdate(upd("또"))).includes("처리 중") && chairMessages.length === 1);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall telegram checks passed");
process.exit(failed ? 1 : 0);
