import fs from "node:fs";
import path from "node:path";
import { slugify } from "@gencouncil/core";
import { currentBranch, git, hasCommits, isRepo } from "./git.js";
import { AgendaStore, councilName, ProjectRegistry, type Autonomy, type ProjectConfig } from "./model.js";
import type { CliProvider, Limits } from "./models.js";
import { describeScan, initLocalGit, type ScanStats } from "./localgit.js";

export interface CreateProjectInput {
  /** project name; " 제작위원회" is appended when missing */
  name: string;
  /** the folder to work on (a git repository or any folder) */
  path: string;
  /** "auto" (default): use the repo when the folder is the top of one with commits, otherwise create a local git there */
  mode?: "auto" | "git" | "folder";
  baseBranch?: string;
  chairModel?: string;
  chairEffort?: string;
  chairAdvisor?: string;
  chairDirectEdit?: boolean;
  chairAccount?: string;
  autonomy?: Autonomy;
  defaultProvider?: CliProvider;
  limits?: Partial<Limits>;
}

async function isRepoRoot(dir: string): Promise<boolean> {
  if (!(await isRepo(dir)) || !(await hasCommits(dir))) return false;
  try {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    return path.resolve(top).toLowerCase() === path.resolve(dir).toLowerCase();
  } catch {
    return false;
  }
}

export interface ResolvedFolder {
  repo: string;
  localGit: boolean;
  baseBranch: string;
  scan?: ScanStats;
  scanSummary?: string;
}

/**
 * Decide how to work on a folder: the top of a git repository with commits is used as is,
 * anything else gets a local git right there (never pushed) with environments, binaries and big media excluded.
 */
export async function resolveFolder(input: { path: string; mode?: "auto" | "git" | "folder"; baseBranch?: string }): Promise<ResolvedFolder> {
  const folder = path.resolve(input.path);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`folder not found: ${folder}`);
  const gitRoot = await isRepoRoot(folder);
  if (gitRoot && input.mode !== "folder") return { repo: folder, localGit: false, baseBranch: input.baseBranch ?? (await currentBranch(folder)) };
  if (input.mode === "git") throw new Error(`not the top of a git repository with commits: ${folder}`);
  const scan = await initLocalGit(folder);
  return { repo: folder, localGit: true, baseBranch: "main", scan: { ...scan, skippedPaths: [] }, scanSummary: describeScan(scan) };
}

/** Register a project. */
export async function createProject(input: CreateProjectInput, registry = new ProjectRegistry()): Promise<ProjectConfig & { scan?: ScanStats; scanSummary?: string }> {
  const name = councilName(input.name);
  const id = slugify(name, 60);
  if (registry.get(id)) throw new Error(`project already exists: ${id}`);
  const r = await resolveFolder(input);
  const cfg = registry.add({
    name,
    repo: r.repo,
    mode: "git",
    localGit: r.localGit,
    baseBranch: r.baseBranch,
    chairModel: input.chairModel,
    chairEffort: input.chairEffort,
    chairAdvisor: input.chairAdvisor,
    chairDirectEdit: input.chairDirectEdit,
    chairAccount: input.chairAccount,
    autonomy: input.autonomy,
    defaultProvider: input.defaultProvider,
    limits: input.limits,
  });
  return { ...cfg, scan: r.scan, scanSummary: r.scanSummary };
}

/** Change a project's name and/or folder. The id (and its data folder) stays the same. */
export async function updateProject(
  id: string,
  patch: { name?: string; path?: string },
  registry = new ProjectRegistry(),
): Promise<ProjectConfig & { scanSummary?: string }> {
  const p = registry.get(id);
  if (!p) throw new Error(`unknown project: ${id}`);
  let scanSummary: string | undefined;
  if (patch.name?.trim()) p.name = councilName(patch.name);
  if (patch.path?.trim() && path.resolve(patch.path).toLowerCase() !== path.resolve(p.repo).toLowerCase()) {
    const open = AgendaStore.list(p).filter((a) => a.status === "open" && (new AgendaStore(p, a.slug).tasks().length > 0 || new AgendaStore(p, a.slug).members().length > 0));
    if (open.length) throw new Error(`진행 중인 안건이 있어 폴더를 바꿀 수 없습니다: ${open.map((a) => a.title).join(", ")}. 안건을 종료하거나 정리한 뒤 바꾸세요.`);
    const r = await resolveFolder({ path: patch.path });
    p.repo = r.repo;
    p.localGit = r.localGit || undefined;
    p.baseBranch = r.baseBranch;
    // empty open agendas follow the new folder's base branch
    for (const a of AgendaStore.list(p)) {
      if (a.status !== "open") continue;
      const store = new AgendaStore(p, a.slug);
      store.saveAgenda({ ...a, baseBranch: r.baseBranch });
    }
    scanSummary = r.scanSummary;
  }
  registry.save(p);
  return { ...p, scanSummary };
}
