/**
 * `gencouncil desktop`: open the console as a desktop window without Tauri —
 * Edge/Chrome "app mode" pointed at the local server (started here if needed).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "@gencouncil/server";

export const DESKTOP_HELP = `desktop
  desktop [--browser edge|chrome] [--no-start]   open the console in an app-mode window (starts the server if needed)
`;

const BROWSERS: Record<string, string[]> = {
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findBrowser(prefer?: string): string | undefined {
  const order = prefer ? [prefer, ...Object.keys(BROWSERS).filter((b) => b !== prefer)] : ["edge", "chrome"];
  for (const b of order) for (const p of BROWSERS[b] ?? []) if (fs.existsSync(p)) return p;
  return undefined;
}

async function serverUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/me`);
    return r.status === 401 || r.status === 200;
  } catch {
    return false;
  }
}

export async function desktopMain(rest: string[]): Promise<number> {
  const cfg = loadServerConfig();
  const prefer = rest.includes("--browser") ? rest[rest.indexOf("--browser") + 1] : undefined;
  if (!(await serverUp(cfg.port))) {
    if (rest.includes("--no-start")) {
      console.error(`server not running on ${cfg.port}; start it with: gencouncil web`);
      return 1;
    }
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
    const child = spawn(process.execPath, [cli, "web"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 30 && !(await serverUp(cfg.port)); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await serverUp(cfg.port))) {
      console.error("could not start the web server");
      return 1;
    }
    console.log(`started web server on port ${cfg.port} (pid ${child.pid})`);
  }
  const url = `http://localhost:${cfg.port}/auth?token=${encodeURIComponent(cfg.token)}`;
  const exe = findBrowser(prefer);
  if (process.platform === "win32" && exe) {
    // a separate browser profile so the app window keeps its own cookie and never mixes with normal browsing
    const profile = path.join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".", "GenCouncilDesktop");
    spawn(exe, [`--app=${url}`, "--window-size=1400,900", `--user-data-dir=${profile}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    console.log(`opened ${path.basename(exe)} app window at http://localhost:${cfg.port}`);
    return 0;
  }
  // fallback: default browser
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawnSync(opener[0] as string, opener[1] as string[], { windowsHide: true });
  console.log(`opened default browser at http://localhost:${cfg.port}`);
  return 0;
}
