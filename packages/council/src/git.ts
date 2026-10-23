import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly output: string,
  ) {
    super(`git ${args.join(" ")} failed:\n${output.trim()}`);
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(args, String(stdout) + String(stderr)));
        else resolve(String(stdout));
      },
    );
  });
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureBranch(dir: string, name: string, from: string): Promise<void> {
  if (!(await branchExists(dir, name))) await git(dir, ["branch", name, from]);
}

export async function worktreeExists(repo: string, dir: string): Promise<boolean> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const want = path.resolve(dir).replace(/\\/g, "/").toLowerCase();
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => l.slice(9).trim().replace(/\\/g, "/").toLowerCase() === want);
}

/** Create a worktree at `dir` on `branch` (creating the branch from `from` if needed). Idempotent. */
export async function ensureWorktree(repo: string, dir: string, branch: string, from: string): Promise<void> {
  if (await worktreeExists(repo, dir)) return;
  await git(repo, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (await branchExists(repo, branch)) {
    await git(repo, ["worktree", "add", dir, branch]);
  } else {
    await git(repo, ["worktree", "add", "-b", branch, dir, from]);
  }
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  try {
    await git(repo, ["worktree", "remove", "--force", dir]);
  } catch {
    // may already be gone
  }
  try {
    await git(repo, ["worktree", "prune"]);
  } catch {
    /* ignore */
  }
}

export async function deleteBranch(repo: string, name: string): Promise<void> {
  try {
    await git(repo, ["branch", "-D", name]);
  } catch {
    /* ignore */
  }
}

/** Add patterns to .git/info/exclude (shared by all worktrees). */
export async function ensureExclude(repo: string, patterns: string[]): Promise<void> {
  let common = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  if (!path.isAbsolute(common)) common = path.resolve(repo, common);
  const file = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = cur.split(/\r?\n/);
  const missing = patterns.filter((p) => !lines.includes(p));
  if (missing.length) fs.appendFileSync(file, (cur.endsWith("\n") || !cur ? "" : "\n") + missing.join("\n") + "\n");
}

export async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, ["status", "--porcelain"])).trim() === "";
}

/** changed tracked files ("M src/a.ts"); untracked files are left out, a merge does not touch them */
export async function trackedChanges(dir: string): Promise<string[]> {
  return (await git(dir, ["status", "--porcelain", "--untracked-files=no"]))
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

export async function logRange(dir: string, from: string, to: string): Promise<string[]> {
  const out = await git(dir, ["log", "--oneline", `${from}..${to}`]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function diffStat(dir: string, from: string, to: string): Promise<string> {
  return (await git(dir, ["diff", "--stat", `${from}...${to}`])).trim();
}

export async function diffFull(dir: string, from: string, to: string, maxChars = 60_000): Promise<string> {
  const out = await git(dir, ["diff", `${from}...${to}`]);
  return out.length > maxChars ? out.slice(0, maxChars) + `\n… (truncated, ${out.length} chars)` : out;
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  output: string;
}

/** Merge `branch` into the branch checked out in `dir`. Aborts and reports conflicts on failure. */
export async function mergeInto(dir: string, branch: string, message: string): Promise<MergeResult> {
  try {
    const out = await git(dir, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
    return { ok: true, conflicts: [], output: out.trim() };
  } catch (e) {
    const err = e as GitError;
    let conflicts: string[] = [];
    try {
      conflicts = (await git(dir, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* ignore */
    }
    try {
      await git(dir, ["merge", "--abort"]);
    } catch {
      /* nothing to abort */
    }
    return { ok: false, conflicts, output: err.output?.trim() ?? err.message };
  }
}
