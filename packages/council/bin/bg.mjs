#!/usr/bin/env node
// GenCouncil background job runner.
//
//   node bg.mjs --title "<what>" --log <file> [--cwd <dir>] -- <command> [args...]
//
// Starts the command in its own console window that the user can see, outside the member's
// process tree (so it keeps running after the member's turn ends). The window shows the output as
// it comes, the same output is appended to the log file (UTF-8), and when the command ends the
// window stays open with the exit code, so the user can read what happened and close it.
// Prints one line: `bg started pid=<pid> log=<file>`.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

function usage(msg) {
  if (msg) console.error(`bg: ${msg}`);
  console.error('usage: node bg.mjs --title "<what>" --log <file> [--cwd <dir>] -- <command> [args...]');
  process.exit(2);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

if (argv[0] === "--run") {
  // inside the new console window
  const job = JSON.parse(Buffer.from(argv[1], "base64").toString("utf8"));
  runJob(job);
} else {
  launch();
}

function launch() {
  const opts = { title: "", log: "", cwd: process.cwd() };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--title") opts.title = argv[++i] ?? "";
    else if (a === "--log") opts.log = argv[++i] ?? "";
    else if (a === "--cwd") opts.cwd = argv[++i] ?? "";
    else usage(`unknown option ${a}`);
  }
  const cmd = argv.slice(i);
  if (!cmd.length) usage("no command after --");
  if (!opts.log) usage("--log is required");
  if (!opts.title) opts.title = path.basename(cmd[0]);
  const cwd = path.resolve(opts.cwd);
  const log = path.resolve(cwd, opts.log);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const job = { title: opts.title, log, cwd, cmd };
  const payload = Buffer.from(JSON.stringify(job), "utf8").toString("base64");

  if (process.platform !== "win32") {
    const child = spawn(process.execPath, [self, "--run", payload], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    console.log(`bg started pid=${child.pid} log=${log}`);
    return;
  }
  // WMI creates the process outside the caller's job and process tree, in a new console window.
  // the runner keeps the window open after the job ends (with the result in its title)
  const line = `"${process.execPath}" "${self}" --run ${payload}`;
  const ps =
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:GC_BG_LINE; CurrentDirectory = $env:GC_BG_CWD };" +
    "\"$($r.ReturnValue) $($r.ProcessId)\"";
  let out;
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GC_BG_LINE: line, GC_BG_CWD: cwd },
    }).trim();
  } catch (e) {
    console.error(`bg: could not start: ${e.message}`);
    process.exit(1);
  }
  const [rv, pid] = out.split(/\s+/);
  if (rv !== "0") {
    console.error(`bg: Win32_Process.Create returned ${rv}`);
    process.exit(1);
  }
  console.log(`bg started pid=${pid} log=${log}`);
}

function runJob(job) {
  const setTitle = (t) => {
    process.title = t;
  };
  setTitle(`[실행 중] ${job.title}`);
  const logStream = fs.createWriteStream(job.log, { flags: "a" });
  const both = (s) => {
    process.stdout.write(s);
    logStream.write(s);
  };
  const started = Date.now();
  both(`=== ${stamp()} 시작: ${job.title}\n=== 폴더: ${job.cwd}\n=== 명령: ${job.cmd.join(" ")}\n=== 로그: ${job.log}\n\n`);
  const child = spawn(job.cmd[0], job.cmd.slice(1), {
    cwd: job.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // .cmd/.bat need the shell on Windows; anything else is found on PATH directly
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(job.cmd[0]),
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", FORCE_COLOR: "0" },
  });
  child.stdout.on("data", (b) => both(b.toString("utf8")));
  child.stderr.on("data", (b) => both(b.toString("utf8")));
  const finish = (code, note) => {
    const mins = Math.round((Date.now() - started) / 60000);
    const ok = code === 0;
    both(`\n=== ${stamp()} ${ok ? "끝남" : "실패"}: exit ${code}${note ? " (" + note + ")" : ""}, ${mins}분 걸림\n`);
    if (process.platform === "win32") both("=== 이 창은 확인용으로 남겨 둔다. 다 봤으면 닫으면 된다.\n");
    setTitle(`[${ok ? "끝남" : "실패 " + code}] ${job.title}`);
    logStream.end(() => {
      // keep the window (and its title) until the user closes it
      if (process.platform === "win32") setInterval(() => {}, 1 << 30);
      else process.exit(0);
    });
  };
  child.on("error", (e) => finish(-1, e.message));
  child.on("close", (code, signal) => finish(code ?? -1, signal ? `signal ${signal}` : ""));
}
