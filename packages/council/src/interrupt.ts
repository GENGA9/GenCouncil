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
