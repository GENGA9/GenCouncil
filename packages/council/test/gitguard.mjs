// Merges that used to need a person: no git identity anywhere, and files a member committed by mistake.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, mergeInto, suspiciousFiles } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-gitguard-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
// no global identity: point HOME/XDG at an empty folder and ignore system config
const emptyHome = path.join(tmp, "home");
fs.mkdirSync(emptyHome);
Object.assign(process.env, { HOME: emptyHome, USERPROFILE: emptyHome, XDG_CONFIG_HOME: emptyHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(emptyHome, "none") });
const sh = (args, cwd = repo) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

sh(["init", "-q", "-b", "main"]);
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);
sh(["checkout", "-q", "-b", "member"]);
fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
fs.mkdirSync(path.join(repo, "tmp"));
fs.writeFileSync(path.join(repo, "tmp", "measure.json"), "{}");
fs.writeFileSync(path.join(repo, ".env.bak-1"), "KEY=x");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "member work"]);
sh(["checkout", "-q", "main"]);


const warnings = await suspiciousFiles(repo, "member");
check("temp and secret files flagged before merge", warnings.some((w) => w.startsWith("tmp/measure.json")) && warnings.some((w) => w.startsWith(".env.bak-1")) && !warnings.some((w) => w.startsWith("b.txt")), JSON.stringify(warnings));

const res = await mergeInto(repo, "member", "merge member");
check("merge works with no identity configured", res.ok, res.output);
check("fallback author recorded", (await git(repo, ["log", "-1", "--format=%cn <%ce>"])).trim() === "GenCouncil <gencouncil@local>");

// a configured identity wins
sh(["config", "user.name", "Real Person"]);
sh(["config", "user.email", "real@example.com"]);
const repo2 = repo; // same repo, new cache key needed: use a worktree path
const wt = path.join(tmp, "wt");
sh(["worktree", "add", "-q", wt, "-b", "side"]);
fs.writeFileSync(path.join(wt, "c.txt"), "three\n");
await git(wt, ["add", "-A"]);
await git(wt, ["commit", "-q", "-m", "side"]);
check("configured identity is kept", (await git(wt, ["log", "-1", "--format=%an"])).trim() === "Real Person", repo2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall git guard checks passed");
process.exitCode = failed ? 1 : 0;
