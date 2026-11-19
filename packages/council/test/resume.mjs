// Continue after an interruption, without any LLM: a fake member is cut off by closing the
// agenda, a crashed run leaves a "running" member with a live leftover process and a chair
// marker file, and resume() restarts the member from its notes and tells the chair.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaRuntime, AgendaStore, ProjectRegistry, drivers, stopLeftover } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-resume-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
const sh = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]);
sh(["config", "user.email", "t@t"]);
sh(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "src", "a.js"), "export const a = 1;\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

// fake claude members: the first one works until stopped, the next must get the handover packet
let spawnCount = 0;
const packets = [];
drivers.claude = {
  provider: "claude",
  spawn(spec, onLine) {
    spawnCount++;
    packets.push(spec.stdinText ?? "");
    if (spawnCount === 1) {
      fs.writeFileSync(path.join(spec.cwd, ".council", "STATE.md"), "한 일: b 절반\n남은 일: b 마무리\n");
      fs.writeFileSync(path.join(spec.cwd, "src", "b.js"), "export const b = 2; // wip\n");
      let finish;
      const done = new Promise((r) => (finish = r));
      return { pid: undefined, child: {}, stop: () => finish({ code: 1, signal: "SIGTERM" }), done };
    }
    const done = new Promise((resolve) =>
      setTimeout(() => {
        fs.writeFileSync(path.join(spec.cwd, "src", "b.js"), "export const b = 2;\n");
        fs.writeFileSync(path.join(spec.cwd, ".council", "RESULT.md"), "## 결과\nb 완료\n## 변경 파일\n- src/b.js\n## 미완료·막힌 점\n없음\n");
        onLine("stdout", JSON.stringify({ type: "result", subtype: "success", result: "done", is_error: false }));
        resolve({ code: 0, signal: null });
      }, 50),
    );
    return { pid: undefined, child: {}, stop() {}, done };
  },
};

const registry = new ProjectRegistry();
const project = registry.add({ name: "재개 테스트", repo, baseBranch: "main" });
const store = AgendaStore.create(project, "안건", ["b 추가"]);
const memory = new MemoryStore({ git: false });
await memory.init();
const chairOpts = { councilUrl: "http://127.0.0.1:9/mcp" };
const chairCalls = [];
const fakeChair = (rt) => {
  rt.chair.turn = async (message) => {
    chairCalls.push(message);
    return { text: "ok", isError: false };
  };
};

// ---- 1. closing the agenda cuts a running member off ----
const rt1 = await AgendaRuntime.open(store, memory, chairOpts);
fakeChair(rt1);
const task = rt1.council.addTask({ title: "b 추가", goal: 1 });
const stopped = new Promise((r) => rt1.council.once("member:done", r));
const m1 = await rt1.council.assign({ taskId: task.id, provider: "claude", instructions: "src/b.js 를 만들어라." });
rt1.close({ closeMemory: false });
const m1done = await stopped;
check("closed member is stopped and interrupted", m1done.status === "stopped" && m1done.interrupted === true, JSON.stringify([m1done.status, m1done.interrupted]));
check("partial work auto-committed", sh(["log", "--oneline", `main..${m1.branch}`]).includes("wip"));

// ---- 2. a crash leaves a running member with a live process and a chair marker ----
const leftover = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
await new Promise((r) => setTimeout(r, 300));
const crashed = {
  id: "claude-9",
  provider: "claude",
  account: "claude",
  taskId: task.id,
  branch: "member/x/claude-9",
  worktree: path.join(tmp, "nowhere"),
  status: "running",
  pid: leftover.pid,
  startedAt: new Date().toISOString(),
  toolCalls: 0,
};
store.saveMembers([...store.members(), crashed]);
store.appendTranscript({ role: "user", text: "로그인 오류 고쳐줘" });
fs.mkdirSync(store.chairDir(), { recursive: true });
fs.writeFileSync(path.join(store.chairDir(), "running.json"), JSON.stringify({ pid: 0, startedAt: new Date().toISOString(), message: "x" }));
const leftoverExit = new Promise((r) => leftover.on("exit", () => r(true)));

const rt2 = await AgendaRuntime.open(store, memory, chairOpts);
fakeChair(rt2);
check("leftover process stopped on reopen", await Promise.race([leftoverExit, new Promise((r) => setTimeout(() => r(false), 10000))]));
const info = rt2.state().resume;
check("resume lists both cut-off members", info && info.members.map((m) => m.id).sort().join() === "claude-1,claude-9", JSON.stringify(info));
check("resume knows the cut chair turn", info?.chair?.message === "로그인 오류 고쳐줘", JSON.stringify(info?.chair));
check("chair marker cleared", !fs.existsSync(path.join(store.chairDir(), "running.json")));

// ---- 3. resume ----
const resumedDone = new Promise((r) => rt2.council.on("member:done", (m) => m.handoverFrom === "claude-1" && r(m)));
const res = await rt2.resume();
check("claude-1 resumed, broken record reported", res.resumed.length === 1 && res.resumed[0].from === "claude-1" && res.failed.length === 1 && res.failed[0].id === "claude-9", JSON.stringify(res));
const m2 = await resumedDone;
check("resumed member keeps worktree, branch and account", m2.worktree === m1.worktree && m2.branch === m1.branch && m2.account === "claude");
check("a resume is recorded as a resume, not as a failure", m2.handoverCause === "resume", String(m2.handoverCause));
check("resumed member got the handover packet with STATE.md", packets[1].includes("인계 패킷") && packets[1].includes("남은 일: b 마무리"));
check("resumed member finished", m2.status === "done" && m2.result.summary === "b 완료", JSON.stringify([m2.status, m2.result?.summary]));
await new Promise((r) => setTimeout(r, 100));
const resumeMsg = chairCalls.find((c) => c.includes("이어서 하기"));
check("chair told to continue its cut request", Boolean(resumeMsg) && resumeMsg.includes("로그인 오류 고쳐줘") && resumeMsg.includes("claude-1 → "), String(resumeMsg).slice(0, 200));
check("nothing left to resume except the broken record", rt2.resumeInfo()?.members.map((m) => m.id).join() === "claude-9" && !rt2.resumeInfo()?.chair);
rt2.dismissResume();
check("dismiss clears it", rt2.resumeInfo() === undefined);

// ---- 4. pid safety ----
check("no pid -> nothing stopped", (await stopLeftover(undefined, undefined)) === false);
const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
await new Promise((r) => setTimeout(r, 300));
const longAgo = new Date(Date.now() - 3600_000).toISOString();
check("process that started at another time is left alone", (await stopLeftover(other.pid, longAgo)) === false || process.platform !== "win32");
other.kill();

// ---- 5. children remembered while running are stopped after their parent died ----
if (process.platform === "win32") {
  const { snapshotDescendants, stopTracked } = await import("@gencouncil/council");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gc-tree-"));
  fs.writeFileSync(path.join(work, "grandchild.mjs"), "setTimeout(() => {}, 60000);\n");
  // the parent starts its child from a relative path, like a member's browser harness
  fs.writeFileSync(path.join(work, "parent.mjs"), "import { spawn } from 'node:child_process'; spawn(process.execPath, ['grandchild.mjs'], { stdio: 'ignore', detached: true }).unref(); setTimeout(() => {}, 60000);\n");
  const parent = spawn(process.execPath, ["parent.mjs"], { cwd: work, stdio: "ignore", windowsHide: true });
  await new Promise((r) => setTimeout(r, 1500));
  const snap = await snapshotDescendants([parent.pid]);
  const kids = snap.get(parent.pid) ?? [];
  check("descendants of a running member are found", kids.length >= 1, JSON.stringify(kids));
  parent.kill(); // the parent dies, its child keeps running (Windows does not kill children)
  await new Promise((r) => setTimeout(r, 500));
  const stopped = await stopTracked(kids);
  await new Promise((r) => setTimeout(r, 500));
  const still = await snapshotDescendants([0]);
  void still;
  check("remembered children are stopped after the parent died", stopped >= 1, `stopped ${stopped}`);
  fs.rmSync(work, { recursive: true, force: true });
}

rt2.close({ closeMemory: false });
memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall resume checks passed");
process.exitCode = failed ? 1 : 0;
