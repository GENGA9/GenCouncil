/**
 * Leftovers of an interrupted run. On Windows, killing the server does not kill the CLI
 * processes it started, so a member or chair can keep running unattended. Before work is
 * resumed we stop such a process, but only when the pid still belongs to a process that
 * started when ours did (pids get reused).
 */
import { execFile, spawn } from "node:child_process";

function startTimeOf(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try {
        process.kill(pid, 0);
        resolve(Number.NaN); // alive, start time unknown
      } catch {
        resolve(undefined);
      }
      return;
    }
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      const t = Date.parse(String(stdout).trim());
      resolve(err || !Number.isFinite(t) ? undefined : t);
    });
  });
}

/**
 * Stop a leftover process tree. Returns true when something was stopped.
 * startedAt is when we spawned it; a process that started more than 2 minutes away from
 * that belongs to someone else and is left alone.
 */
export async function stopLeftover(pid: number | undefined, startedAt: string | undefined): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  const started = await startTimeOf(pid);
  if (started === undefined) return false;
  if (Number.isFinite(started) && startedAt) {
    const ours = Date.parse(startedAt);
    if (Number.isFinite(ours) && Math.abs(started - ours) > 2 * 60_000) return false;
  }
  if (process.platform === "win32") {
    await new Promise<void>((r) => {
      const k = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
      k.on("close", () => r());
      k.on("error", () => r());
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  return true;
}

/** programs a member can leave behind; anything else (an editor open on the folder) is never stopped */
const AGENT_PROGRAMS = ["claude.exe", "codex.exe", "agy.exe", "node.exe", "bash.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "python.exe", "py.exe"];

/**
 * Stop agent/shell processes whose command line mentions dir (a member worktree). Catches trees whose
 * recorded root already exited: Codex members run as cmd.exe -> node codex.js -C <worktree> -> codex.exe,
 * Claude members pass <worktree>/.council/mcp.json, and their test scripts run from the worktree.
 * Returns the stopped pids.
 */
export async function stopProcessesUnder(dir: string): Promise<number[]> {
  if (process.platform !== "win32" || !dir) return [];
  const needle = dir.replace(/[\/]+$/, "").replace(/'/g, "''");
  const names = AGENT_PROGRAMS.map((n) => `'${n}'`).join(",");
  const script =
    `$n=@(${names}); Get-CimInstance Win32_Process | Where-Object { $n -contains $_.Name.ToLower() -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf('${needle}', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }`;
  const pids = await new Promise<number[]>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0));
    });
  });
  for (const pid of pids) {
    await new Promise<void>((r) => {
      const k = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
      k.on("close", () => r());
      k.on("error", () => r());
    });
  }
  return pids;
}
