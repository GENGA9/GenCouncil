/** Folder browser for the "add project" dialog (directories only, authenticated route). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FolderEntry {
  name: string;
  path: string;
  git?: boolean;
}

export interface FolderListing {
  path: string;
  parent?: string;
  entries: FolderEntry[];
  roots: FolderEntry[];
}

const SKIP = new Set(["$recycle.bin", "system volume information", "node_modules", ".git", "windows", "programdata", "recovery", "$windows.~ws"]);

function roots(): FolderEntry[] {
  const out: FolderEntry[] = [{ name: "홈", path: os.homedir() }];
  if (process.platform === "win32") {
    for (let c = 65; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try {
        fs.accessSync(d);
        out.push({ name: d, path: d });
      } catch {
        /* no drive */
      }
    }
  } else {
    out.push({ name: "/", path: "/" });
  }
  return out;
}

export async function listFolder(p: string, isRepo: (dir: string) => Promise<boolean>): Promise<FolderListing> {
  const dir = p ? path.resolve(p) : os.homedir();
  let entries: FolderEntry[] = [];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name.toLowerCase()))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    throw new Error(`cannot read ${dir}: ${(e as Error).message}`);
  }
  // mark git repos (cheap check: a .git entry), capped to keep big folders fast
  for (const e of entries.slice(0, 300)) e.git = fs.existsSync(path.join(e.path, ".git"));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir ? parent : undefined, entries, roots: roots() };
  void isRepo;
}
