// Chair logging test without an LLM: a fake `claude` on PATH prints stream-json and stderr,
// and the chair must write both to chair/chair.log. Windows only (fake is a .cmd shim).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaStore, Chair, Council, ProjectRegistry } from "@gencouncil/council";

if (process.platform !== "win32") {
  console.log("skip: chair log test uses a .cmd fake (Windows only)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-chair-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "claude.cmd"),
  [
    "@echo off",
    'echo {"type":"system","subtype":"init","session_id":"s-1","model":"claude-sonnet-5-5"}',
    "echo fake-warning-on-stderr 1>&2",
    'echo {"type":"result","subtype":"success","result":"done","is_error":false,"session_id":"s-1","total_cost_usd":0.01}',
    "",
  ].join("\r\n"),
);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
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

const project = new ProjectRegistry().add({ name: "로그 테스트", repo, baseBranch: "main" });
const store = AgendaStore.create(project, "안건", ["x"]);
const memory = new MemoryStore({ git: false });
await memory.init();
const council = new Council(store, memory);
await council.open();
const chair = new Chair(council, { councilUrl: "http://127.0.0.1:1/mcp" });

const res = await chair.turn("첫 지시\n두 번째 줄", () => {});
check("turn succeeded via fake claude", !res.isError && res.text === "done" && res.sessionId === "s-1", JSON.stringify(res));
const log = fs.readFileSync(chair.logFile(), "utf8");
check("header with account/model/advisor", /chair turn account=claude model=sonnet .*advisor=opus resume=new/.test(log), log.split("\n")[0]);
check("prompt recorded on one line", log.includes("[prompt] 첫 지시 ⏎ 두 번째 줄"));
check("stdout stream-json recorded", log.includes('[stdout] {"type":"result"'));
check("stderr recorded", log.includes("[stderr] fake-warning-on-stderr"));
check("exit recorded", log.includes("=== exit code=0"));

await chair.turn("다음 턴", () => {});
const log2 = fs.readFileSync(chair.logFile(), "utf8");
check("second turn appended with resume", (log2.match(/=== .* chair turn/g) ?? []).length === 2 && log2.includes("resume=s-1"));

memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall chair log checks passed");
process.exit(failed ? 1 : 0);
