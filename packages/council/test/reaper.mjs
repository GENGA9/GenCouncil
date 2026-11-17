// Cleanup of what a member leaves running. Real processes, never a model.
//
// Two properties, both of which decide whether a cleanup is safe to run while other members work:
// a sweep must not touch a filter whose parent is alive (someone is reading it), and a worktree
// match must not spill into a sibling whose name it is a prefix of — stopping claude-6 must not
// stop claude-69. Every sweep here is restricted to pids this test started.
//
// Making a genuine orphan from a test is environment-dependent on Windows (killing the shell takes
// its console, and the filter with it), so the orphan branch is checked against processes that are
// already orphaned on this machine when there are any, and skipped when there are none.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapStrays, stopProcessesUnder } from "@gencouncil/council";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) =>
  new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });

if (process.platform !== "win32") {
  console.log("skip: the cleanup is Windows-only (nothing orphans processes the way Windows does)");
  process.exit(0);
}

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const TAIL = "C:\\Program Files\\Git\\usr\\bin\\tail.exe";
if (!fs.existsSync(BASH) || !fs.existsSync(TAIL)) {
  console.log("skip: Git for Windows (bash, tail) not installed");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-reaper-"));
const log = path.join(tmp, "members-leave-this.log");
fs.writeFileSync(log, "hello\n");

// ---- a filter whose parent is alive is never touched: someone is reading it ----
const held = spawn(TAIL, ["-f", log], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
await settle(1200);
check("the held tail -f is running", alive(held.pid), String(held.pid));
const spared = await reapStrays({ minAgeMinutes: 0, pids: [held.pid] });
await settle(1000);
check("a filter with a live parent survives the sweep", alive(held.pid), JSON.stringify(spared));
held.kill();

// ---- a filter whose parent is already dead is taken, and only when old enough ----
const strayText = await ps(
  "$live=@{}; Get-Process | ForEach-Object { $live[[int]$_.Id]=$true }; Get-CimInstance Win32_Process | Where-Object { $_.Name.ToLower() -in @('tail.exe','grep.exe') -and -not $live.ContainsKey([int]$_.ParentProcessId) -and $_.CreationDate -lt (Get-Date).AddMinutes(-20) } | ForEach-Object { $_.ProcessId }",
);
const strays = strayText
  .split(/\s+/)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
if (strays.length === 0) {
  console.log("skip: no orphaned filters on this machine to sweep (nothing has leaked since the last cleanup)");
} else {
  const one = strays[0];
  // an orphan younger than the minimum is left alone: a pipeline being set up right now is young
  // and its shell can be a step behind, so age is what separates a leak from a live pipeline
  const tooYoung = await reapStrays({ minAgeMinutes: 24 * 60 * 365, pids: [one] });
  await settle(800);
  check("the age floor keeps an orphan the sweep is not sure about", alive(one) && Object.keys(tooYoung).length === 0, JSON.stringify(tooYoung));
  const taken = await reapStrays({ minAgeMinutes: 10, pids: [one] });
  await settle(1200);
  check("an orphaned filter past the age floor is stopped", !alive(one), JSON.stringify(taken));
  check("the sweep reports what it stopped", Object.values(taken).reduce((a, b) => a + b, 0) === 1, JSON.stringify(taken));
}

// ---- the worktree match must not spill into a sibling ----
// claude-6 is a prefix of claude-69: a plain substring match stops the wrong member's processes
const six = path.join(tmp, "wt", "claude-6");
const sixtyNine = path.join(tmp, "wt", "claude-69");
fs.mkdirSync(sixtyNine, { recursive: true });
fs.mkdirSync(six, { recursive: true });
const other = spawn(BASH, ["-c", `cd "${sixtyNine}" && sleep 300`], { windowsHide: true, stdio: "ignore" });
await settle(1500);
check("the sibling's process is running", alive(other.pid), String(other.pid));

const hitBySix = await stopProcessesUnder(six);
await settle(1200);
check("stopping claude-6 leaves claude-69 alone", alive(other.pid) && !hitBySix.includes(other.pid), JSON.stringify(hitBySix));

const hitByName = await stopProcessesUnder(sixtyNine);
await settle(1500);
check("stopping claude-69 does stop its own process", !alive(other.pid) && hitByName.includes(other.pid), JSON.stringify(hitByName));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a handle may still be closing */
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall cleanup checks passed");
process.exitCode = failed ? 1 : 0;
