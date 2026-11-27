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
const AGENT_PROGRAMS = ["claude.exe", "codex.exe", "agy.exe", "grok.exe", "node.exe", "bash.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "python.exe", "py.exe"];

/**
 * Stop agent/shell processes whose command line mentions dir (a member worktree). Catches trees whose
 * recorded root already exited: Codex members run as cmd.exe -> node codex.js -C <worktree> -> codex.exe,
 * Claude members pass <worktree>/.council/mcp.json, and their test scripts run from the worktree.
 * Returns the stopped pids.
 */
export async function stopProcessesUnder(dir: string): Promise<number[]> {
  if (process.platform !== "win32" || !dir) return [];
  // the same folder as Windows (D:\x), forward-slash (D:/x) and Git Bash (/d/x) paths
  const win = dir.replace(/[\\/]+$/, "");
  const fwd = win.replace(/\\/g, "/");
  const bash = fwd.replace(/^([A-Za-z]):/, (_m, d: string) => "/" + d.toLowerCase());
  // the path must end where the needle ends: a plain substring match makes claude-6 match claude-69
  const alts = [...new Set([win, fwd, bash])].map((n) => n.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|");
  const pattern = `(?:${alts})(?:["'\\s\\\\/,;]|$)`.replace(/'/g, "''");
  const names = AGENT_PROGRAMS.map((n) => `'${n}'`).join(",");
  const script =
    `$n=@(${names}); $re='${pattern}'; Get-CimInstance Win32_Process | Where-Object { $n -contains $_.Name.ToLower() -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -imatch $re } | ForEach-Object { $_.ProcessId }`;
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

export interface TrackedProcess {
  pid: number;
  startedAt: string;
}

/**
 * All live descendants of the given root pids, with their start times (one process-table read).
 * Members start browsers, dev servers and test scripts whose command lines need not mention the
 * worktree; remembering them while the member runs lets a later cleanup stop them even after the
 * member itself died.
 */
export async function snapshotDescendants(roots: number[]): Promise<Map<number, TrackedProcess[]>> {
  const out = new Map<number, TrackedProcess[]>();
  if (process.platform !== "win32" || roots.length === 0) return out;
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }";
  const text = await new Promise<string>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  const children = new Map<number, TrackedProcess[]>();
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, started] = line.trim().split(" ");
    const p = Number(pid);
    const pp = Number(ppid);
    if (!Number.isFinite(p) || !Number.isFinite(pp) || !started) continue;
    const list = children.get(pp) ?? [];
    list.push({ pid: p, startedAt: started });
    children.set(pp, list);
  }
  for (const root of roots) {
    const found: TrackedProcess[] = [];
    const queue = [root];
    const seen = new Set<number>([root]);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const c of children.get(cur) ?? []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        found.push(c);
        queue.push(c.pid);
      }
    }
    out.set(root, found);
  }
  return out;
}

/** stop remembered descendants that are still the same processes (start time matches) */
export async function stopTracked(list: TrackedProcess[] | undefined): Promise<number> {
  let n = 0;
  for (const t of list ?? []) if (await stopLeftover(t.pid, t.startedAt)) n++;
  return n;
}

/**
 * Shell pipeline filters a member leaves behind. A member running `tail -f x.log | grep ...` in a
 * background shell leaves these alive when the shell dies: on Windows nothing reaps them, and
 * `taskkill /t` can no longer reach them because their parent is already gone. They do nothing but
 * hold memory and handles — 170 of them, five days old, was the state that prompted this.
 *
 * Only pure filters are on the list: with a dead parent nobody is reading their output, so killing
 * one cannot interrupt work. Anything that could be doing work on its own (node, python, a CLI, a
 * shell) is never touched here — those are handled by worktree, in stopProcessesUnder.
 */
const STRAY_FILTERS = ["tail.exe", "grep.exe", "sleep.exe", "cut.exe", "head.exe", "sed.exe", "awk.exe", "wc.exe", "sort.exe", "uniq.exe", "tr.exe", "xargs.exe"];

/**
 * Kill orphaned pipeline filters: parent already dead, and older than minAgeMinutes (a filter in a
 * pipeline being set up right now is young and its shell may be a moment behind). Returns how many
 * of each program was stopped.
 */
export async function reapStrays(opts: { minAgeMinutes?: number; pids?: number[] } = {}): Promise<Record<string, number>> {
  if (process.platform !== "win32") return {};
  if (opts.pids && opts.pids.length === 0) return {};
  const minutes = opts.minAgeMinutes ?? 10;
  const names = STRAY_FILTERS.map((n) => `'${n}'`).join(",");
  // pids narrows the sweep to a known set (the test's own processes); without it, every orphan goes
  const only = opts.pids ? ` -and @(${opts.pids.map((p) => String(Math.trunc(p))).join(",")}) -contains [int]$_.ProcessId` : "";
  const script = [
    `$names=@(${names})`,
    "$live=@{}; Get-Process | ForEach-Object { $live[[int]$_.Id]=$true }",
    `$cut=(Get-Date).AddMinutes(-${minutes})`,
    `Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name.ToLower() -and -not $live.ContainsKey([int]$_.ParentProcessId) -and $_.CreationDate -lt $cut${only} } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.Name } catch {} }`,
  ].join("; ");
  const text = await new Promise<string>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? "" : String(stdout)),
    );
  });
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim().toLowerCase();
    if (name) out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}
