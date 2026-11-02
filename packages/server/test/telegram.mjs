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
    sent.push({ method, chat_id: init.body.get("chat_id"), message_thread_id: init.body.get("message_thread_id"), caption: init.body.get("caption"), photo: init.body.get("photo")?.name });
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
    { botToken: "T", chatId: "123", agenda: "proj/agenda" },
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
  check("topic text goes to that agenda's chair (not the bound one)", out === "의장에게 전달했습니다." && B.msgs[0] === "B 안건 지시" && A.msgs.length === 0);
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
  check("DM text still goes to the bound agenda", A.msgs[0] === "DM 에서 지시");

  // drafts and closing
  {
    const fsm = await import("node:fs"); const osm = await import("node:os"); const pathm = await import("node:path");
    const png = pathm.join(osm.tmpdir(), "gc-forum-shot.png");
    fsm.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    sent.length = 0;
    await fb.sendShown("proj/tg", "C안", [{ name: "c.png", type: "image/png", path: png }]);
    const ph = sent.find((m) => m.method === "sendPhoto");
    check("shown photo goes to the topic", ph && String(ph.chat_id) === String(FORUM) && String(ph.message_thread_id) === String(topicB) && ph.caption === "의장 시안: C안", JSON.stringify(ph));
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
    const pre = new TelegramBridge({ botToken: "T", chatId: "123", forumChatId: String(FORUM), topics: { "proj/agenda": 777 } }, { fetch: fakeFetch, log: () => {}, listAgendas: () => [], getRuntime: async () => A.runtime, onBind: () => {} });
    pre.notify("proj/agenda", { type: "chair:done", text: "미리 설정", isError: false });
    await settle();
    check("preconfigured forum + known topic: no creation, goes to the topic", sent.every((m) => m.method !== "createForumTopic") && to(sent, FORUM, 777).length === 1);
    const noForum = await pre.handleUpdate(gmsg("/forum", { chat: -777 }));
    check("works without an onConfig callback", noForum.includes("연결"));
  }
}


console.log(failed ? `\n${failed} check(s) FAILED` : "\nall telegram checks passed");
process.exitCode = failed ? 1 : 0;
