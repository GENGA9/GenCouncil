/**
 * CLI drivers. Every member and the chair is a headless CLI process:
 *   claude -p ... --output-format stream-json     (uses the user's Claude Code login)
 *   agy -p ... --output-format stream-json        (Antigravity CLI, the user's Google login)
 * Multi-account works by pointing the process at another config dir
 * (CLAUDE_CONFIG_DIR / HOME+USERPROFILE for gemini).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Autonomy, Provider } from "./model.js";
import type { CliProvider } from "./models.js";

export interface SpawnSpec {
  cwd: string;
  /** short instruction passed as the -p argument */
  prompt: string;
  /** long content written to stdin (task packet) */
  stdinText?: string;
  model?: string;
  /** low | medium | high | xhigh | max (ignored by CLIs without an effort setting) */
  effort?: string;
  env?: Record<string, string>;
  autonomy: Autonomy;
  extraArgs?: string[];
}

export interface ProcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunningProc {
  pid: number | undefined;
  child: ChildProcess;
  stop(): void;
  done: Promise<ProcExit>;
}

export type LineHandler = (stream: "stdout" | "stderr", line: string) => void;

export interface Driver {
  provider: Provider;
  spawn(spec: SpawnSpec, onLine: LineHandler): RunningProc;
}

// ---------- executable lookup (Windows-aware) ----------

const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

export function findExecutable(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, name + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function quoteForCmd(a: string): string {
  if (!/[\s"&|<>^()]/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

/** spawn a CLI; .cmd shims must go through cmd.exe */
export function spawnCli(name: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const exe = findExecutable(name);
  if (!exe) throw new Error(`${name} not found on PATH`);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    const line = [quoteForCmd(exe), ...args.map(quoteForCmd)].join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(exe, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

export function wireProcess(child: ChildProcess, spec: SpawnSpec, onLine: LineHandler): RunningProc {
  const attach = (stream: "stdout" | "stderr") => {
    let buf = "";
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(stream, line);
      }
    });
    child[stream]?.on("end", () => {
      if (buf.trim()) onLine(stream, buf);
    });
  };
  attach("stdout");
  attach("stderr");
  const done = new Promise<ProcExit>((resolve) => {
    child.on("error", (e) => {
      onLine("stderr", `spawn error: ${e.message}`);
      resolve({ code: -1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (child.stdin) {
    if (spec.stdinText) child.stdin.write(spec.stdinText);
    child.stdin.end();
  }
  return {
    pid: child.pid,
    child,
    done,
    stop: () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    },
  };
}

// ---------- Claude Code ----------

export const claudeDriver: Driver = {
  provider: "claude",
  spawn(spec, onLine) {
    const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose"];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    if (spec.autonomy === "full") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "acceptEdits"); // "chair" adds --permission-prompt-tool via extraArgs
    if (spec.extraArgs) args.push(...spec.extraArgs);
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    // never let a member inherit the parent's interactive session
    delete env.CLAUDECODE;
    const child = spawnCli("claude", args, { cwd: spec.cwd, env });
    return wireProcess(child, spec, onLine);
  },
};

// ---------- Gemini via Antigravity CLI (agy) ----------
// Google stopped serving Gemini CLI personal logins; Antigravity CLI is the replacement.

/** "gemini-4-argon" + "high" -> "gemini-4-argon-high" (xhigh/max clamp to high) */
export function agyModelId(model: string | undefined, effort: string | undefined): string | undefined {
  if (!model) return undefined;
  if (/-(low|medium|high)$/.test(model)) return model;
  const e = effort === "low" || effort === "medium" ? effort : effort ? "high" : "medium";
  return `${model}-${e}`;
}

/** packets up to this size go in the prompt itself; bigger ones are read from .council/TASK.md */
const AGY_INLINE_PACKET = 20000;

export const geminiDriver: Driver = {
  provider: "gemini",
  spawn(spec, onLine) {
    let prompt = spec.prompt;
    if (spec.stdinText) {
      prompt +=
        spec.stdinText.length <= AGY_INLINE_PACKET
          ? `\n\n(작업 패킷은 stdin 대신 아래에 붙였습니다)\n\n${spec.stdinText}`
          : "\n\n작업 패킷이 길어 stdin 대신 .council/TASK.md 파일로만 전달됩니다. 먼저 그 파일을 읽으세요.";
    }
    const args = ["-p", prompt, "--output-format", "stream-json"];
    const model = agyModelId(spec.model, spec.effort);
    if (model) args.push("--model", model);
    if (spec.autonomy === "full") args.push("--dangerously-skip-permissions");
    else args.push("--mode", "accept-edits");
    if (spec.extraArgs) args.push(...spec.extraArgs);
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    const child = spawnCli("agy", args, { cwd: spec.cwd, env });
    return wireProcess(child, { ...spec, stdinText: undefined }, onLine);
  },
};

// ---------- Codex CLI (GPT) ----------

export const codexDriver: Driver = {
  provider: "gpt",
  spawn(spec, onLine) {
    // prompt as the argument, packet on stdin (codex appends piped stdin as a <stdin> block)
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", spec.cwd];
    if (spec.model) args.push("-m", spec.model);
    if (spec.effort) args.push("-c", `model_reasoning_effort=${spec.effort}`);
    if (spec.autonomy === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("-s", "workspace-write", "-c", "approval_policy=never");
    if (spec.extraArgs) args.push(...spec.extraArgs);
    args.push(spec.prompt);
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    const child = spawnCli("codex", args, { cwd: spec.cwd, env });
    return wireProcess(child, spec, onLine);
  },
};

export const drivers: Record<CliProvider, Driver> = { claude: claudeDriver, gemini: geminiDriver, gpt: codexDriver };

// ---------- stream-json parsing (Claude Code) ----------

export type ClaudeEvent =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "result"; text: string; sessionId?: string; isError: boolean; costUsd?: number; numTurns?: number }
  | { kind: "handover"; from: string; to: string; reason: string }
  | { kind: "other"; type: string };

export function parseClaudeLine(line: string): ClaudeEvent[] {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(msg.type ?? "");
  if (type === "system" && msg.subtype === "init") {
    return [{ kind: "init", sessionId: String(msg.session_id ?? ""), model: msg.model as string | undefined }];
  }
  if (type === "assistant") {
    const m = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
    const out: ClaudeEvent[] = [];
    for (const block of m?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        out.push({ kind: "tool", name: String(block.name), input: block.input });
      }
    }
    return out;
  }
  if (type === "result") {
    return [
      {
        kind: "result",
        text: typeof msg.result === "string" ? msg.result : "",
        sessionId: msg.session_id as string | undefined,
        isError: Boolean(msg.is_error) || msg.subtype !== "success",
        costUsd: msg.total_cost_usd as number | undefined,
        numTurns: msg.num_turns as number | undefined,
      },
    ];
  }
  return [{ kind: "other", type }];
}

/**
 * Antigravity CLI stream-json (stateful: text arrives as deltas per step).
 *   {"event":"init","init":{"model":...},"conversation_id":...}
 *   {"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE"|"DONE","step_type":"agent_response","text_delta":"..."}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"..."}}
 * Lines in the old Gemini CLI format are still understood.
 */
export function makeAgyParser(): (line: string) => ClaudeEvent[] {
  const texts = new Map<number, string>();
  const toolsSeen = new Set<number>();
  return (line: string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const ev = msg.event;
    if (typeof ev !== "string") return parseGeminiLine(line);
    if (ev === "init") {
      const init = (msg.init ?? {}) as { model?: string };
      return [{ kind: "init", sessionId: String(msg.conversation_id ?? ""), model: init.model }];
    }
    if (ev === "step_update") {
      const s = (msg.step_update ?? {}) as { step_index?: number; state?: string; step_type?: string; text_delta?: string; tool_name?: string; name?: string };
      const idx = s.step_index ?? -1;
      const type = s.step_type ?? "";
      if (type === "user_input") return [];
      if (type === "agent_response") {
        if (s.text_delta) texts.set(idx, (texts.get(idx) ?? "") + s.text_delta);
        if (s.state === "DONE") {
          const t = (texts.get(idx) ?? "").trim();
          texts.delete(idx);
          return t ? [{ kind: "text", text: t }] : [];
        }
        return [];
      }
      if (type && !toolsSeen.has(idx)) {
        toolsSeen.add(idx);
        return [{ kind: "tool", name: s.tool_name ?? s.name ?? type, input: undefined }];
      }
      return [];
    }
    if (ev === "result") {
      const r = (msg.result ?? {}) as { status?: string; response?: string; error?: string; conversation_id?: string };
      const ok = String(r.status ?? "").toUpperCase() === "SUCCESS";
      return [{ kind: "result", text: r.response ?? r.error ?? "", sessionId: r.conversation_id, isError: !ok }];
    }
    if (ev === "error") {
      const e = (msg.error ?? {}) as { message?: string } | string;
      return [{ kind: "result", text: typeof e === "string" ? e : e.message ?? "error", isError: true }];
    }
    return [{ kind: "other", type: ev }];
  };
}

/** old Gemini CLI stream-json: best effort, we only need text + tool names. */
export function parseGeminiLine(line: string): ClaudeEvent[] {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line.trim() ? [{ kind: "text", text: line }] : [];
  }
  const type = String(msg.type ?? "");
  if (type === "init" || type === "system") {
    const model = (msg.model ?? (msg.data as { model?: string } | undefined)?.model) as string | undefined;
    return model ? [{ kind: "init", sessionId: String(msg.session_id ?? ""), model }] : [{ kind: "other", type }];
  }
  if (type === "message" && msg.role === "assistant" && typeof msg.content === "string") {
    return [{ kind: "text", text: msg.content }];
  }
  if (type === "tool_use" || type === "tool_call") {
    return [{ kind: "tool", name: String((msg as { tool_name?: string; name?: string }).tool_name ?? msg.name ?? "tool"), input: msg.parameters ?? msg.input }];
  }
  if (type === "result") {
    return [{ kind: "result", text: typeof msg.content === "string" ? msg.content : "", isError: msg.status === "error" }];
  }
  if (type === "error") {
    return [{ kind: "result", text: String(msg.message ?? "error"), isError: true }];
  }
  return [{ kind: "other", type }];
}

/** Codex `exec --json` JSONL: thread/turn/item events. Best effort across versions. */
export function parseCodexLine(line: string): ClaudeEvent[] {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(msg.type ?? "");
  if (type === "thread.started") return [{ kind: "init", sessionId: String(msg.thread_id ?? ""), model: msg.model as string | undefined }];
  if (type === "item.completed" || type === "item.started") {
    const item = (msg.item ?? {}) as Record<string, unknown>;
    const itype = String(item.type ?? item.item_type ?? "");
    if (itype === "agent_message" || itype === "assistant_message") {
      return type === "item.completed" && typeof item.text === "string" ? [{ kind: "text", text: item.text }] : [];
    }
    if (type === "item.started" && itype && itype !== "reasoning") return [{ kind: "tool", name: itype, input: item.command ?? item.changes ?? item.tool }];
    return [];
  }
  if (type === "turn.completed") return [{ kind: "result", text: "", isError: false }];
  if (type === "turn.failed") {
    const err = (msg.error ?? {}) as { message?: string };
    return [{ kind: "result", text: err.message ?? "turn failed", isError: true }];
  }
  if (type === "error") return [{ kind: "result", text: String(msg.message ?? "error"), isError: true }];
  return [{ kind: "other", type }];
}
