// Member folder tidy on a long agenda, without any LLM: the report sorts folders into busy, parked,
// free, unmerged and dirty; a tidy removes only free and unmerged ones (branches stay, notes are
// archived); a folder with uncommitted changes or someone working in it is never touched; and an
// unmerged folder comes back from its branch, notes included, when its work is needed again.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "@gencouncil/core";
import { AgendaRuntime, AgendaStore, ProjectRegistry } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-folders-"));
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

const project = new ProjectRegistry().add({ name: "폴더 정리", repo, baseBranch: "main" });
const memory = new MemoryStore({ git: false });
await memory.init();
const chairOpts = { councilUrl: "http://127.0.0.1:9/mcp" };
const store = AgendaStore.create(project, "긴 안건", ["많은 위원"]);
let rt = await AgendaRuntime.open(store, memory, chairOpts);
const agendaBranch = store.agenda().branch;
rt.close({ closeMemory: false });

// four member folders, each in a different state
const now = new Date().toISOString();
const member = (id, status, extra = {}) => ({ id, provider: "claude", taskId: "t1", branch: store.memberBranch(id), worktree: store.memberWorktree(id), status, startedAt: now, endedAt: now, toolCalls: 1, ...extra });
const add = (id) => sh(["worktree", "add", "-q", "-b", store.memberBranch(id), store.memberWorktree(id), agendaBranch]);
const notes = (id, text) => {
  fs.mkdirSync(path.join(store.memberWorktree(id), ".council"), { recursive: true });
  fs.writeFileSync(path.join(store.memberWorktree(id), ".council", "TASK.md"), text);
};
add("claude-1"); // merged, nothing past the agenda branch: free
notes("claude-1", "# 과제 1");
add("claude-2"); // finished, one commit not merged yet: unmerged
fs.writeFileSync(path.join(store.memberWorktree("claude-2"), "b.txt"), "two\n");
sh(["add", "-A"], store.memberWorktree("claude-2"));
sh(["commit", "-q", "-m", "b"], store.memberWorktree("claude-2"));
notes("claude-2", "# 과제 2: b.txt");
add("claude-3"); // finished but left a change nobody committed: dirty
fs.writeFileSync(path.join(store.memberWorktree("claude-3"), "a.txt"), "changed\n");
add("claude-4"); // a relay member waiting for its answer: busy (an app restart stops running ones, not waiting ones)
store.saveMembers([member("claude-1", "done", { merged: true }), member("claude-2", "done"), member("claude-3", "failed"), member("claude-4", "waiting", { provider: "relay", site: "aistudio" })]);
store.saveTasks([{ id: "t1", title: "일", description: "", status: "doing" }]);

rt = await AgendaRuntime.open(store, memory, chairOpts);
const council = rt.council;
check("the agenda counts its member folders", council.state().folders === 4, String(council.state().folders));

const report = await council.folderReport(0);
const kind = Object.fromEntries(report.folders.map((f) => [f.name, f.kind]));
check("merged and nothing past the agenda branch: free", kind["claude-1"] === "free", JSON.stringify(kind));
check("finished work not merged: unmerged", kind["claude-2"] === "unmerged");
check("an uncommitted change: dirty, with how many files", kind["claude-3"] === "dirty" && report.folders.find((f) => f.name === "claude-3").changed === 1);
check("someone working in it: busy", kind["claude-4"] === "busy");
check("a tidy would remove the free and the unmerged ones", report.removable === 2 && report.counts.dirty === 1 && report.counts.busy === 1);
check("one folder is measured to estimate what a tidy frees", typeof report.perFolderMb === "number");
check("with the usual keep, the free folder is parked for reuse instead", (await council.folderReport()).folders.find((f) => f.name === "claude-1").kind === "parked");

const r = await council.tidyFolders(0);
check("the tidy removed two folders", r.removed === 2 && r.dirty.length === 1 && r.busy === 1 && r.locked.length === 0, JSON.stringify(r));
check("free and unmerged folders are gone", !fs.existsSync(store.memberWorktree("claude-1")) && !fs.existsSync(store.memberWorktree("claude-2")));
check("the dirty folder keeps its change", fs.readFileSync(path.join(store.memberWorktree("claude-3"), "a.txt"), "utf8") === "changed\n");
check("the busy folder is untouched", fs.existsSync(store.memberWorktree("claude-4")));
check("every branch stays", ["claude-1", "claude-2", "claude-3", "claude-4"].every((id) => sh(["branch", "--list", store.memberBranch(id)]).trim()));
check("the unmerged work is still on its branch", sh(["show", `${store.memberBranch("claude-2")}:b.txt`]) === "two\n");
check("notes were archived", fs.readFileSync(path.join(council.archiveDir(store.memberWorktree("claude-2")), "TASK.md"), "utf8").includes("b.txt"));
const after = Object.fromEntries(council.members().map((m) => [m.id, m]));
check("merged member: folder released; unmerged member: folder tidied", Boolean(after["claude-1"].worktreeReleased) && Boolean(after["claude-2"].worktreeTidied) && !after["claude-2"].worktreeReleased);
check("the count drops to the folders left", council.state().folders === 2, String(council.state().folders));
check("git no longer lists the removed folders", !sh(["worktree", "list"]).includes("claude-2"));

// the unmerged work is needed again (a handover or a check): the folder comes back from its branch
await council["restoreTidiedFolder"](council.members().find((m) => m.id === "claude-2"));
// (a checkout may write CRLF on Windows)
check("the folder is checked out again on its branch", fs.readFileSync(path.join(store.memberWorktree("claude-2"), "b.txt"), "utf8").trim() === "two");
check("its notes come back", fs.readFileSync(path.join(store.memberWorktree("claude-2"), ".council", "TASK.md"), "utf8").includes("b.txt"));
check("the member owns its folder again", !council.members().find((m) => m.id === "claude-2").worktreeTidied && council.state().folders === 3);

// a merge still works from the branch alone, folder or not
const merged = await council.merge("claude-2");
check("unmerged work merges from its branch", merged.ok, JSON.stringify(merged));

rt.close({ closeMemory: false });
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows may still hold a git handle on a worktree for a moment; the temp folder is left behind */
}
if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall folder tidy checks passed");
