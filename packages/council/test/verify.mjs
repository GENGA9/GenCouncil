// Claude verification after Gemini Flash code work, without any LLM (fake drivers).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaStore, Council, ProjectRegistry, drivers, memberEventText } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-verify-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");

// these checks run Gemini members as a user who switched Gemini (Antigravity CLI) on would
(await import("@gencouncil/council")).setGeminiEnabled(true, true);
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]);
sh(["config", "user.email", "t@t"]);
sh(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const packets = [];
const fake = (lines, after) => (spec, onLine) => {
  packets.push({ provider: spec.model, text: spec.stdinText ?? spec.prompt });
  const done = new Promise((resolve) =>
    setTimeout(() => {
      after?.(spec.cwd, spec);
      for (const l of lines) onLine("stdout", l);
      resolve({ code: 0, signal: null });
    }, 30),
  );
  return { pid: undefined, child: {}, stop() {}, done };
};
// gemini member: edits code (auto-committed by the council) and writes a result with a claim
drivers.gemini = {
  provider: "gemini",
  spawn: fake(['{"event":"result","result":{"status":"SUCCESS","response":"done"}}'], (cwd) => {
    fs.writeFileSync(path.join(cwd, `g-${Date.now()}.txt`), "routine\n");
    fs.writeFileSync(path.join(cwd, ".council", "RESULT.md"), "## 결과\n84:A370 관측으로 확정\n## 변경 파일\n- g.txt\n## 미완료·막힌 점\n없음\n");
  }),
};
// claude member (worker or verifier)
drivers.claude = {
  provider: "claude",
  spawn: fake([JSON.stringify({ type: "result", subtype: "success", result: "ok", is_error: false })], (cwd, spec) => {
    const isVerify = (spec.stdinText ?? "").includes("검증 패킷");
    fs.writeFileSync(path.join(cwd, ".council", "RESULT.md"), isVerify ? "## 결과\n검증: 수정함\n- 관측 표기 하나를 미확인으로 고침\n## 변경 파일\n- g.txt\n## 미완료·막힌 점\n없음\n" : "## 결과\n완료\n## 변경 파일\n-\n## 미완료·막힌 점\n없음\n");
    if (!isVerify) fs.writeFileSync(path.join(cwd, `c-${Date.now()}.txt`), "c\n");
  }),
};

const registry = new ProjectRegistry();
const project = registry.add({ name: "검증 테스트", repo, baseBranch: "main" });
const store = AgendaStore.create(project, "안건", ["번역"]);
const memory = new MemoryStore({ git: false });
await memory.init();
const council = new Council(store, memory);
await council.open();
const doneOf = (id) => new Promise((r) => { const f = (m) => { if (m.id === id) { council.off("member:done", f); r(m); } }; council.on("member:done", f); });
const nextDone = () => new Promise((r) => council.once("member:done", r));

// ---- 1. Flash code work gets a Claude check ----
const t1 = council.addTask({ title: "루틴 번역", goal: 1 });
const g1done = nextDone();
const g1 = await council.assign({ taskId: t1.id, provider: "gemini", model: "gemini-3.8-flash", instructions: "84:A370 루틴을 번역한다. 근거를 적는다." });
const gm = await g1done;
const v = council.members().find((m) => m.verifyOf === g1.id);
check("verifier started for flash code work", gm.verifiedBy && v && v.provider === "claude" && v.id === gm.verifiedBy, JSON.stringify({ verifiedBy: gm.verifiedBy, v: v?.id }));
check("verifier works on the same branch and worktree", v.branch === g1.branch && v.worktree === g1.worktree);
check("verifier defaults to sonnet, high effort", v.model === "sonnet" && v.effort === "high", `${v.model}/${v.effort}`);
check("verify packet carries the claim and the original task", packets.at(-1).text.includes("검증 패킷") && packets.at(-1).text.includes("84:A370 관측으로 확정") && packets.at(-1).text.includes("루틴을 번역한다"));
check("chair is told to wait for the verifier", /검증 중/.test(memberEventText(gm)) && memberEventText(gm).includes(v.id));
check("task follows the verifier", store.tasks().find((t) => t.id === t1.id).memberId === v.id);
const vm = await doneOf(v.id);
check("verifier result replaces the flash result", vm.status === "done" && /검증: 수정함/.test(vm.result.summary + vm.result.raw), vm.result.summary);
check("flash result kept beside it", fs.existsSync(path.join(g1.worktree, ".council", `RESULT.${g1.id}.md`)));
check("task in review after the check", store.tasks().find((t) => t.id === t1.id).status === "review");
check("chair event names what was checked", memberEventText(vm).includes(`${g1.id}의 결과를 검증함`));

// ---- 2. no automatic check when the chair says so, for Argon, or when the project turns it off ----
const t2 = council.addTask({ title: "문서 정리", goal: 1 });
const g2done = nextDone();
await council.assign({ taskId: t2.id, provider: "gemini", model: "gemini-3.8-flash", instructions: "문서의 표를 정리한다. 근거 문서는 docs/a.md.", verify: false });
const g2 = await g2done;
check("verify:false skips the check", !g2.verifiedBy && store.tasks().find((t) => t.id === t2.id).status === "review");
const t3 = council.addTask({ title: "아르곤 작업", goal: 1 });
const g3done = nextDone();
await council.assign({ taskId: t3.id, provider: "gemini", model: "gemini-4-argon", instructions: "긴 분석 작업을 한다. 결과를 적는다." });
check("argon is not auto-checked", !(await g3done).verifiedBy);
council.project.members.verifyGeminiFlash = false;
const t4 = council.addTask({ title: "꺼진 프로젝트", goal: 1 });
const g4done = nextDone();
await council.assign({ taskId: t4.id, provider: "gemini", model: "gemini-3.8-flash", instructions: "코드를 고친다. 테스트를 돌린다." });
check("project switch off skips the check", !(await g4done).verifiedBy);
council.project.members.verifyGeminiFlash = undefined;

// ---- 3. manual check of any finished member ----
const t5 = council.addTask({ title: "클로드 작업", goal: 1 });
const c5done = nextDone();
const c5 = await council.assign({ taskId: t5.id, provider: "claude", instructions: "작은 기능을 만든다. 테스트를 돌린다." });
await c5done;
const mv = await council.verify(c5.id, { model: "opus", effort: "medium", reason: "중요 기능" });
check("manual verify with a chosen model", mv.verifyOf === c5.id && mv.model === "opus" && mv.effort === "medium");
await doneOf(mv.id);
check("same work cannot be checked twice", await council.verify(c5.id).then(() => false, (e) => /already being checked/.test(e.message)));
check("a verifier result can itself be checked", (await council.verify(mv.id, { reason: "재확인" })).verifyOf === mv.id);

// ---- 3b. screenshots members leave, and the chair showing them ----
const t6 = council.addTask({ title: "타이틀 화면", goal: 1 });
const shotsDrv = drivers.claude;
drivers.claude = {
  provider: "claude",
  spawn: (spec, onLine) => {
    fs.mkdirSync(path.join(spec.cwd, ".council", "shots"), { recursive: true });
    fs.writeFileSync(path.join(spec.cwd, ".council", "shots", "title-after.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.writeFileSync(path.join(spec.cwd, ".council", "shots", "notes.zip"), "x");
    return shotsDrv.spawn(spec, onLine);
  },
};
await new Promise((r) => setTimeout(r, 300)); // let the verifier from section 3 finish
const s6 = await council.assign({ taskId: t6.id, provider: "claude", instructions: "타이틀 화면을 바꾸고 스크린샷을 남긴다." });
const s6m = await doneOf(s6.id);
drivers.claude = shotsDrv;
check("member screenshots are collected (images only)", s6m.shots?.length === 1 && s6m.shots[0].endsWith("title-after.png"), JSON.stringify(s6m.shots));
check("chair event lists the screenshots", /스크린샷 1장/.test(memberEventText(s6m)));
{
  const many = Array.from({ length: 30 }, (_, i) => ` src/f${i}.ts | ${i + 1} +`).concat(" 30 files changed, 465 insertions(+)").join("\n");
  const ev = memberEventText({ ...s6m, diffstat: many });
  const evLines = ev.split("\n");
  check("chair event carries the diffstat, capped with the total kept", ev.includes("diffstat:") && ev.includes("src/f0.ts") && !ev.includes("src/f29.ts") && /… \d+ files more/.test(ev) && ev.includes("30 files changed, 465 insertions(+)"), ev);
  check("diffstat takes at most 15 lines", evLines.filter((l) => /^ ?src\/f|files more|files changed/.test(l)).length <= 15);
  check("verifying event carries only the total line", memberEventText({ ...s6m, verifiedBy: "claude-9", diffstat: many }).includes("diffstat: 30 files changed") && !memberEventText({ ...s6m, verifiedBy: "claude-9", diffstat: many }).includes("src/f0.ts"));
  check("event without diffstat has no diffstat line", !memberEventText({ ...s6m, diffstat: "" }).includes("diffstat:"));
  check("event guides toward diffstat and files", /diffstat/.test(ev) && ev.includes("files:[핵심 파일]") && ev.includes("council_verify"));
  const full = await council.memberInfo(s6m.id, { diff: true });
  check("memberInfo diff:true still returns a diff and the diffstat", typeof full.diff === "string" && full.diff.includes("diff --git") && typeof full.diffstat === "string", String(full.diff).slice(0, 80));
  const firstFile = /^diff --git a\/(\S+) /m.exec(full.diff)?.[1];
  const onlyOne = await council.memberInfo(s6m.id, { diff: true, files: [firstFile] });
  check("files filter limits the diff to those paths", firstFile && onlyOne.diff.includes(`a/${firstFile}`) && (onlyOne.diff.match(/^diff --git /gm) ?? []).length === 1, firstFile);
  const none = await council.memberInfo(s6m.id, { diff: true, files: ["no/such/file.txt"] });
  check("files filter with an unknown path gives an empty diff", none.diff === "");
  const capped = await council.memberInfo(s6m.id, { diff: true, maxChars: 50 });
  check("max_chars truncates and points at files", capped.diff.includes("truncated") && capped.diff.includes("files 인자"), capped.diff.slice(-120));
  check("no diff unless asked", (await council.memberInfo(s6m.id)).diff === undefined);
}
const shownEvents = [];
council.on("show", (e) => shownEvents.push(e));
const shown = council.showFiles([s6m.shots[0]], "A안: 타이틀 화면");
check("chair shows a member screenshot", shown.length === 1 && shown[0].type === "image/png" && fs.existsSync(path.join(store.dir, "attachments", shown[0].id)));
check("shown drafts are kept in the chat history", store.transcript?.() ? true : fs.readFileSync(path.join(store.dir, "transcript.jsonl"), "utf8").includes("A안: 타이틀 화면"));
check("show event goes out", shownEvents.length === 1 && shownEvents[0].attachments[0].id === shown[0].id);
check("files outside the agenda are refused", (() => { try { council.showFiles([path.join(os.tmpdir(), "x.png")], "x"); return false; } catch (e) { return /밖의 파일/.test(e.message); } })());
check("unsupported formats are refused", (() => { try { council.showFiles([path.join(s6m.worktree, ".council", "shots", "notes.zip")], "x"); return false; } catch (e) { return /형식/.test(e.message); } })());

// ---- 3b2. council_telegram: only through a sender hook, same path rules as council_show ----
{
  const { createCouncilMcp } = await import("@gencouncil/council");
  const tool = createCouncilMcp(council)._registeredTools["council_telegram"];
  const call = async (args) => {
    const r = await tool.handler(args, {});
    return { isError: Boolean(r.isError), text: r.content[0].text };
  };
  check("council_telegram is registered and says auto sending is the default and it is for explicit instructions only when off", Boolean(tool) && /ONLY when the user explicitly/.test(tool.description) && /ON by default/.test(tool.description) && /agenda.telegramAuto is false/.test(tool.description));
  const noHook = await call({ text: "안녕" });
  check("council_telegram without a Telegram hook returns an error", noHook.isError && noHook.text.includes("텔레그램이 연결되어 있지 않다"), noHook.text);
  const reqs = [];
  let hookResult = { ok: true, detail: "보냈다 (텔레그램 DM): 글" };
  council.setTelegramSender(async (req) => {
    reqs.push(req);
    return hookResult;
  });
  const ok1 = await call({ text: "  보냅니다  " });
  check("council_telegram calls the hook with the text and reports success", !ok1.isError && reqs.length === 1 && reqs[0].text === "보냅니다" && reqs[0].files.length === 0 && !reqs[0].ask && ok1.text.includes("보냈다"), JSON.stringify([ok1, reqs]));
  const ok2 = await call({ text: "시안", paths: [s6m.shots[0]] });
  check("council_telegram resolves files like council_show (name, type, absolute path)", !ok2.isError && reqs[1].files.length === 1 && reqs[1].files[0].name === "title-after.png" && reqs[1].files[0].type === "image/png" && fs.existsSync(reqs[1].files[0].path), JSON.stringify(reqs[1]));
  const bad1 = await call({ text: "x", paths: [path.join(os.tmpdir(), "x.png")] });
  check("council_telegram refuses files outside the agenda", bad1.isError && /밖의 파일/.test(bad1.text) && reqs.length === 2, bad1.text);
  const bad2 = await call({ text: "x", paths: [path.join(s6m.worktree, ".council", "shots", "notes.zip")] });
  check("council_telegram refuses unsupported formats", bad2.isError && /형식/.test(bad2.text) && reqs.length === 2, bad2.text);
  const noAsk = await call({ text: "골라 주세요", ask: true });
  check("council_telegram ask:true without a pending question is an error", noAsk.isError && /질문이 없다/.test(noAsk.text) && reqs.length === 2, noAsk.text);
  council.askUser("어느 시안으로 갈까요?", ["A안", "B안"]);
  const withAsk = await call({ text: "골라 주세요", ask: true });
  check("council_telegram ask:true passes the pending question and options", !withAsk.isError && reqs[2].ask?.question === "어느 시안으로 갈까요?" && reqs[2].ask.options.join() === "A안,B안", JSON.stringify(reqs[2]));
  council.clearWaiting();
  hookResult = { ok: false, detail: "일부만 보냈거나 실패했다: 글 전송 실패" };
  const failed1 = await call({ text: "실패할 글" });
  check("council_telegram reports a failed send as an error with the reason", failed1.isError && failed1.text.includes("텔레그램 전송 실패") && failed1.text.includes("글 전송 실패"), failed1.text);
  const empty = await call({ text: "   " });
  check("council_telegram refuses an empty text", empty.isError && reqs.length === 4, empty.text);
  council.setTelegramSender(undefined);
}

// ---- 3c. the chair sees remaining usage next to the limits ----
council.setUsageProvider(() => [
  { provider: "claude", account: "claude", fiveHour: { usedPct: 85 }, weekly: { usedPct: 72 } },
  { provider: "gpt", account: "gpt", weekly: { usedPct: 10 } },
  { provider: "gemini", account: "gemini", error: "down" },
]);
const lm = council.limitsMarkdown();
check("limits table shows remaining usage", lm.includes("남은 사용량") && lm.includes("| claude | 15% 남음 | 28% 남음 |") && lm.includes("| gpt | - | 90% 남음 |") && !lm.includes("down"), lm.split("\n").slice(-5).join(" / "));
council.setUsageProvider(() => undefined);
check("no usage data: plain table", !council.limitsMarkdown().includes("남은 사용량"));

// ---- 3d. top models are held back when the weekly allowance runs low ----
const { checkTopModelUsage } = await import("@gencouncil/council");
const throws = (fn) => { try { fn(); return false; } catch (e) { return /주간 사용량/.test(e.message); } };
check("astra refused under 50% GPT weekly", throws(() => checkTopModelUsage("gpt", "gpt-6-astra", 40)));
check("6.2 astra held back too", throws(() => checkTopModelUsage("gpt", "gpt-6.2-astra", 40)));
check("astra allowed at 60%", !throws(() => checkTopModelUsage("gpt", "gpt-6-astra", 60)));
check("sol never held back", !throws(() => checkTopModelUsage("gpt", "gpt-6.1-sol", 5)));
check("fable refused under 30% Claude weekly", throws(() => checkTopModelUsage("claude", "fable", 25)) && !throws(() => checkTopModelUsage("claude", "opus", 5)));
check("override passes fable/astra", !throws(() => checkTopModelUsage("claude", "fable", 20, true)) && !throws(() => checkTopModelUsage("gpt", "gpt-6-astra", 20, true)) && throws(() => checkTopModelUsage("claude", "fable", 20)) && throws(() => checkTopModelUsage("gpt", "gpt-6-astra", 20)));
{
  const { normalizeLimits: nl } = await import("@gencouncil/council");
  const d = nl({});
  check("floor defaults 30/50", d.claude.topModelMinWeeklyLeft === 30 && d.gpt.topModelMinWeeklyLeft === 50 && d.gemini.topModelMinWeeklyLeft === undefined);
  const c = nl({ claude: { topModelMinWeeklyLeft: 250 }, gpt: { topModelMinWeeklyLeft: -5 }, gemini: { topModelMinWeeklyLeft: 10 } });
  check("floor clamped 0..100, gemini ignored", c.claude.topModelMinWeeklyLeft === 100 && c.gpt.topModelMinWeeklyLeft === 0 && c.gemini.topModelMinWeeklyLeft === undefined);
  check("floor garbage -> default", nl({ claude: { topModelMinWeeklyLeft: "abc" } }).claude.topModelMinWeeklyLeft === 30);
  check("floor 10: fable ok at 20%", !throws(() => checkTopModelUsage("claude", "fable", 20, false, 10)));
  check("floor 50: fable refused at 40%", throws(() => checkTopModelUsage("claude", "fable", 40, false, 50)));
  check("floor 0: astra ok at 1%", !throws(() => checkTopModelUsage("gpt", "gpt-6-astra", 1, false, 0)));
}
check("unknown usage never blocks", !throws(() => checkTopModelUsage("claude", "fable", undefined)));
council.setUsageProvider(() => [{ provider: "claude", account: "claude", weekly: { usedPct: 80 } }, { provider: "claude", account: "claude-b", weekly: { usedPct: 90 } }]);
check("best account decides", council.weeklyLeft("claude") === 20);
const t7 = council.addTask({ title: "어려운 설계", goal: 1 });
check("assign refuses fable when Claude weekly is low", await council.assign({ taskId: t7.id, provider: "claude", model: "fable", instructions: "가장 어려운 설계 작업을 한다." }).then(() => false, (e) => /fable/.test(e.message) && /주간/.test(e.message)));
council.setUsageProvider(() => undefined);

// ---- 4. GPT members get the memory MCP through codex -c overrides ----
const { codexMcpArgs } = await import("@gencouncil/council");
const ca = codexMcpArgs({ mcpServers: { gencouncil: { command: "C:\\Program Files\\nodejs\\node.exe", args: ["D:\\x\\server.js"], env: { GENCOUNCIL_ROLE: "member" } }, remote: { url: "http://127.0.0.1:7700/mcp-member/a/b/c", bearerTokenEnvVar: "GC_TOKEN" } } });
check(
  "codex mcp overrides use literal TOML strings",
  ca.includes("mcp_servers.gencouncil.command='C:\\Program Files\\nodejs\\node.exe'") &&
    ca.includes("mcp_servers.gencouncil.args=['D:\\x\\server.js']") &&
    ca.includes("mcp_servers.gencouncil.env.GENCOUNCIL_ROLE='member'") &&
    ca.includes("mcp_servers.remote.url='http://127.0.0.1:7700/mcp-member/a/b/c'") &&
    ca.includes("mcp_servers.remote.bearer_token_env_var='GC_TOKEN'") &&
    ca.includes("mcp_servers.gencouncil.default_tools_approval_mode='approve'") &&
    !ca.some((a) => a.includes('"')),
  JSON.stringify(ca),
);

await new Promise((r) => setTimeout(r, 200));
memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall verify checks passed");
process.exitCode = failed ? 1 : 0;
