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
  desktop [--browser chrome|edge] [--no-start]   open the console in an app-mode window (starts the server if needed)
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

function findBrowser(prefer?: string): { kind: string; exe: string } | undefined {
  // Chrome first: a fresh Edge profile stalls on Edge's first-run wizard in --app mode (blank window,
  // and --no-first-run does not skip it), so Edge is only used with the user's normal profile.
  const order = prefer ? [prefer, ...Object.keys(BROWSERS).filter((b) => b !== prefer)] : ["chrome", "edge"];
  for (const kind of order) for (const exe of BROWSERS[kind] ?? []) if (fs.existsSync(exe)) return { kind, exe };
  return undefined;
}

/** app-mode command line for the browser */
export function appArgs(kind: string, url: string, localAppData: string): string[] {
  const args = [`--app=${url}`, "--window-size=1400,900"];
  if (kind === "chrome") {
    // own profile: the token cookie stays out of normal browsing
    args.push(`--user-data-dir=${path.join(localAppData, "GenCouncilDesktop-chrome")}`, "--no-first-run", "--no-default-browser-check");
  }
  return args;
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
  const browser = findBrowser(prefer);
  if (process.platform === "win32" && browser) {
    const args = appArgs(browser.kind, url, process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".");
    // windowsHide must stay off: it starts the browser with SW_HIDE and the app window comes up blank and frameless
    spawn(browser.exe, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    console.log(`opened ${browser.kind} app window at http://localhost:${cfg.port}`);
    return 0;
  }
  // fallback: default browser
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawnSync(opener[0] as string, opener[1] as string[], { windowsHide: true });
  console.log(`opened default browser at http://localhost:${cfg.port}`);
  return 0;
}
