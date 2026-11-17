// CLI launchers on Windows: arguments reach a .cmd file exactly as given, and none of them can run a command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LimitError, normalizeLimits, npmShimTarget, resolveModel, spawnCli } from "@gencouncil/council";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

// ---- model names never carry shell text ----
const limit = normalizeLimits({}).gpt;
const refuses = (m) => {
  try {
    resolveModel("gpt", m, limit);
    return false;
  } catch (e) {
    return e instanceof LimitError;
  }
};
check("model name with a quote and a command is refused", refuses('gpt-6.1-sol" & calc & rem "'));
check("model name with a space is refused", refuses("gpt-6.1-sol --yolo"));
check("model name with % is refused", refuses("gpt-6.1-sol%PATH%"));
check("a plain model name still resolves", resolveModel("gpt", "gpt-6.1-sol", limit) === "gpt-6.1-sol");

if (process.platform !== "win32") {
  console.log("skip .cmd launcher checks (not Windows)");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-spawn-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(path.join(bin, "node_modules", "pkg"), { recursive: true });
  const echo = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";
  fs.writeFileSync(path.join(tmp, "echo.cjs"), echo);
  fs.writeFileSync(path.join(bin, "node_modules", "pkg", "cli.js"), echo);
  // a hand-written batch launcher: goes through cmd.exe
  fs.writeFileSync(path.join(bin, "gcplain.cmd"), '@ECHO off\r\n"%GC_NODE%" "%GC_ECHO%" %*\r\n');
  // what npm writes for a global package: started as its node script, without cmd.exe
  fs.writeFileSync(
    path.join(bin, "gcnpm.cmd"),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*\r\n',
  );
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GC_NODE: process.execPath, GC_ECHO: path.join(tmp, "echo.cjs") };
  process.env.PATH = env.PATH;

  const run = (name, args) =>
    new Promise((resolve) => {
      let out = "";
      let child;
      try {
        child = spawnCli(name, args, { cwd: tmp, env });
      } catch (e) {
        resolve({ thrown: e.message });
        return;
      }
      child.stdout.on("data", (d) => (out += d));
      child.on("error", (e) => resolve({ thrown: e.message }));
      child.on("close", () => {
        try {
          resolve({ args: JSON.parse(out) });
        } catch {
          resolve({ out });
        }
      });
    });

  const marker = path.join(tmp, "injected.txt");
  const args = [
    "plain",
    "two words",
    `gpt-6.1-sol" & echo x>"${marker}" & rem "`,
    `x & echo y>${marker}`,
    "%PATH%",
    "%GC_NODE%",
    "a^b",
    "x&y|z<q>w",
    "(paren)",
    "bang!",
    'q"uo"te',
    "back\\slash\\",
    'tail\\"',
    "",
    "한글 인자",
    "sandbox_mode='read-only'",
    "a,b;c=d",
    "*?.txt",
    "`tick`",
    "%%",
    "^^",
  ];
  check("npm launcher is recognised", npmShimTarget(path.join(bin, "gcnpm.cmd"))?.script === path.join(bin, "node_modules", "pkg", "cli.js"));
  check("a hand-written launcher is not taken for an npm one", npmShimTarget(path.join(bin, "gcplain.cmd")) === undefined);
  for (const name of ["gcplain", "gcnpm"]) {
    const r = await run(name, args);
    const bad = args.map((a, i) => (r.args?.[i] === a ? undefined : `[${i}] ${JSON.stringify(a)} -> ${JSON.stringify(r.args?.[i])}`)).filter(Boolean);
    check(`${name}: every argument arrives unchanged`, Array.isArray(r.args) && r.args.length === args.length && !bad.length, bad.join("; ") || JSON.stringify(r).slice(0, 300));
  }
  check("no argument ran a command", !fs.existsSync(marker));
  const multi = await run("gcnpm", ["line1\nline2\nline3"]);
  check("npm launcher: an argument keeps its line breaks", multi.args?.[0] === "line1\nline2\nline3", JSON.stringify(multi));
  const refused = await run("gcplain", ["line1\nline2"]);
  check("batch launcher: a line break is refused, not cut off", /line break/.test(refused.thrown ?? ""), JSON.stringify(refused));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall spawn checks passed");
process.exitCode = failed ? 1 : 0;
