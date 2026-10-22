import os from "node:os";
import path from "node:path";

/**
 * Runtime data lives outside the repo so the code can be updated freely.
 *   GENCOUNCIL_HOME (default ~/.gencouncil)
 *     space/
 *       memory/          <- shared memory entries (git-tracked)
 *         INDEX.md
 *         solutions/ tools/ conventions/ accounts/ personas/ proposals/
 */
export function gencouncilHome(): string {
  const env = process.env.GENCOUNCIL_HOME;
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), ".gencouncil");
}

export function spaceDir(): string {
  return path.join(gencouncilHome(), "space");
}

export function memoryDir(): string {
  return path.join(spaceDir(), "memory");
}
