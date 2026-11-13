// Shared render folders: linked into every worktree, kept out of git; new big media never lands in a commit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BG_RUNNER, bgRule, claudeModelId, linkShared, prepareShared, removeWorktree, sharedDirs, sharedRule, initLocalGit, unlinkLinks } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-shared-"));
const repo = path.join(tmp, "proj");
fs.mkdirSync(repo);
const sh = (args, cwd = repo) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};
const big = (p, n = 200 * 1024) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(n, 7));
};

// a folder with a script and an existing render folder listed as shared
fs.writeFileSync(path.join(repo, "make.py"), "print('x')\n");
fs.writeFileSync(path.join(repo, ".gencouncil-shared"), "# renders\noutput/video\n../escape\n.git\n");
big(path.join(repo, "output", "video", "old.mp4"));
const project = { repo, localGit: true };
check("shared list: default + file, unsafe lines dropped", JSON.stringify(sharedDirs(project)) === JSON.stringify(["_shared", "output/video"]), JSON.stringify(sharedDirs(project)));
await initLocalGit(repo);
await prepareShared(project);
const tracked = sh(["ls-files"]).split("\n").filter(Boolean);
check("shared folders are not tracked", !tracked.some((f) => f.startsWith("output/video/") || f.startsWith("_shared/")), tracked.join(","));
check("project files are tracked", tracked.includes("make.py") && tracked.includes(".gencouncil-shared"));
check("pre-commit guard installed", fs.readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8").includes("gencouncil-media-guard"));

// a member worktree sees the shared folders through links
const wt = path.join(repo, ".worktrees", "m1");
sh(["worktree", "add", "-q", "-b", "m1", wt, "main"]);
const r = linkShared(project, wt);
check("links made", r.linked.length === 2 && !r.skipped.length, JSON.stringify(r));
check("existing render visible in worktree", fs.existsSync(path.join(wt, "output", "video", "old.mp4")));
big(path.join(wt, "_shared", "ep01", "new.wav"));
check("render saved in worktree lands in main folder", fs.existsSync(path.join(repo, "_shared", "ep01", "new.wav")));
check("linking again is a no-op", linkShared(project, wt).linked.length === 2);

// the member commits everything: renders outside shared folders are kept out, code goes in
fs.writeFileSync(path.join(wt, "make.py"), "print('y')\n");
big(path.join(wt, "renders", "cut01.mp4"));
fs.writeFileSync(path.join(wt, "icon.png"), Buffer.alloc(1000, 1)); // small media is fine
sh(["add", "-A"], wt);
let out = "";
try {
  out = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  out = String(e.stderr || e.message);
}
const inCommit = sh(["show", "--name-only", "--format=", "HEAD"], wt).split("\n").filter(Boolean);
check("code change committed", inCommit.includes("make.py"), inCommit.join(","));
check("small media committed", inCommit.includes("icon.png"));
check("big render kept out of the commit", !inCommit.includes("renders/cut01.mp4"));
check("big render still on disk", fs.existsSync(path.join(wt, "renders", "cut01.mp4")));
check("shared files never staged", !inCommit.some((f) => f.startsWith("_shared/") || f.startsWith("output/video/")));
check("status clean after the guard (render excluded)", sh(["status", "--porcelain"], wt).trim() === "", sh(["status", "--porcelain"], wt));

// removing the worktree never reaches the shared folder behind the link
unlinkLinks(wt);
sh(["worktree", "remove", "--force", wt]);
check("shared render survives worktree removal", fs.existsSync(path.join(repo, "_shared", "ep01", "new.wav")) && fs.existsSync(path.join(repo, "output", "video", "old.mp4")));

// an existing local-git project that still commits renders gets no guard until it lists shared folders
const old = path.join(tmp, "old");
fs.mkdirSync(old);
const shOld = (args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: old, encoding: "utf8" });
shOld(["init", "-q", "-b", "main"]);
fs.writeFileSync(path.join(old, "a.txt"), "a");
shOld(["add", "-A"]);
shOld(["commit", "-q", "-m", "i"]);
await prepareShared({ repo: old, localGit: true });
check("existing project: no guard yet", !fs.existsSync(path.join(old, ".git", "hooks", "pre-commit")));
check("existing project: _shared excluded already", fs.readFileSync(path.join(old, ".git", "info", "exclude"), "utf8").includes("/_shared/"));
fs.writeFileSync(path.join(old, ".gencouncil-shared"), "renders\n");
await prepareShared({ repo: old, localGit: true });
check("existing project: guard once it lists shared folders", fs.existsSync(path.join(old, ".git", "hooks", "pre-commit")));

// an old branch still tracks the render folder: its worktree has a real folder there, and a render
// nobody committed is copied to the main checkout before the worktree goes away
sh(["checkout", "-q", "-b", "oldstyle", "main"]);
big(path.join(repo, "output", "video", "tracked.mp4"));
sh(["add", "-f", "output/video/tracked.mp4"]);
sh(["commit", "-q", "--no-verify", "-m", "old style render"]);
sh(["checkout", "-q", "main"]);
const owt = path.join(repo, ".worktrees", "old");
sh(["worktree", "add", "-q", owt, "oldstyle"]);
const lr = linkShared(project, owt);
check("old branch: real folder left alone", lr.skipped.includes("output/video"), JSON.stringify(lr));
big(path.join(owt, "output", "video", "uncommitted.mp4"), 300 * 1024);
await removeWorktree(repo, owt);
check("old worktree removed", !fs.existsSync(owt));
check("uncommitted render rescued to main", fs.existsSync(path.join(repo, "output", "video", "uncommitted.mp4")));

// rules and models
check("member rule names shared folders", sharedRule(project).includes("`_shared/`") && sharedRule(project).includes("`output/video/`"));
check("git project without a list has no rule", sharedRule({ repo: tmp, localGit: false }) === "");
check("fable goes out as the full 5.2 id", claudeModelId("fable") === "claude-fable-5-2" && claudeModelId("opus") === "opus" && claudeModelId("claude-fable-5-1") === "claude-fable-5-1");

check("background runner exists", fs.existsSync(BG_RUNNER), BG_RUNNER);
check("background rule names the runner and the log", bgRule().includes(BG_RUNNER) && bgRule().includes("--log"));
// the runner itself: output reaches the log, the end line records the exit code
{
  const log = path.join(tmp, "bg.log");
  const started = execFileSync(process.execPath, [BG_RUNNER, "--title", "t", "--log", log, "--", process.execPath, "-e", 'console.log("hello");process.exit(4)'], {
    encoding: "utf8",
  });
  check("runner starts hidden (no window shown)", /^bg started pid=\d+ log=/.test(started.trim()), started.trim());
  for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("exit 4")); i++) await new Promise((r) => setTimeout(r, 100));
  const text = fs.readFileSync(log, "utf8");
  check("runner logs output and exit code", /hello[\s\S]*exit 4/.test(text), text.slice(-200));
  check("runner leaves nothing on screen to close", !/닫으면|남겨 둔다/.test(text));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("shared ok");
