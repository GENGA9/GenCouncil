// Claude verification after Gemini Flash code work, without any LLM (fake drivers).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaStore, Council, ProjectRegistry, drivers, memberEventText } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-verify-"));
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
