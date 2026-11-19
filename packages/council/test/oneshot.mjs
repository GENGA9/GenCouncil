// The advisor consult and the read-only explorer, for every provider. No LLM: fake claude/codex/agy
// shims on PATH record their arguments and print one canned answer, so this checks the wiring —
// which CLI runs, with which read-only flags, and whose model — not the answer's content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignmentRules, consultPrompt, explorePrompt, explorerModel, memberHelpers, oneShot, providerOfModel, strongestWithin } from "@gencouncil/council";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

// ---- the rules that decide where a one-shot call lands ----

check("a claude model id maps to claude", providerOfModel("opus") === "claude" && providerOfModel("claude-fable-5-2") === "claude");
check("gpt and gemini ids map to their own provider", providerOfModel("gpt-6.1-terra") === "gpt" && providerOfModel("gemini-4-hydrogen") === "gemini");
check("an unknown id maps to nothing", providerOfModel("gpt-9-nope") === undefined);

check("the explorer runs on the cheapest rung", explorerModel("claude") === "haiku" && explorerModel("gpt") === "gpt-6-luna" && explorerModel("gemini") === "gemini-3.8-flash");
check("a consult takes the strongest rung the limit allows", strongestWithin("claude", "opus") === "opus" && strongestWithin("gpt", "gpt-6.1-sol") === "gpt-6.2-sol" && strongestWithin("gpt", "gpt-6.2-sol") === "gpt-6.2-sol");
check("no limit means the top of the ladder", strongestWithin("claude", undefined) === "fable" && strongestWithin("gpt", undefined) === "gpt-6.2-astra");
check("a full model id as the limit still resolves", strongestWithin("claude", "claude-opus-5-5") === "opus", strongestWithin("claude", "claude-opus-5-5"));

// ---- who gets the tools: claude keeps its native --advisor/--agents ----

const project = { members: {} };
check("a gpt member gets both tools", memberHelpers({ provider: "gpt" }, project).join(",") === "consult,explore");
check("a gemini member gets both tools", memberHelpers({ provider: "gemini" }, project).join(",") === "consult,explore");
check("a claude member with an advisor gets neither", memberHelpers({ provider: "claude", advisor: "opus" }, project).length === 0);
// a Fable main cannot take --advisor, so the tool is the only way it gets a second opinion
check("a claude member without an advisor gets consult only", memberHelpers({ provider: "claude" }, project).join(",") === "consult");
check("explorers off removes explore", memberHelpers({ provider: "gpt" }, { members: { explorers: false } }).join(",") === "consult");

// ---- the prompts ----

const cp = consultPrompt({ question: "이 계획으로 가도 되나", context: "계획: A를 B로 바꾼다", asker: "위원 gpt-1" });
check("the consult names the asker and carries the context", cp.includes("위원 gpt-1") && cp.includes("계획: A를 B로 바꾼다"));
check("the consult forbids editing", /코드를 고치지 말고/.test(cp));
const ep = explorePrompt("grep", "resolveAdvisor");
check("the explorer is told it is read-only and what to find", /읽기 전용/.test(ep) && ep.includes("resolveAdvisor") && ep.includes("경로:줄번호"));
check("explore kinds differ", explorePrompt("search", "x") !== explorePrompt("docs", "x"));

const rules = assignmentRules({ limits: "|표|", topModelFloor: { claude: 30, gpt: 50 } });
check("the assignment rules carry the limits table and both tools", rules.includes("|표|") && rules.includes("council_consult") && rules.includes("council_explore"));
check("the rules give one effort table for all three providers", rules.includes("추론 수준(effort) 고르기") && rules.includes("mechanical") && rules.includes("complex") && rules.includes("Hydrogen·Neon만 xhigh") && rules.includes("max는 사용자가"));
check("no results table when there are no results", !rules.includes("지금까지 위원 실적"));
check("the results table follows the effort rules when given", assignmentRules({ limits: "|표|", effortStats: "지금까지 위원 실적\n|줄|" }).includes("지금까지 위원 실적\n|줄|"));
check("the rules still teach the ladder", rules.includes("위원 고르기") && rules.includes("gpt-6.1-terra") && rules.includes("30% 미만"));

// ---- the real thing: fake CLIs on PATH ----

if (process.platform !== "win32") {
  console.log(`\nskip: the CLI half of this test uses .cmd fakes (Windows only)`);
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall one-shot checks passed");
  process.exitCode = failed ? 1 : 0;
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-oneshot-"));
  const bin = path.join(tmp, "bin");
  const rec = path.join(tmp, "rec");
  fs.mkdirSync(bin);
  fs.mkdirSync(rec);
  const cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd);

  fs.writeFileSync(
    path.join(bin, "claude.cmd"),
    [
      "@echo off",
      'echo %* > "%GC_REC%\\claude-args.txt"',
      'echo {"type":"system","subtype":"init","session_id":"s-1","model":"claude-haiku-5-5"}',
      'echo {"type":"result","subtype":"success","result":"claude says: packages/council/src/models.ts:155","is_error":false}',
      "",
    ].join("\r\n"),
  );
  fs.writeFileSync(
    path.join(bin, "codex.cmd"),
    [
      "@echo off",
      'echo %* > "%GC_REC%\\codex-args.txt"',
      'echo {"type":"thread.started","thread_id":"t-1"}',
      'echo {"type":"item.completed","item":{"type":"agent_message","text":"codex says: go with B"}}',
      'echo {"type":"turn.completed"}',
      "",
    ].join("\r\n"),
  );
  fs.writeFileSync(
    path.join(bin, "agy.cmd"),
    [
      "@echo off",
      'echo %* > "%GC_REC%\\agy-args.txt"',
      'echo {"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-low"}}',
      'echo {"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"gemini says: see wiki.ts"}}',
      "",
    ].join("\r\n"),
  );
  fs.writeFileSync(path.join(bin, "boom.cmd"), ["@echo off", "echo kaboom 1>&2", "exit /b 3", ""].join("\r\n"));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.GC_REC = rec;

  // every argument reaches a batch file quoted; the checks below read them as plain words
  const args = (who) => fs.readFileSync(path.join(rec, `${who}-args.txt`), "utf8").replace(/"/g, "");

  // consult: no tools at all, so it cannot touch the worktree
  const c = await oneShot({ provider: "claude", model: "opus", effort: "high", cwd, prompt: "질문", tools: "none" });
  check("claude consult returns the result line", c.text.startsWith("claude says:") && !c.error, JSON.stringify(c));
  check("claude consult runs with no tools", args("claude").includes("--tools") && !args("claude").includes("--allowedTools"), args("claude"));
  check("claude consult passes model and effort", args("claude").includes("--model claude-opus") || args("claude").includes("--model opus"), args("claude"));
  check("consult timing is reported", typeof c.seconds === "number" && c.seconds >= 0);

  // explore: read tools only, never an editing one
  const e = await oneShot({ provider: "claude", model: "haiku", effort: "low", cwd, prompt: "찾기", tools: "read" });
  const ea = args("claude");
  check("claude explore gets the read tools", ea.includes("--allowedTools") && ea.includes("Read") && ea.includes("Grep"), ea);
  check("claude explore cannot edit or run commands", ea.includes("--disallowedTools") && ea.includes("Edit") && ea.includes("Bash"), ea);
  check("claude explore returns what it found", e.text.includes("models.ts:155"), JSON.stringify(e));

  const g = await oneShot({ provider: "gpt", model: "gpt-6-astra", effort: "high", cwd, prompt: "질문", tools: "none" });
  check("codex answers from its last message", g.text === "codex says: go with B" && !g.error, JSON.stringify(g));
  check("codex is sandboxed read-only", args("codex").includes("sandbox_mode='read-only'") && args("codex").includes("approval_policy='never'"), args("codex"));
  check("codex gets the model and the effort", args("codex").includes("-m gpt-6-astra") && args("codex").includes("model_reasoning_effort='high'"), args("codex"));

  const m = await oneShot({ provider: "gemini", model: "gemini-3.8-flash", effort: "low", cwd, prompt: "찾기", tools: "read" });
  check("agy answers from its result event", m.text === "gemini says: see wiki.ts" && !m.error, JSON.stringify(m));
  check("agy gets the effort-suffixed model and the folder", args("agy").includes("--model gemini-3.8-flash-low") && args("agy").includes("--add-dir"), args("agy"));

  // a failed consult must come back as a value: it cannot be allowed to kill the caller's turn.
  // PATH is emptied for this one so the real CLI is never reached (that would be a billed call).
  const realPath = process.env.PATH;
  process.env.PATH = path.join(tmp, "nothing-here");
  const gone = await oneShot({ provider: "claude", cwd, prompt: "x", tools: "none" });
  process.env.PATH = realPath;
  check("a missing CLI is an error string, not a throw", Boolean(gone.error) && gone.text === "" && /claude/.test(gone.error), JSON.stringify(gone));

  // a CLI that exits non-zero without answering is an error too, not an empty success
  fs.writeFileSync(path.join(bin, "codex.cmd"), ["@echo off", "echo kaboom 1>&2", "exit /b 3", ""].join("\r\n"));
  const broke = await oneShot({ provider: "gpt", cwd, prompt: "x", tools: "none" });
  check("a CLI that answers nothing is an error", Boolean(broke.error) && broke.text === "" && broke.error.includes("kaboom"), JSON.stringify(broke));

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall one-shot checks passed");
  process.exitCode = failed ? 1 : 0;
}
