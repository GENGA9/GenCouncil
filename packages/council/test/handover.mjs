// Phase 4 smoke test without any LLM: quota classifier, account registry, relay round trip,
// and automatic handover driven by a fake claude driver that fails with a usage-limit error.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import {
  AccountRegistry,
  AgendaStore,
  Council,
  ProjectRegistry,
  classifyFailure,
  drivers,
  parseRelayResponse,
  parseReset,
} from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-ho-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]);
sh(["config", "user.email", "t@t"]);
sh(["config", "user.name", "t"]);
fs.mkdirSync(path.join(repo, "src"));
fs.writeFileSync(path.join(repo, "src", "a.js"), "export const a = 1;\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

// ---- quota classifier ----
const epoch = Math.floor(Date.now() / 1000) + 3600;
const q1 = classifyFailure("claude", `Claude AI usage limit reached|${epoch}`, 1);
check("claude usage-limit epoch parsed", q1.kind === "quota" && Math.abs(Date.parse(q1.resetAt) - epoch * 1000) < 1000, JSON.stringify(q1));
const q2 = classifyFailure("gemini", "Error: 429 RESOURCE_EXHAUSTED: quota exceeded. Please retry in 42.5s", 1);
check("gemini 429 + retry-in parsed", q2.kind === "quota" && Date.parse(q2.resetAt) > Date.now() + 30_000, JSON.stringify(q2));
check("auth classified", classifyFailure("gemini", "Please set an Auth method in your settings", 1).kind === "auth");
check("other classified", classifyFailure("claude", "TypeError: boom", 1).kind === "other");
check("parseReset hours", parseReset("Your limit will reset in 2 hours", 0) === new Date(2 * 3600_000).toISOString());

// ---- account registry ----
const reg = new AccountRegistry();
check("implicit accounts exist", reg.list().map((a) => a.id).sort().join() === "claude,gemini,gpt");
reg.upsert({ id: "claude-b", provider: "claude", configDir: path.join(tmp, "claude-b"), priority: 60 });
check("pick prefers lower priority", reg.pick("claude").id === "claude");
reg.markExhausted("claude", "limit", new Date(Date.now() + 60_000).toISOString());
check("pick skips exhausted", reg.pick("claude").id === "claude-b");
reg.markExhausted("claude-b", "limit", new Date(Date.now() - 1000).toISOString());
check("lazy reset of expired cooldown", reg.get("claude-b").status === "ok");
reg.markOk("claude");
reg.upsert({ id: "web-a@x.com", provider: "gemini-web" });
check("same id cannot change kind", (() => { try { reg.upsert({ id: "web-a@x.com", provider: "claude" }); return false; } catch (e) { return /이미/.test(e.message); } })());
check("web account kept its kind", reg.get("web-a@x.com").provider === "gemini-web");
check("no extra Antigravity accounts", (() => { try { reg.upsert({ id: "gem-b", provider: "gemini" }); return false; } catch (e) { return /하나만/.test(e.message); } })());
check("built-in gemini account still editable", reg.upsert({ id: "gemini", provider: "gemini", priority: 40 }).priority === 40);

// ---- project / agenda ----
const registry = new ProjectRegistry();
const project = registry.add({ name: "인계 테스트", repo, baseBranch: "main" });
const store = AgendaStore.create(project, "안건", ["릴레이", "핸드오버"]);
const memory = new MemoryStore({ git: false });
await memory.init();
const council = new Council(store, memory);
await council.open();
const logs = [];
council.on("log", (l) => logs.push(l));

// ---- relay round trip ----
const tRelay = council.addTask({ title: "a.js 에 b 추가", goal: 1 });
const relay = await council.assign({ taskId: tRelay.id, provider: "relay", label: "제미나이(agy)", files: ["src/a.js", "src"], instructions: "src/a.js 에 export const b = 2 를 추가하라." });
check("relay member waiting", relay.status === "waiting" && relay.id === "relay-1" && relay.label === "제미나이(agy)");
const packet = council.relayPacket(relay.id);
check("packet bundles file content", packet.includes("=== FILE: src/a.js ===") && packet.includes("export const a = 1;") && packet.includes("=== DIR: src ==="));
check("packet has answer format", packet.includes("=== RESULT ===") && packet.includes("답변 양식"));
const parsed = parseRelayResponse("설명 blah\n=== FILE: src/a.js ===\n```js\nexport const a = 1;\nexport const b = 2;\n```\n=== END ===\n\n=== RESULT ===\n## 결과\nb 추가함\n## 변경 파일\n- src/a.js\n## 미완료·막힌 점\n없음\n=== END ===\n");
check("relay response parsed (fence stripped)", parsed.files.length === 1 && parsed.files[0].content === "export const a = 1;\nexport const b = 2;\n" && parsed.result.includes("b 추가함"));
const donePromise = new Promise((r) => council.once("member:done", r));
await council.relaySubmit(relay.id, { response: "=== FILE: src/a.js ===\nexport const a = 1;\nexport const b = 2;\n=== END ===\n=== RESULT ===\n## 결과\nb 추가함\n## 변경 파일\n- src/a.js\n## 미완료·막힌 점\n없음\n=== END ===" });
const relayDone = await donePromise;
check("relay member done with commit", relayDone.id === "relay-1" && relayDone.status === "done" && relayDone.commits.length === 1, JSON.stringify([relayDone.status, relayDone.commits]));
check("relay file committed on branch", sh(["show", `${relay.branch}:src/a.js`]).includes("export const b = 2;"));
check("relay task in review", store.tasks().find((t) => t.id === tRelay.id).status === "review");
check("relay result parsed", relayDone.result.summary === "b 추가함");
const m1 = await council.merge(relay.id);
check("relay branch merges", m1.ok);

// ---- auto handover with a fake claude driver ----
let spawnCount = 0;
const fakeProc = (lines, exitCode, cwd, onLine, after) => {
  const done = new Promise((resolve) =>
    setTimeout(() => {
      for (const [stream, line] of lines) onLine(stream, line);
      if (after) after(cwd);
      resolve({ code: exitCode, signal: null });
    }, 50),
  );
  return { pid: 4242 + spawnCount, child: {}, stop() {}, done };
};
drivers.claude = {
  provider: "claude",
  spawn(spec, onLine) {
    spawnCount++;
    if (spawnCount === 1) {
      // first member: writes a STATE.md checkpoint, commits part of the work, then hits the limit
      fs.writeFileSync(path.join(spec.cwd, ".council", "STATE.md"), "한 일: c 추가\n남은 일: d 추가\n");
      fs.writeFileSync(path.join(spec.cwd, "src", "c.js"), "export const c = 3;\n");
      return fakeProc([["stderr", `Claude AI usage limit reached|${epoch}`]], 1, spec.cwd, onLine);
    }
    // handover member: must see the handover packet on stdin and finish the job
    const sawHandover = spec.stdinText.includes("인계 패킷") && spec.stdinText.includes("한 일: c 추가") && spec.stdinText.includes("원래 작업 패킷");
    return fakeProc([["stdout", JSON.stringify({ type: "result", subtype: "success", result: "done", is_error: false })]], sawHandover ? 0 : 1, spec.cwd, onLine, (cwd) => {
      fs.writeFileSync(path.join(cwd, "src", "d.js"), "export const d = 4;\n");
      fs.writeFileSync(path.join(cwd, ".council", "RESULT.md"), "## 결과\nd 추가 완료\n## 변경 파일\n- src/d.js\n## 미완료·막힌 점\n없음\n");
    });
  },
};
const tHo = council.addTask({ title: "c, d 추가", goal: 2 });
const events = [];
council.on("member:done", (m) => events.push({ id: m.id, status: m.status, handoverTo: m.handoverTo, failure: m.failure }));
const second = new Promise((resolve) => council.on("member:done", (m) => m.id === "claude-2" && resolve(m)));
const first = await council.assign({ taskId: tHo.id, provider: "claude", instructions: "src 에 c.js 와 d.js 를 추가하라." });
check("first member on default account", first.id === "claude-1" && first.account === "claude");
const m2 = await second;
const failedRec = council.members().find((m) => m.id === "claude-1");
check("first member failed with quota", failedRec.status === "failed" && failedRec.failure.kind === "quota" && failedRec.failure.resetAt === new Date(epoch * 1000).toISOString(), JSON.stringify(failedRec.failure));
check("account marked exhausted", reg.get("claude").status === "exhausted" && reg.get("claude").resetAt === new Date(epoch * 1000).toISOString());
check("auto handover created claude-2 on claude-b", failedRec.handoverTo === "claude-2" && m2.handoverFrom === "claude-1" && m2.account === "claude-b", JSON.stringify([failedRec.handoverTo, m2.account]));
check("same worktree and branch", m2.worktree === failedRec.worktree && m2.branch === failedRec.branch);
check("handover member done", m2.status === "done" && m2.result.summary === "d 추가 완료", JSON.stringify([m2.status, m2.result?.summary]));
check("partial work auto-committed before handover", sh(["log", "--oneline", `main..${m2.branch}`]).includes("wip"));
check("both files on branch", sh(["ls-tree", "--name-only", m2.branch, "src/"]).includes("c.js") && sh(["ls-tree", "--name-only", m2.branch, "src/"]).includes("d.js"));
check("HANDOVER.md written", fs.existsSync(path.join(m2.worktree, ".council", "HANDOVER.md")));
check("task follows handover", store.tasks().find((t) => t.id === tHo.id).memberId === "claude-2" && store.tasks().find((t) => t.id === tHo.id).status === "review");
check("events order: failed then done", events.map((e) => e.id).join() === "claude-1,claude-2", events.map((e) => e.id).join());
check("no second handover allowed", await council.handover("claude-1").then(() => false, (e) => /already handed over/.test(e.message)));

// ---- Antigravity quota is per model: a spent Argon goes on with Hydrogen on the same login ----
const agyQuota = "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 59h36m39s.";
const q3 = classifyFailure("gemini", agyQuota, 1);
check("agy per-model quota parsed with its reset", q3.kind === "quota" && Math.abs(Date.parse(q3.resetAt) - (Date.now() + (59 * 3600 + 36 * 60 + 39) * 1000)) < 60_000, JSON.stringify(q3));
const geminiSpawns = [];
drivers.gemini = {
  provider: "gemini",
  spawn(spec, onLine) {
    geminiSpawns.push(spec.model);
    if (geminiSpawns.length === 1) return fakeProc([["stderr", agyQuota]], 1, spec.cwd, onLine);
    return fakeProc([["stdout", JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } })]], 0, spec.cwd, onLine, (cwd) => {
      fs.writeFileSync(path.join(cwd, ".council", "RESULT.md"), "## 결과\n조사 완료\n## 변경 파일\n없음\n## 미완료·막힌 점\n없음\n");
    });
  },
};
const tGem = council.addTask({ title: "레거시 조사", goal: 2 });
const gemDone = new Promise((resolve) => council.on("member:done", (m) => m.id === "gemini-2" && resolve(m)));
const g1 = await council.assign({ taskId: tGem.id, provider: "gemini", model: "gemini-4-argon", instructions: "조사하라." });
const g2 = await gemDone;
const gAcc = reg.get("gemini");
check("argon blocked, account still usable", gAcc.status === "ok" && Boolean(gAcc.modelBlocks?.["gemini-4-argon"]), JSON.stringify(gAcc));
check("handover stays on the same login with neon", g1.model === "gemini-4-argon" && g2.account === "gemini" && g2.model === "gemini-4-neon" && g2.status === "done", JSON.stringify([g2.account, g2.model, g2.status, geminiSpawns]));
const tGem2 = council.addTask({ title: "또 조사", goal: 2 });
const g3 = await council.assign({ taskId: tGem2.id, provider: "gemini", model: "gemini-4-argon", instructions: "조사하라." });
check("new argon assignment steps down while blocked", g3.model === "gemini-4-neon", g3.model);
await new Promise((r) => council.on("member:done", (m) => m.id === g3.id && r()));
reg.blockModel("gemini", "gemini-4-neon", agyQuota);
reg.blockModel("gemini", "gemini-4-hydrogen", agyQuota);
check("argon, neon and hydrogen spent: steps down to flash", reg.fitModel("gemini", "gemini-4-argon") === "gemini-3.8-flash");
reg.blockModel("gemini", "gemini-3.8-flash", agyQuota);
check("all models spent: no lower model left", reg.fitModel("gemini", "gemini-4-argon") === undefined);
reg.markOk("gemini");
check("markOk clears model blocks", reg.fitModel("gemini", "gemini-4-argon") === "gemini-4-argon");

// Model-aware effort validation must use the fitted model, including during handover.
council.project.members.limits.gemini.maxEffort = "xhigh";
const tHydrogen = council.addTask({ title: "Hydrogen xhigh", goal: 2 });
const h1 = await council.assign({ taskId: tHydrogen.id, provider: "gemini", effort: "xhigh", instructions: "조사하라." });
check("default assignment uses neon with xhigh", h1.model === "gemini-4-neon" && h1.effort === "xhigh");
await new Promise((r) => council.on("member:done", (m) => m.id === h1.id && r()));
reg.blockModel("gemini", "gemini-4-neon", agyQuota);
reg.blockModel("gemini", "gemini-4-hydrogen", agyQuota);
const h2 = await council.handover(h1.id, { account: "gemini" });
check("neon xhigh handover clamps to flash high", h2.model === "gemini-3.8-flash" && h2.effort === "high" && h2.account === "gemini");
await new Promise((r) => council.on("member:done", (m) => m.id === h2.id && r()));
const tFlash = council.addTask({ title: "Flash rejects xhigh", goal: 2 });
check("fitted flash assignment rejects explicit xhigh", await council.assign({ taskId: tFlash.id, provider: "gemini", effort: "xhigh", instructions: "조사하라." }).then(() => false, (e) => /above the user's limit/.test(e.message)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall handover checks passed");
process.exitCode = failed ? 1 : 0;
