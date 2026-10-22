import fs from "node:fs";
import path from "node:path";
import { slugify } from "@gencouncil/core";
import { currentBranch, git, hasCommits, isRepo } from "./git.js";
import { councilName, ProjectRegistry, type Autonomy, type ProjectConfig } from "./model.js";
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

/** Register a project. A folder that isn't a repository gets a local git (never pushed) with environments, binaries and big media excluded. */
export async function createProject(input: CreateProjectInput, registry = new ProjectRegistry()): Promise<ProjectConfig & { scan?: ScanStats; scanSummary?: string }> {
  const folder = path.resolve(input.path);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`folder not found: ${folder}`);
  const name = councilName(input.name);
  const id = slugify(name, 60);
  if (registry.get(id)) throw new Error(`project already exists: ${id}`);

  const gitRoot = await isRepoRoot(folder);
  const common = {
    name,
    chairModel: input.chairModel,
    chairEffort: input.chairEffort,
    chairAdvisor: input.chairAdvisor,
    chairAccount: input.chairAccount,
    autonomy: input.autonomy,
    defaultProvider: input.defaultProvider,
    limits: input.limits,
  };
  if (gitRoot && input.mode !== "folder") {
    return registry.add({ ...common, repo: folder, mode: "git", baseBranch: input.baseBranch ?? (await currentBranch(folder)) });
  }
  if (input.mode === "git") throw new Error(`not the top of a git repository with commits: ${folder}`);
  // not a repository: a local git right in the folder, environments/binaries/big media excluded
  const scan = await initLocalGit(folder);
  const cfg = registry.add({ ...common, repo: folder, mode: "git", localGit: true, baseBranch: "main" });
  return { ...cfg, scan: { ...scan, skippedPaths: [] }, scanSummary: describeScan(scan) };
}
