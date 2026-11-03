// Telegram bridge test with a fake Telegram API: formatting, chat filtering, commands, relay to the chair.
import { TelegramBridge } from "@gencouncil/server";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const sent = [];
let nextThread = 100;
const deadThreads = new Set();
const fakeFetch = async (url, init) => {
  const method = url.split("/").pop();
  if (init.body instanceof FormData) {
    // photo uploads are multipart, not JSON
    sent.push({ method, chat_id: init.body.get("chat_id"), message_thread_id: init.body.get("message_thread_id"), caption: init.body.get("caption"), photo: init.body.get("photo")?.name, document: init.body.get("document")?.name });
    return { json: async () => ({ ok: true, result: {} }) };
  }
  const body = JSON.parse(init.body);
  if (method === "getMe") return { json: async () => ({ ok: true, result: { username: "gencouncil_bot" } }) };
  if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") {
    sent.push({ method, ...body });
    return { json: async () => ({ ok: true, result: true }) };
  }
  if (method === "createForumTopic") {
    sent.push({ method, ...body });
    await new Promise((r) => setTimeout(r, 15));
    return { json: async () => ({ ok: true, result: { message_thread_id: ++nextThread, name: body.name } }) };
  }
  if (method === "closeForumTopic") {
    sent.push({ method, ...body });
    return { json: async () => ({ ok: true, result: true }) };
  }
  if (method === "sendMessage") {
    sent.push(body);
    if (deadThreads.has(body.message_thread_id)) return { json: async () => ({ ok: false, description: "Bad Request: message thread not found" }), status: 400 };
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
  { botToken: "T", chatId: "123", autoNotify: true },
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
check("plain text relayed to chair", r === "의장에게 전달했습니다." && chairMessages[0] === "[텔레그램] 목표 2를 배정해줘");
busy = true;
check("busy chair rejects", (await bridge.handleUpdate(upd("또"))).includes("처리 중") && chairMessages.length === 1);

// ---- drafts the chair shows ----
{
  const fsm = await import("node:fs"); const osm = await import("node:os"); const pathm = await import("node:path");
  const png = pathm.join(osm.tmpdir(), "gc-shot-test.png");
  fsm.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let before2;
  const before = sent.length;
  await bridge.sendShown("proj/agenda", "A안: 타이틀", [{ name: "a.png", type: "image/png", path: png }, { name: "spec.pdf", type: "application/pdf", path: png }, { name: "big.pdf", type: "application/pdf" }]);
  const newOnes = sent.slice(before);
  check("shown image goes as a photo with caption", newOnes.some((m) => m.method === "sendPhoto" && /의장 시안: A안/.test(m.caption ?? "") && m.photo === "a.png"), JSON.stringify(newOnes));
  const doc = newOnes.find((m) => m.method === "sendDocument");
  check("shown pdf goes as a document in the DM, without caption", doc && doc.document === "spec.pdf" && String(doc.chat_id) === "123" && !doc.caption, JSON.stringify(newOnes));
  check("unsendable file is only named in a text note", newOnes.some((m) => (m.text ?? "").includes("big.pdf") && !(m.text ?? "").includes("spec.pdf")), JSON.stringify(newOnes));
  before2 = sent.length;
  await bridge.sendShown("proj/agenda", "문서만", [{ name: "x.pdf", type: "application/pdf", path: png }, { name: "y.pdf", type: "application/pdf", path: png }]);
  const docs = sent.slice(before2).filter((m) => m.method === "sendDocument");
  check("caption goes on the first file only (document first)", docs.length === 2 && /^\[agenda\] 의장 시안: 문서만$/.test(docs[0].caption ?? "") && !docs[1].caption, JSON.stringify(docs));
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

// ---- forum (topics) group: one topic per agenda ----
{
  const FORUM = -1001234567890;
  const mkRuntime = (title) => {
    const r = { msgs: [], busy: false };
    r.runtime = {
      chair: { isBusy: () => r.busy },
      council: { clearWaiting: () => {} },
      state: () => ({ agenda: { title, goals: [], waitingForUser: r.waiting }, tasks: [], members: [], chair: { busy: r.busy } }),
      send: async (t) => { r.msgs.push(t); return { text: "ok", isError: false }; },
    };
    return r;
  };
  const A = mkRuntime("밸런스 안건");
  const B = mkRuntime("텔레그램 연결");
  const runtimes = { "proj/agenda": A, "proj/tg": B };
  const configs = [];
  const fb = new TelegramBridge(
    { botToken: "T", chatId: "123", agenda: "proj/agenda", autoNotify: true },
    {
      fetch: fakeFetch,
      log: () => {},
      listAgendas: () => [
        { key: "proj/agenda", title: "밸런스 안건", status: "open" },
        { key: "proj/tg", title: "텔레그램 연결", status: "open" },
      ],
      getRuntime: async (key) => runtimes[key]?.runtime ?? Promise.reject(new Error("unknown")),
      onBind: () => {},
      onConfig: (patch) => configs.push(patch),
    },
  );
  const gmsg = (text, { chat = FORUM, from = 123, thread, type = "supergroup", is_forum = true } = {}) => ({
    update_id: 9,
    message: { message_id: 5, text, chat: { id: chat, type, is_forum }, from: { id: from }, ...(thread !== undefined ? { message_thread_id: thread } : {}) },
  });
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const to = (arr, chat, thread) => arr.filter((m) => m.method !== "createForumTopic" && String(m.chat_id) === String(chat) && (thread === undefined || String(m.message_thread_id) === String(thread)));

  // connecting
  sent.length = 0;
  check("group before /forum: other text ignored", (await fb.handleUpdate(gmsg("안녕"))) === undefined && sent.length === 0);
  check("/forum by a stranger is ignored", (await fb.handleUpdate(gmsg("/forum", { from: 999 }))) === undefined && sent.length === 0 && configs.length === 0);
  const noTopics = await fb.handleUpdate(gmsg("/forum", { is_forum: false }));
  check("/forum in a group without topics explains how to enable them", noTopics.includes("토픽") && configs.length === 0);
  const plain = await fb.handleUpdate(gmsg("/forum", { type: "group", is_forum: undefined }));
  check("/forum in a basic group is refused too", plain.includes("토픽") && configs.length === 0);
  sent.length = 0;
  const conn = await fb.handleUpdate(gmsg("/forum@gencouncil_bot"));
  check("owner /forum connects the group and saves it", conn.includes("포럼으로 연결") && configs.at(-1)?.forumChatId === String(FORUM), JSON.stringify(configs));
  check("connect reply goes to the group", to(sent, FORUM).length === 1);
  const dmForum = await fb.handleUpdate(upd("/forum"));
  check("/forum in the DM only explains", dmForum.includes("그룹") && configs.length === 1);

  // notifications go to per-agenda topics, not the DM
  sent.length = 0;
  fb.notify("proj/agenda", { type: "chair:done", text: "배정 끝", isError: false });
  fb.notify("proj/agenda", { type: "chair:done", text: "또 하나", isError: false });
  await settle();
  const creates = sent.filter((m) => m.method === "createForumTopic");
  check("two concurrent notifications make one topic", creates.length === 1 && creates[0].name === "밸런스 안건" && String(creates[0].chat_id) === String(FORUM), JSON.stringify(creates));
  const topicA = configs.at(-1).topics["proj/agenda"];
  check("topic id is saved", typeof topicA === "number");
  const inTopic = to(sent, FORUM, topicA);
  check("both notifications are in the topic with message_thread_id", inTopic.length === 2 && inTopic[0].text === "의장:\n배정 끝", JSON.stringify(inTopic));
  check("nothing goes to the DM in forum mode", to(sent, "123").length === 0);
  fb.notify("proj/agenda", { type: "chair:done", text: "세 번째", isError: false });
  await settle();
  check("existing topic is reused", sent.filter((m) => m.method === "createForumTopic").length === 1 && to(sent, FORUM, topicA).length === 3);
  fb.notify("proj/tg", { type: "chair:done", text: "다른 안건", isError: false });
  await settle();
  const topicB = configs.at(-1).topics["proj/tg"];
  check("another agenda gets its own topic", topicB !== topicA && to(sent, FORUM, topicB).length === 1);

  // writing in a topic goes to that agenda's chair, even if it is not the bound one
  sent.length = 0;
  A.msgs.length = 0; B.msgs.length = 0;
  let out = await fb.handleUpdate(gmsg("B 안건 지시", { thread: topicB }));
  check("topic text goes to that agenda's chair (not the bound one)", out === "의장에게 전달했습니다." && B.msgs[0] === "[텔레그램] B 안건 지시" && A.msgs.length === 0);
  check("reply goes to the same topic", to(sent, FORUM, topicB).length === 1 && to(sent, "123").length === 0);
  B.busy = true;
  out = await fb.handleUpdate(gmsg("또", { thread: topicB }));
  check("busy chair in a topic is not interrupted", out.includes("처리 중") && B.msgs.length === 1);
  B.busy = false;
  out = await fb.handleUpdate(gmsg("/status", { thread: topicB }));
  check("/status in a topic is that agenda's status", out.startsWith("텔레그램 연결"));
  out = await fb.handleUpdate(gmsg("/status", { thread: topicA }));
  check("/status in the other topic", out.startsWith("밸런스 안건"));
  out = await fb.handleUpdate(gmsg("남이 쓴 글", { thread: topicB, from: 999 }));
  check("a stranger's topic text is ignored", out === undefined && B.msgs.length === 1);

  // outside topics
  A.msgs.length = 0;
  out = await fb.handleUpdate(gmsg("그냥 글"));
  check("General plain text gets guidance, not the chair", out.includes("안건 토픽") && A.msgs.length === 0 && B.msgs.length === 1);
  out = await fb.handleUpdate(gmsg("그냥 글", { thread: 4242 }));
  check("unknown topic is treated like General", out.includes("안건 토픽") && A.msgs.length === 0);
  out = await fb.handleUpdate(gmsg("/status"));
  check("/status in General is the bound agenda", out.startsWith("밸런스 안건"));
  out = await fb.handleUpdate(gmsg("/list"));
  check("/list in General", out.includes("proj/tg"));
  out = await fb.handleUpdate(gmsg("/help"));
  check("/help in General", out.includes("토픽"));

  // inline buttons in the group
  {
    const fcq = (data, { from = 123, chat = FORUM, thread } = {}) => ({ update_id: 3, callback_query: { id: "g1", data, from: { id: from }, message: { message_id: 88, chat: { id: chat }, ...(thread !== undefined ? { message_thread_id: thread } : {}) } } });
    sent.length = 0;
    B.waiting = { question: "그룹 질문?", options: ["가", "나"], at: 1 };
    fb.notify("proj/tg", { type: "chair:ask", question: "그룹 질문?", options: ["가", "나"] });
    await settle();
    const ask = to(sent, FORUM, topicB).find((m) => m.reply_markup);
    check("ask in forum mode carries the buttons in the topic", ask?.reply_markup?.inline_keyboard?.length === 2);
    const data = ask.reply_markup.inline_keyboard[1][0].callback_data;
    B.msgs.length = 0; sent.length = 0;
    await fb.handleUpdate(fcq(data, { from: 999, thread: topicB }));
    check("button pressed by a stranger is ignored", B.msgs.length === 0 && sent.length === 0);
    await fb.handleUpdate(fcq(data, { chat: -555, thread: topicB }));
    check("button from an unknown group is ignored", B.msgs.length === 0 && sent.length === 0);
    await fb.handleUpdate(fcq(data, { thread: topicB }));
    check("group button forwards the choice to that agenda's chair", B.msgs[0] === "나");
    const edit = sent.find((m) => m.method === "editMessageReplyMarkup");
    check("buttons are removed from the message in the group", edit && String(edit.chat_id) === String(FORUM) && edit.message_id === 88, JSON.stringify(edit));
    const conf = sent.find((m) => m.text?.startsWith("선택: "));
    check("confirmation goes to the group topic, not the DM", conf && String(conf.chat_id) === String(FORUM) && conf.message_thread_id === topicB, JSON.stringify(conf));
    // thread id missing on the callback message: falls back to the agenda's topic
    B.waiting = { question: "하나 더?", options: ["x"], at: 2 };
    sent.length = 0;
    fb.notify("proj/tg", { type: "chair:ask", question: "하나 더?", options: ["x"] });
    await settle();
    const ask2 = to(sent, FORUM, topicB).find((m) => m.reply_markup);
    sent.length = 0;
    await fb.handleUpdate(fcq(ask2.reply_markup.inline_keyboard[0][0].callback_data));
    check("callback without thread id falls back to the agenda topic", sent.some((m) => m.text?.startsWith("선택: ") && m.message_thread_id === topicB));
  }

  // DM still works in forum mode
  out = await fb.handleUpdate(upd("/status"));
  check("DM /status still uses the bound agenda", out.startsWith("밸런스 안건"));
  A.msgs.length = 0;
  out = await fb.handleUpdate(upd("DM 에서 지시"));
  check("DM text still goes to the bound agenda", A.msgs[0] === "[텔레그램] DM 에서 지시");

  // drafts and closing
  {
    const fsm = await import("node:fs"); const osm = await import("node:os"); const pathm = await import("node:path");
    const png = pathm.join(osm.tmpdir(), "gc-forum-shot.png");
    fsm.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    sent.length = 0;
    await fb.sendShown("proj/tg", "C안", [{ name: "c.png", type: "image/png", path: png }]);
    const ph = sent.find((m) => m.method === "sendPhoto");
    check("shown photo goes to the topic", ph && String(ph.chat_id) === String(FORUM) && String(ph.message_thread_id) === String(topicB) && ph.caption === "의장 시안: C안", JSON.stringify(ph));
    sent.length = 0;
    await fb.sendShown("proj/tg", "D안", [{ name: "d.pdf", type: "application/pdf", path: png }]);
    const dd = sent.find((m) => m.method === "sendDocument");
    check("shown pdf goes to the topic as a document", dd && String(dd.message_thread_id) === String(topicB) && dd.document === "d.pdf" && dd.caption === "의장 시안: D안", JSON.stringify(dd));
    fsm.rmSync(png, { force: true });
  }
  sent.length = 0;
  await fb.finishFor("proj/tg", "[proj/tg] 안건 종료: 머지됨");
  const bye = sent.findIndex((m) => m.text === "안건 종료: 머지됨" && m.message_thread_id === topicB);
  const closeAt = sent.findIndex((m) => m.method === "closeForumTopic" && m.message_thread_id === topicB);
  check("finish message goes to the topic, then the topic is closed", bye >= 0 && closeAt > bye, JSON.stringify(sent));

  // a topic deleted by hand is recreated once
  deadThreads.add(topicA);
  sent.length = 0;
  const before = sent.filter((m) => m.method === "createForumTopic").length;
  fb.notify("proj/agenda", { type: "chair:done", text: "지워진 뒤", isError: false });
  await settle();
  const newA = configs.at(-1).topics["proj/agenda"];
  check("deleted topic is recreated and the message is resent there", newA !== topicA && sent.filter((m) => m.method === "createForumTopic").length === before + 1 && to(sent, FORUM, newA).some((m) => m.text === "의장:\n지워진 뒤"), JSON.stringify(sent));
  check("mapping now points at the new topic", configs.at(-1).topics["proj/agenda"] === newA);

  // CLI-style config: forum present at start, topics already known
  {
    sent.length = 0;
    const pre = new TelegramBridge({ botToken: "T", chatId: "123", forumChatId: String(FORUM), topics: { "proj/agenda": 777 }, autoNotify: true }, { fetch: fakeFetch, log: () => {}, listAgendas: () => [], getRuntime: async () => A.runtime, onBind: () => {} });
    pre.notify("proj/agenda", { type: "chair:done", text: "미리 설정", isError: false });
    await settle();
    check("preconfigured forum + known topic: no creation, goes to the topic", sent.every((m) => m.method !== "createForumTopic") && to(sent, FORUM, 777).length === 1);
    const noForum = await pre.handleUpdate(gmsg("/forum", { chat: -777 }));
    check("works without an onConfig callback", noForum.includes("연결"));
  }
}


// ---- default (autoNotify off): nothing goes out by itself; the chair sends on request ----
{
  const fsm = await import("node:fs"); const osm = await import("node:os"); const pathm = await import("node:path");
  const FORUM = -1009998887776;
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  const msgs = [];
  let waiting2;
  let busy2 = false;
  const rt = {
    chair: { isBusy: () => busy2 },
    council: { clearWaiting: () => {} },
    state: () => ({ agenda: { title: "조용한 안건", goals: [], waitingForUser: waiting2 }, tasks: [], members: [], chair: { busy: busy2 } }),
    send: async (t) => { msgs.push(t); return { text: "ok", isError: false }; },
  };
  const mk = (cfg) => new TelegramBridge({ botToken: "T", chatId: "123", agenda: "proj/q", ...cfg }, {
    fetch: fakeFetch, log: () => {},
    listAgendas: () => [{ key: "proj/q", title: "조용한 안건", status: "open" }],
    getRuntime: async () => rt, onBind: () => {}, onConfig: () => {},
  });
  const png = pathm.join(osm.tmpdir(), "gc-quiet.png");
  fsm.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const dm = mk({});
  sent.length = 0;
  for (const e of [
    { type: "chair:done", text: "끝", isError: false },
    { type: "member:done", member: { id: "claude-1", provider: "claude", model: "claude-sonnet-5-5", status: "done" } },
    { type: "chair:handover", from: "a", to: "b", reason: "quota" },
  ]) dm.notify("proj/q", e);
  await dm.sendShown("proj/q", "시안", [{ name: "a.png", type: "image/png", path: png }]);
  await dm.finishFor("proj/q", "[proj/q] 안건 종료");
  await settle();
  check("autoNotify off: chair:done, member:done, handover, sendShown and finishFor send nothing", sent.length === 0, JSON.stringify(sent));

  // a question waiting for the user's decision always goes out, with buttons
  dm.notify("proj/q", { type: "chair:ask", question: "어느 쪽?", options: ["A", "B"] });
  await settle();
  const dmAsk = sent.find((m) => m.reply_markup);
  check("autoNotify off: chair:ask goes to the DM with buttons", sent.length === 1 && String(dmAsk?.chat_id) === "123" && dmAsk.text.includes("어느 쪽?") && dmAsk.reply_markup.inline_keyboard.length === 2, JSON.stringify(sent));
  sent.length = 0;
  dm.notify("proj/q", { type: "chair:ask", question: "자유 답?" });
  await settle();
  check("autoNotify off: chair:ask without options goes as plain text", sent.length === 1 && sent[0].text.includes("자유 답?") && !sent[0].reply_markup, JSON.stringify(sent));

  // receiving still works, with the source mark; replies to the user's own action stay
  const u = (text) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: 123 } } });
  check("autoNotify off: /status still answers", (await dm.handleUpdate(u("/status"))).startsWith("조용한 안건"));
  check("autoNotify off: text is relayed with the [텔레그램] mark and acknowledged", (await dm.handleUpdate(u("종료해"))) === "의장에게 전달했습니다." && msgs[0] === "[텔레그램] 종료해");
  busy2 = true;
  const busyReply = await dm.handleUpdate(u("또"));
  check("autoNotify off: busy notice does not promise a notification", busyReply.includes("처리 중") && !busyReply.includes("알림이 옵니다"), busyReply);
  busy2 = false;

  // explicit send: DM
  sent.length = 0;
  let r1 = await dm.sendRequested("proj/q", { text: "텔레그램으로 보내 달라고 하셔서 보냅니다", files: [] });
  check("sendRequested text goes to the DM with the agenda tag", r1.ok && sent.length === 1 && sent[0].text === "[q] 텔레그램으로 보내 달라고 하셔서 보냅니다" && String(sent[0].chat_id) === "123", JSON.stringify([r1, sent]));
  sent.length = 0;
  r1 = await dm.sendRequested("proj/q", { text: "시안 보냅니다", files: [{ name: "a.png", type: "image/png", path: png }, { name: "b.pdf", type: "application/pdf", path: png }] });
  check("sendRequested files: first file carries the text as caption, no extra message", r1.ok && sent.length === 2 && sent[0].method === "sendPhoto" && sent[0].caption === "[q] 시안 보냅니다" && sent[1].method === "sendDocument" && !sent[1].caption, JSON.stringify([r1, sent]));
  sent.length = 0;
  r1 = await dm.sendRequested("proj/q", { text: "없는 파일", files: [{ name: "gone.pdf", type: "application/pdf", path: pathm.join(osm.tmpdir(), "gc-no-such-file.pdf") }] });
  check("sendRequested reports an unsendable file as a failure, text still goes", !r1.ok && r1.detail.includes("gone.pdf") && sent.some((m) => m.text?.includes("없는 파일")), JSON.stringify([r1, sent]));

  // explicit send with the pending question as buttons
  sent.length = 0;
  waiting2 = { question: "어느 시안으로 갈까요?", options: ["A안", "B안"], at: 1 };
  r1 = await dm.sendRequested("proj/q", { text: "골라 주세요", files: [], ask: { question: waiting2.question, options: waiting2.options } });
  const askMsg = sent.find((m) => m.reply_markup);
  check("sendRequested ask:true attaches buttons and the question", r1.ok && askMsg?.reply_markup.inline_keyboard.length === 2 && askMsg.text.includes("어느 시안으로 갈까요?") && askMsg.text.includes("골라 주세요"), JSON.stringify([r1, sent]));
  msgs.length = 0; sent.length = 0;
  await dm.handleUpdate({ update_id: 5, callback_query: { id: "q1", data: askMsg.reply_markup.inline_keyboard[1][0].callback_data, message: { message_id: 9, chat: { id: 123 } } } });
  check("a button sent on request works like an automatic one (choice unmarked)", msgs[0] === "B안" && sent.some((m) => m.text === "선택: B안 → 의장에게 전달했습니다"), JSON.stringify([msgs, sent]));
  waiting2 = undefined;

  // forum mode: explicit send goes to the agenda topic; finishFor closes the topic silently
  const fm = mk({ forumChatId: String(FORUM), topics: { "proj/q": 555 } });
  sent.length = 0;
  r1 = await fm.sendRequested("proj/q", { text: "토픽으로", files: [{ name: "c.pdf", type: "application/pdf", path: png }] });
  check("sendRequested in forum mode: document in the agenda topic with caption", r1.ok && sent.length === 1 && sent[0].method === "sendDocument" && String(sent[0].chat_id) === String(FORUM) && String(sent[0].message_thread_id) === "555" && sent[0].caption === "토픽으로", JSON.stringify([r1, sent]));
  sent.length = 0;
  r1 = await fm.sendRequested("proj/q", { text: "글만", files: [] });
  check("sendRequested text in forum mode: topic, no tag", r1.ok && sent[0].text === "글만" && String(sent[0].message_thread_id) === "555", JSON.stringify(sent));
  sent.length = 0;
  await fm.finishFor("proj/q", "[proj/q] 안건 종료");
  check("autoNotify off: finishFor closes the topic without a message", sent.length === 1 && sent[0].method === "closeForumTopic" && sent[0].message_thread_id === 555, JSON.stringify(sent));
  sent.length = 0;
  fm.notify("proj/q", { type: "chair:ask", question: "토픽 질문?", options: ["예", "아니오"] });
  await settle();
  check("autoNotify off in forum mode: chair:ask goes to the agenda topic with buttons", sent.length === 1 && String(sent[0].chat_id) === String(FORUM) && String(sent[0].message_thread_id) === "555" && sent[0].reply_markup?.inline_keyboard.length === 2, JSON.stringify(sent));
  sent.length = 0;
  await fm.sendShown("proj/q", "시안", [{ name: "a.png", type: "image/png", path: png }]);
  check("autoNotify off in forum mode: sendShown sends nothing", sent.length === 0);

  // a failing API is reported, not thrown
  const bad = new TelegramBridge({ botToken: "T", chatId: "123" }, { fetch: async () => ({ json: async () => ({ ok: false, description: "chat not found" }), status: 400 }), log: () => {}, listAgendas: () => [], getRuntime: async () => rt, onBind: () => {} });
  const rb = await bad.sendRequested("proj/q", { text: "안 가요", files: [] });
  check("sendRequested reports a Telegram failure instead of throwing", rb.ok === false && rb.detail.includes("실패"), JSON.stringify(rb));

  fsm.rmSync(png, { force: true });
}


// ---- per-agenda automatic sending (isAuto / setAuto, web button and /auto) ----
{
  const fsm = await import("node:fs"); const osm = await import("node:os"); const pathm = await import("node:path");
  const FORUM = -1009998887775;
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  const msgs = [];
  const autoOff = new Set(["proj/off"]); // explicit off; any other agenda (unset) is on by default
  const rtFor = (title) => ({
    chair: { isBusy: () => false },
    council: { clearWaiting: () => {} },
    state: () => ({ agenda: { title, goals: [], waitingForUser: undefined }, tasks: [], members: [], chair: { busy: false } }),
    send: async (t) => { msgs.push(t); return { text: "ok", isError: false }; },
  });
  const mk = (cfg) => new TelegramBridge({ botToken: "T", chatId: "123", agenda: "proj/off", ...cfg }, {
    fetch: fakeFetch, log: () => {},
    listAgendas: () => [{ key: "proj/on", title: "켜진 안건", status: "open" }, { key: "proj/off", title: "꺼진 안건", status: "open" }],
    getRuntime: async (key) => rtFor(key === "proj/on" ? "켜진 안건" : "꺼진 안건"), onBind: () => {}, onConfig: () => {},
    isAuto: (key) => !autoOff.has(key),
    setAuto: async (key, on) => { if (on) autoOff.delete(key); else autoOff.add(key); },
  });
  const png = pathm.join(osm.tmpdir(), "gc-peragenda.png");
  fsm.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const doneEv = { type: "chair:done", text: "켜진 답", isError: false };

  const dm = mk({});
  sent.length = 0;
  dm.notify("proj/on", doneEv);
  await dm.sendShown("proj/on", "시안", [{ name: "a.png", type: "image/png", path: png }]);
  await dm.finishFor("proj/on", "[proj/on] 안건 종료");
  await settle();
  check("agenda with auto unset (default on): chair:done, sendShown photo and finish message are sent", sent.some((m) => m.text?.includes("켜진 답")) && sent.some((m) => m.method === "sendPhoto") && sent.some((m) => m.text?.includes("안건 종료")), JSON.stringify(sent));

  sent.length = 0;
  dm.notify("proj/off", doneEv);
  dm.notify("proj/off", { type: "member:done", member: { id: "claude-1", provider: "claude", model: "claude-sonnet-5-5", status: "done" } });
  await dm.sendShown("proj/off", "시안", [{ name: "a.png", type: "image/png", path: png }]);
  await dm.finishFor("proj/off", "[proj/off] 안건 종료");
  await settle();
  check("agenda explicitly off: nothing is sent while another agenda has it on", sent.length === 0, JSON.stringify(sent));
  dm.notify("proj/off", { type: "chair:ask", question: "꺼진 질문?", options: ["A", "B"] });
  await settle();
  check("agenda with auto off: chair:ask still goes out with buttons", sent.length === 1 && sent[0].reply_markup?.inline_keyboard.length === 2, JSON.stringify(sent));

  // an agenda that was never touched (no explicit off) still sends by default
  sent.length = 0;
  dm.notify("proj/fresh", doneEv);
  await settle();
  check("never-configured agenda sends chair:done by default", sent.some((m) => m.text?.includes("켜진 답")), JSON.stringify(sent));

  // server-wide autoNotify forces it on even for an agenda that is off
  const forced = mk({ autoNotify: true });
  sent.length = 0;
  forced.notify("proj/off", doneEv);
  await settle();
  check("autoNotify forces auto sending for an agenda whose own switch is off", sent.some((m) => m.text?.includes("켜진 답")), JSON.stringify(sent));

  // a throwing isAuto counts as off
  const broken = new TelegramBridge({ botToken: "T", chatId: "123" }, { fetch: fakeFetch, log: () => {}, listAgendas: () => [], getRuntime: async () => rtFor("x"), onBind: () => {}, isAuto: () => { throw new Error("boom"); } });
  sent.length = 0;
  broken.notify("proj/off", doneEv);
  await settle();
  check("isAuto that throws is treated as off", sent.length === 0, JSON.stringify(sent));

  // /auto in the DM acts on the bound agenda (proj/off)
  const u = (text) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: 123 } } });
  msgs.length = 0;
  check("/auto shows the off state", (await dm.handleUpdate(u("/auto"))).includes("꺼짐"));
  check("/help on an off agenda says auto is off", (await dm.handleUpdate(u("/help"))).includes("자동 전송이 꺼져"));
  check("/auto on turns the bound agenda on", (await dm.handleUpdate(u("/auto on"))).includes("켰습니다") && !autoOff.has("proj/off"));
  check("/auto shows the on state", (await dm.handleUpdate(u("/auto"))).includes("켜짐"));
  sent.length = 0;
  dm.notify("proj/off", doneEv);
  await settle();
  check("after /auto on the agenda's notifications go out", sent.some((m) => m.text?.includes("켜진 답")), JSON.stringify(sent));
  check("/auto off turns it off again", (await dm.handleUpdate(u("/auto off"))).includes("껐습니다") && autoOff.has("proj/off"));
  check("/auto with a bad argument explains", (await dm.handleUpdate(u("/auto maybe"))).includes("/auto on"));
  check("/auto is not relayed to the chair", msgs.length === 0, JSON.stringify(msgs));
  check("/help mentions /auto and the off hint", (await dm.handleUpdate(u("/help"))).includes("/auto on|off") );
  check("/auto with server-wide autoNotify says it is forced", (await forced.handleUpdate(u("/auto off"))).includes("--auto on"));

  // forum: /auto acts on the topic's agenda
  const fm = mk({ forumChatId: String(FORUM), topics: { "proj/on": 701, "proj/off": 702 } });
  const fu = (text, thread) => ({ update_id: 2, message: { message_id: 2, text, chat: { id: FORUM, type: "supergroup", is_forum: true }, message_thread_id: thread, from: { id: 123 } } });
  check("forum /auto in the topic of an agenda that is on shows on", (await fm.handleUpdate(fu("/auto", 701))).includes("켜짐"));
  check("forum /auto off in that topic switches it off", (await fm.handleUpdate(fu("/auto off", 701))).includes("껐습니다") && autoOff.has("proj/on"));
  check("forum /auto outside an agenda topic is refused", (await fm.handleUpdate(fu("/auto on", 999))).includes("토픽"));
  check("forum /help shows the on hint for the topic's agenda", (await fm.handleUpdate(fu("/help", 702))).includes("/auto on"));

  // no setAuto dependency: /auto on explains
  const noSet = new TelegramBridge({ botToken: "T", chatId: "123", agenda: "proj/off" }, { fetch: fakeFetch, log: () => {}, listAgendas: () => [], getRuntime: async () => rtFor("x"), onBind: () => {} });
  check("/auto on without setAuto is refused politely", (await noSet.handleUpdate(u("/auto on"))).includes("쓸 수 없"));

  fsm.rmSync(png, { force: true });
}

// ---- photos, videos and files with a caption ----
{
  const FORUM = -1009;
  const files = {
    "p/small.jpg": Buffer.from("small"),
    "p/big.jpg": Buffer.from("big-photo"),
    "v/clip.mp4": Buffer.from("video-bytes"),
    "d/doc.pdf": Buffer.from("pdf-bytes"),
  };
  const out = [];
  const downloads = [];
  const mediaFetch = async (url, init) => {
    if (url.includes("/file/bot")) {
      const p = url.split("/file/bot")[1].split("/").slice(1).join("/");
      downloads.push(p);
      const f = files[p];
      return { ok: true, status: 200, arrayBuffer: async () => f.buffer.slice(f.byteOffset, f.byteOffset + f.length) };
    }
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "getFile") {
      if (body.file_id === "huge-id") return { json: async () => ({ ok: false, description: "Bad Request: file is too big" }), status: 400 };
      const map = { "small-id": "p/small.jpg", "big-id": "p/big.jpg", "video-id": "v/clip.mp4", "doc-id": "d/doc.pdf" };
      return { json: async () => ({ ok: true, result: { file_id: body.file_id, file_path: map[body.file_id] } }) };
    }
    if (method === "sendMessage") out.push(body);
    return { json: async () => ({ ok: true, result: {} }) };
  };
  const saved = [];
  const sends = [];
  let chairBusy = false;
  const rt = {
    chair: { isBusy: () => chairBusy },
    saveAttachment: (name, type, data) => {
      const a = { id: `id${saved.length}-${name}`, name, type, size: data.length };
      saved.push({ ...a, text: data.toString() });
      return a;
    },
    send: async (t, role, atts) => {
      sends.push({ t, role, atts });
      return { text: "ok", isError: false };
    },
  };
  const mk = (cfg) => new TelegramBridge({ botToken: "T", chatId: "123", agenda: "proj/agenda", ...cfg }, { fetch: mediaFetch, log: () => {}, listAgendas: () => [{ key: "proj/agenda", title: "x", status: "open" }, { key: "proj/other", title: "y", status: "open" }], getRuntime: async () => rt, onBind: () => {} }, { batchMs: 60, busyPollMs: 25, busyMaxMs: 300 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reset = () => { out.length = 0; saved.length = 0; sends.length = 0; downloads.length = 0; };
  const dm = (extra, id = 1) => ({ update_id: id, message: { message_id: id, chat: { id: 123 }, from: { id: 123 }, ...extra } });

  // photo + caption: the largest size, one send with the caption
  const b = mk({});
  const ack = await b.handleUpdate(dm({ caption: "이 인물로 해줘", photo: [{ file_id: "small-id", width: 90, height: 90, file_size: 5 }, { file_id: "big-id", width: 1280, height: 960, file_size: 9 }] }));
  check("photo gets an acknowledgement with the file count", ack?.includes("받았습니다(파일 1개)") && sends.length === 0, ack);
  await wait(150);
  check("photo + caption go to the chair in one send with the largest size", sends.length === 1 && sends[0].t === "[텔레그램] 이 인물로 해줘" && sends[0].role === "user" && sends[0].atts.length === 1 && saved[0].text === "big-photo" && saved[0].name === "photo.jpg" && saved[0].type === "image/jpeg", JSON.stringify({ sends, saved }));
  check("only the largest photo is downloaded", downloads.length === 1 && downloads[0] === "p/big.jpg", JSON.stringify(downloads));
  check("delivery is reported with the file count", out.some((m) => m.text === "의장에게 전달했습니다(파일 1개)."), JSON.stringify(out));

  // a video then a photo in a row, plus a plain text: one send, two files, three lines
  reset();
  await b.handleUpdate(dm({ caption: "이 영상 분석해서 15초 영상 만들어줘", video: { file_id: "video-id", file_name: "clip.mp4", mime_type: "video/mp4", file_size: 11 } }, 1));
  await wait(20);
  await b.handleUpdate(dm({ caption: "이 인물로 해줘", photo: [{ file_id: "big-id", width: 100, height: 100 }] }, 2));
  await wait(20);
  const joinReply = await b.handleUpdate(dm({ text: "배경음악도" }, 3));
  check("a text joining a batch is not acknowledged again", joinReply === undefined);
  await wait(150);
  check("video + photo + text arrive as one send", sends.length === 1 && sends[0].atts.length === 2 && sends[0].t === "[텔레그램] 이 영상 분석해서 15초 영상 만들어줘\n이 인물로 해줘\n배경음악도", JSON.stringify(sends));
  check("video keeps its file name and type", saved[0].name === "clip.mp4" && saved[0].type === "video/mp4");
  check("batch acknowledged once, delivered once", out.filter((m) => m.text?.startsWith("받았습니다")).length === 1 && out.filter((m) => m.text?.startsWith("의장에게 전달했습니다(파일 2개)")).length === 1, JSON.stringify(out));

  // a document without a caption gets default text; mime type and name default
  reset();
  await b.handleUpdate(dm({ document: { file_id: "doc-id" } }));
  await wait(150);
  check("file without caption is sent with a placeholder text", sends.length === 1 && sends[0].t === "[텔레그램] 첨부 파일 1개" && saved[0].name === "document" && saved[0].type === "application/octet-stream", JSON.stringify({ sends, saved }));
  reset();
  await b.handleUpdate(dm({ voice: { file_id: "doc-id" } }));
  await wait(150);
  check("voice defaults to voice.ogg", saved[0]?.name === "voice.ogg" && saved[0].type === "audio/ogg", JSON.stringify(saved));

  // over 20MB: not downloaded, user is told; the caption still goes through
  reset();
  const big = await b.handleUpdate(dm({ caption: "큰 파일", video: { file_id: "video-id", file_size: 25 * 1024 * 1024 } }));
  await wait(150);
  check("file_size over 20MB is not downloaded and explained", out.some((m) => m.text.includes("20MB 넘는 파일")) && downloads.length === 0 && saved.length === 0, JSON.stringify(out));
  check("the caption of a refused file still goes to the chair", sends.length === 1 && sends[0].t === "[텔레그램] 큰 파일" && sends[0].atts.length === 0, JSON.stringify(sends));
  reset();
  const big2 = await b.handleUpdate(dm({ document: { file_id: "huge-id" } }));
  await wait(150);
  check("getFile 'file is too big' is explained, nothing is sent", big2.includes("20MB 넘는 파일") && sends.length === 0 && saved.length === 0, big2);
  reset();
  await b.handleUpdate(dm({ caption: "섞어서", video: { file_id: "huge-id" } }, 1));
  await b.handleUpdate(dm({ photo: [{ file_id: "big-id" }] }, 2));
  await wait(150);
  check("a refused file does not stop the others in the batch", sends.length === 1 && sends[0].atts.length === 1 && sends[0].t === "[텔레그램] 섞어서", JSON.stringify(sends));

  // other chats / other users are ignored
  reset();
  check("file from another chat ignored", (await b.handleUpdate({ update_id: 5, message: { message_id: 5, chat: { id: 999 }, photo: [{ file_id: "big-id" }] } })) === undefined);
  const grp = mk({ forumChatId: String(FORUM), topics: { "proj/agenda": 701, "proj/other": 702 } });
  const gu = (extra, from = 123, thread = 701) => ({ update_id: 6, message: { message_id: 6, chat: { id: FORUM, type: "supergroup", is_forum: true }, message_thread_id: thread, from: { id: from }, ...extra } });
  check("file from another user in the forum ignored", (await grp.handleUpdate(gu({ photo: [{ file_id: "big-id" }] }, 555))) === undefined);
  check("file in a not connected group ignored", (await mk({}).handleUpdate({ update_id: 7, message: { message_id: 7, chat: { id: FORUM, type: "supergroup" }, from: { id: 123 }, caption: "/forum", photo: [{ file_id: "big-id" }] } })) === undefined);
  await wait(100);
  check("ignored files are neither downloaded nor sent", downloads.length === 0 && sends.length === 0);

  // forum topic file goes to that topic's agenda; General explains
  const seen = [];
  const grp2 = new TelegramBridge({ botToken: "T", chatId: "123", forumChatId: String(FORUM), topics: { "proj/agenda": 701, "proj/other": 702 } }, { fetch: mediaFetch, log: () => {}, listAgendas: () => [], getRuntime: async (k) => { seen.push(k); return rt; }, onBind: () => {} }, { batchMs: 40 });
  await grp2.handleUpdate(gu({ caption: "토픽 지시", photo: [{ file_id: "big-id" }] }, 123, 702));
  await wait(120);
  check("forum topic file goes to the topic's agenda", sends.length === 1 && sends[0].t === "[텔레그램] 토픽 지시" && seen.every((k) => k === "proj/other"), JSON.stringify({ sends, seen }));
  check("forum reply goes to the topic", out.some((m) => m.message_thread_id === 702 && m.text.includes("받았습니다")));
  const gen = await grp2.handleUpdate(gu({ photo: [{ file_id: "big-id" }] }, 123, 1));
  check("file in General is not relayed", gen.includes("안건 토픽") && sends.length === 1, gen);

  // unbound DM
  const unbound = mk({ agenda: undefined });
  check("file before binding asks for /agenda", (await unbound.handleUpdate(dm({ photo: [{ file_id: "big-id" }] }))).includes("/agenda"));

  // busy chair: kept, delivered when free
  reset();
  chairBusy = true;
  const bb = mk({});
  await bb.handleUpdate(dm({ caption: "바쁠 때", video: { file_id: "video-id" } }));
  await wait(110);
  check("busy chair: told it will be delivered later, not sent yet", out.some((m) => m.text === "의장이 처리 중이라 끝나면 전달합니다.") && sends.length === 0, JSON.stringify({ out, sends }));
  await bb.handleUpdate(dm({ text: "추가 메모" }, 9));
  await wait(60);
  check("still waiting while busy", sends.length === 0);
  chairBusy = false;
  await wait(80);
  check("delivered when the chair is free, with the late text", sends.length === 1 && sends[0].t === "[텔레그램] 바쁠 때\n추가 메모" && sends[0].atts.length === 1, JSON.stringify(sends));

  // busy forever: gives up after busyMaxMs
  reset();
  chairBusy = true;
  const bg = mk({});
  await bg.handleUpdate(dm({ caption: "영원히", photo: [{ file_id: "big-id" }] }));
  await wait(500);
  check("waiting is given up after the limit and the user is told", sends.length === 0 && out.some((m) => m.text.includes("전달하지 못했습니다")), JSON.stringify(out));

  // stop clears pending timers
  reset();
  chairBusy = false;
  const st = mk({});
  await st.handleUpdate(dm({ caption: "취소", photo: [{ file_id: "big-id" }] }));
  st.stop();
  await wait(150);
  check("stop() drops pending batches", sends.length === 0);

  // commands are immediate even with a batch open
  reset();
  const cb = mk({});
  await cb.handleUpdate(dm({ caption: "대기", photo: [{ file_id: "big-id" }] }));
  const lst = await cb.handleUpdate(dm({ text: "/list" }, 11));
  check("/list answers at once while a batch waits", lst.includes("proj/agenda") && sends.length === 0, lst);
  cb.stop();
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall telegram checks passed");
process.exitCode = failed ? 1 : 0;
