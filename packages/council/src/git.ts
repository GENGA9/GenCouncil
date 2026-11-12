import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rescueShared } from "./shared.js";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly output: string,
  ) {
    super(`git ${args.join(" ")} failed:\n${output.trim()}`);
  }
}

/** commands that write commits and fail with "Committer identity unknown" when no name/email is set */
const IDENTITY_COMMANDS = new Set(["commit", "merge"]);
const identityCache = new Map<string, Promise<string[]>>();

/**
 * Fallback author for repos with no user.name/user.email anywhere (repo or global): council merges
 * and auto-commits used to fail with "Committer identity unknown". A configured identity always wins.
 */
function identityArgs(cwd: string): Promise<string[]> {
  let p = identityCache.get(cwd);
  if (!p) {
    const has = (key: string) => run(cwd, ["config", "--get", key]).then((v) => Boolean(v.trim()), () => false);
    p = Promise.all([has("user.name"), has("user.email")]).then(([name, email]) => [
      ...(name ? [] : ["-c", "user.name=GenCouncil"]),
      ...(email ? [] : ["-c", "user.email=gencouncil@local"]),
    ]);
    identityCache.set(cwd, p);
  }
  return p;
}

export function git(cwd: string, args: string[]): Promise<string> {
  if (IDENTITY_COMMANDS.has(args[0])) return identityArgs(cwd).then((pre) => run(cwd, [...pre, ...args]));
  return run(cwd, args);
}

function run(cwd: string, args: string[]): Promise<string> {
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

/**
 * Unlink every symlink / directory junction under dir without following it. Members link
 * node_modules, data or reference folders from the main checkout into their worktree; removing
 * those links first means no delete can ever reach the real folders behind them.
 */
export function unlinkLinks(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          fs.unlinkSync(p);
          n++;
        } catch {
          try {
            fs.rmdirSync(p); // directory junctions on Windows
            n++;
          } catch {
            /* leave it; the folder delete below will report it */
          }
        }
      } else if (st.isDirectory() && e.name !== ".git") {
        walk(p);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

/**
 * Delete a folder, retrying while Windows still holds it (a process that just exited, antivirus,
 * indexer). Returns undefined on success, otherwise a readable reason.
 */
export async function removeDir(dir: string, attempts = 4): Promise<string | undefined> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    if (!fs.existsSync(dir)) return undefined;
    unlinkLinks(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return undefined;
    } catch (e) {
      // the raw message shows Korean paths garbled on Windows; keep the code and our own path
      last = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return fs.existsSync(dir) ? `${dir} (${last}: 다른 프로그램이 폴더나 그 안의 파일을 쓰고 있음)` : undefined;
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  // renders left in a shared folder that was still a real folder here are copied to the main checkout first
  try {
    rescueShared(repo, dir);
  } catch {
    /* never blocks a cleanup */
  }
  unlinkLinks(dir);
  try {
    await git(repo, ["worktree", "remove", "--force", dir]);
  } catch {
    // may already be gone, or locked: removeDir below retries
  }
  await removeDir(dir, 2);
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
  /** files the merge brings in that usually should not be committed (temp output, secrets, huge files) */
  warnings?: string[];
}

const SUSPECT_PATH = /(^|\/)(tmp|temp|\.tmp)\/|(^|\/)\.env($|\.)|\.(bak|orig|log)$|(^|\/)node_modules\//i;
const HUGE_FILE = 50 * 1024 * 1024;

/** What a branch would add that looks like a mistake; checked before every member merge. */
export async function suspiciousFiles(dir: string, branch: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await git(dir, ["diff", "--name-only", "--diff-filter=AM", `HEAD...${branch}`])).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (SUSPECT_PATH.test(n)) out.push(`${n} (임시·비밀·로그 파일로 보임)`);
    else {
      try {
        const size = Number((await git(dir, ["cat-file", "-s", `${branch}:${n}`])).trim());
        if (size > HUGE_FILE) out.push(`${n} (${Math.round(size / 1024 / 1024)}MB)`);
      } catch {
        /* deleted or unreadable */
      }
    }
    if (out.length >= 20) break;
  }
  return out;
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
