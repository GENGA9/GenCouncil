import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || "") + (stderr || "") });
    });
  });
}

export async function gitAvailable(): Promise<boolean> {
  const r = await run(process.cwd(), ["--version"]);
  return r.ok;
}

/** Initialise a repo in `dir` if there is none. Best effort. */
export async function ensureRepo(dir: string): Promise<boolean> {
  if (fs.existsSync(path.join(dir, ".git"))) return true;
  if (!(await gitAvailable())) return false;
  const r = await run(dir, ["init", "-q"]);
  if (!r.ok) return false;
  // keep memory history readable; no fancy config
  await run(dir, ["config", "user.name", process.env.GENCOUNCIL_GIT_USER ?? "gencouncil"]);
  await run(dir, ["config", "user.email", process.env.GENCOUNCIL_GIT_EMAIL ?? "gencouncil@local"]);
  return true;
}

let chain: Promise<void> = Promise.resolve();

/** Stage everything and commit, serialised so concurrent writers don't race. Best effort. */
export function commitAll(dir: string, message: string): Promise<void> {
  chain = chain.then(async () => {
    if (!fs.existsSync(path.join(dir, ".git"))) return;
    await run(dir, ["add", "-A"]);
    await run(dir, ["commit", "-q", "-m", message]);
  });
  return chain;
}
