/**
 * Folder mode: the user's folder is not a git repository (or they don't want one there).
 * The council works in a private "shadow" repo under ~/.gencouncil/projects/<id>/shadow:
 *   - snapshot(): copy the folder into the shadow main branch and commit (picks up the user's edits)
 *   - syncBack(): after an agenda is merged, copy changed/added files back and delete removed ones
 * The user's folder never gets a .git directory.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureExclude, git, isClean } from "./git.js";
import { projectDir, type ProjectConfig } from "./model.js";

export const DEFAULT_IGNORE = [
  ".git",
  ".worktrees",
  ".council",
  ".gemini",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
];

export function shadowDir(projectId: string): string {
  return path.join(projectDir(projectId), "shadow");
}

function ignored(name: string, extra: string[]): boolean {
  return DEFAULT_IGNORE.includes(name) || extra.includes(name);
}

/** relative paths of all files under dir, skipping ignored names at any depth */
function walk(dir: string, extra: string[], rel = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (ignored(e.name, extra)) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(dir, extra, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    if (Math.abs(sa.mtimeMs - sb.mtimeMs) < 2) return true;
    return sa.size < 4_000_000 ? fs.readFileSync(a).equals(fs.readFileSync(b)) : false;
  } catch {
    return false;
  }
}

function copyFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const st = fs.statSync(from);
  fs.utimesSync(to, st.atime, st.mtime);
}

function removeEmptyDirs(root: string, rel: string): void {
  let d = path.dirname(rel);
  while (d && d !== ".") {
    const abs = path.join(root, d);
    try {
      if (fs.readdirSync(abs).length) return;
      fs.rmdirSync(abs);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

/** mirror src into dst (files only). Returns counts. */
export function mirror(src: string, dst: string, extra: string[] = []): { copied: number; removed: number } {
  let copied = 0;
  let removed = 0;
  const srcFiles = walk(src, extra);
  const set = new Set(srcFiles.map((f) => f.toLowerCase()));
  for (const f of srcFiles) {
    const a = path.join(src, f);
    const b = path.join(dst, f);
    if (!sameFile(a, b)) {
      copyFile(a, b);
      copied++;
    }
  }
  for (const f of walk(dst, extra)) {
    if (!set.has(f.toLowerCase())) {
      fs.rmSync(path.join(dst, f), { force: true });
      removeEmptyDirs(dst, f);
      removed++;
    }
  }
  return { copied, removed };
}

async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ["add", "-A"]);
  if (await isClean(dir)) return null;
  await git(dir, ["commit", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** Create the shadow repo for a folder-mode project and take the first snapshot. */
export async function initShadow(source: string, shadow: string, extra: string[] = []): Promise<void> {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`not a folder: ${source}`);
  fs.mkdirSync(shadow, { recursive: true });
  if (!fs.existsSync(path.join(shadow, ".git"))) {
    await git(shadow, ["init", "-q", "-b", "main"]);
    await git(shadow, ["config", "user.name", "gencouncil"]);
    await git(shadow, ["config", "user.email", "gencouncil@local"]);
    await git(shadow, ["config", "core.autocrlf", "false"]);
  }
  await ensureExclude(shadow, [".worktrees/", ".council/", ".gemini/"]);
  mirror(source, shadow, extra);
  fs.writeFileSync(path.join(shadow, ".gencouncil-shadow"), `source: ${source}\n`, "utf8");
  await git(shadow, ["add", "-A"]);
  await git(shadow, ["commit", "-q", "--allow-empty", "-m", `snapshot: initial copy of ${source}`]);
}

/** Copy the user's folder into the shadow main branch. Returns the new commit, or null if nothing changed. */
export async function snapshot(project: ProjectConfig): Promise<string | null> {
  if (project.mode !== "folder" || !project.source) return null;
  const shadow = project.repo;
  if (!(await isClean(shadow))) throw new Error(`shadow repo has uncommitted changes: ${shadow}`);
  const cur = (await git(shadow, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (cur !== project.baseBranch) throw new Error(`shadow repo is on '${cur}', expected '${project.baseBranch}'`);
  const { copied, removed } = mirror(project.source, shadow, project.ignore ?? []);
  if (!copied && !removed) return null;
  return commitAll(shadow, `snapshot: ${copied} changed, ${removed} removed in ${project.source}`);
}

/**
 * Apply the changes between two shadow commits to the user's folder.
 * Returns the relative paths written and deleted.
 */
export async function syncBack(project: ProjectConfig, from: string, to: string): Promise<{ written: string[]; deleted: string[] }> {
  const written: string[] = [];
  const deleted: string[] = [];
  if (project.mode !== "folder" || !project.source) return { written, deleted };
  const out = await git(project.repo, ["diff", "--name-status", "-z", "--no-renames", from, to]);
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i];
    const rel = parts[i + 1];
    if (!rel || rel === ".gencouncil-shadow") continue;
    const target = path.join(project.source, rel);
    if (status.startsWith("D")) {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        removeEmptyDirs(project.source, rel);
      }
      deleted.push(rel);
    } else {
      copyFile(path.join(project.repo, rel), target);
      written.push(rel);
    }
  }
  return { written, deleted };
}
