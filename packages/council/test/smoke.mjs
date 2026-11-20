// Council smoke test without any LLM: registry, agenda, worktrees, packet, merge/conflict.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaStore, Council, ProjectRegistry, buildPacket, ensureWorktree, git, parseResult } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-council-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");

// these checks run Gemini members as a user who switched Gemini (Antigravity CLI) on would
(await import("@gencouncil/council")).setGeminiEnabled(true, true);
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

const registry = new ProjectRegistry();
const project = registry.add({ name: "테스트", repo, baseBranch: "main" });
check("project id slug + suffix", project.id === "테스트-제작위원회" && project.name === "테스트 제작위원회", project.id);
check("guidelines template written", fs.existsSync(registry.guidelinesPath(project)));
const store = AgendaStore.create(project, "첫 안건", ["a.txt 를 고친다", "b.txt 를 만든다"]);
check("agenda branch name", store.agenda().branch === "agenda/첫-안건", store.agenda().branch);

const memory = new MemoryStore({ git: false });
await memory.init();
const council = new Council(store, memory);
await council.open();
check("integration worktree exists", fs.existsSync(path.join(store.integrationWorktree(), "a.txt")));
check("exclude written", fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").includes(".worktrees/"));
await council.open();
check("open is idempotent", true);

const t1 = council.addTask({ title: "a.txt 수정", description: "one -> two", goal: 1 });
const t2 = council.addTask({ title: "b.txt 생성", goal: 2 });
check("task ids", t1.id === "T1" && t2.id === "T2");

// packet round trip
const member = { id: "claude-1", provider: "claude", taskId: t1.id, branch: store.memberBranch("claude-1"), worktree: store.memberWorktree("claude-1"), status: "starting", startedAt: "", toolCalls: 0 };
const packet = buildPacket({ project, agenda: store.agenda(), task: t1, member, instructions: "one 을 two 로 바꿔라", memoryIndex: memory.renderIndex() });
check("packet has instructions + rules", packet.includes("one 을 two 로") && packet.includes("RESULT.md"));
const parsed = parseResult(`## 결과\n바꿨다\n\n## 변경 파일\n- a.txt\n\n## 미완료·막힌 점\n없음\n\n## 기억 제안\n### a.txt 는 LF 로 끝나야 한다\ntype: convention\ntags: git, eol\n본문입니다 충분히 길게\n`);
check("result parsed", parsed.summary === "바꿨다" && parsed.unfinished === "없음" && parsed.proposals.length === 1 && parsed.proposals[0].type === "convention" && parsed.proposals[0].tags.join() === "git,eol");

// simulate two members by hand (no LLM): one clean, one conflicting
const simulate = async (id, file, content, msg) => {
  const wt = store.memberWorktree(id);
  await ensureWorktree(repo, wt, store.memberBranch(id), store.agenda().branch);
  fs.writeFileSync(path.join(wt, file), content);
  fs.mkdirSync(path.join(wt, ".council"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".council", "RESULT.md"), `## 결과\n${msg}\n`);
  fs.writeFileSync(path.join(wt, ".council", "STATE.md"), `한 일: ${msg}\n`);
  fs.writeFileSync(path.join(wt, ".council", "mcp.json"), "{}");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", msg]);
  return wt;
};
await simulate("claude-1", "a.txt", "two\n", "a: two");
await simulate("gemini-1", "a.txt", "three\n", "a: three");
const shot = path.join(store.memberWorktree("claude-1"), ".council", "shots", "s.png");
fs.mkdirSync(path.dirname(shot), { recursive: true });
fs.writeFileSync(shot, "png");
// register them as finished members so merge() can find them
const members = [
  { ...member, status: "done", commits: ["x"], toolCalls: 0, shots: [shot] },
  { ...member, id: "gemini-1", provider: "gemini", taskId: t2.id, branch: store.memberBranch("gemini-1"), worktree: store.memberWorktree("gemini-1"), status: "done", toolCalls: 0 },
];
store.saveMembers(members);
const council2 = new Council(store, memory);
await council2.open();
const m1 = await council2.merge("claude-1");
check("clean merge ok", m1.ok, m1.output);
check("task done after merge", council2.store.tasks().find((t) => t.id === t1.id).status === "done");
const merged = fs.readFileSync(path.join(store.integrationWorktree(), "a.txt"), "utf8");
check("integration has merged content", merged.replace(/\r/g, "") === "two\n", JSON.stringify(merged));
const m2 = await council2.merge("gemini-1");
check("conflict detected", !m2.ok && m2.conflicts.includes("a.txt"), JSON.stringify(m2.conflicts));
check("merge aborted cleanly", (await git(store.integrationWorktree(), ["status", "--porcelain"])).trim() === "");
check("task blocked after conflict", council2.store.tasks().find((t) => t.id === t2.id).status === "blocked");

// a merged member's folder is kept for reuse (the merge runs a prune in the background)
await new Promise((r) => setTimeout(r, 500));
await council2.pruneMergedWorktrees();
check("merged folder kept for reuse", fs.existsSync(store.memberWorktree("claude-1")));
check("unmerged member folder kept", fs.existsSync(store.memberWorktree("gemini-1")));

// the next member takes that folder over instead of a fresh checkout
const t3 = council2.addTask({ title: "d.txt", goal: 1 });
const r1 = await council2.assign({ taskId: t3.id, provider: "relay", instructions: "d.txt 를 만들어라. 충분히 긴 지시문." });
const c1 = council2.members().find((m) => m.id === "claude-1");
check("new member reuses the merged folder", !fs.existsSync(store.memberWorktree("claude-1")) && fs.existsSync(r1.worktree) && !!c1.worktreeReleased);
check("reused folder is on the new member's branch", (await git(r1.worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() === r1.branch);
check("reused folder starts from the agenda branch", fs.readFileSync(path.join(r1.worktree, "a.txt"), "utf8").replace(/\r/g, "") === "two\n");
check("reused folder has only the new task notes", fs.existsSync(path.join(r1.worktree, ".council", "TASK.md")) && !fs.existsSync(path.join(r1.worktree, ".council", "STATE.md")));
check("merged member branch kept", (await git(repo, ["branch", "--list", store.memberBranch("claude-1")])).trim() !== "");
check("notes archived on reuse", fs.existsSync(path.join(store.dir, "archive", "claude-1", "RESULT.md")));
check("shots archived and repointed", c1.shots?.[0] && fs.existsSync(c1.shots[0]) && c1.shots[0].includes(path.join("archive", "claude-1", "shots")), JSON.stringify(c1.shots));
check("released member cannot be handed over", await council2.handover("claude-1").then(() => false, (e) => /합쳐져/.test(e.message)));
const info1 = await council2.memberInfo("claude-1");
check("released member's STATE.md read from archive", info1.stateMd === "한 일: a: two\n", JSON.stringify(info1.stateMd));

// a merged folder with uncommitted work stays; a clean one beyond the kept count is removed
await simulate("claude-2", "c.txt", "c\n", "c");
fs.writeFileSync(path.join(store.memberWorktree("claude-2"), "left.txt"), "not committed");
await simulate("claude-3", "e.txt", "e\n", "e");
for (const id of ["claude-2", "claude-3"]) council2.members().push({ ...member, id, branch: store.memberBranch(id), worktree: store.memberWorktree(id), status: "done", toolCalls: 0 });
council2.persistMembers();
check("more merges ok", (await council2.merge("claude-2")).ok && (await council2.merge("claude-3")).ok);
await new Promise((r) => setTimeout(r, 500));
await council2.pruneMergedWorktrees(0);
check("merged folder with uncommitted files kept", fs.existsSync(path.join(store.memberWorktree("claude-2"), "left.txt")));
check("free folder beyond the kept count removed", !fs.existsSync(store.memberWorktree("claude-3")) && !!council2.members().find((m) => m.id === "claude-3").worktreeReleased);
check("removed folder's notes archived", fs.existsSync(path.join(store.dir, "archive", "claude-3", "RESULT.md")));
council2.stopMember(r1.id);

// finish: base checkout must be clean & on main
const out = await council2.finish();
const mainContent = fs.readFileSync(path.join(repo, "a.txt"), "utf8");
check("finish merged into main", mainContent.replace(/\r/g, "") === "two\n", JSON.stringify(mainContent) + " " + out);
check("worktrees removed", !fs.existsSync(store.worktreeRoot()));
const arch = path.join(store.dir, "archive", "claude-1");
check("council notes archived before removal", fs.existsSync(path.join(arch, "RESULT.md")) && fs.existsSync(path.join(arch, "STATE.md")) && !fs.existsSync(path.join(arch, "mcp.json")));
check("both member worktrees archived", fs.existsSync(path.join(store.dir, "archive", "gemini-1", "RESULT.md")));
const info = await council2.memberInfo("claude-1");
check("memberInfo reads STATE.md from archive", info.stateMd === "한 일: a: two\n", JSON.stringify(info.stateMd));
check("agenda closed", store.agenda().status === "closed");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall council checks passed");
process.exitCode = failed ? 1 : 0;
