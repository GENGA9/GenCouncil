// Limits, model ladders, GPT parsing and folder mode — no LLM involved.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import {
  AgendaStore,
  Council,
  ProjectRegistry,
  createProject,
  commitUserEdits,
  drivers,
  ensureWorktree,
  git,
  memberDisplayName,
  normalizeLimits,
  parseCodexLine,
  resolveAdvisor,
  resolveEffort,
  resolveModel,
  tierOf,
} from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-limits-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");

// these checks run Gemini members as a user who switched Gemini (Antigravity CLI) on would
(await import("@gencouncil/council")).setGeminiEnabled(true, true);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};
const rejects = (p, re) => p.then(() => false, (e) => re.test(e.message));

// ---- ladders ----
const lim = normalizeLimits({ claude: { maxMembers: 1, maxModel: "sonnet", maxEffort: "medium" }, gpt: { maxMembers: 0 }, "gemini-web": { maxMembers: 1 } });
check("full ids map to tiers", tierOf("claude", "claude-opus-5-5") === 2 && tierOf("gpt", "gpt-6.1-sol") === 2 && tierOf("gpt", "gpt-6.1-terra") === 1 && tierOf("gemini", "gemini-3.8-flash-high") === 0 && tierOf("gemini", "gemini-2.5-pro") === 3 && tierOf("gemini", "gemini-4-neon-xhigh") === 2);
check("default model is the workhorse within limit", resolveModel("claude", undefined, lim.claude) === "sonnet" && resolveModel("gpt", undefined, normalizeLimits({}).gpt) === "gpt-6.2-sol");
check("6.2 Sol and Astra share the old rungs", tierOf("gpt", "gpt-6.2-sol") === 2 && tierOf("gpt", "gpt-6.2-astra") === 3 && tierOf("gpt", "gpt-6-astra") === 3);
check("an old 6.1 Sol limit loads as 6.2 Sol and still allows 6.1 Sol by name", normalizeLimits({ gpt: { maxMembers: 1, maxModel: "gpt-6.1-sol" } }).gpt.maxModel === "gpt-6.2-sol" && resolveModel("gpt", "gpt-6.1-sol", normalizeLimits({}).gpt) === "gpt-6.1-sol");
check("6.2 Astra stays above a Sol limit", (() => { try { resolveModel("gpt", "gpt-6.2-astra", normalizeLimits({}).gpt); return false; } catch { return true; } })());
check("model above limit rejected", throws(() => resolveModel("claude", "opus", lim.claude), /above the user's limit/));
check("unknown model rejected", throws(() => resolveModel("claude", "gpt-6", lim.claude), /unknown claude model/));
check("default effort medium", resolveEffort("claude", undefined, lim.claude) === "medium");
check("effort above limit rejected", throws(() => resolveEffort("claude", "high", lim.claude), /above the user's limit/));
check("gemini effort caps at high", resolveEffort("gemini", "high", lim.gemini) === "high" && resolveEffort("gemini", undefined, lim.gemini) === "medium");
check("advisor below main rejected", throws(() => resolveAdvisor("sonnet", "haiku", lim.claude), /ranks below/));
check("advisor above limit rejected", throws(() => resolveAdvisor("haiku", "opus", lim.claude), /above the user's limit/));
check("advisor ok", resolveAdvisor("haiku", "sonnet", lim.claude) === "sonnet");
check("fable main needs fable advisor", throws(() => resolveAdvisor("fable", "opus", normalizeLimits({ claude: { maxMembers: 1, maxModel: "fable" } }).claude), /ranks below|Fable/));
const fableLim = normalizeLimits({ claude: { maxMembers: 1, maxModel: "fable" } }).claude;
check("fable main takes no advisor", throws(() => resolveAdvisor("fable", "fable", fableLim), /without an advisor/) && resolveAdvisor("fable", "none", fableLim) === undefined);
check("opus main may take fable advisor", resolveAdvisor("opus", "fable", fableLim) === "fable");
check("gpt display name", memberDisplayName({ id: "gpt-1", provider: "gpt", model: "gpt-6.1-sol" }) === "GPT-6.1 Sol");
check("a grok member without a model is shown as Grok", memberDisplayName({ id: "grok-1", provider: "grok" }) === "Grok");
check("terra display name", memberDisplayName({ id: "gpt-2", provider: "gpt", model: "gpt-6.1-terra" }) === "GPT-6.1 Terra");

// Hydrogen is the middle workhorse; old Flash/Pro limits keep their meaning.
check("hydrogen tier and suffix do not match argon", tierOf("gemini", "gemini-4-hydrogen") === 1 && tierOf("gemini", "gemini-4-hydrogen-xhigh") === 1);
check("gemini default is neon, the opus-rank model", resolveModel("gemini", undefined, lim.gemini) === "gemini-4-neon");
check("a hydrogen limit clamps the default to hydrogen", resolveModel("gemini", undefined, { maxMembers: 1, maxModel: "gemini-4-hydrogen" }) === "gemini-4-hydrogen");
check("flash limit clamps the workhorse", resolveModel("gemini", undefined, { maxMembers: 1, maxModel: "gemini-3.8-flash" }) === "gemini-3.8-flash");
const hydrogenLimit = { ...lim.gemini, maxEffort: "xhigh" };
check("hydrogen permits xhigh within user limit", resolveEffort("gemini", "xhigh", hydrogenLimit, "gemini-4-hydrogen") === "xhigh");
check("default gemini effort limit still rejects xhigh", throws(() => resolveEffort("gemini", "xhigh", lim.gemini, "gemini-4-hydrogen"), /above the user's limit/));
for (const model of ["gemini-4-argon", "gemini-3.8-flash"]) {
  check(model + " rejects xhigh", throws(() => resolveEffort("gemini", "xhigh", hydrogenLimit, model), /above the user's limit/));
}
check("explicit xhigh suffix cannot bypass user effort limit", throws(() => resolveEffort("gemini", "low", lim.gemini, "gemini-4-hydrogen-xhigh"), /above the user's limit/));
check("explicit xhigh suffix is validated and retained", resolveEffort("gemini", "low", hydrogenLimit, "gemini-4-hydrogen-xhigh") === "xhigh");
check("hydrogen rejects max effort", throws(() => resolveEffort("gemini", "max", { ...hydrogenLimit, maxEffort: "max" }, "gemini-4-hydrogen"), /above the user's limit/));

// ---- codex json ----
const ev = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"npm test"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"끝났습니다"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1}}',
].flatMap(parseCodexLine);
check("codex events parsed", ev.map((e) => e.kind).join() === "init,tool,text,result" && ev[2].text === "끝났습니다" && ev[3].isError === false, JSON.stringify(ev));
check("codex failure parsed", parseCodexLine('{"type":"turn.failed","error":{"message":"usage limit reached"}}')[0].isError === true);

// ---- council slot limits with a hanging fake driver ----
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]);
sh(["config", "user.email", "t@t"]);
sh(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);

const registry = new ProjectRegistry();
const old = registry.add({ name: "옛 한도", repo, baseBranch: "main", limits: { gemini: { maxMembers: 2, maxModel: "gemini-2.5-pro" } } });
check("old gemini limit loads as current ladder id", registry.get(old.id).members.limits.gemini.maxModel === "gemini-4-argon", JSON.stringify(registry.get(old.id).members.limits.gemini));
const project = registry.add({ name: "한도", repo, baseBranch: "main", limits: { claude: { maxMembers: 1, maxModel: "sonnet", maxEffort: "medium" }, gpt: { maxMembers: 0 }, "gemini-web": { maxMembers: 1 } } });
const store = AgendaStore.create(project, "안건", ["x"]);
const memory = new MemoryStore({ git: false });
await memory.init();
const council = new Council(store, memory);
await council.open();

let release;
const spawned = [];
drivers.claude = {
  provider: "claude",
  spawn(spec) {
    spawned.push(spec);
    const done = new Promise((r) => (release = () => r({ code: 0, signal: null })));
    return { pid: 1, child: {}, stop() {}, done };
  },
};
const t = () => council.addTask({ title: "t" }).id;
check("claude model above limit", await rejects(council.assign({ taskId: t(), provider: "claude", model: "opus", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" }), /above the user's limit/));
const m1 = await council.assign({ taskId: t(), provider: "claude", model: "haiku", advisor: "sonnet", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" });
check("claude member gets model/effort/advisor", m1.model === "haiku" && m1.effort === "medium" && m1.advisor === "sonnet");
check("driver received effort and advisor", spawned[0].effort === "medium" && spawned[0].extraArgs.join(" ").includes("--advisor sonnet") && spawned[0].extraArgs.includes("--agents"));
check("second claude blocked by count", await rejects(council.assign({ taskId: t(), provider: "claude", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" }), /limit reached \(1\/1/));
check("gpt disabled", await rejects(council.assign({ taskId: t(), provider: "gpt", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" }), /disabled/));
const r1 = await council.assign({ taskId: t(), provider: "relay", site: "gemini-web", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" });
check("web gemini relay waiting with label", r1.status === "waiting" && r1.site === "gemini-web" && r1.label === "웹 제미나이");
check("second web gemini blocked", await rejects(council.assign({ taskId: t(), provider: "relay", site: "gemini-web", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" }), /gemini-web limit reached/));
const r2 = await council.assign({ taskId: t(), provider: "relay", label: "Antigravity", instructions: "xxxxxxxxxxxxxxxxxxxxxxxx" });
check("site-less relay not limited", r2.status === "waiting");
const active = council.activeCounts();
check("active counts", active.claude === 1 && active["gemini-web"] === 1 && active.gpt === 0, JSON.stringify(active));
check("limits table for the chair", council.limitsMarkdown().includes("| claude | 1 (1) |") && council.limitsMarkdown().includes("사용 안 함"));
const finished = new Promise((r) => council.once("member:done", r));
release();
await finished;
check("slot freed after finish", council.activeCounts().claude === 0);

// ---- non-git folder: local git in place ----
const src = path.join(tmp, "plain folder");
fs.mkdirSync(path.join(src, "sub"), { recursive: true });
fs.writeFileSync(path.join(src, "keep.txt"), "keep\n");
fs.writeFileSync(path.join(src, "sub", "old.txt"), "old\n");
fs.mkdirSync(path.join(src, "node_modules", "x"), { recursive: true });
fs.writeFileSync(path.join(src, "node_modules", "x", "big.js"), "ignored\n");
fs.mkdirSync(path.join(src, "tools", "py-env", "Lib"), { recursive: true });
fs.writeFileSync(path.join(src, "tools", "py-env", "pyvenv.cfg"), "home = x\n");
fs.writeFileSync(path.join(src, "tools", "py-env", "Lib", "mod.py"), "x = 1\n");
fs.writeFileSync(path.join(src, "tools", "run.py"), "print(1)\n");
fs.mkdirSync(path.join(src, "output"), { recursive: true });
fs.writeFileSync(path.join(src, "output", "big.png"), Buffer.alloc(100 * 1024));
fs.writeFileSync(path.join(src, "icon.png"), Buffer.alloc(2 * 1024));
fs.writeFileSync(path.join(src, "lib.dll"), Buffer.alloc(10));
// a folder that is its own git repository
fs.mkdirSync(path.join(src, "site"), { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: path.join(src, "site") });
fs.writeFileSync(path.join(src, "site", "index.html"), "<h1>x</h1>\n");
const fp = await createProject({ name: "폴더 작업", path: src });
check("local git created in the folder", fp.localGit === true && fp.repo === path.resolve(src) && fs.existsSync(path.join(src, ".git")) && fp.name === "폴더 작업 제작위원회");
const lsFiles = async () => (await git(src, ["ls-files"])).split("\n").filter(Boolean);
const tracked = await lsFiles();
check("code tracked, small icon tracked", tracked.includes("keep.txt") && tracked.includes("tools/run.py") && tracked.includes("icon.png"), tracked.join(","));
check("venv, node_modules, big media, binaries excluded", !tracked.some((f) => f.startsWith("tools/py-env") || f.startsWith("node_modules") || f === "output/big.png" || f === "lib.dll"), tracked.join(","));
check("scan summary", /제외/.test(fp.scanSummary) && fp.scan.skippedDirs.includes("tools/py-env"), fp.scanSummary);
check("nested repo kept out", fp.scan.nestedRepos.includes("site") && !tracked.some((f) => f.startsWith("site")) && (await git(src, ["status", "--porcelain"])).trim() === "", fp.scanSummary);

const fstore = AgendaStore.create(fp, "폴더 안건", ["y"]);
// the user edits the folder before the agenda opens: committed on open
fs.writeFileSync(path.join(src, "before.txt"), "before\n");
const fc = new Council(fstore, memory);
await fc.open();
check("user edits committed on open", (await git(src, ["log", "--oneline", "-1"])).includes("사용자 변경 반영") && (await git(src, ["status", "--porcelain"])).trim() === "");

// a member edits keep.txt, adds new.txt, deletes sub/old.txt on its branch
const wt = fstore.memberWorktree("claude-1");
await ensureWorktree(fp.repo, wt, fstore.memberBranch("claude-1"), fstore.agenda().branch);
check("member worktree has no venv or big files", !fs.existsSync(path.join(wt, "tools", "py-env")) && !fs.existsSync(path.join(wt, "output", "big.png")) && fs.existsSync(path.join(wt, "keep.txt")));
fs.writeFileSync(path.join(wt, "keep.txt"), "keep\nchanged by member\n");
fs.writeFileSync(path.join(wt, "new.txt"), "new\n");
fs.rmSync(path.join(wt, "sub", "old.txt"));
// a rendered video committed on purpose past the media guard (--no-verify; renders normally go to _shared/)
fs.mkdirSync(path.join(wt, "renders"), { recursive: true });
fs.writeFileSync(path.join(wt, "renders", "ep01.mp4"), Buffer.alloc(200 * 1024));
await git(wt, ["add", "-A"]);
await git(wt, ["add", "-f", "renders/ep01.mp4"]);
await git(wt, ["commit", "-q", "--no-verify", "-m", "member work"]);
fstore.saveMembers([{ id: "claude-1", provider: "claude", taskId: "T1", branch: fstore.memberBranch("claude-1"), worktree: wt, status: "done", startedAt: "", toolCalls: 0 }]);
fstore.saveTasks([{ id: "T1", title: "t", description: "", status: "review", created: "", updated: "" }]);
const fc2 = new Council(fstore, memory);
await fc2.open();
check("member merge", (await fc2.merge("claude-1")).ok);

// meanwhile the user edits another file and drops a big video into the folder
fs.writeFileSync(path.join(src, "user.txt"), "user edit\n");
fs.writeFileSync(path.join(src, "output", "clip.mp4"), Buffer.alloc(400 * 1024));
await fc2.finish();
const after = await lsFiles();
check("member change in folder", fs.readFileSync(path.join(src, "keep.txt"), "utf8").replace(/\r/g, "").includes("changed by member") && fs.existsSync(path.join(src, "new.txt")));
check("member deletion applied", !fs.existsSync(path.join(src, "sub", "old.txt")));
check("user edit kept and committed", fs.readFileSync(path.join(src, "user.txt"), "utf8") === "user edit\n" && after.includes("user.txt"));
check("new big file stays out of git but on disk", fs.existsSync(path.join(src, "output", "clip.mp4")) && !after.includes("output/clip.mp4"));
check("excluded things untouched", fs.existsSync(path.join(src, "node_modules", "x", "big.js")) && fs.existsSync(path.join(src, "tools", "py-env", "Lib", "mod.py")) && fs.existsSync(path.join(src, "output", "big.png")));
check("worktrees cleaned", !fs.existsSync(path.join(src, ".worktrees", "폴더-안건")));
check("member's big file merged into the folder", after.includes("renders/ep01.mp4") && fs.existsSync(path.join(src, "renders", "ep01.mp4")));

// the next user edit rescans the folder: the tracked big file must not be listed or untracked
fs.writeFileSync(path.join(src, "user2.txt"), "again\n");
const fp2 = { ...fp, localGit: true };
const c2 = await commitUserEdits(fp2);
const after2 = await lsFiles();
const deleted = (await git(src, ["show", "--name-status", "--format=", "HEAD"])).split("\n").filter((l) => l.startsWith("D"));
check("user edit commit deletes nothing", !!c2 && after2.includes("user2.txt") && deleted.length === 0, deleted.join(","));
check("tracked big file stays tracked", after2.includes("renders/ep01.mp4") && after2.includes("icon.png"));
const excl = fs.readFileSync(path.join(src, ".git", "info", "exclude"), "utf8");
check("tracked file not in the exclude list", !excl.includes("/renders/ep01.mp4") && excl.includes("/output/clip.mp4"));

memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall limits/folder checks passed");
process.exitCode = failed ? 1 : 0;
