// The chair ends an agenda with council_finish, without any LLM: the request is checked at once,
// the merge into the base branch runs after the chair's turn, a closed agenda stays closed when
// reopened, and a finish that fails after the turn is reported back to the chair.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaRuntime, AgendaStore, ProjectRegistry } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-finish-"));
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

const project = new ProjectRegistry().add({ name: "종료 테스트", repo, baseBranch: "main" });
const memory = new MemoryStore({ git: false });
await memory.init();
const chairOpts = { councilUrl: "http://127.0.0.1:9/mcp" };

// ---- 1. preflight: the main checkout must be on the base branch ----
const store = AgendaStore.create(project, "안건", ["b 추가"]);
const rt = await AgendaRuntime.open(store, memory, chairOpts);
const integ = store.integrationWorktree();
fs.writeFileSync(path.join(integ, "b.txt"), "two\n");
sh(["add", "-A"], integ);
sh(["commit", "-q", "-m", "add b"], integ);
sh(["checkout", "-q", "-b", "other"]);
const blocked = await rt.council.requestFinish("테스트");
check("refused when main checkout is on another branch", !blocked.scheduled && /브랜치/.test(blocked.problems.join(" ")), JSON.stringify(blocked));
check("nothing scheduled after a refusal", rt.council.finishRequest === undefined);
sh(["checkout", "-q", "main"]);

// ---- 2. the chair requests the finish during its turn; it runs after the turn ----
const events = [];
rt.on("event", (e) => events.push(e));
const chairCalls = [];
rt.chair.turn = async (message) => {
  chairCalls.push(message);
  const r = await rt.council.requestFinish("모든 목표 머지 완료");
  // the worktree must still be there while the chair is working
  return { text: r.scheduled && fs.existsSync(integ) ? "요약: b.txt 추가" : "실패", isError: false };
};
const res = await rt.send("다 됐으면 끝내자");
check("chair turn finished normally", res.text === "요약: b.txt 추가", res.text);
check("agenda merged into main", sh(["show", "main:b.txt"]).includes("two"));
check("agenda closed", store.agenda().status === "closed");
check("integration worktree removed", !fs.existsSync(integ));
check("finished event emitted", events.some((e) => e.type === "agenda:finished" && e.reason === "모든 목표 머지 완료"));
check("transcript notes the finish", rt.transcript().some((t) => /안건 종료: 모든 목표 머지 완료/.test(t.text)));

// ---- 3. reopening a closed agenda keeps it closed ----
const again = await AgendaRuntime.open(store, memory, chairOpts);
check("closed agenda reopens without recreating its worktree", !fs.existsSync(integ));
check("chat refused on a closed agenda", await again.send("하나 더").then(() => false, (e) => /종료/.test(e.message)));
again.close({ closeMemory: false });

// ---- 4. a finish that fails after the turn is reported to the chair ----
const store2 = AgendaStore.create(project, "두번째", ["c 추가"]);
const rt2 = await AgendaRuntime.open(store2, memory, chairOpts);
const calls2 = [];
rt2.chair.turn = async (message) => {
  calls2.push(message);
  if (calls2.length === 1) {
    await rt2.council.requestFinish("끝");
    fs.writeFileSync(path.join(repo, "a.txt"), "user edit\n"); // the user starts editing a tracked file in main meanwhile
  }
  return { text: "ok", isError: false };
};
await rt2.send("끝내");
await new Promise((r) => setTimeout(r, 200));
check("failed finish leaves the agenda open", store2.agenda().status === "open");
check("chair told why the finish failed", calls2.length === 2 && /안건 종료 실패/.test(calls2[1]) && /커밋하지 않은 변경/.test(calls2[1]), String(calls2[1]).slice(0, 160));
const listed = await rt2.council.finishProblems();
check("refusal lists the changed files", listed.some((p) => p.includes("a.txt")), listed.join(" | "));
sh(["checkout", "--", "a.txt"]);
// untracked files (like a .claude/ settings folder) do not block a merge
fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
fs.writeFileSync(path.join(repo, ".claude", "settings.local.json"), "{}\n");
const untrackedOnly = await rt2.council.finishProblems();
check("untracked files do not block finishing", untrackedOnly.length === 0, untrackedOnly.join(" | "));
rt2.close({ closeMemory: false });

// ---- 4b. cleanup never deletes through links, and a locked folder does not undo a finish ----
{
  const { spawn } = await import("node:child_process");
  const shared = path.join(tmp, "shared-node-modules");
  fs.mkdirSync(path.join(shared, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(shared, "pkg", "index.js"), "keep me\n");
  const s3 = AgendaStore.create(project, "링크와 잠금", ["x"]);
  const r3 = await AgendaRuntime.open(s3, memory, chairOpts);
  const integ3 = s3.integrationWorktree();
  fs.symlinkSync(shared, path.join(integ3, "node_modules"), "junction");
  fs.writeFileSync(path.join(integ3, "c.txt"), "c\n");
  sh(["add", "c.txt"], integ3);
  sh(["commit", "-q", "-m", "add c"], integ3);
  // a process sitting in a folder inside the worktree root keeps it locked on Windows
  const lockDir = path.join(s3.worktreeRoot(), "locked");
  fs.mkdirSync(lockDir, { recursive: true });
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: lockDir, stdio: "ignore", windowsHide: true });
  await new Promise((r) => setTimeout(r, 400));
  const out = await r3.council.finish();
  check("finish closes after the merge even with a locked folder", s3.agenda().status === "closed" && sh(["show", "main:c.txt"]).includes("c"));
  check("files behind a junction survive the cleanup", fs.readFileSync(path.join(shared, "pkg", "index.js"), "utf8") === "keep me\n");
  if (process.platform === "win32") {
    check("locked folder is reported and remembered", /지우지 못한 폴더/.test(out) && (s3.agenda().cleanupPending ?? []).length === 1, out.slice(-160));
    holder.kill();
    await new Promise((r) => setTimeout(r, 500));
    const still = await r3.council.retryPendingCleanup();
    check("pending cleanup succeeds once the lock is gone", still.length === 0 && !fs.existsSync(s3.worktreeRoot()) && !s3.agenda().cleanupPending);
  } else holder.kill();
  r3.close({ closeMemory: false });
}

// ---- 4c. the chair waiting for the user's decision ----
{
  const { trailingQuestion } = await import("@gencouncil/council");
  const s4 = AgendaStore.create(project, "결정 대기", ["x"]);
  const r4 = await AgendaRuntime.open(s4, memory, chairOpts);
  const evs = [];
  r4.on("event", (e) => evs.push(e));
  let reply = "";
  r4.chair.turn = async (msg) => {
    if (msg === "A냐 B냐") r4.council.askUser("세트 효과를 A안으로 할까요, B안으로 할까요?", ["A안", "B안"]);
    return { text: reply, isError: false };
  };
  reply = "두 안을 정리했습니다.";
  await r4.send("A냐 B냐");
  const w = s4.agenda().waitingForUser;
  check("ask marks the agenda as waiting with options", w?.question.includes("A안으로") && w.options?.join() === "A안,B안");
  check("ask event goes out (UI + Telegram)", evs.some((e) => e.type === "chair:ask" && e.options?.length === 2));
  check("runtime state carries the question", r4.state().agenda.waitingForUser?.options?.length === 2);
  await r4.send("[council event] 위원 끝남", "event");
  check("a council event does not clear it", Boolean(s4.agenda().waitingForUser));
  reply = "A안으로 진행합니다.";
  await r4.send("A안");
  check("the user's answer clears it", !s4.agenda().waitingForUser);
  reply = "작업을 나눴습니다.\n\n**로그인 화면도 같이 바꿀까요?**";
  await r4.send("진행해");
  check("a reply ending in a question still shows waiting", s4.agenda().waitingForUser?.question === "로그인 화면도 같이 바꿀까요?", JSON.stringify(s4.agenda().waitingForUser));
  check("plain statements are not questions", trailingQuestion("배정했습니다.\n위원 3명이 작업 중입니다.") === undefined && trailingQuestion("") === undefined);
  r4.close({ closeMemory: false });
}

// ---- 4d. the chair only proposes; the user ends the agenda ----
{
  const { userAskedToFinish } = await import("@gencouncil/council");
  check("finish phrases count", ["종료해", "안건 종료", "여기서 일단 종료하자", "중단하고 마무리해줘", "그냥 안건 종료", "이제 끝내자", "닫아줘"].every((t) => userAskedToFinish(t)));
  check("other messages do not", ["진행해", "라이브 올려주고 앱도 묶어줘 집에가서 볼게", "80도에 풀로드인데 괜찮을까?", "응", ""].every((t) => !userAskedToFinish(t)));
  check("negations do not", ["종료하지 마", "아직 종료 말고 더 고쳐줘", "끝내지 말고 계속해"].every((t) => !userAskedToFinish(t)));
  const s5 = AgendaStore.create(project, "제안만", ["x"]);
  const r5 = await AgendaRuntime.open(s5, memory, chairOpts);
  const i5 = s5.integrationWorktree();
  fs.writeFileSync(path.join(i5, "p.txt"), "p\n");
  sh(["add", "p.txt"], i5);
  sh(["commit", "-q", "-m", "add p"], i5);
  let res5;
  r5.chair.turn = async () => {
    res5 = await r5.council.requestFinish("목표 완료");
    return { text: "요약", isError: false };
  };
  await r5.send("라이브 올려주고 앱도 묶어줘 집에가서 볼게");
  check("work done but not asked: only a proposal", res5.proposed === true && !res5.scheduled && s5.agenda().status === "open");
  check("proposal card waits for the user", s5.agenda().waitingForUser?.kind === "finish" && s5.agenda().waitingForUser.options?.includes("안건 종료"));
  await r5.send("안건 종료");
  check("the user saying so ends it", res5.scheduled === true && s5.agenda().status === "closed" && sh(["show", "main:p.txt"]).includes("p"));
  r5.close({ closeMemory: false });
}

// ---- 5. deleting agendas ----
const { deleteAgenda } = await import("@gencouncil/council");
// a mistaken blank agenda: nothing to lose
const blank = AgendaStore.create(project, "실수로 만든 안건", []);
const rtb = await AgendaRuntime.open(blank, memory, chairOpts);
rtb.close({ closeMemory: false });
const blankDir = blank.dir;
const blankBranch = blank.agenda().branch;
const d1 = await deleteAgenda(project, blank);
check("blank agenda deleted at once", d1.deleted && d1.lost.length === 0 && !fs.existsSync(blankDir) && fs.existsSync(d1.movedTo));
check("its branch and worktree are gone", !sh(["branch", "--list", blankBranch]).trim() && !fs.existsSync(blank.integrationWorktree()));
// an agenda with unmerged work is refused until forced
const work = AgendaStore.create(project, "작업 있는 안건", ["x"]);
const rtw = await AgendaRuntime.open(work, memory, chairOpts);
fs.writeFileSync(path.join(work.integrationWorktree(), "w.txt"), "w\n");
sh(["add", "-A"], work.integrationWorktree());
sh(["commit", "-q", "-m", "work"], work.integrationWorktree());
rtw.close({ closeMemory: false });
const d2 = await deleteAgenda(project, work);
check("unmerged work blocks delete", !d2.deleted && d2.lost.some((l) => l.includes("커밋 1개")) && fs.existsSync(work.dir), JSON.stringify(d2.lost));
const d3 = await deleteAgenda(project, work, { force: true });
check("forced delete removes it", d3.deleted && !fs.existsSync(work.dir) && !sh(["branch", "--list", work.agenda?.branch ?? "agenda/작업-있는-안건"]).trim());
// a finished (closed) agenda deletes without asking
const d4 = await deleteAgenda(project, store);
check("closed agenda deletes cleanly and main keeps its merge", d4.deleted && d4.lost.length === 0 && sh(["show", "main:b.txt"]).includes("two"));

memory.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall finish checks passed");
process.exitCode = failed ? 1 : 0;
