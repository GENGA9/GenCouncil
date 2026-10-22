/**
 * Register the GenCouncil MCP server with local AI CLIs and drop a short
 * usage rule into their global instruction files.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Target = "claude" | "gemini" | "antigravity";

export interface InstallOptions {
  role?: "owner" | "chair" | "member";
  /** also write the usage rule block into CLAUDE.md / GEMINI.md (default true) */
  rules?: boolean;
  /** print what would be done */
  dryRun?: boolean;
}

export function serverEntry(): string {
  // dist/install.js -> dist/server.js
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");
}

function nodeExe(): string {
  return process.execPath;
}

const MARK_START = "<!-- gencouncil:start -->";
const MARK_END = "<!-- gencouncil:end -->";

export function rulesBlock(): string {
  return `${MARK_START}
## GenCouncil 공유 기억 (Space Memory)

- 작업을 시작할 때, 막혔을 때, 도구 위치나 실행법이 필요할 때는 \`memory_search\`로 먼저 찾는다. 전체 목록은 \`memory_index\`.
- 재사용 가치가 있는 것(비자명한 해결책, 도구 위치, 규약, 계정 특성)을 알게 되면 \`memory_write\`(owner/chair) 또는 \`memory_propose\`(member)로 기록한다. 제목은 나중에 검색할 문장으로, 본문은 "문제 / 해결 / 적용 방법".
- 기억 원본은 \`~/.gencouncil/space/memory/\`의 markdown 파일이며 직접 편집해도 된다.
${MARK_END}`;
}

export function upsertRules(file: string, dryRun = false): "created" | "updated" | "unchanged" {
  const block = rulesBlock();
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}`);
  let next: string;
  let result: "created" | "updated" | "unchanged";
  if (re.test(text)) {
    next = text.replace(re, block);
    result = next === text ? "unchanged" : "updated";
  } else {
    next = text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
    result = text ? "updated" : "created";
  }
  if (result !== "unchanged" && !dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, "utf8");
  }
  return result;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function envFor(target: Target, role: string): Record<string, string> {
  const agent = target === "claude" ? "claude-code" : target === "gemini" ? "gemini-cli" : "antigravity";
  const env: Record<string, string> = { GENCOUNCIL_ROLE: role, GENCOUNCIL_AGENT: agent };
  if (process.env.GENCOUNCIL_HOME) env.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
  return env;
}

function sh(cmd: string, args: string[], dryRun: boolean): { ok: boolean; out: string } {
  const line = [cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
  if (dryRun) return { ok: true, out: `$ ${line}` };
  const r = spawnSync(line, { shell: true, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: `$ ${line}\n${(r.stdout || "") + (r.stderr || "")}`.trim() };
}

// ---------- Claude Code ----------

export function installClaude(opts: InstallOptions = {}): string[] {
  const role = opts.role ?? "owner";
  const dry = opts.dryRun ?? false;
  const log: string[] = [];
  const env = envFor("claude", role);
  // remove an older registration first so the add is idempotent
  const rm = sh("claude", ["mcp", "remove", "--scope", "user", "gencouncil"], dry);
  if (rm.ok) log.push("removed previous registration");
  // name must come before the variadic -e flags, and `--` ends them
  const args = ["mcp", "add", "--scope", "user", "--transport", "stdio", "gencouncil"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push("--", nodeExe(), serverEntry());
  const add = sh("claude", args, dry);
  log.push(add.out);
  if (!add.ok) log.push("claude mcp add failed (is `claude` on PATH?)");
  if (opts.rules ?? true) {
    const f = path.join(os.homedir(), ".claude", "CLAUDE.md");
    log.push(`${f}: rules ${upsertRules(f, dry)}`);
  }
  return log;
}

// ---------- Gemini CLI / Antigravity (settings.json style) ----------

interface McpJson {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

function upsertJsonServer(file: string, role: string, target: Target, dry: boolean): string {
  let cfg: McpJson = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8")) as McpJson;
    } catch {
      return `${file}: could not parse JSON, not touching it`;
    }
  }
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers.gencouncil = {
    command: nodeExe(),
    args: [serverEntry()],
    env: envFor(target, role),
    timeout: 30000,
    trust: false,
  };
  if (!dry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
  return `${file}: mcpServers.gencouncil ${dry ? "(dry run)" : "written"}`;
}

export function installGemini(opts: InstallOptions = {}): string[] {
  const role = opts.role ?? "owner";
  const dry = opts.dryRun ?? false;
  const log: string[] = [];
  log.push(upsertJsonServer(path.join(os.homedir(), ".gemini", "settings.json"), role, "gemini", dry));
  if (opts.rules ?? true) {
    const f = path.join(os.homedir(), ".gemini", "GEMINI.md");
    log.push(`${f}: rules ${upsertRules(f, dry)}`);
  }
  return log;
}

export function installAntigravity(opts: InstallOptions = {}): string[] {
  const role = opts.role ?? "member";
  const dry = opts.dryRun ?? false;
  const file = path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json");
  return [
    upsertJsonServer(file, role, "antigravity", dry),
    "Antigravity reads this file on restart; check Settings > MCP in the IDE.",
  ];
}

export function install(target: Target | "all", opts: InstallOptions = {}): string[] {
  const out: string[] = [];
  if (target === "claude" || target === "all") out.push("[claude]", ...installClaude(opts));
  if (target === "gemini" || target === "all") out.push("[gemini]", ...installGemini(opts));
  if (target === "antigravity") out.push("[antigravity]", ...installAntigravity(opts));
  return out;
}
