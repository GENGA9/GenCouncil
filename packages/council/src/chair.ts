import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WikiStore } from "@gencouncil/core";
import { ensureAgyCouncil, serverEntry } from "@gencouncil/mcp/install";
import type { Account } from "./accounts.js";
import type { Council } from "./council.js";
import { agyModelId, claudeModelId, codexMcpArgs, makeAgyParser, parseClaudeLine, parseCodexLine, spawnCli, wireProcess, type ClaudeEvent, type RunningProc } from "./drivers.js";
import { tierOf, type CliProvider } from "./models.js";
import { advisorFor, projectMemoryKey } from "./model.js";
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
  "Bash(git rev-parse:*)",
  "Bash(git ls-tree:*)",
  "Bash(git cat-file:*)",
  "Bash(git merge-base:*)",
  "Bash(git worktree list:*)",
  "Bash(git branch --list:*)",
  "Bash(cd:*)",
  "Bash(ls:*)",
  // read-only text tools so ordinary pipelines (git log | head, grep | wc) are not refused as a whole
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(grep:*)",
  "Bash(wc:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(cut:*)",
  "Bash(cat:*)",
  "Bash(echo:*)",
  "Bash(pwd:*)",
  "Bash(du:*)",
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
// Monitor keeps the turn open while it watches a log, which locks the user out of the chat;
// members report back through [council event] messages instead
const CHAIR_ALWAYS_DENIED = ["NotebookEdit", "Task", "Monitor"];

export function chairToolArgs(directEdit: boolean): { allowed: string[]; disallowed: string[] } {
  const allowed = [...CHAIR_READ_TOOLS, ...CHAIR_READONLY_BASH, ...(directEdit ? CHAIR_EDIT_TOOLS : [])];
  const disallowed = [...CHAIR_ALWAYS_DENIED, ...(directEdit ? [] : ["Edit", "Write"])];
  return { allowed, disallowed };
}
const MAX_ACCOUNT_SWITCHES = 3;

/** "the session to resume is gone" across CLIs (claude / codex / agy) */
const RESUME_FAILED = /no conversation found|no (session|rollout|thread) found|(conversation|session|thread)\b[^\n]{0,40}not found/i;

interface ChairLaunch {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** what goes on stdin; defaults to the user message */
  stdinText?: string;
  parse: (line: string) => ClaudeEvent[];
}

/** chair model when the project names none (or one from another provider) */
export const CHAIR_DEFAULT_MODEL: Record<CliProvider, string> = { claude: "opus", gpt: "gpt-6.1-sol", gemini: "gemini-4-argon" };

/** the chair's model for a provider: the configured one when it belongs to that provider, else the default */
export function chairModelFor(provider: CliProvider, model: string | undefined): string {
  if (model && tierOf(provider, model) >= 0) return model;
  return CHAIR_DEFAULT_MODEL[provider];
}

export class Chair {
  private readonly mcpFile: string;
  private readonly mcpCfg: { mcpServers: Record<string, { type?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string> }> };
  /** env the memory MCP server needs (agy chairs pass it through the process env) */
  private readonly memoryEnv: Record<string, string>;
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
      GENCOUNCIL_PROJECT: projectMemoryKey(council.project),
    };
    if (process.env.GENCOUNCIL_HOME) env.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
    this.memoryEnv = env;
    this.mcpCfg = {
      mcpServers: {
        council: { type: "http", url: opts.councilUrl, ...(opts.councilHeaders ? { headers: opts.councilHeaders } : {}) },
        gencouncil: { type: "stdio", command: process.execPath, args: [serverEntry()], env },
      },
    };
    fs.mkdirSync(store.chairDir(), { recursive: true });
    fs.writeFileSync(this.mcpFile, JSON.stringify(this.mcpCfg, null, 2), "utf8");
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

  /** the chair runs on whatever CLI its account belongs to */
  provider(): CliProvider {
    const p = this.council.accounts.get(this.account())?.provider;
    return p === "gpt" || p === "gemini" ? p : "claude";
  }

  model(): string | undefined {
    const m = this.opts.model ?? this.council.project.chair.model;
    const p = this.provider();
    if (p === "claude") return m;
    const want = chairModelFor(p, m);
    // a model spent on this login (Antigravity counts per model) steps down to the next one still open
    return this.council.accounts.fitModel(this.account(), want) ?? want;
  }

  effort(): string | undefined {
    return this.opts.effort ?? this.council.project.chair.effort;
  }

  advisor(): string | undefined {
    if (this.provider() !== "claude") return undefined;
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
      memoryIndex: this.council.memory.renderIndex({ project: projectMemoryKey(this.council.project) }),
      wikiToc: new WikiStore().renderRoot({ project: projectMemoryKey(this.council.project) }),
      integrationWorktree: store.integrationWorktree(),
      limits: this.council.limitsMarkdown(),
      topModelFloor: { claude: this.council.limits().claude.topModelMinWeeklyLeft, gpt: this.council.limits().gpt.topModelMinWeeklyLeft },
    });
  }

  resetSession(): void {
    this.council.store.saveChairSession({});
  }

  /** Switch the chair to another usable claude account (persisted). Returns the new account or undefined. */
  private switchAccount(exclude: string[]): Account | undefined {
    const next = this.council.accounts.pick(this.provider(), { exclude });
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
        // a session belongs to one CLI (older sessions are Claude ones)
        const resumeId = (session.provider ?? "claude") === account.provider ? session.sessionId : undefined;
        res = await this.runOnce(message, resumeId, account, onEvent);
        if (res.isError && res.resumeFailed) {
          onEvent({ kind: "text", text: "(이전 의장 세션을 찾지 못해 새 세션으로 시작합니다. state.md는 이어집니다.)" });
          this.resetSession();
          res = await this.runOnce(message, undefined, account, onEvent);
        }
        if (!res.isError) break;
        const failure = classifyFailure(account.provider as CliProvider, `${res.stderr}\n${res.text}`, res.exitCode);
        if (failure.kind === "other") break;
        const spent = this.model();
        if (failure.kind === "quota" && this.council.accounts.blockModel(account.id, spent, failure.message, failure.resetAt)) {
          // only this model is spent (Antigravity): the same login goes on with the next lower model
          const lower = this.model();
          this.appendLog(`=== ${new Date().toISOString()} model ${spent} quota spent -> ${lower} (${failure.message})`);
          onEvent({ kind: "text", text: `(의장 모델 ${spent} 한도 소진 → ${lower}로 이어갑니다.)` });
          account = this.council.accounts.get(account.id) ?? account;
          continue;
        }
        if (failure.kind === "quota") this.council.accounts.markExhausted(account.id, failure.message, failure.resetAt);
        else this.council.accounts.markAuth(account.id, failure.message);
        tried.push(account.id);
        const next = this.switchAccount(tried);
        if (!next) {
          res.text = `의장 계정 ${account.id} ${failure.kind === "quota" ? "한도 소진" : "로그인 필요"}: ${failure.message}. 쓸 수 있는 다른 ${account.provider} 계정이 없습니다. 'gencouncil account add'로 계정을 추가하거나 리셋을 기다리세요.`;
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
      if (res.sessionId && !res.isError) store.saveChairSession({ sessionId: res.sessionId, model: this.model(), provider: account.provider });
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
    const provider = (account.provider === "gpt" || account.provider === "gemini" ? account.provider : "claude") as CliProvider;
    const launch = provider === "gpt" ? this.codexLaunch(message, resume, account) : provider === "gemini" ? this.agyLaunch(message, resume, account) : this.claudeLaunch(resume, account);
    const model = this.model();
    const effort = this.effort();
    const advisor = this.advisor();
    this.council.accounts.touch(account.id);
    fs.mkdirSync(store.chairDir(), { recursive: true });
    const log = fs.createWriteStream(this.logFile(), { flags: "a" });
    log.write(
      `=== ${new Date().toISOString()} chair turn provider=${provider} account=${account.id} model=${model ?? "default"} effort=${effort ?? "default"} advisor=${advisor ?? "off"} resume=${resume ?? "new"}\n` +
        `[prompt] ${message.slice(0, 4000).replace(/\r?\n/g, " ⏎ ")}\n`,
    );
    return this.execute(launch, message, resume, log, onEvent);
  }

  /** Claude Code: the message goes on stdin and the system prompt in a file (Windows caps a command line at 32,767 chars) */
  private claudeLaunch(resume: string | undefined, account: Account): ChairLaunch {
    const store = this.council.store;
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resume) args.push("--resume", resume);
    args.push("--mcp-config", this.mcpFile, "--strict-mcp-config");
    const tools = chairToolArgs(Boolean(this.council.project.chair.directEdit));
    args.push("--allowedTools", ...tools.allowed);
    args.push("--disallowedTools", ...tools.disallowed);
    const spFile = path.join(store.chairDir(), "system-prompt.md");
    fs.mkdirSync(store.chairDir(), { recursive: true });
    fs.writeFileSync(spFile, this.systemPrompt(), "utf8");
    args.push("--append-system-prompt-file", spFile);
    args.push("--add-dir", store.worktreeRoot());
    // files the user attached in the chat
    const attachDir = path.join(store.dir, "attachments");
    if (fs.existsSync(attachDir)) args.push("--add-dir", attachDir);
    // the main checkout is readable (what members merge into, what a finish checks); edits stay limited to ./**
    args.push("--add-dir", this.council.project.repo);
    const model = this.model();
    const effort = this.effort();
    if (model) args.push("--model", claudeModelId(model));
    if (effort) args.push("--effort", effort);
    const advisor = this.advisor();
    if (advisor) args.push("--advisor", advisor);

    // only the council and memory servers are loaded (strict), so their tools go up front: no ToolSearch round trip first
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.council.accounts.env(account), GENCOUNCIL_ROLE: "chair", ENABLE_TOOL_SEARCH: "false" };
    delete env.CLAUDECODE;
    return { cmd: "claude", args, env, parse: parseClaudeLine };
  }

  /** bearer token of the council endpoint (from the Authorization header the host gave us) */
  private councilToken(): string | undefined {
    const h = this.opts.councilHeaders?.Authorization ?? this.opts.councilHeaders?.authorization;
    return h?.replace(/^Bearer\s+/i, "");
  }

  /**
   * Codex and Antigravity have no system-prompt flag: the full chair prompt opens each new session
   * and later turns carry only what changes between turns (goals, limits, state.md).
   */
  private promptWithInstructions(message: string, resume: string | undefined): string {
    if (!resume) return `<의장_지침>\n${this.systemPrompt()}\n</의장_지침>\n\n${message}`;
    const store = this.council.store;
    const agenda = store.agenda();
    const goals = agenda.goals.map((g, n) => `${n + 1}. ${g}`).join("\n") || "(아직 목표 없음)";
    const refresh = [
      `안건: "${agenda.title}"`,
      `목표:\n${goals}`,
      `위원 한도(지금 기준):\n${this.council.limitsMarkdown()}`,
      `state.md:\n${store.chairState() || "(없음)"}`,
    ].join("\n\n");
    return `<의장_지침_갱신>\n${refresh}\n</의장_지침_갱신>\n\n${message}`;
  }

  /** Codex CLI: read-only sandbox unless the chair may edit; MCP servers as -c overrides */
  private codexLaunch(message: string, resume: string | undefined, account: Account): ChairLaunch {
    const directEdit = Boolean(this.council.project.chair.directEdit);
    const council = this.mcpCfg.mcpServers.council;
    const memory = this.mcpCfg.mcpServers.gencouncil;
    const opts = [
      "--json",
      "--skip-git-repo-check",
      "-c",
      `sandbox_mode='${directEdit ? "workspace-write" : "read-only"}'`,
      "-c",
      "approval_policy='never'",
      ...codexMcpArgs({
        mcpServers: {
          council: { url: council.url, bearerTokenEnvVar: "GENCOUNCIL_COUNCIL_TOKEN" },
          gencouncil: { command: memory.command, args: memory.args, env: memory.env },
        },
      }),
    ];
    const model = this.model();
    const effort = this.effort();
    if (model) opts.push("-m", model);
    if (effort) opts.push("-c", `model_reasoning_effort='${effort}'`);
    // resume takes no -C/-s: the cwd and the sandbox_mode override cover both
    const args = resume ? ["exec", "resume", ...opts, resume, "-"] : ["exec", ...opts, "-"];
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.council.accounts.env(account), GENCOUNCIL_ROLE: "chair" };
    const token = this.councilToken();
    if (token) env.GENCOUNCIL_COUNCIL_TOKEN = token;
    return { cmd: "codex", args, env, stdinText: this.promptWithInstructions(message, resume), parse: parseCodexLine };
  }

  /**
   * Antigravity CLI: MCP servers come only from its global config, so the council bridge and the
   * memory server registered there pick this agenda from the process env. The prompt goes on stdin.
   */
  private agyLaunch(message: string, resume: string | undefined, account: Account): ChairLaunch {
    const store = this.council.store;
    const accountEnv = this.council.accounts.env(account);
    ensureAgyCouncil(accountEnv.USERPROFILE ?? os.homedir());
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print", ""];
    if (resume) args.push("--conversation", resume);
    const model = agyModelId(this.model(), this.effort());
    if (model) args.push("--model", model);
    if (this.council.project.chair.directEdit) args.push("--mode", "accept-edits");
    args.push("--add-dir", store.worktreeRoot(), "--add-dir", this.council.project.repo);
    const attachDir = path.join(store.dir, "attachments");
    if (fs.existsSync(attachDir)) args.push("--add-dir", attachDir);
    const env: NodeJS.ProcessEnv = { ...process.env, ...accountEnv, ...this.memoryEnv, GENCOUNCIL_COUNCIL_URL: this.opts.councilUrl };
    const token = this.councilToken();
    if (token) env.GENCOUNCIL_COUNCIL_TOKEN = token;
    const stdinText = JSON.stringify({ event: "user", message: { content: this.promptWithInstructions(message, resume) } }) + "\n";
    return { cmd: "agy", args, env, stdinText, parse: makeAgyParser() };
  }

  private execute(
    launch: ChairLaunch,
    message: string,
    resume: string | undefined,
    log: fs.WriteStream,
    onEvent: (e: ClaudeEvent) => void,
  ): Promise<ChairTurnResult & { resumeFailed?: boolean; stderr: string; exitCode: number | null }> {
    const store = this.council.store;
    const { cmd, args, env, parse } = launch;
    let child;
    try {
      child = spawnCli(cmd, args, { cwd: store.integrationWorktree(), env });
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
    const proc = wireProcess(child, { cwd: store.integrationWorktree(), prompt: message, stdinText: launch.stdinText ?? message, autonomy: "edits" }, (stream, line) => {
      log.write(`[${stream}] ${line}\n`);
      if (stream === "stderr") {
        stderr += line + "\n";
        return;
      }
      for (const ev of parse(line)) {
        if (ev.kind === "init") sessionId = ev.sessionId;
        else if (ev.kind === "text") texts.push(ev.text);
        else if (ev.kind === "result") {
          // codex ends with an empty turn.completed: keep the last message text
          finalText = ev.text || finalText;
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
      const resumeFailed = Boolean(resume) && RESUME_FAILED.test(`${stderr}\n${isError ? finalText : ""}`);
      if (exit.code !== 0 && !finalText) {
        isError = true;
        finalText = stderr.trim() || `${cmd} exited with code ${exit.code}`;
      }
      if (!finalText && texts.length) finalText = texts[texts.length - 1];
      return { text: finalText, sessionId, isError, costUsd, resumeFailed, stderr, exitCode: exit.code };
    });
  }
}
