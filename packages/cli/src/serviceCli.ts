/**
 * Keep the web server resident: a Windows logon task that runs `gencouncil web` hidden.
 * (schtasks ONLOGON; no admin needed. On other platforms we print what to do.)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gencouncilHome } from "@gencouncil/core";
import { loadServerConfig } from "@gencouncil/server";

export const SERVICE_HELP = `service
  service install [--dry-run]    register a logon task "GenCouncilWeb" that starts the web server hidden
  service uninstall              remove the task
  service start | stop | status  control the task / server
  service logs [--lines n]       tail ~/.gencouncil/service/web.log
`;

const TASK = "GenCouncilWeb";

function cliEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function serviceDir(): string {
  return path.join(gencouncilHome(), "service");
}

function schtasks(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("schtasks", args, { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function writeLaunchers(): { cmd: string; vbs: string; log: string } {
  const dir = serviceDir();
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "web.log");
  const cmd = path.join(dir, "gencouncil-web.cmd");
  const vbs = path.join(dir, "gencouncil-web.vbs");
  const home = gencouncilHome();
  fs.writeFileSync(
    cmd,
    [
      "@echo off",
      `set "GENCOUNCIL_HOME=${home}"`,
      `cd /d "${path.dirname(cliEntry())}"`,
      `"${process.execPath}" "${cliEntry()}" web >> "${log}" 2>&1`,
      "",
    ].join("\r\n"),
    "utf8",
  );
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${cmd}""", 0, False\r\n`, "utf8");
  return { cmd, vbs, log };
}

function listeningPids(port: number): number[] {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  const pids = new Set<number>();
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!/LISTENING/.test(line) || !line.includes(`:${port} `)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (pid) pids.add(pid);
  }
  return [...pids];
}

export async function serviceMain(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (process.platform !== "win32" && sub !== "logs") {
    console.log("service: only the Windows logon-task installer is implemented. On macOS use a LaunchAgent, on Linux a systemd --user unit, running: gencouncil web");
    return 2;
  }
  const cfg = loadServerConfig();
  switch (sub) {
    case "install": {
      const dry = rest.includes("--dry-run");
      const { vbs, log } = writeLaunchers();
      const args = ["/Create", "/TN", TASK, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", `wscript.exe "${vbs}"`];
      if (dry) {
        console.log(`schtasks ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
        console.log(`launcher: ${vbs}\nlog: ${log}`);
        return 0;
      }
      const r = schtasks(args);
      console.log(r.out);
      if (!r.ok) return 1;
      console.log(`installed. starts at next logon; start now with: gencouncil service start\nlog: ${log}`);
      return 0;
    }
    case "uninstall": {
      const r = schtasks(["/Delete", "/TN", TASK, "/F"]);
      console.log(r.out || "removed");
      return r.ok ? 0 : 1;
    }
    case "start": {
      if (listeningPids(cfg.port).length) {
        console.log(`already running on port ${cfg.port}`);
        return 0;
      }
      const r = schtasks(["/Run", "/TN", TASK]);
      if (!r.ok) {
        console.log(`${r.out}\n(task not installed? run: gencouncil service install)`);
        return 1;
      }
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 500));
        if (listeningPids(cfg.port).length) {
          console.log(`running on http://localhost:${cfg.port}`);
          return 0;
        }
      }
      console.log("started the task but the server is not listening yet; check: gencouncil service logs");
      return 1;
    }
    case "stop": {
      schtasks(["/End", "/TN", TASK]);
      const pids = listeningPids(cfg.port);
      for (const pid of pids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      console.log(pids.length ? `stopped (pid ${pids.join(", ")})` : "not running");
      return 0;
    }
    case "status": {
      const q = schtasks(["/Query", "/TN", TASK, "/FO", "LIST"]);
      const pids = listeningPids(cfg.port);
      console.log(`task     : ${q.ok ? "installed" : "not installed"}`);
      if (q.ok) {
        const st = /(Status|상태):\s*(.+)/.exec(q.out);
        if (st) console.log(`task st. : ${st[2].trim()}`);
      }
      console.log(`server   : ${pids.length ? `listening on ${cfg.port} (pid ${pids.join(", ")})` : "not running"}`);
      console.log(`log      : ${path.join(serviceDir(), "web.log")}`);
      return 0;
    }
    case "logs": {
      const n = Number(rest[rest.indexOf("--lines") + 1]) || 50;
      const log = path.join(serviceDir(), "web.log");
      if (!fs.existsSync(log)) {
        console.log("(no log yet)");
        return 0;
      }
      const lines = fs.readFileSync(log, "utf8").split("\n");
      console.log(lines.slice(-n).join("\n"));
      return 0;
    }
    default:
      process.stdout.write(SERVICE_HELP);
      return 2;
  }
}
