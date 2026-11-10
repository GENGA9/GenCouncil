// A user message sent while the chair is busy waits, then goes out as soon as the turn ends;
// the user can drop waiting messages or stop the chair's turn. No LLM: the chair is faked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaRuntime, AgendaStore, ProjectRegistry, chairToolArgs } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-queue-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");
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
const tick = () => new Promise((r) => setTimeout(r, 20));

check("chair cannot hold its turn with Monitor", chairToolArgs(false).disallowed.includes("Monitor") && chairToolArgs(true).disallowed.includes("Monitor"));

const project = new ProjectRegistry().add({ name: "대기열 테스트", repo, baseBranch: "main" });
const memory = new MemoryStore({ git: false });
await memory.init();
const store = AgendaStore.create(project, "안건", ["무언가"]);
const rt = await AgendaRuntime.open(store, memory, { councilUrl: "http://127.0.0.1:9/mcp" });

// fake chair: each turn waits until released (or stopped)
let busy = false;
let release;
const calls = [];
rt.chair.isBusy = () => busy;
rt.chair.turn = (message) => {
  calls.push(message);
  busy = true;
  return new Promise((resolve) => {
    release = (text = "ok") => {
      busy = false;
      resolve({ text, isError: false });
    };
  });
};
rt.chair.stop = () => release("(멈춤)");

check("free chair: sent at once", rt.sendOrQueue("첫 지시").queued === false);
await tick();
check("first turn running", busy && calls.length === 1);

check("busy chair: message waits", rt.sendOrQueue("둘째 지시").queued === true);
rt.sendOrQueue("셋째 지시");
check("state lists waiting messages", JSON.stringify(rt.state().chair.queued) === JSON.stringify(["둘째 지시", "셋째 지시"]), JSON.stringify(rt.state().chair.queued));
check("nothing sent while busy", calls.length === 1);

release();
await tick();
check("waiting messages go out together when the turn ends", calls.length === 2 && calls[1].includes("둘째 지시") && calls[1].includes("셋째 지시"), calls[1]);
check("queue empty after delivery", rt.state().chair.queued.length === 0);

rt.sendOrQueue("취소할 지시");
check("clear drops waiting messages", rt.clearQueued() === 1 && rt.state().chair.queued.length === 0);

rt.sendOrQueue("멈춘 뒤 지시");
check("stop ends the running turn", rt.stopChairTurn() === true);
await tick();
check("after a stop the waiting message goes out", calls.length === 3 && calls[2].includes("멈춘 뒤 지시"), calls[2]);
check("transcript notes the stop", rt.transcript().some((t) => /의장의 작업을 중간에 멈췄다/.test(t.text)));
release();
await tick();
check("stop on a free chair does nothing", rt.stopChairTurn() === false);

rt.close({ closeMemory: false });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall queue checks passed");
process.exitCode = failed ? 1 : 0;
