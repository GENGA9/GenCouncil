/**
 * Folders that aren't git repositories get a LOCAL git repository right in the folder
 * (nothing is pushed anywhere). Python environments, build caches, binaries and big
 * media/archives/models are kept out through .git/info/exclude, so the repository and
 * every member worktree only carry what an AI member could reasonably edit.
 * The user keeps working in the folder as before; their edits are committed automatically
 * before an agenda opens and before it is merged back.
 */
import fs from "node:fs";
import path from "node:path";
import { git, isClean } from "./git.js";
import type { ProjectConfig } from "./model.js";

/** folder names skipped at any depth */
export const DEFAULT_IGNORE_DIRS = [
  ".worktrees",
  ".council",
  ".gemini",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
  ".next",
  ".nuxt",
  ".gradle",
  ".idea",
  ".vs",
];

/** compiled/binary files and logs: never tracked */
export const BINARY_EXT = [".log", ".pyc", ".pyo", ".pyd", ".dll", ".exe", ".lib", ".so", ".dylib", ".o", ".obj", ".a", ".class", ".pdb", ".msi", ".node"];
/** media, archives, model weights: tracked only when small (icons, sample data) */
const HEAVY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".psd", ".ico", ".exr", ".hdr",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac",
  ".zip", ".7z", ".rar", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".iso", ".bin", ".dat",
  ".safetensors", ".ckpt", ".pt", ".pth", ".onnx", ".gguf", ".h5", ".npy", ".npz", ".pkl",
  ".pdf", ".ttf", ".otf", ".woff", ".woff2", ".fbx", ".blend", ".uasset", ".umap",
]);
export const HEAVY_MAX_BYTES = 64 * 1024;
export const ANY_MAX_BYTES = 5 * 1024 * 1024;

export interface ScanStats {
  files: number;
  bytes: number;
  skippedFiles: number;
  skippedBytes: number;
  /** skipped folders (python environments, caches), relative with forward slashes */
  skippedDirs: string[];
  /** individual heavy files kept out, relative with forward slashes */
  skippedPaths: string[];
  /** folders that are git repositories of their own: kept out (register them as separate projects) */
  nestedRepos: string[];
}

/** true when the file belongs in git */
export function fileWanted(name: string, size: number): boolean {
  const ext = path.extname(name).toLowerCase();
  if (BINARY_EXT.includes(ext)) return false;
  if (size > ANY_MAX_BYTES) return false;
  if (HEAVY_EXT.has(ext) && size > HEAVY_MAX_BYTES) return false;
  return true;
}

let ticks = 0;
async function breathe(): Promise<void> {
  // keep the server responsive during long scans
  if (++ticks % 300 === 0) await new Promise((r) => setImmediate(r));
}

const slash = (p: string) => p.split(path.sep).join("/");

/** Walk the folder and decide what stays out of git. */
export async function scanFolder(root: string, extraDirs: string[] = []): Promise<ScanStats> {
  const stats: ScanStats = { files: 0, bytes: 0, skippedFiles: 0, skippedBytes: 0, skippedDirs: [], skippedPaths: [], nestedRepos: [] };
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...extraDirs]);
  async function walk(rel: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    // a Python virtual environment: keep the whole folder out
    if (rel && entries.some((e) => e.isFile() && e.name === "pyvenv.cfg")) {
      stats.skippedDirs.push(slash(rel));
      return;
    }
    // a git repository of its own inside the folder: the outer git can't track its files
    if (rel && entries.some((e) => e.name === ".git")) {
      stats.nestedRepos.push(slash(rel));
      return;
    }
    for (const e of entries) {
      await breathe();
      if (e.name === ".git") continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue; // covered by a name pattern
        await walk(r);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = (await fs.promises.stat(path.join(root, r))).size;
        } catch {
          continue;
        }
        if (fileWanted(e.name, size)) {
          stats.files++;
          stats.bytes += size;
        } else {
          stats.skippedFiles++;
          stats.skippedBytes += size;
          // binary extensions are covered by glob patterns; list the rest one by one
          if (!BINARY_EXT.includes(path.extname(e.name).toLowerCase())) stats.skippedPaths.push(slash(r));
        }
      }
    }
  }
  await walk("");
  return stats;
}

const START = "# >>> gencouncil (managed: environments, binaries, big media) >>>";
const END = "# <<< gencouncil <<<";

function gitPathEscape(p: string): string {
  return p.replace(/([*?[\]\\!#])/g, "\\$1").replace(/^ /, "\\ ");
}

/** Write the managed exclude block into .git/info/exclude (the user's own lines are kept). */
export async function writeExclude(root: string, stats: ScanStats, extraDirs: string[] = []): Promise<void> {
  let common = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
  if (!path.isAbsolute(common)) common = path.resolve(root, common);
  const file = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  const lines = [
    START,
    ...[...DEFAULT_IGNORE_DIRS, ...extraDirs].map((d) => `${d}/`),
    ...BINARY_EXT.map((e) => `*${e}`),
    ...stats.skippedDirs.map((d) => `/${gitPathEscape(d)}/`),
    ...stats.nestedRepos.map((d) => `/${gitPathEscape(d)}/`),
    ...stats.skippedPaths.map((p) => `/${gitPathEscape(p)}`),
    END,
  ];
  const block = lines.join("\n") + "\n";
  const next = re.test(cur) ? cur.replace(re, block) : (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + block;
  fs.writeFileSync(file, next, "utf8");
}

export function describeScan(s: ScanStats): string {
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
  return (
    `git으로 관리: ${s.files}개 ${mb(s.bytes)} · 제외(가상환경·바이너리·큰 미디어): ${s.skippedFiles}개 ${mb(s.skippedBytes)}` +
    (s.skippedDirs.length ? ` · 제외 폴더 ${s.skippedDirs.slice(0, 5).join(", ")}${s.skippedDirs.length > 5 ? " …" : ""}` : "") +
    (s.nestedRepos.length ? ` · 자체 git이 있어 제외(따로 등록 가능): ${s.nestedRepos.join(", ")}` : "")
  );
}

/**
 * Leave files git already tracks out of the per-file exclude list. A big file a member
 * committed on purpose (rendered media, audio) is part of the project now; listing it would
 * only invite untracking it, which the next commit records as a deletion.
 */
async function dropTracked(root: string, stats: ScanStats): Promise<void> {
  if (!stats.skippedPaths.length || !(await hasHead(root))) return;
  const tracked = new Set((await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean));
  stats.skippedPaths = stats.skippedPaths.filter((p) => !tracked.has(p));
}

/** Drop from the index whatever the exclude list now covers (files stay on disk). Only at setup. */
async function untrackExcluded(root: string, stats: ScanStats): Promise<void> {
  for (const d of stats.nestedRepos) await git(root, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", d]);
  const ignored = (await git(root, ["ls-files", "-ci", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (let i = 0; i < ignored.length; i += 200) await git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...ignored.slice(i, i + 200)]);
}

/** Create a local git repository in the folder (if needed) and commit the current state. */
export async function initLocalGit(root: string, extraDirs: string[] = []): Promise<ScanStats> {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`);
  if (!fs.existsSync(path.join(root, ".git"))) await git(root, ["init", "-q", "-b", "main"]);
  // commits made by the council carry this identity unless the user configured one
  try {
    await git(root, ["config", "user.email"]);
  } catch {
    await git(root, ["config", "user.name", "gencouncil"]);
    await git(root, ["config", "user.email", "gencouncil@local"]);
  }
  const stats = await scanFolder(root, extraDirs);
  await dropTracked(root, stats);
  await writeExclude(root, stats, extraDirs);
  if (await hasHead(root)) await untrackExcluded(root, stats);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "--allow-empty", "-m", "gencouncil: 시작 스냅샷"]);
  return stats;
}

/**
 * Local-git projects: commit whatever the user changed in the folder (new big files are
 * re-scanned into the exclude list first). Files git already tracks stay tracked: this
 * never removes anything from git, it only keeps new big files from being added.
 * Returns the commit or null.
 */
export async function commitUserEdits(project: ProjectConfig): Promise<string | null> {
  if (!project.localGit) return null;
  const root = project.repo;
  const cur = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (cur !== project.baseBranch) throw new Error(`folder is on branch '${cur}', expected '${project.baseBranch}'`);
  if (await isClean(root)) return null;
  const stats = await scanFolder(root, project.ignore ?? []);
  await dropTracked(root, stats);
  await writeExclude(root, stats, project.ignore ?? []);
  await git(root, ["add", "-A"]);
  if (await isClean(root)) return null;
  await git(root, ["commit", "-q", "-m", "gencouncil: 사용자 변경 반영"]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}
