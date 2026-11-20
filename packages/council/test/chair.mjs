// Chair logging test without an LLM: a fake `claude` on PATH prints stream-json and stderr,
// and the chair must write both to chair/chair.log. Windows only (fake is a .cmd shim).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaStore, Chair, Council, ProjectRegistry, chairToolArgs } from "@gencouncil/council";

if (process.platform !== "win32") {
  console.log("skip: chair log test uses a .cmd fake (Windows only)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-chair-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");

// these checks run Gemini members as a user who switched Gemini (Antigravity CLI) on would
(await import("@gencouncil/council")).setGeminiEnabled(true, true);
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "claude.cmd"),
  [
    "@echo off",
    'echo {"type":"system","subtype":"init","session_id":"s-1","model":"claude-sonnet-5-5"}',
    "echo fake-warning-on-stderr 1>&2",
    "if defined GC_FAKE_EDIT echo edited by chair> chair-edit.txt",
    'if defined GC_REC echo ets=%ENABLE_TOOL_SEARCH% > "%GC_REC%\\claude-env.txt"',
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
check("header with account/model/advisor", /chair turn provider=claude account=claude model=opus .*advisor=off resume=new/.test(log), log.split("\n")[0]);
check("prompt recorded on one line", log.includes("[prompt] 첫 지시 ⏎ 두 번째 줄"));
check("stdout stream-json recorded", log.includes('[stdout] {"type":"result"'));
check("stderr recorded", log.includes("[stderr] fake-warning-on-stderr"));
check("exit recorded", log.includes("=== exit code=0"));

await chair.turn("다음 턴", () => {});
const log2 = fs.readFileSync(chair.logFile(), "utf8");
check("second turn appended with resume", (log2.match(/=== .* chair turn/g) ?? []).length === 2 && log2.includes("resume=s-1"));

// ---- tool permissions ----
const off = chairToolArgs(false);
const on = chairToolArgs(true);
check("read-only commands and web always allowed", off.allowed.includes("WebSearch") && off.allowed.includes("Bash(git diff:*)") && off.allowed.includes("Bash(npx vitest:*)") && !off.disallowed.includes("Bash"));
check("edits denied unless enabled", off.disallowed.includes("Edit") && !off.allowed.some((t) => t.startsWith("Edit")));
check("edits scoped to the integration worktree when enabled", on.allowed.includes("Edit(./**)") && on.allowed.includes("Bash(git merge:*)") && !on.disallowed.includes("Edit"));
check("no shell beyond the allow list", !on.allowed.includes("Bash") && on.disallowed.includes("Task"));

// ---- direct edit: the chair writes a file, the server commits it after the turn ----
const integ = store.integrationWorktree();
const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: integ, encoding: "utf8" }).trim();
process.env.GC_FAKE_EDIT = "1";
await chair.turn("편집 없음 프로젝트", () => {});
check("edit not committed when direct edit is off", execFileSync("git", ["rev-parse", "HEAD"], { cwd: integ, encoding: "utf8" }).trim() === before);
fs.rmSync(path.join(integ, "chair-edit.txt"), { force: true });
council.project.chair.directEdit = true;
const r3 = await chair.turn("README 오타 수정", () => {});
const head = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: integ, encoding: "utf8" }).trim();
check("chair edit committed on the agenda branch", head === "chair: README 오타 수정" && execFileSync("git", ["show", "HEAD:chair-edit.txt"], { cwd: integ, encoding: "utf8" }).includes("edited by chair"), head);
check("turn reply mentions the commit", /통합 브랜치에 커밋/.test(r3.text), r3.text);
check("worktree clean after commit", execFileSync("git", ["status", "--porcelain"], { cwd: integ, encoding: "utf8" }).trim() === "");
delete process.env.GC_FAKE_EDIT;
council.project.chair.directEdit = false;

// ---- GPT / Gemini chairs: fake codex and agy record their args and stdin ----
const rec = path.join(tmp, "rec");
fs.mkdirSync(rec);
process.env.GC_REC = rec;
fs.writeFileSync(
  path.join(bin, "codex.cmd"),
  [
    "@echo off",
    'echo %* > "%GC_REC%\\codex-args.txt"',
    'findstr "^" > "%GC_REC%\\codex-stdin.txt"',
    'echo token=%GENCOUNCIL_COUNCIL_TOKEN% > "%GC_REC%\\codex-env.txt"',
    'echo {"type":"thread.started","thread_id":"t-9"}',
    'echo {"type":"item.completed","item":{"type":"agent_message","text":"gpt chair reply"}}',
    'echo {"type":"turn.completed"}',
    "",
  ].join("\r\n"),
);
fs.writeFileSync(
  path.join(bin, "agy.cmd"),
  [
    "@echo off",
    'echo %* > "%GC_REC%\\agy-args.txt"',
    'findstr "^" > "%GC_REC%\\agy-stdin.txt"',
    'echo url=%GENCOUNCIL_COUNCIL_URL% role=%GENCOUNCIL_ROLE% > "%GC_REC%\\agy-env.txt"',
    'if not defined GC_ARGON_SPENT goto run',
    'echo %* | findstr /c:"gemini-4-neon" >nul || goto run',
    "echo error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 59h36m39s. 1>&2",
    'echo {"event":"result","result":{"conversation_id":"c-8","status":"ERROR","response":"","error":"Individual quota reached. Resets in 59h36m39s."}}',
    "exit /b 1",
    ":run",
    'echo {"event":"init","conversation_id":"c-7","init":{"model":"gemini-4-argon-medium"}}',
    'echo {"event":"result","result":{"conversation_id":"c-7","status":"SUCCESS","response":"gemini chair reply"}}',
    "",
  ].join("\r\n"),
);
const chairTok = new Chair(council, { councilUrl: "http://127.0.0.1:1/mcp/p/a", councilHeaders: { Authorization: "Bearer tok-1" } });
const rt = await import("@gencouncil/council");
council.project.chair.account = "gpt";
check("chair provider follows the account", chairTok.provider() === "gpt");
check("claude model swapped for the provider default", chairTok.model() === "gpt-6.2-sol" && rt.chairModelFor("gpt", "gpt-6-astra") === "gpt-6-astra");
const g1 = await chairTok.turn("GPT 의장 첫 턴", () => {});
const cArgs = fs.readFileSync(path.join(rec, "codex-args.txt"), "utf8").replace(/"/g, ""); // arguments reach a batch file quoted
const cIn = fs.readFileSync(path.join(rec, "codex-stdin.txt"), "utf8");
check("gpt chair reply and thread id", !g1.isError && g1.text === "gpt chair reply" && g1.sessionId === "t-9", JSON.stringify(g1));
check("codex runs read-only with council + memory MCP", /exec --json/.test(cArgs) && cArgs.includes("sandbox_mode='read-only'") && cArgs.includes("mcp_servers.council.url") && cArgs.includes("mcp_servers.gencouncil.command") && cArgs.includes("-m gpt-6.2-sol"), cArgs);
check("council token reaches codex through env", fs.readFileSync(path.join(rec, "codex-env.txt"), "utf8").includes("token=tok-1"));
check("first gpt turn carries the full chair prompt", cIn.includes("<의장_지침>") && cIn.includes("GPT 의장 첫 턴"));
await chairTok.turn("GPT 의장 둘째 턴", () => {});
const cArgs2 = fs.readFileSync(path.join(rec, "codex-args.txt"), "utf8").replace(/"/g, ""); // arguments reach a batch file quoted
const cIn2 = fs.readFileSync(path.join(rec, "codex-stdin.txt"), "utf8");
check("next gpt turn resumes the thread with a short refresh", /exec resume .* t-9 -/.test(cArgs2) && cIn2.includes("<의장_지침_갱신>") && !cIn2.includes("<의장_지침>"), cArgs2);
// codex has no system-prompt flag, so the rules that decide whether it hands work out go again every turn
check(
  "the refresh repeats the assignment rules",
  cIn2.includes("위원 고르기") && cIn2.includes("council_explore") && cIn2.includes("council_consult"),
  cIn2.slice(0, 200),
);

// agy reads MCP only from its global config: keep the test away from the real home
const fakeHome = path.join(tmp, "userhome");
fs.mkdirSync(fakeHome);
const realProfile = process.env.USERPROFILE;
process.env.USERPROFILE = fakeHome;
council.project.chair.account = "gemini";
const m1 = await chairTok.turn("제미나이 의장 첫 턴", () => {});
process.env.USERPROFILE = realProfile;
const aArgs = fs.readFileSync(path.join(rec, "agy-args.txt"), "utf8").replace(/"/g, ""); // arguments reach a batch file quoted
const aIn = fs.readFileSync(path.join(rec, "agy-stdin.txt"), "utf8");
check("gemini chair reply and conversation id", !m1.isError && m1.text === "gemini chair reply" && m1.sessionId === "c-7", JSON.stringify(m1));
check("gpt session not resumed by gemini", !aArgs.includes("--conversation"), aArgs);
check("agy gets the prompt as stream-json on stdin", aIn.startsWith('{"event":"user","message":{"content":"<의장_지침>'), aIn.slice(0, 80));
check("agy model carries the effort suffix", aArgs.includes("--model gemini-4-neon-"), aArgs);
check("agy env points the bridge at this agenda", fs.readFileSync(path.join(rec, "agy-env.txt"), "utf8").includes("url=http://127.0.0.1:1/mcp/p/a role=member"));
const agyMcp = JSON.parse(fs.readFileSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json"), "utf8"));
const agySet = JSON.parse(fs.readFileSync(path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
check("council bridge and memory registered for agy", agyMcp.mcpServers.gencouncil_council?.args?.[0]?.endsWith("bridge.js") && agyMcp.mcpServers.gencouncil?.args?.[0]?.endsWith("server.js"));
check("their tools allowed without prompts", agySet.permissions.allow.includes("mcp(gencouncil_council/*)") && agySet.permissions.allow.includes("mcp(gencouncil/*)"));
// Antigravity spends each model on its own: a spent Neon (the default) leaves Hydrogen on the same login
process.env.GC_ARGON_SPENT = "1";
process.env.USERPROFILE = fakeHome;
const shown = [];
const m2 = await chairTok.turn("아르곤 한도 소진", (e) => e.kind === "text" && shown.push(e.text));
process.env.USERPROFILE = realProfile;
delete process.env.GC_ARGON_SPENT;
const aArgs2 = fs.readFileSync(path.join(rec, "agy-args.txt"), "utf8").replace(/"/g, ""); // arguments reach a batch file quoted
check("neon quota: same gemini login retried with hydrogen", !m2.isError && aArgs2.includes("--model gemini-4-hydrogen") && council.accounts.get("gemini").status === "ok", JSON.stringify([m2, aArgs2]));
check("the user is told about the step down", shown.some((t) => /gemini-4-neon 한도 소진 → gemini-4-hydrogen/.test(t)), JSON.stringify(shown));
check("chair model now reports hydrogen", chairTok.model() === "gemini-4-hydrogen");
council.accounts.markOk("gemini");
council.project.chair.account = "claude";
await chairTok.turn("클로드 의장", () => {});
check("claude chair loads its tools up front (no ToolSearch)", fs.readFileSync(path.join(rec, "claude-env.txt"), "utf8").includes("ets=false"));

// ---- the chair belongs to the agenda: a second agenda of the same project keeps its own ----
{
  const store2 = AgendaStore.create(project, "다른 안건", ["y"]);
  const council2 = new Council(store2, memory);
  await council2.open();
  council.saveChairCfg({ account: "gpt", model: "gpt-5.5-codex" });
  check("agenda 1 runs on its own chair", council.chairCfg().account === "gpt" && council.chairCfg().model === "gpt-5.5-codex", JSON.stringify(council.chairCfg()));
  check("agenda 2 untouched, follows the project", council2.chairCfg().account === project.chair.account && council2.chairCfg().model === project.chair.model, JSON.stringify(council2.chairCfg()));
  check("the project default is unchanged", project.chair.account === "claude" && project.chair.model === "opus", JSON.stringify(project.chair));
  council2.saveChairCfg({ account: "gemini" });
  check("each agenda keeps its own account", council.chairCfg().account === "gpt" && council2.chairCfg().account === "gemini");
  council.saveChairCfg({ account: "claude", model: "opus" });
  council2.close?.();
}

memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall chair log checks passed");
process.exitCode = failed ? 1 : 0;
