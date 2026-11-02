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
  if (init.body instanceof FormData) {
    // photo uploads are multipart, not JSON
    sent.push({ method, caption: init.body.get("caption"), photo: init.body.get("photo")?.name });
    return { json: async () => ({ ok: true, result: {} }) };
  }
  const body = JSON.parse(init.body);
  if (method === "getMe") return { json: async () => ({ ok: true, result: { username: "gencouncil_bot" } }) };
  if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") {
    sent.push({ method, ...body });
    return { json: async () => ({ ok: true, result: true }) };
  }
  if (method === "sendMessage") {
    sent.push(body);
    return { json: async () => ({ ok: true, result: {} }) };
  }
  return { json: async () => ({ ok: false, description: "unknown method" }), status: 400 };
};

const chairMessages = [];
let busy = false;
let waiting;
let cleared = 0;
const fakeRuntime = {
  chair: { isBusy: () => busy },
  council: { clearWaiting: () => { cleared++; waiting = undefined; } },
  state: () => ({
    agenda: { title: "밸런스 안건", goals: ["a", "b"], waitingForUser: waiting },
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

// ---- drafts the chair shows ----
{
  const fsm = await import("node:fs"); const osm = await import("node:os"); const pathm = await import("node:path");
  const png = pathm.join(osm.tmpdir(), "gc-shot-test.png");
  fsm.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const before = sent.length;
  await bridge.sendShown("proj/agenda", "A안: 타이틀", [{ name: "a.png", type: "image/png", path: png }, { name: "mock.html", type: "text/html", path: png }]);
  const newOnes = sent.slice(before);
  check("shown image goes as a photo with caption", newOnes.some((m) => m.method === "sendPhoto" && /의장 시안: A안/.test(m.caption ?? "") && m.photo === "a.png"), JSON.stringify(newOnes));
  check("non-image drafts are named in a text note", newOnes.some((m) => (m.text ?? "").includes("mock.html")));
  fsm.rmSync(png, { force: true });
}

// ---- inline buttons for chair questions ----
{
  busy = false;
  const cq = (data, chat = 123, id = "cb1") => ({ update_id: 2, callback_query: { id, data, message: { message_id: 77, chat: { id: chat } } } });
  const press = async (data, chat) => { sent.length = 0; await bridge.handleUpdate(cq(data, chat)); return [...sent]; };
  const longOpt = "가".repeat(100);
  const ask = (q, options) => { sent.length = 0; waiting = { question: q, options, at: 1 }; bridge.notify("proj/agenda", { type: "chair:ask", question: q, options }); return new Promise((r) => setTimeout(() => r(sent[0]), 20)); };

  let m = await ask("어느 쪽?", ["A안", longOpt]);
  const kb = m?.reply_markup?.inline_keyboard;
  check("ask gets inline keyboard, one row per option", kb?.length === 2 && kb[0][0].text === "A안", JSON.stringify(m));
  check("long option label truncated", kb[1][0].text.length <= 60);
  check("callback_data <= 64 bytes", kb.every((r) => Buffer.byteLength(r[0].callback_data) <= 64));
  const d0 = kb[0][0].callback_data, d1 = kb[1][0].callback_data;

  chairMessages.length = 0;
  let out = await press(d0, 999);
  check("callback from other chat ignored", out.length === 0 && chairMessages.length === 0);
  busy = true;
  out = await press(d0);
  check("busy chair: not forwarded, notice, buttons kept", chairMessages.length === 0 && out.some((x) => x.method === "answerCallbackQuery" && x.text.includes("처리 중")) && !out.some((x) => x.method === "editMessageReplyMarkup"));
  busy = false;
  out = await press(d1);
  check("press forwards full option text to chair", chairMessages[0] === longOpt);
  check("press answers callback, clears buttons, confirms", out.some((x) => x.method === "answerCallbackQuery" && x.callback_query_id === "cb1") && out.some((x) => x.method === "editMessageReplyMarkup" && x.message_id === 77) && out.some((x) => x.text?.startsWith("선택: ")));
  chairMessages.length = 0;
  out = await press(d1);
  check("same button again is stale", chairMessages.length === 0 && out.some((x) => x.text?.includes("지난")));

  m = await ask("두번째?", ["X", "Y"]);
  waiting = { question: "새 질문", options: [], at: 2 };
  chairMessages.length = 0;
  out = await press(m.reply_markup.inline_keyboard[0][0].callback_data);
  check("answered/replaced question is rejected", chairMessages.length === 0 && out.some((x) => x.text?.includes("지난")) && out.some((x) => x.method === "editMessageReplyMarkup"));
  out = await press("a:zzz:0");
  check("unknown ask id is rejected", chairMessages.length === 0 && out.some((x) => x.text?.includes("지난")));

  m = await ask("끝낼까요?", ["안건 종료", "계속 진행"]);
  waiting = { question: "끝낼까요?", options: ["안건 종료", "계속 진행"], at: 3, kind: "finish" };
  out = await press(m.reply_markup.inline_keyboard[1][0].callback_data);
  check("finish 계속 진행 clears waiting without chair message", cleared === 1 && chairMessages.length === 0);
  m = await ask("끝낼까요?2", ["안건 종료", "계속 진행"]);
  waiting = { question: "끝낼까요?2", options: [], at: 4, kind: "finish" };
  await press(m.reply_markup.inline_keyboard[0][0].callback_data);
  check("finish 안건 종료 goes to chair", chairMessages[0] === "안건 종료");
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall telegram checks passed");
process.exitCode = failed ? 1 : 0;
