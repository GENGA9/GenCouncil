/**
 * Visible windows on the user's PC: login consoles for CLI accounts and Chrome
 * windows for web accounts (web Gemini, AI Studio, ChatGPT).
 */
import { spawn } from "node:child_process";
import { AccountRegistry, findChrome, isWebSite, loginCommand, type Account } from "./accounts.js";
import { findExecutable } from "./drivers.js";
import { SITE_INFO, type WebSite } from "./models.js";

function quote(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Open a login window for the account. Returns the hint to show the user. */
export function openLoginWindow(account: Account, registry = new AccountRegistry()): string {
  const cmd = loginCommand(account, registry, findChrome());
  if (cmd.kind === "browser") {
    spawn(cmd.exe, cmd.args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
  } else {
    const exe = findExecutable(cmd.exe);
    if (!exe) throw new Error(`${cmd.exe} CLI not found on PATH`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...cmd.env };
    delete env.CLAUDECODE;
    if (process.platform === "win32") {
      const line = [quote(exe), ...cmd.args.map(quote)].join(" ");
      spawn("cmd.exe", ["/d", "/c", `start "GenCouncil 로그인 - ${account.id.replace(/[^\p{L}\p{N}_.@ -]/gu, "_")}" cmd /k ${line}`], {
        env,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      throw new Error(`open a terminal and run: ${Object.entries(cmd.env).map(([k, v]) => `${k}=${v} `).join("")}${cmd.exe} ${cmd.args.join(" ")}`);
    }
  }
  registry.markLoginOpened(account.id);
  return cmd.hint;
}

/** Open the web AI for a relay member in its account's Chrome profile (or plain Chrome). */
export function openWebSite(site: WebSite, account?: Account): void {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome not found");
  const args = ["--no-first-run", "--no-default-browser-check", "--new-window", SITE_INFO[site].url];
  if (account?.configDir && isWebSite(account.provider)) args.unshift(`--user-data-dir=${account.configDir}`);
  spawn(chrome, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
