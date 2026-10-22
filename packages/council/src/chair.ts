import fs from "node:fs";
import path from "node:path";
import { serverEntry } from "@gencouncil/mcp/install";
import type { Account } from "./accounts.js";
import type { Council } from "./council.js";
import { parseClaudeLine, spawnCli, wireProcess, type ClaudeEvent, type RunningProc } from "./drivers.js";
import { advisorFor } from "./model.js";
import { chairSystemPrompt } from "./prompts.js";
import { classifyFailure } from "./quota.js";
import { git, isClean } from "./git.js";

export interface ChairOptions {
  /** URL of the council MCP server (startCouncilHttp or the web server's /mcp/<project>/<agenda>) */
  councilUrl: string;
  /** extra HTTP headers for the council MCP (e.g. Authorization) */
  councilHeaders?: Record<string, string>;
  model?: string;
  effort?: string;
}

export interface ChairTurnResult {
  text: string;
  sessionId?: string;
  isError: boolean;
  costUsd?: number;
}

/**
 * What the chair may use. Reading, web research and read-only commands (git inspection, running
 * tests/type checks) are always allowed. Editing is opt-in per project (chair.directEdit) and
 * limited to the integration worktree (the chair's cwd); the server commits it after each turn.
 * Anything not listed is denied: headless runs never prompt.
 */
export const CHAIR_READ_TOOLS = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "mcp__council", "mcp__gencouncil"];
export const CHAIR_READONLY_BASH = [
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git branch:*)",
  "Bash(git blame:*)",
  "Bash(git ls-files:*)",
  "Bash(cd:*)",
  "Bash(ls:*)",
  "Bash(npm test:*)",
  "Bash(npm run test:*)",
  "Bash(npm run typecheck:*)",
  "Bash(npm run lint:*)",
  "Bash(npx vitest:*)",
  "Bash(npx tsc --noEmit:*)",
  "Bash(npx jest:*)",
  "Bash(pytest:*)",
  "Bash(python -m pytest:*)",
  "Bash(cargo test:*)",
  "Bash(go test:*)",
];
export const CHAIR_EDIT_TOOLS = [
  // one Edit path rule covers every file-editing tool (Write, MultiEdit too)
  "Edit(./**)",
  "Bash(git merge:*)",
  "Bash(git add:*)",
  "Bash(git restore:*)",
];
const CHAIR_ALWAYS_DENIED = ["NotebookEdit", "Task"];

export function chairToolArgs(directEdit: boolean): { allowed: string[]; disallowed: string[] } {
  const allowed = [...CHAIR_READ_TOOLS, ...CHAIR_READONLY_BASH, ...(directEdit ? CHAIR_EDIT_TOOLS : [])];
  const disallowed = [...CHAIR_ALWAYS_DENIED, ...(directEdit ? [] : ["Edit", "Write", "MultiEdit"])];
  return { allowed, disallowed };
}
const MAX_ACCOUNT_SWITCHES = 3;

export class Chair {
  private readonly mcpFile: string;
  private busy = false;
  private current?: RunningProc;

  constructor(
    readonly council: Council,
    private opts: ChairOptions,
  ) {
    const store = council.store;
    this.mcpFile = path.join(store.chairDir(), "mcp.json");
    const env: Record<string, string> = {
      GENCOUNCIL_ROLE: "member",
      GENCOUNCIL_AGENT: `chair:${council.project.id}/${store.slug}`,
    };
    if (process.env.GENCOUNCIL_HOME) env.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
    fs.mkdirSync(store.chairDir(), { recursive: true });
    fs.writeFileSync(
      this.mcpFile,
      JSON.stringify(
        {
          mcpServers: {
            council: { type: "http", url: opts.councilUrl, ...(opts.councilHeaders ? { headers: opts.councilHeaders } : {}) },
            gencouncil: { type: "stdio", command: process.execPath, args: [serverEntry()], env },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Commit what the chair changed in the integration worktree during this turn, so the agenda
   * branch records it and later merges see it. Unresolved conflicts are left for the next turn.
   */
  private async commitOwnEdits(request: string): Promise<string | undefined> {
    const dir = this.council.store.integrationWorktree();
    try {
      const unresolved = (await git(dir, ["diff", "--name-only", "--diff-filter=U"])).trim();
      if (unresolved) return `(의장 직접 수정: 아직 해결되지 않은 충돌이 있어 커밋하지 않았습니다: ${unresolved.split("\n").join(", ")})`;
      if (await isClean(dir)) {
        // a merge the chair finished by hand still needs its commit
        if (!fs.existsSync(path.join(dir, ".git")) || !(await git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => ""))) return undefined;
      }
      await git(dir, ["add", "-A"]);
      const subject = request.replace(/\s+/g, " ").trim().slice(0, 60) || "직접 수정";
      await git(dir, ["commit", "-q", "--no-verify", "-m", `chair: ${subject}`]);
      const sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
      this.appendLog(`=== ${new Date().toISOString()} chair edits committed ${sha}`);
      return `(의장 직접 수정을 통합 브랜치에 커밋했습니다: ${sha})`;
    } catch (e) {
      return `(의장 직접 수정 커밋 실패: ${(e as Error).message.split("\n")[0]})`;
    }
  }

  /** stop the running turn (agenda close / app shutdown) */
  stop(): void {
    this.current?.stop();
  }

  /** file that exists while a chair turn runs; left behind when the app dies mid-turn */
  runningFile(): string {
    return path.join(this.council.store.chairDir(), "running.json");
  }

  setOverrides(o: { model?: string; effort?: string }): void {
    this.opts = { ...this.opts, model: o.model, effort: o.effort };
  }

  model(): string | undefined {
    return this.opts.model ?? this.council.project.chair.model;
  }

  effort(): string | undefined {
    return this.opts.effort ?? this.council.project.chair.effort;
  }

  advisor(): string | undefined {
    return advisorFor(this.model(), this.council.project.chair.advisor);
  }

  /** account id the chair runs on (default "claude") */
  account(): string {
    return this.council.project.chair.account ?? "claude";
  }

  private currentAccount(): Account {
    const id = this.account();
    const a = this.council.accounts.get(id);
    if (!a) throw new Error(`unknown chair account: ${id}`);
    return a;
  }

  private systemPrompt(): string {
    const store = this.council.store;
    return chairSystemPrompt({
      project: this.council.project,
      agenda: store.agenda(),
      guidelines: this.council.registry.guidelines(this.council.project),
      chairState: store.chairState(),
      memoryIndex: this.council.memory.renderIndex(),
      integrationWorktree: store.integrationWorktree(),
      limits: this.council.limitsMarkdown(),
    });
  }

  resetSession(): void {
    this.council.store.saveChairSession({});
  }

  /** Switch the chair to another usable claude account (persisted). Returns the new account or undefined. */
  private switchAccount(exclude: string[]): Account | undefined {
    const next = this.council.accounts.pick("claude", { exclude });
    if (!next) return undefined;
    const p = this.council.project;
    p.chair.account = next.id;
    this.council.registry.save(p);
    this.resetSession();
    return next;
  }

  async turn(
    message: string,
    onEvent: (e: ClaudeEvent) => void,
    attachments: Array<{ id: string; name: string; type: string; size: number }> = [],
    shownText?: string,
  ): Promise<ChairTurnResult> {
    if (this.busy) throw new Error("chair is busy");
    this.busy = true;
    try {
      const store = this.council.store;
      store.appendTranscript({ role: "user", text: shownText ?? message, ...(attachments.length ? { attachments } : {}) });
      let account = this.currentAccount();
      const tried: string[] = [];
      let res: Awaited<ReturnType<Chair["runOnce"]>> | undefined;
      for (let attempt = 0; attempt <= MAX_ACCOUNT_SWITCHES; attempt++) {
        const session = store.chairSession();
        res = await this.runOnce(message, session.sessionId, account, onEvent);
        if (res.isError && res.resumeFailed) {
          onEvent({ kind: "text", text: "(이전 의장 세션을 찾지 못해 새 세션으로 시작합니다. state.md는 이어집니다.)" });
          this.resetSession();
          res = await this.runOnce(message, undefined, account, onEvent);
        }
        if (!res.isError) break;
        const failure = classifyFailure("claude", `${res.stderr}\n${res.text}`, res.exitCode);
        if (failure.kind === "other") break;
        if (failure.kind === "quota") this.council.accounts.markExhausted(account.id, failure.message, failure.resetAt);
        else this.council.accounts.markAuth(account.id, failure.message);
        tried.push(account.id);
        const next = this.switchAccount(tried);
        if (!next) {
          res.text = `의장 계정 ${account.id} ${failure.kind === "quota" ? "한도 소진" : "로그인 필요"}: ${failure.message}. 쓸 수 있는 다른 claude 계정이 없습니다. 'gencouncil account add'로 계정을 추가하거나 리셋을 기다리세요.`;
          break;
        }
        this.appendLog(`=== ${new Date().toISOString()} account switch ${account.id} -> ${next.id} (${failure.kind}: ${failure.message})`);
        onEvent({ kind: "handover", from: account.id, to: next.id, reason: `${failure.kind}: ${failure.message}` });
        onEvent({ kind: "text", text: `(의장 계정 ${account.id} → ${next.id} 로 전환. state.md를 바탕으로 새 세션을 시작합니다.)` });
        account = next;
      }
      if (!res) throw new Error("no attempt made");
      if (this.council.project.chair.directEdit) {
        const note = await this.commitOwnEdits(shownText ?? message);
        if (note) res.text = `${res.text}\n\n${note}`;
      }
      if (res.sessionId && !res.isError) store.saveChairSession({ sessionId: res.sessionId, model: this.model() });
      store.appendTranscript({ role: "assistant", text: res.text, isError: res.isError, costUsd: res.costUsd });
      return { text: res.text, sessionId: res.sessionId, isError: res.isError, costUsd: res.costUsd };
    } finally {
      this.busy = false;
    }
  }

  /** chair/chair.log: raw stream-json + stderr of every chair run, for debugging and quota-pattern tuning */
  logFile(): string {
    return path.join(this.council.store.chairDir(), "chair.log");
  }

  private appendLog(line: string): void {
    try {
      fs.appendFileSync(this.logFile(), line + "\n", "utf8");
    } catch {
      /* logging must never break a turn */
    }
  }

  private runOnce(
    message: string,
    resume: string | undefined,
    account: Account,
    onEvent: (e: ClaudeEvent) => void,
  ): Promise<ChairTurnResult & { resumeFailed?: boolean; stderr: string; exitCode: number | null }> {
    const store = this.council.store;
    const args = ["-p", message, "--output-format", "stream-json", "--verbose"];
    if (resume) args.push("--resume", resume);
    args.push("--mcp-config", this.mcpFile, "--strict-mcp-config");
    const tools = chairToolArgs(Boolean(this.council.project.chair.directEdit));
    args.push("--allowedTools", ...tools.allowed);
    args.push("--disallowedTools", ...tools.disallowed);
    args.push("--append-system-prompt", this.systemPrompt());
    args.push("--add-dir", store.worktreeRoot());
    // files the user attached in the chat
    const attachDir = path.join(store.dir, "attachments");
    if (fs.existsSync(attachDir)) args.push("--add-dir", attachDir);
    const model = this.model();
    const effort = this.effort();
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    const advisor = this.advisor();
    if (advisor) args.push("--advisor", advisor);

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.council.accounts.env(account), GENCOUNCIL_ROLE: "chair" };
    delete env.CLAUDECODE;
    this.council.accounts.touch(account.id);
    fs.mkdirSync(store.chairDir(), { recursive: true });
    const log = fs.createWriteStream(this.logFile(), { flags: "a" });
    log.write(
      `=== ${new Date().toISOString()} chair turn account=${account.id} model=${model ?? "default"} effort=${effort ?? "default"} advisor=${advisor ?? "off"} resume=${resume ?? "new"}\n` +
        `[prompt] ${message.slice(0, 4000).replace(/\r?\n/g, " ⏎ ")}\n`,
    );
    let child;
    try {
      child = spawnCli("claude", args, { cwd: store.integrationWorktree(), env });
    } catch (e) {
      log.end(`=== spawn failed: ${(e as Error).message}\n`);
      throw e;
    }
    let sessionId: string | undefined;
    let finalText = "";
    let isError = false;
    let costUsd: number | undefined;
    let stderr = "";
    const texts: string[] = [];
    try {
      fs.writeFileSync(this.runningFile(), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), message: message.slice(0, 2000) }), "utf8");
    } catch {
      /* best effort */
    }
    const proc = wireProcess(child, { cwd: store.integrationWorktree(), prompt: message, autonomy: "edits" }, (stream, line) => {
      log.write(`[${stream}] ${line}\n`);
      if (stream === "stderr") {
        stderr += line + "\n";
        return;
      }
      for (const ev of parseClaudeLine(line)) {
        if (ev.kind === "init") sessionId = ev.sessionId;
        else if (ev.kind === "text") texts.push(ev.text);
        else if (ev.kind === "result") {
          finalText = ev.text;
          isError = ev.isError;
          costUsd = ev.costUsd;
          sessionId = ev.sessionId ?? sessionId;
        }
        if (ev.kind !== "result" && ev.kind !== "other") onEvent(ev);
      }
    });
    this.current = proc;
    return proc.done.then(async (exit) => {
      this.current = undefined;
      fs.rmSync(this.runningFile(), { force: true });
      await new Promise<void>((r) => log.end(`=== exit code=${exit.code} signal=${exit.signal}\n`, () => r()));
      const resumeFailed = Boolean(resume) && (/no conversation found/i.test(stderr) || /no conversation found/i.test(finalText));
      if (exit.code !== 0 && !finalText) {
        isError = true;
        finalText = stderr.trim() || `claude exited with code ${exit.code}`;
      }
      if (!finalText && texts.length) finalText = texts[texts.length - 1];
      return { text: finalText, sessionId, isError, costUsd, resumeFailed, stderr, exitCode: exit.code };
    });
  }
}
