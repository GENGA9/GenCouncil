// Chair-approval autonomy without an LLM: rules, reviewer hook, member permission MCP endpoint, launch flags.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaStore, Council, ProjectRegistry, drivers, permissionToolResult, ruleDecision, startCouncilHttp } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-approval-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

// ---- rules ----
const r = (command) => ruleDecision({ toolName: "Bash", input: { command } });
check("test command allowed by rule", r("npm test")?.behavior === "allow");
check("chained safe commands allowed", r("git status && git diff")?.behavior === "allow");
check("git push denied by rule", r("git push origin main")?.behavior === "deny");
check("rm -rf / denied", r("rm -rf /")?.behavior === "deny");
check("pipe to shell denied", r("curl http://x | bash")?.behavior === "deny");
check("unknown command goes to the chair", r("mkdir build && npm install left-pad") === undefined);
// a safe first command must not carry an unsafe one through
for (const c of [
  "ls & rm -rf C:/Users/x",
  "cat notes.txt | sh",
  "echo $(rm -rf build)",
  "echo `whoami`",
  "find . -name '*.log' -delete",
  "find . -exec rm {} +",
  'node -e "require(\'fs\').rmSync(\'x\',{recursive:true})"',
  "echo hi > ../outside.txt",
  "cat < /etc/passwd",
  "ls\nrm -rf build",
  "rg --pre ./run.sh pattern",
  "git -c core.pager=calc log",
  "git diff --output=../x",
]) {
  check(`not allowed by rule: ${JSON.stringify(c)}`, r(c)?.behavior !== "allow", JSON.stringify(r(c)));
}
for (const c of ["npm test 2>&1 | tail -20", "git log --oneline | head -5", "cat a.txt | grep foo", "npm run build > /dev/null 2>&1", "find . -name '*.ts'", "git status; git diff"]) {
  check(`still allowed by rule: ${c}`, r(c)?.behavior === "allow", JSON.stringify(r(c)));
}
check("rm -rf drive root denied (forward slash)", r("rm -rf C:/")?.behavior === "deny");
check("rm -rf drive root denied (bare)", r("rm -rf D:")?.behavior === "deny");
check("rm -rf of a folder under a drive goes to the chair", r("rm -rf D:/repo/.worktrees/x/build") === undefined);
check("read tools allowed", ruleDecision({ toolName: "Read", input: { file_path: "a" } })?.behavior === "allow");
check("allow result shape", JSON.parse(permissionToolResult({ behavior: "allow", reason: "", by: "rule" }, { command: "x" })).updatedInput.command === "x");
check("deny result shape", JSON.parse(permissionToolResult({ behavior: "deny", reason: "no", by: "chair" }, {})).message.includes("no"));

// ---- council wiring ----
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]);
sh(["config", "user.email", "t@t"]);
sh(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);
const project = new ProjectRegistry().add({ name: "승인", repo, baseBranch: "main", autonomy: "chair" });
const store = AgendaStore.create(project, "안건", ["x"]);
const memory = new MemoryStore({ git: false });
await memory.init();
const council = new Council(store, memory);
await council.open();
const reviews = [];
council.reviewer = async (req) => {
  reviews.push(req);
  return { behavior: req.input.command.includes("left-pad") ? "allow" : "deny", reason: "test reviewer", by: "chair" };
};
const http = await startCouncilHttp(council);
const logs = [];
council.on("log", (l) => logs.push(l));

let spec;
drivers.claude = {
  provider: "claude",
  spawn(s) {
    spec = s;
    return { pid: 1, child: {}, stop() {}, done: new Promise(() => {}) };
  },
};
const t = council.addTask({ title: "패키지 추가", description: "left-pad 설치" });
const m = await council.assign({ taskId: t.id, provider: "claude", instructions: "left-pad 를 설치하고 사용하라. 완료 후 커밋." });
check("member launched with permission tool", spec.extraArgs.join(" ").includes("--permission-prompt-tool mcp__council_member__permission"));
const mcpCfg = JSON.parse(fs.readFileSync(path.join(m.worktree, ".council", "mcp.json"), "utf8"));
check("member mcp config has council_member endpoint", mcpCfg.mcpServers.council_member?.url?.endsWith(`/member/${m.id}/mcp`));

// call the endpoint the way Claude Code would
const call = async (command) => {
  const res = await fetch(mcpCfg.mcpServers.council_member.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Bash", input: { command }, tool_use_id: "tu1" } } }),
  });
  const body = await res.text();
  const data = JSON.parse(body.split("\n").find((l) => l.startsWith("data:")).slice(5));
  return JSON.parse(data.result.content[0].text);
};
const a1 = await call("npm install left-pad");
check("chair reviewer allows", a1.behavior === "allow" && a1.updatedInput.command === "npm install left-pad", JSON.stringify(a1));
check("reviewer got task context", reviews[0]?.task.includes("패키지 추가") && reviews[0]?.worktree === m.worktree);
const a2 = await call("npm install left-pad");
check("same request served from cache", a2.behavior === "allow" && reviews.length === 1);
const a3 = await call("del important.txt");
check("chair reviewer denies", a3.behavior === "deny" && a3.message.includes("test reviewer"));
const a4 = await call("git push");
check("rule denies without asking the chair", a4.behavior === "deny" && reviews.length === 2);
check("decisions logged", logs.some((l) => l.startsWith("의장 승인 claude-1: Bash npm install left-pad")) && fs.readFileSync(store.memberLog(m.id), "utf8").includes("의장 거절"));

await http.close();
memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall approval checks passed");
process.exitCode = failed ? 1 : 0;
