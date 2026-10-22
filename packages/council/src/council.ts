import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { type EntryType, type MemoryStore } from "@gencouncil/core";
import { serverEntry } from "@gencouncil/mcp/install";
import { AccountRegistry, type Account } from "./accounts.js";
import { ChairApprover, chairReview, type PermissionDecision, type Reviewer } from "./approval.js";
import { drivers, makeAgyParser, parseClaudeLine, parseCodexLine, type RunningProc } from "./drivers.js";
import {
  currentBranch,
  deleteBranch,
  diffFull,
  diffStat,
  ensureBranch,
  ensureExclude,
  ensureWorktree,
  git,
  hasCommits,
  isClean,
  isRepo,
  logRange,
  mergeInto,
  removeWorktree,
  type MergeResult,
} from "./git.js";
import { explorerAgents } from "./explorers.js";
import {
  LIMIT_KEYS,
  LimitError,
  SITE_INFO,
  WEB_SITES,
  limitsMarkdown,
  normalizeLimits,
  resolveAdvisor,
  resolveEffort,
  resolveModel,
  type CliProvider,
  type LimitKey,
  type Limits,
  type WebSite,
} from "./models.js";
import { commitUserEdits } from "./localgit.js";
import {
  AgendaStore,
  ProjectRegistry,
  type MemberRecord,
  type ProjectConfig,
  type Provider,
  type Task,
  type TaskStatus,
} from "./model.js";
import { buildHandoverPacket, buildPacket, MEMBER_PROMPT, parseResult } from "./packet.js";
import { classifyFailure } from "./quota.js";
import { stopLeftover } from "./interrupt.js";
import { applyRelayFiles, bundleFiles, parseRelayResponse, RELAY_FORMAT } from "./relay.js";

export { accountsFile, loadAccounts, type Account } from "./accounts.js";

export interface AssignInput {
  taskId: string;
  provider?: Provider;
  model?: string;
  /** low | medium | high | xhigh | max (claude, gpt) */
  effort?: string;
  /** claude only: stronger model consulted at key decisions */
  advisor?: string;
  account?: string;
  instructions: string;
  /** relay only: which web AI (gemini-web | aistudio | chatgpt); others are free-form */
  site?: WebSite;
  /** relay only: display label such as "제미나이(agy)" */
  label?: string;
  /** relay only: files (relative to the repo) to bundle into the packet */
  files?: string[];
}

export interface HandoverOptions {
  /** continue after an interruption: same account if usable, no handover-count limit */
  resume?: boolean;
  provider?: CliProvider;
  model?: string;
  effort?: string;
  account?: string;
  reason?: string;
}

export interface CouncilState {
  project: { id: string; name: string; repo: string; baseBranch: string };
  agenda: { slug: string; title: string; goals: string[]; branch: string; status: string };
  tasks: Task[];
  members: Array<Omit<MemberRecord, "result"> & { result?: { summary: string; unfinished: string } }>;
  integrationWorktree: string;
  chairState: string;
  accounts: Account[];
  limits: Limits;
  active: Record<LimitKey, number>;
  mode: "git" | "folder";
  source?: string;
  localGit: boolean;
}

const RELAY_PROMPT_HEAD = `# 릴레이 작업 패킷

당신은 제작위원회의 위원이다. 저장소에 직접 접근할 수 없으므로 필요한 파일은 아래에 포함되어 있다. 아래 지시를 수행하고, 반드시 '답변 양식'대로만 답하라. 사람이 당신의 답변을 그대로 저장소에 적용한다.`;

export class Council extends EventEmitter {
  readonly project: ProjectConfig;
  readonly registry = new ProjectRegistry();
  readonly accounts = new AccountRegistry();
  private membersCache: MemberRecord[] | null = null;
  private running = new Map<string, RunningProc>();
  private finished: MemberRecord[] = [];
  private waiters: Array<() => void> = [];
  /** where claude members reach the permission tool (set by whoever hosts the council MCP) */
  private memberMcp?: (memberId: string) => { url: string; headers?: Record<string, string> };
  /** decides permission requests the rules can't; replaceable in tests */
  reviewer: Reviewer;
  private approver: ChairApprover;

  constructor(
    readonly store: AgendaStore,
    readonly memory: MemoryStore,
  ) {
    super();
    this.project = store.project;
    this.reviewer = (req) =>
      chairReview(req, {
        model: this.project.chair.model,
        env: this.accounts.env(this.accounts.get(this.project.chair.account ?? "claude")),
      });
    this.approver = new ChairApprover(
      (req) => this.reviewer(req),
      (req, d) => {
        const what = typeof req.input.command === "string" ? req.input.command : typeof req.input.file_path === "string" ? req.input.file_path : "";
        const line = `의장 ${d.behavior === "allow" ? "승인" : "거절"} ${req.memberId}: ${req.toolName} ${String(what).slice(0, 120)} (${d.by}${d.reason ? ": " + d.reason : ""})`;
        this.log(line);
        try {
          fs.appendFileSync(this.store.memberLog(req.memberId), `=== ${new Date().toISOString()} ${line}\n`);
        } catch {
          /* ignore */
        }
      },
    );
  }

  setMemberMcp(fn: (memberId: string) => { url: string; headers?: Record<string, string> }): void {
    this.memberMcp = fn;
  }

  /** Permission request from a claude member running with autonomy "chair". */
  async requestPermission(memberId: string, toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    const m = this.member(memberId);
    const task = this.task(m.taskId);
    return this.approver.decide({ memberId, toolName, input, task: `${task.title}\n${task.description}`, worktree: m.worktree });
  }

  private log(line: string): void {
    this.emit("log", line);
  }

  // ---------- lifecycle ----------

  async open(): Promise<void> {
    const repo = this.project.repo;
    if (!(await isRepo(repo))) throw new Error(`not a git repository: ${repo}`);
    if (!(await hasCommits(repo))) throw new Error(`repository has no commits yet: ${repo}`);
    await ensureExclude(repo, [".worktrees/", ".council/", ".gemini/"]);
    if (this.project.localGit) {
      // the user edits this folder directly; record their changes so agendas start from them
      const c = await commitUserEdits(this.project);
      if (c) this.log(`사용자 변경을 커밋했습니다 (${c.slice(0, 7)})`);
    }
    const agenda = this.store.agenda();
    await ensureBranch(repo, agenda.branch, agenda.baseBranch);
    await ensureWorktree(repo, this.store.integrationWorktree(), agenda.branch, agenda.baseBranch);
    const members = this.members();
    let changed = false;
    for (const m of members) {
      if (m.status === "running" || m.status === "starting") {
        // the CLI may still be running on its own (Windows keeps children alive); stop it first
        if (await stopLeftover(m.pid, m.startedAt)) this.log(`member ${m.id}: stopped a leftover process (pid ${m.pid})`);
        m.status = "stopped";
        m.interrupted = true;
        m.error = "앱이 꺼지면서 중단됨";
        m.endedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.saveMembers(members);
  }

  /** stop every running member; they are marked interrupted so the work can be resumed later */
  stopAll(): void {
    const members = this.members();
    for (const [id, proc] of this.running) {
      this.log(`stopping ${id}`);
      const m = members.find((x) => x.id === id);
      if (m) {
        m.status = "stopped";
        m.interrupted = true;
        m.error = "안건을 닫으면서 중단됨";
      }
      proc.stop();
    }
    if (this.running.size) this.saveMembers(members);
  }

  /** members cut off by a shutdown/close that nobody has continued yet */
  interruptedMembers(): MemberRecord[] {
    return this.members().filter((m) => m.interrupted && m.status === "stopped" && !m.handoverTo);
  }

  // ---------- state ----------

  members(): MemberRecord[] {
    if (!this.membersCache) this.membersCache = this.store.members();
    return this.membersCache;
  }

  persistMembers(): void {
    this.saveMembers(this.members());
  }

  private saveMembers(list: MemberRecord[]): void {
    this.membersCache = list;
    this.store.saveMembers(list);
  }

  private member(id: string): MemberRecord {
    const m = this.members().find((x) => x.id === id);
    if (!m) throw new Error(`unknown member: ${id}`);
    return m;
  }

  private task(id: string): Task {
    const t = this.store.tasks().find((x) => x.id === id);
    if (!t) throw new Error(`unknown task: ${id}`);
    return t;
  }

  state(): CouncilState {
    const a = this.store.agenda();
    return {
      project: { id: this.project.id, name: this.project.name, repo: this.project.repo, baseBranch: this.project.baseBranch },
      agenda: { slug: a.slug, title: a.title, goals: a.goals, branch: a.branch, status: a.status },
      tasks: this.store.tasks(),
      members: this.members().map((m) => ({
        ...m,
        result: m.result ? { summary: m.result.summary, unfinished: m.result.unfinished } : undefined,
      })),
      integrationWorktree: this.store.integrationWorktree(),
      chairState: this.store.chairState(),
      accounts: this.accounts.list(),
      limits: this.limits(),
      active: this.activeCounts(),
      mode: this.project.mode ?? "git",
      source: this.project.source,
      localGit: Boolean(this.project.localGit),
    };
  }

  limits(): Limits {
    return normalizeLimits(this.project.members.limits);
  }

  private limitKeyOf(m: Pick<MemberRecord, "provider" | "site">): LimitKey | undefined {
    if (m.provider === "relay") return m.site;
    return m.provider;
  }

  /** members currently occupying a slot (running, starting, or a relay waiting for a human) */
  activeCounts(): Record<LimitKey, number> {
    const out = Object.fromEntries(LIMIT_KEYS.map((k) => [k, 0])) as Record<LimitKey, number>;
    for (const m of this.members()) {
      if (!["running", "starting", "waiting"].includes(m.status)) continue;
      const k = this.limitKeyOf(m);
      if (k) out[k]++;
    }
    return out;
  }

  limitsMarkdown(): string {
    return limitsMarkdown(this.limits(), this.activeCounts());
  }

  private checkSlot(key: LimitKey): void {
    const lim = this.limits()[key];
    if (lim.maxMembers <= 0) throw new LimitError(`${key} members are disabled by the user's limits`);
    const active = this.activeCounts()[key];
    if (active >= lim.maxMembers)
      throw new LimitError(`${key} limit reached (${active}/${lim.maxMembers} working). wait for one to finish (council_wait) or use another provider`);
  }

  runningCount(): number {
    return this.running.size;
  }

  /** The chair names the agenda and sets its goals from the user's request. */
  setAgenda(patch: { title?: string; goals?: string[] }): { title: string; goals: string[] } {
    const a = this.store.agenda();
    if (patch.title?.trim()) a.title = patch.title.trim();
    if (patch.goals) a.goals = patch.goals.map((g) => g.trim()).filter(Boolean);
    this.store.saveAgenda(a);
    this.emit("agenda", a);
    return { title: a.title, goals: a.goals };
  }

  // ---------- tasks ----------

  addTask(input: { title: string; description?: string; goal?: number }): Task {
    const tasks = this.store.tasks();
    const now = new Date().toISOString();
    const t: Task = {
      id: `T${tasks.length + 1}`,
      title: input.title.trim(),
      description: (input.description ?? "").trim(),
      goal: input.goal,
      status: "todo",
      created: now,
      updated: now,
    };
    tasks.push(t);
    this.store.saveTasks(tasks);
    return t;
  }

  updateTask(id: string, patch: { status?: TaskStatus; note?: string; title?: string; description?: string; memberId?: string }): Task {
    const tasks = this.store.tasks();
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error(`unknown task: ${id}`);
    if (patch.status) t.status = patch.status;
    if (patch.note !== undefined) t.note = patch.note;
    if (patch.title) t.title = patch.title;
    if (patch.description !== undefined) t.description = patch.description;
    if (patch.memberId !== undefined) t.memberId = patch.memberId;
    t.updated = new Date().toISOString();
    this.store.saveTasks(tasks);
    return t;
  }

  // ---------- members: creation ----------

  private nextMemberId(provider: Provider): string {
    const n = this.members().filter((m) => m.provider === provider).length + 1;
    return `${provider}-${n}`;
  }

  /** Choose the account for a CLI member; falls back to another provider when configured. */
  private chooseAccount(provider: CliProvider, prefer?: string, exclude: string[] = []): { provider: CliProvider; account: Account } {
    const a = this.accounts.pick(provider, { prefer, exclude });
    if (a) return { provider, account: a };
    const fb = this.project.members.fallbackProvider;
    if (fb && fb !== provider) {
      const b = this.accounts.pick(fb, { exclude });
      if (b) return { provider: fb, account: b };
    }
    const states = this.accounts
      .list(provider)
      .map((x) => `${x.id}:${x.status}${x.resetAt ? "(reset " + x.resetAt + ")" : ""}`)
      .join(", ");
    throw new Error(`no usable ${provider} account (${states || "none"}). Add one with 'gencouncil account add' or wait for the reset.`);
  }

  private memoryMcpConfig(agent: string): Record<string, unknown> {
    const env: Record<string, string> = { GENCOUNCIL_ROLE: "member", GENCOUNCIL_AGENT: agent };
    if (process.env.GENCOUNCIL_HOME) env.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
    return { mcpServers: { gencouncil: { type: "stdio", command: process.execPath, args: [serverEntry()], env } } };
  }

  async assign(input: AssignInput): Promise<MemberRecord> {
    const task = this.task(input.taskId);
    const agenda = this.store.agenda();
    const requested = input.provider ?? this.project.members.defaultProvider;
    const limits = this.limits();

    let provider: Provider = requested;
    let account: Account | undefined;
    let model: string | undefined;
    let effort: MemberRecord["effort"];
    let advisor: string | undefined;
    let site: WebSite | undefined;
    if (requested !== "relay") {
      const pick = this.chooseAccount(requested, input.account);
      provider = pick.provider;
      account = pick.account;
      const p = provider as CliProvider;
      this.checkSlot(p);
      // a fallback provider cannot use the other provider's model name
      model = resolveModel(p, p === requested ? input.model : undefined, limits[p]);
      effort = resolveEffort(p, input.effort, limits[p]);
      if (p === "claude") advisor = resolveAdvisor(model, input.advisor, limits.claude);
    } else {
      site = input.site && (WEB_SITES as readonly string[]).includes(input.site) ? input.site : undefined;
      if (site) {
        this.checkSlot(site);
        // a pre-logged-in browser profile for that site, if the user set one up
        account = this.accounts.pickWeb(site, input.account);
      }
    }
    const id = this.nextMemberId(provider);
    const branch = this.store.memberBranch(id);
    const worktree = this.store.memberWorktree(id);
    await ensureWorktree(this.project.repo, worktree, branch, agenda.branch);

    const member: MemberRecord = {
      id,
      provider,
      label: provider === "relay" ? input.label || (site ? SITE_INFO[site].label : "relay") : undefined,
      site,
      model,
      effort,
      advisor,
      account: account?.id,
      taskId: task.id,
      branch,
      worktree,
      status: "starting",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      relayFiles: provider === "relay" ? input.files : undefined,
    };
    const members = this.members();
    members.push(member);
    this.saveMembers(members);
    this.updateTask(task.id, { status: "doing", memberId: id });

    const councilDir = path.join(worktree, ".council");
    fs.mkdirSync(councilDir, { recursive: true });
    for (const f of ["RESULT.md", "STATE.md"]) {
      const p = path.join(councilDir, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    let packet = buildPacket({ project: this.project, agenda, task, member, instructions: input.instructions, memoryIndex: this.memory.renderIndex() });
    if (provider === "relay") {
      const bundle = input.files?.length ? bundleFiles(worktree, input.files) : "(포함된 파일 없음)";
      packet = `${RELAY_PROMPT_HEAD}\n\n${packet}\n\n${RELAY_FORMAT}\n\n## 포함된 파일\n\n${bundle}\n`;
    }
    fs.writeFileSync(path.join(councilDir, "TASK.md"), packet, "utf8");

    if (provider === "relay") {
      member.status = "waiting";
      this.saveMembers(members);
      this.emit("member:start", member);
      this.log(`relay member ${id} waiting for a human to carry the packet (${input.files?.length ?? 0} files bundled)`);
      return member;
    }
    this.spawnMember(member, packet, account!);
    return member;
  }

  /** Start the CLI process for a member in its worktree with the given packet on stdin. */
  private spawnMember(member: MemberRecord, packet: string, account: Account): void {
    const provider = member.provider as CliProvider;
    const agenda = this.store.agenda();
    const task = this.task(member.taskId);
    const councilDir = path.join(member.worktree, ".council");
    const agentLabel = `${provider}:${this.project.id}/${agenda.slug}/${member.id}`;
    const mcpCfg = this.memoryMcpConfig(agentLabel) as { mcpServers: Record<string, unknown> };
    const chairApproves = provider === "claude" && this.project.members.autonomy === "chair" && Boolean(this.memberMcp);
    if (provider === "claude" && this.project.members.autonomy === "chair" && !this.memberMcp)
      this.log(`member ${member.id}: chair approval unavailable here (no council endpoint); running with file edits only`);
    if (chairApproves) {
      const t = this.memberMcp!(member.id);
      mcpCfg.mcpServers.council_member = { type: "http", url: t.url, ...(t.headers ? { headers: t.headers } : {}) };
    }
    const mcpFile = path.join(councilDir, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify(mcpCfg, null, 2), "utf8");
    if (provider === "gemini") {
      const gdir = path.join(member.worktree, ".gemini");
      fs.mkdirSync(gdir, { recursive: true });
      fs.writeFileSync(path.join(gdir, "settings.json"), JSON.stringify(mcpCfg, null, 2), "utf8");
    }
    const extraArgs: string[] = [];
    if (provider === "claude") {
      extraArgs.push("--mcp-config", mcpFile, "--strict-mcp-config");
      if (chairApproves) extraArgs.push("--permission-prompt-tool", "mcp__council_member__permission");
      if (member.advisor) extraArgs.push("--advisor", member.advisor);
      if (this.project.members.explorers ?? true) {
        const agentsFile = path.join(councilDir, "agents.json");
        fs.writeFileSync(agentsFile, JSON.stringify(explorerAgents(), null, 2), "utf8");
        extraArgs.push("--agents", agentsFile);
      }
      extraArgs.push(...(this.project.members.claudeArgs ?? []));
    }
    const logFile = this.store.memberLog(member.id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    logStream.write(
      `=== ${new Date().toISOString()} spawn ${provider} account=${account.id} model=${member.model ?? "default"} effort=${member.effort ?? "-"} advisor=${member.advisor ?? "-"} task=${task.id} branch=${member.branch}\n`,
    );

    const parse = provider === "claude" ? parseClaudeLine : provider === "gpt" ? parseCodexLine : makeAgyParser();
    let resultText = "";
    let sawError = false;
    const tail: string[] = [];
    const remember = (line: string) => {
      tail.push(line);
      if (tail.length > 200) tail.shift();
    };
    this.accounts.touch(account.id);
    let proc: RunningProc;
    try {
      proc = drivers[provider].spawn(
        {
          cwd: member.worktree,
          prompt: MEMBER_PROMPT,
          stdinText: packet,
          model: member.model,
          effort: member.effort,
          autonomy: this.project.members.autonomy,
          env: { ...this.accounts.env(account), GENCOUNCIL_ROLE: "member", GENCOUNCIL_AGENT: agentLabel },
          extraArgs,
        },
        (stream, line) => {
          logStream.write(`[${stream}] ${line}\n`);
          if (stream === "stderr") {
            remember(line);
            return;
          }
          for (const ev of parse(line)) {
            if (ev.kind === "init") {
              // record the model that actually runs (aliases like "sonnet" resolve here)
              if (ev.model && ev.model !== member.model) {
                member.model = ev.model;
                this.saveMembers(this.members());
                this.emit("member:start", member);
              }
            } else if (ev.kind === "tool") {
              member.toolCalls++;
              this.emit("member:line", member, `tool ${ev.name}`);
            } else if (ev.kind === "text") {
              member.lastText = ev.text.slice(0, 2000);
              remember(ev.text.slice(0, 500));
              this.emit("member:line", member, ev.text.split("\n")[0].slice(0, 160));
            } else if (ev.kind === "result") {
              resultText = ev.text;
              sawError = ev.isError;
              remember(ev.text.slice(0, 1000));
            }
          }
        },
      );
    } catch (e) {
      logStream.write(`=== spawn failed: ${(e as Error).message}\n`);
      logStream.end();
      member.status = "failed";
      member.error = (e as Error).message;
      member.failure = { kind: "other", message: member.error };
      member.endedAt = new Date().toISOString();
      this.saveMembers(this.members());
      this.emit("member:done", member);
      return;
    }
    member.pid = proc.pid;
    member.status = "running";
    this.saveMembers(this.members());
    this.running.set(member.id, proc);
    this.emit("member:start", member);
    this.log(`member ${member.id} started (pid ${proc.pid}, account ${account.id}) on ${member.branch}`);

    void proc.done.then(async (exit) => {
      this.running.delete(member.id);
      logStream.write(`=== exit code=${exit.code} signal=${exit.signal}\n`);
      logStream.end();
      await this.finalizeMember(member, exit.code, sawError, resultText, tail.join("\n"));
    });
  }

  // ---------- members: completion ----------

  private async finalizeMember(member: MemberRecord, code: number | null, sawError: boolean, resultText: string, output: string): Promise<void> {
    const agenda = this.store.agenda();
    member.endedAt = new Date().toISOString();
    member.exitCode = code;
    if (member.status !== "stopped") member.status = code === 0 && !sawError ? "done" : "failed";
    try {
      if (!(await isClean(member.worktree))) {
        await git(member.worktree, ["add", "-A"]);
        await git(member.worktree, ["commit", "-q", "-m", `wip: ${member.taskId} (auto-commit by council)`]);
        this.log(`member ${member.id}: uncommitted changes auto-committed`);
      }
      member.commits = await logRange(this.project.repo, agenda.branch, member.branch);
      member.diffstat = await diffStat(this.project.repo, agenda.branch, member.branch);
    } catch (e) {
      member.error = `git: ${(e as Error).message}`;
    }
    const resultFile = path.join(member.worktree, ".council", "RESULT.md");
    if (fs.existsSync(resultFile)) {
      member.result = parseResult(fs.readFileSync(resultFile, "utf8"));
    } else {
      member.result = { summary: resultText || member.lastText || "", changedFiles: "", unfinished: "(RESULT.md 없음)", proposals: [], raw: resultText };
    }
    this.ingestProposals(member);

    // classify failures and update the account registry
    let handedOver: MemberRecord | undefined;
    if (member.status === "failed" && member.provider !== "relay") {
      member.failure = classifyFailure(member.provider, `${output}\n${resultText}`, code);
      member.error = member.failure.message;
      if (member.account && member.failure.kind === "quota") this.accounts.markExhausted(member.account, member.failure.message, member.failure.resetAt);
      if (member.account && member.failure.kind === "auth") this.accounts.markAuth(member.account, member.failure.message);
      if (member.failure.kind !== "other" && (this.project.members.autoHandover ?? true)) {
        try {
          handedOver = await this.handover(member.id, { reason: `${member.failure.kind}: ${member.failure.message}` });
        } catch (e) {
          this.log(`auto-handover of ${member.id} not possible: ${(e as Error).message}`);
          member.error = `${member.error} (핸드오버 불가: ${(e as Error).message})`;
        }
      }
    }
    if (!handedOver) {
      const t = this.store.tasks().find((x) => x.id === member.taskId);
      if (t && t.status === "doing") this.updateTask(t.id, { status: member.status === "done" ? "review" : "blocked" });
    }
    this.saveMembers(this.members());
    this.log(`member ${member.id} ${member.status} (${member.commits?.length ?? 0} commits)${handedOver ? ` → handed over to ${handedOver.id}` : ""}`);
    this.finished.push(member);
    this.emit("member:done", member);
    for (const f of this.waiters.splice(0)) f();
  }

  private ingestProposals(member: MemberRecord): void {
    const agenda = this.store.agenda();
    for (const p of member.result?.proposals ?? []) {
      try {
        this.memory.propose({
          title: p.title,
          type: (["solution", "tool", "convention", "account", "persona"].includes(p.type) ? p.type : "solution") as EntryType,
          body: p.body,
          tags: p.tags,
          project: this.project.name,
          source: `${member.provider}:${this.project.id}/${agenda.slug}/${member.id}`,
        });
      } catch (e) {
        this.log(`proposal skipped: ${(e as Error).message}`);
      }
    }
  }

  private handoverCount(member: MemberRecord): number {
    let n = 0;
    let cur: MemberRecord | undefined = member;
    while (cur?.handoverFrom) {
      n++;
      cur = this.members().find((m) => m.id === cur!.handoverFrom);
    }
    return n;
  }

  /** Continue a stopped/failed member's work with a new process in the same worktree and branch. */
  async handover(memberId: string, opts: HandoverOptions = {}): Promise<MemberRecord> {
    const prev = this.member(memberId);
    if (this.running.has(memberId)) throw new Error(`member ${memberId} is still running; stop it first`);
    if (prev.provider === "relay" && !opts.provider) throw new Error("relay member: specify provider claude|gemini|gpt to hand over to a CLI member");
    if (prev.handoverTo) throw new Error(`member ${memberId} was already handed over to ${prev.handoverTo}`);
    // check before changing any record, so a failed handover leaves nothing half-done
    if (!fs.existsSync(path.join(prev.worktree, ".council"))) throw new Error(`member ${memberId}: 작업 폴더가 없습니다 (${prev.worktree})`);
    const max = this.project.members.maxHandovers ?? 2;
    if (!opts.resume && this.handoverCount(prev) >= max) throw new Error(`task ${prev.taskId} already handed over ${max} times`);

    const wantProvider = (opts.provider ?? (prev.provider === "relay" ? this.project.members.defaultProvider : prev.provider)) as CliProvider;
    let pick: ReturnType<Council["chooseAccount"]>;
    if (opts.resume) {
      // same login as before when it is still usable, otherwise any usable one
      try {
        pick = this.chooseAccount(wantProvider, opts.account ?? prev.account, []);
      } catch {
        pick = this.chooseAccount(wantProvider, undefined, []);
      }
    } else {
      const exclude = prev.account && !opts.account ? [prev.account] : [];
      pick = this.chooseAccount(wantProvider, opts.account, exclude);
    }
    const provider = pick.provider;
    const limits = this.limits();
    this.checkSlot(provider);
    const sameProvider = provider === prev.provider;
    const model = resolveModel(provider, opts.model ?? (sameProvider ? prev.model : undefined), limits[provider]);
    const effort = resolveEffort(provider, opts.effort ?? (sameProvider ? prev.effort : undefined), limits[provider]);
    let advisor: string | undefined;
    if (provider === "claude" && sameProvider && prev.advisor) {
      try {
        advisor = resolveAdvisor(model, prev.advisor, limits.claude);
      } catch {
        advisor = undefined;
      }
    }
    const id = this.nextMemberId(provider);
    const next: MemberRecord = {
      id,
      provider,
      model,
      effort,
      advisor,
      account: pick.account.id,
      taskId: prev.taskId,
      branch: prev.branch,
      worktree: prev.worktree,
      status: "starting",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      handoverFrom: prev.id,
    };
    const members = this.members();
    prev.handoverTo = id;
    prev.interrupted = false;
    if (prev.status !== "failed") prev.status = "handed_over";
    members.push(next);
    this.saveMembers(members);
    this.updateTask(prev.taskId, { status: "doing", memberId: id, note: `${prev.id} → ${id} 인계 (${opts.reason ?? "manual"})` });

    const councilDir = path.join(prev.worktree, ".council");
    const read = (f: string) => (fs.existsSync(path.join(councilDir, f)) ? fs.readFileSync(path.join(councilDir, f), "utf8") : "");
    const agenda = this.store.agenda();
    let commits: string[] = [];
    let stat = "";
    let uncommitted = "";
    try {
      commits = await logRange(this.project.repo, agenda.branch, prev.branch);
      stat = await diffStat(this.project.repo, agenda.branch, prev.branch);
      uncommitted = await git(prev.worktree, ["status", "--porcelain"]);
    } catch {
      /* best effort */
    }
    const packet = buildHandoverPacket({
      original: read("TASK.md"),
      fromMember: prev.id,
      toMember: id,
      reason: opts.reason ?? "manual handover",
      stateMd: read("STATE.md"),
      commits,
      diffstat: stat,
      uncommitted,
      previousResult: read("RESULT.md") || undefined,
    });
    fs.writeFileSync(path.join(councilDir, "HANDOVER.md"), packet, "utf8");
    const rf = path.join(councilDir, "RESULT.md");
    if (fs.existsSync(rf)) fs.renameSync(rf, path.join(councilDir, `RESULT.${prev.id}.md`));
    this.log(`handover ${prev.id} → ${id} (${provider}/${pick.account.id}): ${opts.reason ?? "manual"}`);
    this.spawnMember(next, packet, pick.account);
    return next;
  }

  // ---------- relay ----------

  relayPacket(memberId: string): string {
    const m = this.member(memberId);
    if (m.provider !== "relay") throw new Error(`${memberId} is not a relay member`);
    const f = path.join(m.worktree, ".council", "TASK.md");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }

  /** Apply a relay member's answer (FILE/RESULT blocks) or just mark it done after manual edits. */
  async relaySubmit(memberId: string, input: { response?: string; result?: string }): Promise<MemberRecord> {
    const m = this.member(memberId);
    if (m.provider !== "relay") throw new Error(`${memberId} is not a relay member`);
    if (m.status !== "waiting") throw new Error(`relay member ${memberId} is ${m.status}`);
    const councilDir = path.join(m.worktree, ".council");
    let written: string[] = [];
    let resultText = input.result?.trim() ?? "";
    if (input.response?.trim()) {
      const parsed = parseRelayResponse(input.response);
      written = applyRelayFiles(m.worktree, parsed.files);
      if (!resultText && parsed.result) resultText = parsed.result;
      if (parsed.files.length === 0 && !parsed.result) throw new Error("no FILE/RESULT blocks found in the response");
    }
    if (!resultText) resultText = `## 결과\n릴레이 위원 결과가 수동으로 반영되었다.\n\n## 변경 파일\n${written.map((w) => `- ${w}`).join("\n") || "(수동 편집)"}\n\n## 미완료·막힌 점\n없음\n`;
    fs.writeFileSync(path.join(councilDir, "RESULT.md"), resultText + "\n", "utf8");
    const task = this.task(m.taskId);
    if (!(await isClean(m.worktree))) {
      await git(m.worktree, ["add", "-A"]);
      await git(m.worktree, ["commit", "-q", "-m", `${task.title}: relay ${m.label ?? ""} (${written.length} files)`]);
    }
    m.status = "running"; // finalize expects a live-ish status to compute done/failed
    await this.finalizeMember(m, 0, false, resultText, "");
    return m;
  }

  // ---------- members: inspection / control ----------

  async memberInfo(id: string, opts: { tail?: number; diff?: boolean } = {}): Promise<Record<string, unknown>> {
    const m = this.member(id);
    const agenda = this.store.agenda();
    const logFile = this.store.memberLog(id);
    let tail: string[] = [];
    if (opts.tail && fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, "utf8").split("\n");
      tail = lines.slice(-opts.tail).map((l) => l.slice(0, 400));
    }
    let diff: string | undefined;
    if (opts.diff) {
      try {
        diff = await diffFull(this.project.repo, agenda.branch, m.branch);
      } catch (e) {
        diff = `(diff failed: ${(e as Error).message})`;
      }
    }
    // after the agenda is closed the worktree is gone; fall back to the archived copy
    const stateFile = [path.join(m.worktree, ".council", "STATE.md"), path.join(this.archiveDir(m.worktree), "STATE.md")].find((f) => fs.existsSync(f));
    const stateMd = stateFile ? fs.readFileSync(stateFile, "utf8") : undefined;
    return { ...m, result: m.result ? { ...m.result, raw: undefined } : undefined, logTail: tail, diff, stateMd };
  }

  async waitAny(timeoutMs: number): Promise<MemberRecord[]> {
    if (this.finished.length) return this.finished.splice(0);
    if (this.running.size === 0) return [];
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    return this.finished.splice(0);
  }

  takeFinished(): MemberRecord[] {
    return this.finished.splice(0);
  }

  stopMember(id: string): boolean {
    const proc = this.running.get(id);
    const m = this.member(id);
    if (!proc) {
      if (m.status === "waiting") {
        m.status = "stopped";
        m.endedAt = new Date().toISOString();
        this.saveMembers(this.members());
        this.updateTask(m.taskId, { status: "blocked", note: `${m.id} 릴레이 취소` });
        this.emit("member:done", m);
        return true;
      }
      return false;
    }
    m.status = "stopped";
    proc.stop();
    return true;
  }

  async merge(memberId: string): Promise<MergeResult & { member: string; branch: string }> {
    const m = this.member(memberId);
    const task = this.task(m.taskId);
    if (this.running.has(memberId)) throw new Error(`member ${memberId} is still running`);
    const res = await mergeInto(this.store.integrationWorktree(), m.branch, `merge ${m.id}: ${task.title}`);
    const members = this.members();
    const mm = members.find((x) => x.id === memberId)!;
    if (res.ok) {
      mm.merged = true;
      this.updateTask(task.id, { status: "done" });
    } else {
      this.updateTask(task.id, { status: "blocked", note: `merge conflict: ${res.conflicts.join(", ")}` });
    }
    this.saveMembers(members);
    this.log(`merge ${memberId}: ${res.ok ? "ok" : "CONFLICT " + res.conflicts.join(",")}`);
    return { ...res, member: m.id, branch: m.branch };
  }

  checkpoint(md: string): void {
    this.store.saveChairState(md);
  }

  // ---------- agenda end ----------

  async finish(): Promise<string> {
    if (this.running.size) throw new Error("members still running");
    const repo = this.project.repo;
    const agenda = this.store.agenda();
    const cur = await currentBranch(repo);
    if (cur !== agenda.baseBranch) throw new Error(`main checkout is on '${cur}', expected '${agenda.baseBranch}'. Switch branches first.`);
    // local-git folders: commit the user's own edits first so the merge sees them (conflicts surface as git conflicts)
    if (this.project.localGit) await commitUserEdits(this.project);
    if (!(await isClean(repo))) throw new Error("main checkout has uncommitted changes; commit or stash them first");
    const res = await mergeInto(repo, agenda.branch, `agenda: ${agenda.title}`);
    if (!res.ok) throw new Error(`merge conflict in main checkout: ${res.conflicts.join(", ")}`);
    const output = res.output;
    await this.clean();
    agenda.status = "closed";
    agenda.closed = new Date().toISOString();
    this.store.saveAgenda(agenda);
    return output;
  }

  /** <agenda>/archive/<worktree name>/ keeps a worktree's .council/*.md after the worktree is removed */
  archiveDir(worktree: string): string {
    return path.join(this.store.dir, "archive", path.basename(worktree));
  }

  /** Copy TASK/RESULT/STATE/HANDOVER notes out of a worktree before it is deleted. Returns files copied. */
  archiveCouncilFiles(worktree: string): string[] {
    const src = path.join(worktree, ".council");
    if (!fs.existsSync(src)) return [];
    const dest = this.archiveDir(worktree);
    const copied: string[] = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith(".md")) continue;
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
      copied.push(f);
    }
    return copied;
  }

  async clean(opts: { deleteBranches?: boolean } = {}): Promise<void> {
    if (this.running.size) throw new Error("members still running");
    const repo = this.project.repo;
    const archived = new Set<string>();
    for (const m of this.members()) {
      // handed-over members share a worktree; archive it once
      if (!archived.has(m.worktree)) {
        archived.add(m.worktree);
        const files = this.archiveCouncilFiles(m.worktree);
        if (files.length) this.log(`archived ${files.length} notes from ${path.basename(m.worktree)}`);
      }
      await removeWorktree(repo, m.worktree);
      if (opts.deleteBranches) await deleteBranch(repo, m.branch);
    }
    await removeWorktree(repo, this.store.integrationWorktree());
    const root = this.store.worktreeRoot();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
}
