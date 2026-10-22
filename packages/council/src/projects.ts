import fs from "node:fs";
import path from "node:path";
import { slugify } from "@gencouncil/core";
import { currentBranch, git, hasCommits, isRepo } from "./git.js";
import { councilName, ProjectRegistry, type Autonomy, type ProjectConfig } from "./model.js";
import type { CliProvider, Limits } from "./models.js";
import { initShadow, shadowDir } from "./shadow.js";

export interface CreateProjectInput {
  /** project name; " 제작위원회" is appended when missing */
  name: string;
  /** the folder to work on (a git repository or any folder) */
  path: string;
  /** "auto" (default): git when the folder is the top of a repo with commits, otherwise folder mode */
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

/** Register a project. Non-git folders get a private shadow repo; the folder itself is never touched until an agenda finishes. */
export async function createProject(input: CreateProjectInput, registry = new ProjectRegistry()): Promise<ProjectConfig> {
  const folder = path.resolve(input.path);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`folder not found: ${folder}`);
  const name = councilName(input.name);
  const id = slugify(name, 60);
  if (registry.get(id)) throw new Error(`project already exists: ${id}`);

  const gitRoot = await isRepoRoot(folder);
  const mode = input.mode === "folder" || (input.mode !== "git" && !gitRoot) ? "folder" : "git";
  if (mode === "git" && !gitRoot) throw new Error(`not the top of a git repository with commits: ${folder}`);

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
  if (mode === "git") {
    return registry.add({ ...common, repo: folder, mode: "git", baseBranch: input.baseBranch ?? (await currentBranch(folder)) });
  }
  const shadow = shadowDir(id);
  await initShadow(folder, shadow);
  return registry.add({ ...common, repo: shadow, mode: "folder", source: folder, baseBranch: "main" });
}
