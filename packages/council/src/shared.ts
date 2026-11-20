/**
 * Shared folders: rendered media and other big generated files live OUTSIDE git, in folders
 * every worktree links to (a directory junction to the same folder in the main checkout).
 * Agendas and members then see each other's renders at once, worktrees stay small and quick
 * to create, and merges never fight over binary files.
 *
 * - Local-git projects always have `_shared/` at the folder root.
 * - Any project can list more folders in `.gencouncil-shared` at its root (one relative path per
 *   line, `#` comments), e.g. `output/first_film/video`.
 * - Local-git projects also get a pre-commit hook that keeps NEW big media out of commits
 *   (the file stays on disk and is added to the exclude list), so renders saved elsewhere
 *   can't grow the repository again. New projects get it from the start; a project that already
 *   commits its renders gets it once it lists its shared folders in .gencouncil-shared (until then
 *   its members still save renders in tracked folders, and a dropped file would be lost when the
 *   worktree is cleaned up).
 */
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { BINARY_EXT, HEAVY_EXT, HEAVY_MAX_BYTES, ANY_MAX_BYTES } from "./localgit.js";
import type { ProjectConfig } from "./model.js";

export const DEFAULT_SHARED_DIR = "_shared";
export const SHARED_LIST_FILE = ".gencouncil-shared";

/** a safe relative folder path with forward slashes, or undefined */
function cleanRel(p: string): string | undefined {
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!s || s.startsWith("/") || /^[a-z]:/i.test(s)) return undefined;
  const parts = s.split("/");
  if (parts.some((x) => !x || x === "." || x === ".." || x === ".git" || x === ".worktrees" || x === ".council")) return undefined;
  return parts.join("/");
}

/** the project's shared folders, relative to its root (forward slashes) */
export function sharedDirs(project: Pick<ProjectConfig, "repo" | "localGit">): string[] {
  const out: string[] = [];
  if (project.localGit) out.push(DEFAULT_SHARED_DIR);
  const file = path.join(project.repo, SHARED_LIST_FILE);
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const l = line.replace(/#.*/, "");
      const r = cleanRel(l);
      if (r && !out.includes(r)) out.push(r);
    }
  }
  return out;
}

async function commonDir(repo: string): Promise<string> {
  let common = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  if (!path.isAbsolute(common)) common = path.resolve(repo, common);
  return common;
}

const START = "# >>> gencouncil shared folders (linked into every worktree) >>>";
const END = "# <<< gencouncil shared folders <<<";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** keep the shared folders out of git (managed block in .git/info/exclude) */
async function writeSharedExclude(repo: string, dirs: string[]): Promise<void> {
  const file = path.join(await commonDir(repo), "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`${esc(START)}[\\s\\S]*?${esc(END)}\\n?`);
  const block = dirs.length ? [START, ...dirs.map((d) => `/${d}/`), END].join("\n") + "\n" : "";
  const next = re.test(cur) ? cur.replace(re, block) : block ? (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + block : cur;
  if (next !== cur) fs.writeFileSync(file, next, "utf8");
}

const HOOK_MARK = "gencouncil-media-guard";

/** the pre-commit guard (self-contained: runs from the repository's hooks folder) */
function guardScript(): string {
  return `// ${HOOK_MARK}: keeps NEW big media out of commits (the file stays on disk).
// Installed by GenCouncil for local-git projects; renders belong in the shared folders.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const BINARY = ${JSON.stringify(BINARY_EXT)};
const HEAVY = new Set(${JSON.stringify([...HEAVY_EXT])});
const HEAVY_MAX = ${HEAVY_MAX_BYTES}, ANY_MAX = ${ANY_MAX_BYTES};
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
try {
  const added = git("diff", "--cached", "--name-only", "--diff-filter=A", "-z").split("\\0").filter(Boolean);
  if (!added.length) process.exit(0);
  const top = git("rev-parse", "--show-toplevel").trim();
  const heavy = [];
  for (const f of added) {
    let size;
    try { size = fs.statSync(path.join(top, f)).size; } catch { try { size = Number(git("cat-file", "-s", ":" + f).trim()); } catch { continue; } }
    const ext = path.extname(f).toLowerCase();
    if (BINARY.includes(ext) || size > ANY_MAX || (HEAVY.has(ext) && size > HEAVY_MAX)) heavy.push(f);
  }
  if (!heavy.length) process.exit(0);
  for (let i = 0; i < heavy.length; i += 100) git("rm", "--cached", "-q", "--", ...heavy.slice(i, i + 100));
  let common = git("rev-parse", "--git-common-dir").trim();
  if (!path.isAbsolute(common)) common = path.resolve(common);
  const ex = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
  const lines = heavy.map((f) => "/" + f.replace(/([*?[\\]\\\\!#])/g, "\\\\$1")).filter((l) => !cur.split(/\\r?\\n/).includes(l));
  if (lines.length) fs.appendFileSync(ex, (cur && !cur.endsWith("\\n") ? "\\n" : "") + lines.join("\\n") + "\\n");
  process.stderr.write(
    "gencouncil: 큰 미디어 " + heavy.length + "개는 커밋에서 뺐다(파일은 그대로 있다): " + heavy.slice(0, 5).join(", ") + (heavy.length > 5 ? " …" : "") +
      "\\n렌더 결과물은 공유 폴더(_shared/ 또는 .gencouncil-shared에 적힌 폴더)에 저장한다. 작업 폴더의 다른 자리에 둔 파일은 폴더 정리 때 사라진다.\\n",
  );
} catch (e) {
  process.stderr.write("gencouncil media guard skipped: " + (e && e.message ? e.message.split("\\n")[0] : e) + "\\n");
}
process.exit(0);
`;
}

/** install (or refresh) the pre-commit guard; leaves a user's own pre-commit hook alone */
async function installGuard(repo: string): Promise<boolean> {
  const hooks = path.join(await commonDir(repo), "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, "pre-commit");
  if (fs.existsSync(hook) && !fs.readFileSync(hook, "utf8").includes(HOOK_MARK)) return false;
  const script = path.join(hooks, `${HOOK_MARK}.mjs`);
  const node = process.execPath.replace(/\\/g, "/");
  const body = `#!/bin/sh\n# ${HOOK_MARK} (GenCouncil)\n"${node}" "${script.replace(/\\/g, "/")}"\nexit 0\n`;
  const js = guardScript();
  if (!fs.existsSync(script) || fs.readFileSync(script, "utf8") !== js) fs.writeFileSync(script, js, "utf8");
  if (!fs.existsSync(hook) || fs.readFileSync(hook, "utf8") !== body) fs.writeFileSync(hook, body, { encoding: "utf8", mode: 0o755 });
  return true;
}

/**
 * Main checkout side: shared folders exist and are excluded. Local-git projects get the media
 * guard when they are created (newProject) or once they list their shared folders.
 */
export async function prepareShared(project: Pick<ProjectConfig, "repo" | "localGit">, opts: { newProject?: boolean } = {}): Promise<string[]> {
  const dirs = sharedDirs(project);
  for (const d of dirs) fs.mkdirSync(path.join(project.repo, d), { recursive: true });
  await writeSharedExclude(project.repo, dirs);
  if (project.localGit && (opts.newProject || fs.existsSync(path.join(project.repo, SHARED_LIST_FILE)))) await installGuard(project.repo);
  return dirs;
}

/**
 * Link each shared folder into a worktree. A path the worktree's branch still has as a real
 * folder (tracked files from before the folder became shared) is left alone and reported.
 */
export function linkShared(project: Pick<ProjectConfig, "repo" | "localGit">, worktree: string): { linked: string[]; skipped: string[] } {
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const d of sharedDirs(project)) {
    const target = path.join(project.repo, d);
    const link = path.join(worktree, d);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(link);
    } catch {
      st = undefined;
    }
    if (st?.isSymbolicLink()) {
      linked.push(d);
      continue;
    }
    if (st) {
      // an empty real folder (git leaves none, but a tool may) can become the link
      if (st.isDirectory() && fs.readdirSync(link).length === 0) fs.rmdirSync(link);
      else {
        skipped.push(d);
        continue;
      }
    }
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "junction");
    linked.push(d);
  }
  return { linked, skipped };
}

/**
 * Before a worktree is removed: a shared folder that is still a real folder there (its branch
 * tracked the folder before it became shared) may hold renders nobody committed. Copy the ones
 * the main checkout lacks into it, so a cleanup never throws work away. A same-named file with
 * different content goes to <shared>/_rescued/<worktree>/ instead of overwriting.
 */
export function rescueShared(repo: string, worktree: string): number {
  const dirs = [...new Set([...(fs.existsSync(path.join(repo, DEFAULT_SHARED_DIR)) ? [DEFAULT_SHARED_DIR] : []), ...sharedDirs({ repo, localGit: false })])];
  let copied = 0;
  for (const d of dirs) {
    const src = path.join(worktree, d);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(src);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const walk = (rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          walk(r);
          continue;
        }
        if (!e.isFile()) continue;
        const from = path.join(src, r);
        let dest = path.join(repo, d, r);
        try {
          if (fs.existsSync(dest)) {
            if (fs.statSync(dest).size === fs.statSync(from).size) continue;
            dest = path.join(repo, d, "_rescued", path.basename(worktree), r);
            if (fs.existsSync(dest)) continue;
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(from, dest);
          copied++;
        } catch {
          /* best effort */
        }
      }
    };
    walk("");
  }
  return copied;
}
