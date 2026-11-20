import { EventEmitter } from "node:events";
import { GEMINI_OFF, geminiEnabled } from "./optin.js";
import fs from "node:fs";
import path from "node:path";
import { WikiStore, type EntryType, type MemoryStore } from "@gencouncil/core";
import { serverEntry } from "@gencouncil/mcp/install";
import { AccountRegistry, type Account } from "./accounts.js";
import { ChairApprover, chairReview, type PermissionDecision, type Reviewer } from "./approval.js";
import { codexMcpArgs, drivers, makeAgyParser, parseClaudeLine, parseCodexLine, type RunningProc } from "./drivers.js";
import {
  currentBranch,
  branchExists,
  deleteBranch,
  diffFull,
  diffStat,
  ensureBranch,
  ensureExclude,
  ensureWorktree,
  git,
  hasCommits,
  isClean,
  trackedChanges,
  isRepo,
  logRange,
  mergeInto,
  suspiciousFiles,
  removeWorktree,
  removeDir,
  leftoverDir,
  isInside,
  type MergeResult,
} from "./git.js";
import { explorerAgents } from "./explorers.js";
import {
  consultPrompt,
  explorePrompt,
  explorerModel,
  oneShot,
  providerOfModel,
  strongestWithin,
  type ExploreKind,
} from "./oneshot.js";
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
  checkTopModelUsage,
  allowedEfforts,
  effortIndex,
  allowedModels,
  tierOf,
  type CliProvider,
  type Effort,
  type LimitKey,
  type Limits,
  type WebSite,
} from "./models.js";
import { commitUserEdits } from "./localgit.js";
import { linkShared, prepareShared } from "./shared.js";
import {
  AgendaStore,
  ProjectRegistry,
  projectMemoryKey,
  SHOW_TYPES,
  TASK_KINDS,
  type AgendaConfig,
  type MemberRecord,
  type ProjectConfig,
  type Provider,
  type Task,
  type TaskKind,
  type TaskStatus,
} from "./model.js";
import { effortStats, effortStatsMarkdown } from "./effortStats.js";
import { buildHandoverPacket, buildPacket, buildVerifyPacket, MEMBER_PROMPT, parseResult } from "./packet.js";
import { classifyFailure } from "./quota.js";
import { reapStrays, snapshotDescendants, stopLeftover, stopProcessesUnder, stopTracked } from "./interrupt.js";
import { applyRelayFiles, bundleFiles, parseRelayResponse, RELAY_FORMAT } from "./relay.js";

export { accountsFile, loadAccounts, type Account } from "./accounts.js";

export interface AssignInput {
  taskId: string;
  provider?: Provider;
  model?: string;
  /** low | medium | high | xhigh | max, as far as the model and the user's limit go */
  effort?: string;
  /** mechanical | routine | complex: recorded with the member so results can be compared per kind */
  kind?: string;
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
  /** false: skip the automatic Claude check after a Gemini Flash member (doc-only or trivial work) */
  verify?: boolean;
  /** only when the user explicitly asked for this top model: skip the weekly-usage floor */
  overrideUsage?: boolean;
}

export interface VerifyOptions {
  overrideUsage?: boolean;
  model?: string;
  effort?: string;
  reason?: string;
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

/** a council_telegram request handed to the Telegram bridge by whoever hosts the council */
export interface TelegramRequest {
  text: string;
  files: Array<{ name: string; type: string; path: string }>;
  /** the pending question to attach as buttons */
  ask?: { question: string; options: string[] };
}

export type TelegramSender = (req: TelegramRequest) => Promise<{ ok: boolean; detail: string }>;

export interface CouncilState {
  project: { id: string; name: string; repo: string; baseBranch: string };
  agenda: { slug: string; title: string; goals: string[]; branch: string; status: string; waitingForUser?: { question: string; options?: string[]; at: string; kind?: "finish" }; telegramAuto?: boolean };
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
  /** member folders on disk (the integration folder not counted): a long agenda piles them up */
  folders: number;
}

/** one member folder in a tidy report */
export interface FolderInfo {
  /** folder name, e.g. "claude-12" */
  name: string;
  members: Array<{ id: string; status: MemberRecord["status"]; merged: boolean }>;
  /**
   * busy: someone is working in it; parked: free, kept for the next member to reuse; free: merged and
   * nothing left, removed by a tidy; unmerged: finished work not merged yet, removed by a tidy (the
   * branch keeps it and the folder comes back when needed); dirty: changes nobody committed, never removed
   */
  kind: "busy" | "parked" | "free" | "unmerged" | "dirty";
  /** dirty only: how many files changed or new */
  changed?: number;
}

export interface FolderReport {
  folders: FolderInfo[];
  counts: Record<FolderInfo["kind"], number>;
  /** what a tidy would remove */
  removable: number;
  /** a measured folder's size, to estimate what a tidy frees (undefined when nothing could be measured) */
  perFolderMb?: number;
}

/** size of a folder's own files (links into shared folders and .git not followed), within a time budget */
function folderSizeMb(dir: string, budgetMs = 6000): number | undefined {
  const until = Date.now() + budgetMs;
  let bytes = 0;
  const walk = (d: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (Date.now() > until) return false;
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!walk(p)) return false;
      } else bytes += st.size;
    }
    return true;
  };
  return walk(dir) ? Math.round(bytes / 1048576) : undefined;
}

/** merged member folders kept per agenda for new members to reuse; the rest are removed */
export const PARKED_FOLDERS = 4;

/**
 * Which one-shot helpers a member needs from the council endpoint. A claude member has the real
 * things in-session (`--advisor`, `--agents`), so it is given a tool only where that flag is
 * missing: no advisor was attached (a Fable main cannot take one), or explorers are off.
 */
export function memberHelpers(member: Pick<MemberRecord, "provider" | "advisor">, project: ProjectConfig): Array<"consult" | "explore"> {
  const out: Array<"consult" | "explore"> = [];
  const claude = member.provider === "claude";
  if (!claude || !member.advisor) out.push("consult");
  if (!claude && (project.members.explorers ?? true)) out.push("explore");
  return out;
}

const RELAY_PROMPT_HEAD = `# 릴레이 작업 패킷

당신은 제작위원회의 위원이다. 저장소에 직접 접근할 수 없으므로 필요한 파일은 아래에 포함되어 있다. 아래 지시를 수행하고, 반드시 '답변 양식'대로만 답하라. 사람이 당신의 답변을 그대로 저장소에 적용한다.`;

export class Council extends EventEmitter {
  readonly project: ProjectConfig;
  readonly registry = new ProjectRegistry();
  readonly accounts = new AccountRegistry();
  private membersCache: MemberRecord[] | null = null;
  private running = new Map<string, RunningProc>();
  private trackTimer?: NodeJS.Timeout;

  /** while members run, remember their child processes every minute (see snapshotDescendants) */
  private ensureTracking(): void {
    if (this.trackTimer) return;
    this.trackTimer = setInterval(() => void this.trackDescendants(), 60_000);
    this.trackTimer.unref?.();
  }

  private async trackDescendants(): Promise<void> {
    if (this.running.size === 0) {
      if (this.trackTimer) clearInterval(this.trackTimer);
      this.trackTimer = undefined;
      return;
    }
    const byPid = new Map<number, MemberRecord>();
    for (const id of this.running.keys()) {
      const m = this.members().find((x) => x.id === id);
      if (m?.pid) byPid.set(m.pid, m);
    }
    try {
      const snap = await snapshotDescendants([...byPid.keys()]);
      let changed = false;
      for (const [root, found] of snap) {
        const m = byPid.get(root);
        if (!m || found.length === 0) continue;
        const known = new Set((m.descendants ?? []).map((d) => `${d.pid}@${d.startedAt}`));
        for (const d of found) {
          if (known.has(`${d.pid}@${d.startedAt}`)) continue;
          (m.descendants ??= []).push(d);
          changed = true;
        }
        if (m.descendants && m.descendants.length > 300) m.descendants = m.descendants.slice(-300);
      }
      if (changed) this.saveMembers(this.members());
    } catch {
      /* best effort */
    }
  }
  private finished: MemberRecord[] = [];
  private waiters: Array<() => void> = [];
  /** where claude members reach the permission tool (set by whoever hosts the council MCP) */
  private memberMcp?: (memberId: string) => { url: string; headers?: Record<string, string> };
  /**
   * The chair settings this agenda runs on: its own choices, falling back to the project's.
   * Every agenda picks its own AI, so a change here never reaches another agenda.
   */
  chairCfg(): ProjectConfig["chair"] {
    const own = this.store.agenda().chair ?? {};
    const p = this.project.chair;
    return {
      ...p,
      ...(own.model !== undefined ? { model: own.model || undefined } : {}),
      ...(own.effort !== undefined ? { effort: own.effort || undefined } : {}),
      ...(own.advisor !== undefined ? { advisor: own.advisor } : {}),
      ...(own.account !== undefined ? { account: own.account || undefined } : {}),
    };
  }

  /** Store this agenda's own chair settings (undefined values are left as they were). */
  saveChairCfg(patch: { model?: string; effort?: string; advisor?: string; account?: string }): void {
    const a = this.store.agenda();
    a.chair = { ...(a.chair ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (a.chair as Record<string, string>)[k] = v;
    }
    this.store.saveAgenda(a);
  }

  /** decides permission requests the rules can't; replaceable in tests */
  reviewer: Reviewer;
  private approver: ChairApprover;

  constructor(
    readonly store: AgendaStore,
    readonly memory: MemoryStore,
  ) {
    super();
    this.project = store.project;
    // the reviewer always runs on Claude; a GPT/Gemini chair borrows a usable claude login with Opus
    this.reviewer = (req) => {
      const cfg = this.chairCfg();
      const chairAccount = this.accounts.get(cfg.account ?? "claude");
      const onClaude = !chairAccount || chairAccount.provider === "claude";
      return chairReview(req, {
        model: onClaude ? cfg.model : "opus",
        env: this.accounts.env(onClaude ? chairAccount : this.accounts.pick("claude")),
      });
    };
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

  /** how long each step of the last open() took, for the server's slow-open log */
  openSteps: string[] = [];

  async open(): Promise<void> {
    const repo = this.project.repo;
    this.openSteps = [];
    let t = Date.now();
    const step = (name: string) => {
      this.openSteps.push(`${name} ${Date.now() - t}ms`);
      t = Date.now();
    };
    if (!(await isRepo(repo))) throw new Error(`not a git repository: ${repo}`);
    if (!(await hasCommits(repo))) throw new Error(`repository has no commits yet: ${repo}`);
    await ensureExclude(repo, [".worktrees/", ".council/", ".gemini/"]);
    step("repo check");
    // a closed agenda is history: show it, but never commit, recreate its branch or worktrees
    if (this.store.agenda().status === "closed") {
      const closed = this.store.agenda();
      if (closed.waitingForUser) {
        closed.waitingForUser = undefined;
        this.store.saveAgenda(closed);
      }
      fs.rmSync(path.join(this.store.chairDir(), "running.json"), { force: true });
      const still = await this.retryPendingCleanup();
      if (still.length) this.log(`still locked: ${still.join(", ")}`);
      return;
    }
    if (this.project.localGit) {
      // the user edits this folder directly; record their changes so agendas start from them
      const c = await commitUserEdits(this.project);
      if (c) this.log(`사용자 변경을 커밋했습니다 (${c.slice(0, 7)})`);
      step("user edits");
    }
    const agenda = this.store.agenda();
    await ensureBranch(repo, agenda.branch, agenda.baseBranch);
    await ensureWorktree(repo, this.store.integrationWorktree(), agenda.branch, agenda.baseBranch);
    step("integration worktree");
    await prepareShared(this.project).catch((e) => this.log(`shared folders: ${(e as Error).message.split("\n")[0]}`));
    this.linkSharedInto(this.store.integrationWorktree());
    const members = this.members();
    let changed = false;
    for (const m of members) {
      if (m.status === "running" || m.status === "starting") {
        // the CLI may still be running on its own (Windows keeps children alive); stop it first
        if (await stopLeftover(m.pid, m.startedAt)) this.log(`member ${m.id}: stopped a leftover process (pid ${m.pid})`);
        // the recorded root may be gone while its children still run (e.g. cmd.exe -> codex); find them by worktree path
        const tracked = await stopTracked(m.descendants);
        if (tracked) this.log(`member ${m.id}: stopped ${tracked} remembered child process(es)`);
        const orphans = await stopProcessesUnder(m.worktree);
        if (orphans.length) this.log(`member ${m.id}: stopped ${orphans.length} orphaned process(es) in its worktree`);
        m.status = "stopped";
        m.interrupted = true;
        m.error = "앱이 꺼지면서 중단됨";
        m.endedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.saveMembers(members);
    step("leftover members");
    // folders merged before this feature existed, or left while the app was down; in the background, it can take minutes
    void this.pruneMergedWorktrees().catch((e) => this.log(`prune failed: ${(e as Error).message}`));
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
      agenda: { slug: a.slug, title: a.title, goals: a.goals, branch: a.branch, status: a.status, waitingForUser: a.waitingForUser, telegramAuto: a.telegramAuto !== false },
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
      folders: this.folderGroups().length,
    };
  }

  /** the project's limits, with Gemini (Antigravity CLI) at zero while it is switched off for the space */
  limits(): Limits {
    const l = normalizeLimits(this.project.members.limits);
    return geminiEnabled() ? l : { ...l, gemini: { ...l.gemini, maxMembers: 0 } };
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

  /** latest subscription usage (set by the web server, which polls it every few minutes) */
  private usageProvider?: () => Array<{ provider: string; account: string; fiveHour?: { usedPct: number; resetsAt?: string }; weekly?: { usedPct: number; resetsAt?: string }; error?: string }> | undefined;

  setUsageProvider(fn: Council["usageProvider"]): void {
    this.usageProvider = fn;
  }

  /** highest weekly remaining % among this provider's measured accounts (undefined when unknown) */
  weeklyLeft(provider: string): number | undefined {
    const rows = (this.usageProvider?.() ?? []).filter((u) => u.provider === provider && !u.error && u.weekly);
    if (!rows.length) return undefined;
    return Math.max(...rows.map((u) => 100 - u.weekly!.usedPct));
  }

  limitsMarkdown(): string {
    const off = geminiEnabled() ? "" : "\n\n제미나이(gemini, 안티그래비티 CLI)는 사용자가 꺼 두었다(약관상 계정 정지 위험). gemini 위원은 만들 수 없다. 제미나이가 꼭 필요하면 relay(gemini-web·aistudio)를 쓴다.";
    const table = limitsMarkdown(this.limits(), this.activeCounts()) + off;
    const usage = this.usageProvider?.();
    if (!usage?.length) return table;
    const left = (w?: { usedPct: number }) => (w ? `${100 - w.usedPct}% 남음` : "-");
    const rows = usage
      .filter((u) => !u.error)
      .map((u) => `| ${u.provider}${u.account !== u.provider ? " (" + u.account + ")" : ""} | ${left(u.fiveHour)} | ${left(u.weekly)} |`);
    if (!rows.length) return table;
    return `${table}

남은 사용량 (몇 분 전 측정):
| 계정 | 5시간 | 주간 |
|---|---|---|
${rows.join("\n")}`;
  }

  /** how past members did per model and reasoning level, for the models this project may use ("" when there is nothing yet) */
  effortStatsMarkdown(): string {
    const limits = this.limits();
    try {
      return effortStatsMarkdown(effortStats(), {
        allow: (p, model) => limits[p].maxMembers > 0 && (tierOf(p, limits[p].maxModel) < 0 || tierOf(p, model) <= tierOf(p, limits[p].maxModel)),
      });
    } catch (e) {
      this.log(`effort stats unavailable: ${(e as Error).message}`);
      return "";
    }
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
  /** step down to a model this login can still run (Antigravity quota is per model) */
  private fitModel(account: Account, model: string): string {
    const fit = this.accounts.fitModel(account.id, model);
    if (!fit) {
      const blocks = Object.entries(account.modelBlocks ?? {}).map(([m, at]) => `${m}(reset ${at})`).join(", ");
      throw new Error(`${account.id}: 이 계정은 ${model} 이하 모델 한도가 모두 찼습니다 (${blocks})`);
    }
    if (fit !== model) this.log(`${account.id}: ${model} 한도 소진 → ${fit}로 실행`);
    return fit;
  }

  private chooseAccount(provider: CliProvider, prefer?: string, exclude: string[] = []): { provider: CliProvider; account: Account } {
    const a = this.accounts.pick(provider, { prefer, exclude });
    if (a) return { provider, account: a };
    const fb = this.project.members.fallbackProvider;
    if (fb && fb !== provider) {
      const b = this.accounts.pick(fb, { exclude });
      if (b) return { provider: fb, account: b };
    }
    if (provider === "gemini" && !geminiEnabled()) throw new LimitError(GEMINI_OFF);
    const states = this.accounts
      .list(provider)
      .map((x) => `${x.id}:${x.status}${x.resetAt ? "(reset " + x.resetAt + ")" : ""}`)
      .join(", ");
    throw new Error(`no usable ${provider} account (${states || "none"}). Add one with 'gencouncil account add' or wait for the reset.`);
  }

  private memoryMcpConfig(agent: string): Record<string, unknown> {
    const env: Record<string, string> = { GENCOUNCIL_ROLE: "member", GENCOUNCIL_AGENT: agent, GENCOUNCIL_PROJECT: projectMemoryKey(this.project) };
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
      model = this.fitModel(account, resolveModel(p, p === requested ? input.model : undefined, limits[p]));
      checkTopModelUsage(p, model, this.weeklyLeft(p), input.overrideUsage, limits[p].topModelMinWeeklyLeft);
      effort = resolveEffort(p, input.effort, limits[p], model);
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
    if (!(await this.reuseFolder(worktree, branch))) await ensureWorktree(this.project.repo, worktree, branch, agenda.branch);
    this.linkSharedInto(worktree);

    const member: MemberRecord = {
      id,
      provider,
      label: provider === "relay" ? input.label || (site ? SITE_INFO[site].label : "relay") : undefined,
      site,
      model,
      effort,
      kind: (TASK_KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as TaskKind) : undefined,
      advisor,
      account: account?.id,
      taskId: task.id,
      branch,
      worktree,
      status: "starting",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      relayFiles: provider === "relay" ? input.files : undefined,
      verify: input.verify === false ? false : undefined,
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
    let packet = buildPacket({ project: this.project, agenda, task, member, instructions: input.instructions, memoryIndex: this.memory.renderIndex({ project: projectMemoryKey(this.project) }), wikiToc: new WikiStore().renderRoot({ project: projectMemoryKey(this.project) }) });
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
    // the member endpoint carries consult/explore (and the permission tool in "chair approves"
    // autonomy), so a Codex or Antigravity member has an advisor and an explorer too. A claude
    // member keeps the native --advisor/--agents and only needs the endpoint when it has neither.
    let councilToken: string | undefined;
    if (this.memberMcp && (chairApproves || memberHelpers(member, this.project).length > 0)) {
      const t = this.memberMcp(member.id);
      councilToken = (t.headers?.Authorization ?? t.headers?.authorization)?.replace(/^Bearer\s+/i, "");
      // Codex takes the bearer token from an env var, not from a headers map
      mcpCfg.mcpServers.council_member =
        provider === "gpt" && councilToken
          ? { type: "http", url: t.url, bearerTokenEnvVar: "GENCOUNCIL_COUNCIL_TOKEN" }
          : { type: "http", url: t.url, ...(t.headers ? { headers: t.headers } : {}) };
    }
    const mcpFile = path.join(councilDir, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify(mcpCfg, null, 2), "utf8");
    if (provider === "gemini") {
      const gdir = path.join(member.worktree, ".gemini");
      fs.mkdirSync(gdir, { recursive: true });
      fs.writeFileSync(path.join(gdir, "settings.json"), JSON.stringify(mcpCfg, null, 2), "utf8");
    }
    const extraArgs: string[] = [];
    if (provider === "gpt") {
      // shared memory (memory_search / memory_propose) for Codex members, same server the others get
      extraArgs.push(...codexMcpArgs(mcpCfg as Parameters<typeof codexMcpArgs>[0]));
    }
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
          env: {
            ...this.accounts.env(account),
            GENCOUNCIL_ROLE: "member",
            GENCOUNCIL_AGENT: agentLabel,
            // strict MCP config keeps the tool list small: load it up front instead of a ToolSearch round trip
            ...(provider === "claude" ? { ENABLE_TOOL_SEARCH: "false" } : {}),
            ...(councilToken ? { GENCOUNCIL_COUNCIL_TOKEN: councilToken } : {}),
          },
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
    this.ensureTracking();
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
    // The member is gone; the shells it started are not. Windows reaps nothing, and once a member's
    // own background shell exits, taskkill /t can no longer reach what that shell left (a `tail -f`
    // on a log, a `grep --line-buffered` behind it, a polling `sleep`) because the parent it would
    // walk is already dead. Until now this ran only when the app restarted or a run was resumed, so
    // every normally finished member left its pipeline behind for good — 170 of them, up to five
    // days old, was the state that prompted this.
    //
    // Only the pipeline filters among its own remembered descendants are taken, and only where the
    // parent is already dead. The worktree-wide sweep (stopProcessesUnder) is NOT used here: a
    // render or a conversion started through bin/bg.mjs is supposed to outlive the member, and its
    // command line names the member's worktree, so that sweep would kill the work.
    try {
      const pids = (member.descendants ?? []).map((d) => d.pid);
      const killed = await reapStrays({ minAgeMinutes: 0, pids });
      const n = Object.values(killed).reduce((a, b) => a + b, 0);
      if (n) this.log(`member ${member.id}: stopped ${n} leftover shell process(es) (${Object.keys(killed).join(", ")})`);
    } catch (e) {
      this.log(`member ${member.id}: cleanup skipped (${(e as Error).message.split("\n")[0]})`);
    }
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
    // screenshots / drafts the member left for the chair to show
    try {
      const shotsDir = path.join(member.worktree, ".council", "shots");
      if (fs.existsSync(shotsDir)) {
        member.shots = fs
          .readdirSync(shotsDir)
          .filter((f) => SHOW_TYPES[path.extname(f).toLowerCase()])
          .map((f) => path.join(shotsDir, f))
          .slice(0, 20);
      }
    } catch {
      /* best effort */
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
      if (member.account && member.failure.kind === "quota") {
        // Antigravity spends each model on its own: a spent Argon leaves Flash on the same login
        if (!this.accounts.blockModel(member.account, member.model, member.failure.message, member.failure.resetAt))
          this.accounts.markExhausted(member.account, member.failure.message, member.failure.resetAt);
      }
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
    // Gemini Flash code work gets a Claude check before the chair merges it
    let verifier: MemberRecord | undefined;
    if (!handedOver && this.shouldAutoVerify(member)) {
      try {
        verifier = await this.verify(member.id, { reason: "Gemini Flash가 끝낸 코드 작업 자동 검증" });
      } catch (e) {
        this.log(`auto-verify of ${member.id} not possible: ${(e as Error).message}`);
        member.error = `${member.error ? member.error + " · " : ""}자동 검증 못 붙임: ${(e as Error).message}`;
      }
    }
    if (!handedOver && !verifier) {
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
          project: projectMemoryKey(this.project),
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
    if (prev.worktreeReleased) throw new Error(`member ${memberId}: 결과가 이미 안건 브랜치에 합쳐져 작업 폴더를 정리했거나 다른 위원에게 넘겼습니다. 이어서 할 일은 새로 배정하세요.`);
    await this.restoreTidiedFolder(prev);
    if (!fs.existsSync(path.join(prev.worktree, ".council"))) throw new Error(`member ${memberId}: 작업 폴더가 없습니다 (${prev.worktree})`);
    const max =this.project.members.maxHandovers ?? 2;
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
      const modelOnly = prev.failure?.kind === "quota" && prev.account !== undefined && this.accounts.get(prev.account)?.status === "ok";
      const exclude = prev.account && !opts.account && !modelOnly ? [prev.account] : [];
      pick = this.chooseAccount(wantProvider, opts.account, exclude);
    }
    const provider = pick.provider;
    const limits = this.limits();
    this.checkSlot(provider);
    const sameProvider = provider === prev.provider;
    const model = this.fitModel(pick.account, resolveModel(provider, opts.model ?? (sameProvider ? prev.model : undefined), limits[provider]));
    const inheritedEffort = sameProvider && prev.effort
      ? allowedEfforts(provider, limits[provider], model).filter((e) => effortIndex(e) <= effortIndex(prev.effort)).at(-1)
      : undefined;
    const effort = resolveEffort(provider, opts.effort ?? inheritedEffort, limits[provider], model);
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
      kind: prev.kind,
      advisor,
      account: pick.account.id,
      taskId: prev.taskId,
      branch: prev.branch,
      worktree: prev.worktree,
      status: "starting",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      handoverFrom: prev.id,
      // a login that ran out or stopped working is not a verdict on the work; a restart is neither
      handoverCause: opts.resume ? "resume" : prev.failure?.kind === "quota" || prev.failure?.kind === "auth" ? prev.failure.kind : "manual",
      handoverReason: opts.reason?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined,
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

  // ---------- verification ----------

  /** Gemini Flash finished code work (commits) and nobody said to skip the check. */
  private shouldAutoVerify(m: MemberRecord): boolean {
    if (m.provider !== "gemini" || m.status !== "done" || m.verifiedBy || m.verify === false) return false;
    if (this.project.members.verifyGeminiFlash === false) return false;
    if (tierOf("gemini", m.model) !== 0) return false;
    return (m.commits?.length ?? 0) > 0;
  }

  /**
   * Start a Claude member that checks another member's finished work in the same worktree and
   * branch (default Sonnet, high effort, both clamped to the user's limits).
   */
  async verify(memberId: string, opts: VerifyOptions = {}): Promise<MemberRecord> {
    const prev = this.member(memberId);
    if (this.running.has(memberId)) throw new Error(`member ${memberId} is still running`);
    if (prev.verifiedBy) throw new Error(`member ${memberId} is already being checked by ${prev.verifiedBy}`);
    if (prev.status !== "done") throw new Error(`member ${memberId} is ${prev.status}; only finished work can be checked`);
    if (prev.worktreeReleased) throw new Error(`member ${memberId}: 결과가 이미 안건 브랜치에 합쳐져 작업 폴더를 정리했거나 다른 위원에게 넘겼습니다. 검증은 합친 결과를 새로 배정해 하세요.`);
    await this.restoreTidiedFolder(prev);
    if (!fs.existsSync(path.join(prev.worktree, ".council"))) throw new Error(`member ${memberId}: 작업 폴더가 없습니다 (${prev.worktree})`);
    const limits = this.limits();
    const pick = this.chooseAccount("claude", undefined, []);
    if (pick.provider !== "claude") throw new Error("no usable claude account for the check");
    this.checkSlot("claude");
    const allowed = allowedModels("claude", limits.claude).map((m) => m.id);
    const wantModel = opts.model ?? (allowed.includes("sonnet") ? "sonnet" : allowed[allowed.length - 1]);
    const model = resolveModel("claude", wantModel, limits.claude);
    checkTopModelUsage("claude", model, this.weeklyLeft("claude"), opts.overrideUsage, this.limits().claude.topModelMinWeeklyLeft);
    const efforts = allowedEfforts("claude", limits.claude);
    const effort = resolveEffort("claude", opts.effort ?? (efforts.includes("high") ? "high" : efforts[efforts.length - 1]), limits.claude);
    const id = this.nextMemberId("claude");
    const next: MemberRecord = {
      id,
      provider: "claude",
      model,
      effort,
      account: pick.account.id,
      taskId: prev.taskId,
      branch: prev.branch,
      worktree: prev.worktree,
      status: "starting",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      verifyOf: prev.id,
    };
    const members = this.members();
    prev.verifiedBy = id;
    members.push(next);
    this.saveMembers(members);
    this.updateTask(prev.taskId, { status: "doing", memberId: id, note: `${prev.id} 결과를 ${id}가 검증 중` });

    const councilDir = path.join(prev.worktree, ".council");
    const read = (f: string) => (fs.existsSync(path.join(councilDir, f)) ? fs.readFileSync(path.join(councilDir, f), "utf8") : "");
    const agenda = this.store.agenda();
    let commits: string[] = [];
    let stat = "";
    try {
      commits = await logRange(this.project.repo, agenda.branch, prev.branch);
      stat = await diffStat(this.project.repo, agenda.branch, prev.branch);
    } catch {
      /* best effort */
    }
    const packet = buildVerifyPacket({
      original: read("TASK.md"),
      fromMember: prev.id,
      fromModel: prev.model,
      toMember: id,
      agendaBranch: agenda.branch,
      commits,
      diffstat: stat,
      previousResult: read("RESULT.md") || undefined,
      reason: opts.reason ?? "의장 요청",
    });
    fs.writeFileSync(path.join(councilDir, "VERIFY.md"), packet, "utf8");
    const rf = path.join(councilDir, "RESULT.md");
    if (fs.existsSync(rf)) fs.renameSync(rf, path.join(councilDir, `RESULT.${prev.id}.md`));
    this.log(`verify ${prev.id} → ${id} (claude ${model}/${effort ?? "-"}): ${opts.reason ?? "manual"}`);
    this.spawnMember(next, packet, pick.account);
    return next;
  }

  // ---------- advisor consult / repository explorer (every provider) ----------

  /** per-caller one-shot counts for this agenda, so a looping member cannot burn an allowance */
  private oneShotUsed = new Map<string, number>();

  private takeOneShot(kind: "consult" | "explore", who: string): void {
    const cap = kind === "consult" ? 12 : 30;
    const key = `${kind}\u0000${who}`;
    const used = this.oneShotUsed.get(key) ?? 0;
    if (used >= cap)
      throw new Error(`${who}의 ${kind} 호출이 이 안건에서 ${cap}회 한도에 닿았다. 직접 판단하거나 결과를 RESULT.md에 적고 끝낸다.`);
    this.oneShotUsed.set(key, used + 1);
  }

  /** where a one-shot call may read: the asking member's worktree, or the chair's integration worktree */
  private oneShotCwd(memberId?: string): string {
    return memberId ? this.member(memberId).worktree : this.store.integrationWorktree();
  }

  /**
   * Pick provider + model for a one-shot call, clamped to the user's limits, on an account that is
   * actually usable. A fallback to another provider changes the model too: a claude model id means
   * nothing to codex.
   */
  private oneShotTarget(want: string | undefined, kind: "consult" | "explore"): { provider: CliProvider; model: string; account: Account } {
    const limits = this.limits();
    const asked = want?.trim() || undefined;
    let provider = (asked && providerOfModel(asked)) || "claude";
    if (asked && !providerOfModel(asked)) throw new LimitError(`unknown model "${asked}"`);
    const pick = this.chooseAccount(provider, undefined, []);
    provider = pick.provider;
    const limit = limits[provider];
    // the asked-for model only survives when the fallback did not move us to another provider
    const rung = kind === "explore" ? explorerModel(provider) : (asked && providerOfModel(asked) === provider ? asked : strongestWithin(provider, limit.maxModel));
    let model: string;
    try {
      model = resolveModel(provider, rung, limit);
    } catch {
      model = strongestWithin(provider, limit.maxModel);
    }
    return { provider, model: this.fitModel(pick.account, model), account: pick.account };
  }

  private oneShotEffort(provider: CliProvider, model: string, want: Effort): Effort | undefined {
    try {
      return resolveEffort(provider, want, this.limits()[provider], model);
    } catch {
      return resolveEffort(provider, undefined, this.limits()[provider], model);
    }
  }

  /**
   * Ask a stronger model one question and return its answer. This is what `claude --advisor` does
   * for a claude member, as a tool any provider can call.
   */
  async consult(input: { question: string; context?: string; model?: string; memberId?: string }): Promise<Record<string, unknown>> {
    const q = input.question?.trim();
    if (!q) throw new Error("question is required");
    const cwd = this.oneShotCwd(input.memberId);
    const { provider, model, account } = this.oneShotTarget(input.model, "consult");
    const asker = input.memberId ? `위원 ${input.memberId}` : "의장";
    this.takeOneShot("consult", asker);
    const effort = this.oneShotEffort(provider, model, "high");
    this.accounts.touch(account.id);
    this.log(`consult by ${asker}: ${provider} ${model}/${effort ?? "-"} (${account.id})`);
    const r = await oneShot({
      provider,
      model,
      effort,
      cwd,
      env: this.accounts.env(account),
      prompt: consultPrompt({ question: q, context: input.context, asker }),
      tools: "none",
      timeoutMs: 300_000,
    });
    this.log(`consult by ${asker} → ${r.error ? "실패: " + r.error : `${r.seconds}초, ${r.text.length}자`}`);
    return { advisor: `${provider}:${model}`, seconds: r.seconds, ...(r.error ? { error: r.error } : {}), answer: r.text };
  }

  /**
   * Read-only repository lookup on the cheapest rung, so the asking session spends its own context
   * on the work instead of on `git grep`.
   */
  async explore(input: { kind?: ExploreKind; query: string; memberId?: string }): Promise<Record<string, unknown>> {
    const query = input.query?.trim();
    if (!query) throw new Error("query is required");
    const kind: ExploreKind = input.kind ?? "search";
    this.takeOneShot("explore", input.memberId ?? "의장");
    const cwd = this.oneShotCwd(input.memberId);
    const { provider, model, account } = this.oneShotTarget(undefined, "explore");
    const effort = this.oneShotEffort(provider, model, "low");
    this.accounts.touch(account.id);
    this.log(`explore(${kind}) by ${input.memberId ?? "chair"}: ${provider} ${model} (${account.id}) "${query.slice(0, 60)}"`);
    const r = await oneShot({
      provider,
      model,
      effort,
      cwd,
      env: this.accounts.env(account),
      prompt: explorePrompt(kind, query),
      tools: "read",
      timeoutMs: 240_000,
    });
    this.log(`explore(${kind}) → ${r.error ? "실패: " + r.error : `${r.seconds}초, ${r.text.length}자`}`);
    return { explorer: `${provider}:${model}`, kind, seconds: r.seconds, ...(r.error ? { error: r.error } : {}), found: r.text };
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

  async memberInfo(id: string, opts: { tail?: number; diff?: boolean; files?: string[]; maxChars?: number } = {}): Promise<Record<string, unknown>> {
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
        const files = opts.files?.filter(Boolean) ?? [];
        diff = await diffFull(this.project.repo, agenda.branch, m.branch, opts.maxChars ?? (files.length ? 60_000 : 20_000), files);
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
    // a member's report can miss what it committed: name temp files, secrets and huge files in the result
    const warnings = await suspiciousFiles(this.store.integrationWorktree(), m.branch);
    const res: MergeResult = { ...(await mergeInto(this.store.integrationWorktree(), m.branch, `merge ${m.id}: ${task.title}`)), ...(warnings.length ? { warnings } : {}) };
    if (warnings.length) this.log(`merge ${memberId}: suspicious files ${warnings.join(", ")}`);
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
    // merged work no longer needs its folder; a big repo checkout per member adds up fast
    if (res.ok) void this.pruneMergedWorktrees().catch((e) => this.log(`prune failed: ${(e as Error).message}`));
    return { ...res, member: m.id, branch: m.branch };
  }

  checkpoint(md: string): void {
    this.store.saveChairState(md);
  }

  // ---------- agenda end ----------

  /**
   * Put files from this agenda's worktrees or the project folder into the chat (copied into the
   * agenda's attachments so they outlive worktree cleanup). Used for drafts, screenshots, mockups.
   */
  showFiles(paths: string[], caption: string): Array<{ id: string; name: string; type: string; size: number }> {
    const checked = this.checkShowFiles(paths);
    const dir = path.join(this.store.dir, "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const out: Array<{ id: string; name: string; type: string; size: number }> = [];
    for (const { abs, name, type, size } of checked) {
      const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}-${name}`;
      fs.copyFileSync(abs, path.join(dir, id));
      out.push({ id, name, type, size });
    }
    const text = caption.trim();
    this.store.appendTranscript({ role: "assistant", text, attachments: out, shown: true });
    this.emit("show", { caption: text, attachments: out });
    this.log(`chair showed ${out.length} file(s): ${out.map((a) => a.name).join(", ")}`);
    return out;
  }

  /** Path rules shared by council_show and council_telegram: inside this agenda's worktrees or the project folder, known types, at most 8 files / 25MB each. */
  private checkShowFiles(paths: string[]): Array<{ abs: string; name: string; type: string; size: number }> {
    if (!paths.length) throw new Error("no files to show");
    if (paths.length > 8) throw new Error("show at most 8 files at once");
    // archive: shots of merged members whose folders were removed
    const roots = [this.store.worktreeRoot(), this.project.repo, path.join(this.store.dir, "archive")].map((r) => path.resolve(r));
    const base = this.store.integrationWorktree();
    return paths.map((p) => {
      const abs = path.resolve(path.isAbsolute(p) ? p : path.join(base, p));
      if (!roots.some((r) => !path.relative(r, abs).startsWith("..") && !path.isAbsolute(path.relative(r, abs)))) throw new Error(`${p}: 이 안건의 작업 폴더나 프로젝트 폴더 밖의 파일은 보여줄 수 없습니다`);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`${p}: 파일이 없습니다`);
      const ext = path.extname(abs).toLowerCase();
      const type = SHOW_TYPES[ext];
      if (!type) throw new Error(`${p}: 보여줄 수 없는 형식입니다 (${Object.keys(SHOW_TYPES).join(" ")})`);
      const size = fs.statSync(abs).size;
      if (size > 25 * 1024 * 1024) throw new Error(`${p}: 25MB보다 큽니다`);
      const name = path.basename(abs).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(-80);
      return { abs, name, type, size };
    });
  }

  /** set by whoever hosts the council and has a Telegram bridge (the web server); absent = Telegram not connected */
  private telegramSender?: TelegramSender;

  setTelegramSender(fn: TelegramSender | undefined): void {
    this.telegramSender = fn;
  }

  /**
   * council_telegram: send text (and files, and the pending question as buttons) to the user's Telegram.
   * Only for an explicit user instruction; the prompt and the tool description say so.
   */
  async sendTelegram(text: string, paths?: string[], ask?: boolean): Promise<{ sent: true; detail: string }> {
    if (!this.telegramSender) throw new Error("텔레그램이 연결되어 있지 않다 (gencouncil web telegram 으로 설정하고 서버를 다시 시작해야 한다)");
    const body = text.trim();
    if (!body) throw new Error("보낼 글이 비어 있다");
    const files = paths?.length ? this.checkShowFiles(paths).map(({ abs, name, type }) => ({ name, type, path: abs })) : [];
    let question: TelegramRequest["ask"];
    if (ask) {
      const w = this.store.agenda().waitingForUser;
      if (!w) throw new Error("ask:true 이지만 지금 기다리는 질문이 없다. 먼저 council_ask_user 를 부른다");
      question = { question: w.question, options: w.options ?? [] };
    }
    const r = await this.telegramSender({ text: body, files, ...(question ? { ask: question } : {}) });
    this.log(`chair → telegram: ${r.ok ? "ok" : "failed"} ${r.detail}`);
    if (!r.ok) throw new Error(`텔레그램 전송 실패: ${r.detail}`);
    return { sent: true, detail: r.detail };
  }

  /** The chair needs a decision from the user: mark the agenda as waiting until the user answers. */
  askUser(question: string, options?: string[], kind?: "finish"): { waiting: true } {
    const a = this.store.agenda();
    a.waitingForUser = { question: question.trim(), options: options?.map((o) => o.trim()).filter(Boolean).slice(0, 6), at: new Date().toISOString(), ...(kind ? { kind } : {}) };
    this.store.saveAgenda(a);
    this.log(`chair is waiting for the user: ${a.waitingForUser.question.slice(0, 120)}`);
    this.emit("ask", a.waitingForUser);
    this.emit("agenda");
    return { waiting: true };
  }

  /** the user turned this agenda's automatic Telegram sending on or off (web button or Telegram /auto) */
  setTelegramAuto(on: boolean): void {
    const a = this.store.agenda();
    if ((a.telegramAuto !== false) === on) return;
    // unset means on (the default); only an explicit off is stored
    if (on) delete a.telegramAuto;
    else a.telegramAuto = false;
    this.store.saveAgenda(a);
    this.log(`텔레그램 자동 전송 ${on ? "켜짐" : "꺼짐"}`);
    this.emit("agenda");
  }

  /** the user answered (any message): no longer waiting */
  clearWaiting(): void {
    const a = this.store.agenda();
    if (!a.waitingForUser) return;
    delete a.waitingForUser;
    this.store.saveAgenda(a);
    this.emit("agenda");
  }

  /** set by the chair's council_finish; the runtime finishes the agenda once the chair's turn is over */
  finishRequest?: { reason: string; at: string };

  /** members whose finished work never reached the agenda branch */
  unmergedMembers(): MemberRecord[] {
    return this.members().filter((m) => m.status === "done" && !m.merged && !m.handoverTo && (m.commits?.length ?? 0) > 0);
  }

  /** Check what would stop finish() now, without changing anything. */
  async finishProblems(opts: { includeUnmerged?: boolean } = {}): Promise<string[]> {
    const problems: string[] = [];
    if (this.running.size) problems.push(`위원이 아직 실행 중이다: ${[...this.running.keys()].join(", ")}`);
    const unmerged = this.unmergedMembers();
    if (unmerged.length && !opts.includeUnmerged)
      problems.push(`머지하지 않은 위원 결과가 있다: ${unmerged.map((m) => m.id).join(", ")}. council_merge로 합치거나, 버릴 거면 include_unmerged:true로 다시 요청한다.`);
    const repo = this.project.repo;
    const agenda = this.store.agenda();
    const cur = await currentBranch(repo);
    if (cur !== agenda.baseBranch) problems.push(`메인 폴더가 '${cur}' 브랜치에 있다(필요: '${agenda.baseBranch}'). 사용자가 브랜치를 바꿔야 한다.`);
    else if (!this.project.localGit) {
      const changed = await trackedChanges(repo);
      if (changed.length)
        problems.push(
          `메인 폴더(${repo})에 커밋하지 않은 변경이 있다(${changed.length}개): ${changed.slice(0, 15).join(", ")}${changed.length > 15 ? " …" : ""}. 사용자가 커밋하거나 치워야 한다. (메인 폴더는 네 명령 범위 밖이니 직접 git으로 보려 하지 말고 이 목록을 사용자에게 전한다.)`,
        );
    }
    return problems;
  }

  /** chair asks to end the agenda; it runs after the current chair turn */
  /** set by the runtime when the user sends a message (more reliable than reading the transcript) */
  latestUserMessage?: string;

  /** what the user (not a council event) last said to the chair */
  lastUserMessage(): string | undefined {
    if (this.latestUserMessage !== undefined) return this.latestUserMessage;
    const f = path.join(this.store.dir, "transcript.jsonl");
    if (!fs.existsSync(f)) return undefined;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as { role?: string; text?: string };
        if (e.role === "user" && e.text && !e.text.startsWith("[council event]") && !e.text.startsWith("[회고]")) return e.text;
      } catch {
        /* skip */
      }
    }
    return undefined;
  }

  /**
   * The chair wants to end the agenda. It ends only when the user's latest message asks for it
   * (checked here, not trusted from the chair); otherwise it becomes a proposal the user approves.
   */
  async requestFinish(
    reason: string,
    opts: { includeUnmerged?: boolean } = {},
  ): Promise<{ scheduled: boolean; proposed?: boolean; problems: string[] }> {
    const problems = await this.finishProblems(opts);
    if (problems.length) return { scheduled: false, problems };
    if (!userAskedToFinish(this.lastUserMessage())) {
      this.askUser(`안건을 종료할까요? ${reason}`, ["안건 종료", "계속 진행"], "finish");
      this.log(`chair proposed finishing the agenda: ${reason}`);
      return { scheduled: false, proposed: true, problems: [] };
    }
    this.finishRequest = { reason, at: new Date().toISOString() };
    this.log(`chair requested agenda finish: ${reason}`);
    return { scheduled: true, problems: [] };
  }

  /** merge the agenda branch into the base branch in the main checkout (shared by finish and mergeToBase) */
  private async mergeAgendaIntoBase(message: string): Promise<{ output: string; agenda: AgendaConfig }> {
    const repo = this.project.repo;
    const agenda = this.store.agenda();
    const cur = await currentBranch(repo);
    if (cur !== agenda.baseBranch) throw new Error(`main checkout is on '${cur}', expected '${agenda.baseBranch}'. Switch branches first.`);
    // local-git folders: commit the user's own edits first so the merge sees them (conflicts surface as git conflicts)
    if (this.project.localGit) await commitUserEdits(this.project);
    const changed = await trackedChanges(repo);
    if (changed.length) throw new Error(`main checkout has uncommitted changes (${changed.slice(0, 10).join(", ")}); commit or stash them first`);
    const res = await mergeInto(repo, agenda.branch, message);
    if (!res.ok && !res.conflicts.length) throw new Error(`메인 폴더 머지가 실패했다(충돌은 아님): ${res.output.trim().split(/\s*\n\s*/).slice(-3).join(" ").slice(0, 400)}`);
    if (!res.ok)
      throw new Error(
        `메인(${agenda.baseBranch})이 이 안건 뒤에 따로 바뀌어 머지 충돌이 난다: ${res.conflicts.slice(0, 12).join(", ")}${res.conflicts.length > 12 ? ` 외 ${res.conflicts.length - 12}개` : ""}. ` +
          `메인 폴더는 그대로다. 위원 한 명에게 안건 브랜치(${agenda.branch})에서 'git merge ${agenda.baseBranch}'로 이 파일들을 합치게 하고(생성물은 생성기를 다시 돌려 만든다) council_merge한 뒤 다시 종료한다.`,
      );
    return { output: res.output, agenda };
  }

  /**
   * Merge what the agenda branch has so far into the base branch and keep the agenda open, so the
   * user sees the results in the main folder and later merges stay small. Member work that is not
   * merged into the agenda branch yet is not included.
   */
  async mergeToBase(by: "user" | "chair"): Promise<string> {
    if (this.store.agenda().status === "closed") throw new Error("이 안건은 이미 종료되었습니다.");
    const { output, agenda } = await this.mergeAgendaIntoBase(`agenda (중간 반영): ${this.store.agenda().title}`);
    const a = this.store.agenda();
    a.baseMerges = [...(a.baseMerges ?? []), { at: new Date().toISOString(), by }];
    this.store.saveAgenda(a);
    this.log(`merged ${agenda.branch} into ${agenda.baseBranch} (agenda stays open, by ${by})`);
    return output;
  }

  /** set while a finish merges; a second finish (double tap, chair and user at once) is refused */
  private finishing = false;

  async finish(): Promise<string> {
    if (this.running.size) throw new Error("members still running");
    if (this.finishing) throw new Error("이미 안건을 종료하는 중이다. 머지가 끝날 때까지 기다린다.");
    if (this.store.agenda().status === "closed") throw new Error("이 안건은 이미 종료되었습니다.");
    this.finishing = true;
    let output: string;
    let agenda: AgendaConfig;
    try {
      ({ output, agenda } = await this.mergeAgendaIntoBase(`agenda: ${this.store.agenda().title}`));
    } finally {
      this.finishing = false;
    }
    const res = { output };
    // the merge is the finish; from here on the agenda is closed even if a folder stays locked.
    // cleanup is recorded as pending first, so a server that dies mid-cleanup finishes it on the next open
    agenda.status = "closed";
    agenda.closed = new Date().toISOString();
    agenda.waitingForUser = undefined;
    agenda.cleanupPending = [this.store.worktreeRoot()];
    this.store.saveAgenda(agenda);
    const leftovers = await this.clean();
    {
      const a = this.store.agenda();
      a.cleanupPending = leftovers.length ? leftovers : undefined;
      this.store.saveAgenda(a);
    }
    if (leftovers.length) {
      this.log(`finish: could not delete ${leftovers.join(", ")}; will retry when the agenda is opened`);
      return `${res.output}\n(머지는 끝났지만 지우지 못한 폴더가 있어 나중에 다시 지웁니다: ${leftovers.join(", ")})`;
    }
    return res.output;
  }

  /** retry deleting folders a finish could not remove */
  async retryPendingCleanup(): Promise<string[]> {
    const a = this.store.agenda();
    if (!a.cleanupPending?.length) return [];
    const still: string[] = [];
    for (const dir of a.cleanupPending) {
      const p = leftoverDir(dir);
      // only this agenda's own worktree folder is ever deleted here, whatever the saved entry says
      if (!isInside(this.store.worktreeRoot(), p)) {
        this.log(`cleanup: skipped "${dir}" (not inside ${this.store.worktreeRoot()})`);
        continue;
      }
      // the whole worktree folder is pending when the finish died before its cleanup: do the full
      // cleanup (archive notes, remove each worktree through git, unlink node_modules junctions)
      if (path.resolve(p) === path.resolve(this.store.worktreeRoot())) still.push(...(await this.clean()));
      else if (await removeDir(p)) still.push(dir);
    }
    await git(this.project.repo, ["worktree", "prune"]).catch(() => "");
    a.cleanupPending = still.length ? still : undefined;
    this.store.saveAgenda(a);
    return still;
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

  /** folders a prune or an assign is working on; checked and set without an await in between */
  private claimed = new Set<string>();

  /** member folders with members, newest work first; the integration folder and gone folders are left out */
  private folderGroups(): Array<{ worktree: string; members: MemberRecord[]; ended: string }> {
    const groups = new Map<string, MemberRecord[]>();
    for (const m of this.members()) groups.set(m.worktree, [...(groups.get(m.worktree) ?? []), m]);
    const integration = path.resolve(this.store.integrationWorktree());
    return [...groups]
      .filter(([w, ms]) => path.resolve(w) !== integration && !ms.some((m) => m.worktreeReleased || m.worktreeTidied) && fs.existsSync(w))
      .map(([worktree, members]) => ({ worktree, members, ended: members.map((m) => m.endedAt ?? m.startedAt).sort().pop() ?? "" }))
      .sort((a, b) => b.ended.localeCompare(a.ended));
  }

  /**
   * The folder's work is all on the agenda branch and nobody needs it: nobody sharing it is
   * running, one of them was merged, the branch has no commits past the agenda branch, and no
   * uncommitted or untracked file is left (that would leak into the next member's work).
   */
  private async isFree(worktree: string, ms: MemberRecord[]): Promise<boolean> {
    if (ms.some((m) => this.running.has(m.id) || m.status === "starting" || m.status === "running" || m.status === "waiting")) return false;
    if (!ms.some((m) => m.merged)) return false;
    try {
      if ((await logRange(this.project.repo, this.store.agenda().branch, ms[0].branch)).length) return false;
      return await isClean(worktree);
    } catch {
      return false;
    }
  }

  /** Archive a free folder's notes and shots and mark its members as no longer owning it. */
  private releaseFolder(worktree: string): void {
    this.archiveCouncilFiles(worktree);
    const shots = this.archiveShots(worktree);
    const members = this.members();
    for (const m of members) {
      if (m.worktree !== worktree) continue;
      m.worktreeReleased = new Date().toISOString();
      if (m.shots) m.shots = m.shots.map((s) => shots.get(s) ?? s);
    }
    this.saveMembers(members);
  }

  /**
   * Hand a free folder to a new member instead of checking the repository out again: the folder is
   * renamed to the new member's path (no file is rewritten) and switched to its new branch, so git
   * only rewrites the files that differ. Returns false when no folder could be reused.
   */
  /** link the shared render folders (shared.ts) into a worktree; a failure never blocks the work */
  private linkSharedInto(worktree: string): void {
    try {
      const { skipped } = linkShared(this.project, worktree);
      if (skipped.length) this.log(`shared folders not linked into ${path.basename(worktree)} (this branch still has files there): ${skipped.join(", ")}`);
    } catch (e) {
      this.log(`shared folders: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  private async reuseFolder(worktree: string, branch: string): Promise<boolean> {
    const repo = this.project.repo;
    const from = this.store.agenda().branch;
    for (const g of this.folderGroups()) {
      if (this.claimed.has(g.worktree)) continue;
      this.claimed.add(g.worktree);
      try {
        if (!(await this.isFree(g.worktree, g.members))) continue;
        this.releaseFolder(g.worktree);
        fs.rmSync(path.join(g.worktree, ".council"), { recursive: true, force: true });
        try {
          await git(repo, ["worktree", "move", g.worktree, worktree]);
        } catch (e) {
          // a process still holds the folder: leave it for a later prune
          this.log(`could not reuse ${path.basename(g.worktree)}: ${(e as Error).message.split("\n")[0]}`);
          continue;
        }
        try {
          await git(worktree, ["checkout", "-q", "-b", branch, from]);
        } catch (e) {
          this.log(`reused folder would not switch branch, checking out fresh: ${(e as Error).message.split("\n")[0]}`);
          await removeWorktree(repo, worktree);
          return false;
        }
        this.log(`reused ${path.basename(g.worktree)}'s folder for ${path.basename(worktree)}`);
        return true;
      } finally {
        this.claimed.delete(g.worktree);
      }
    }
    return false;
  }

  /**
   * Free folders beyond the few kept for reuse are removed (notes and shots archived first, the
   * branch stays). Runs after merges and when the agenda opens. Returns how many were removed.
   */
  async pruneMergedWorktrees(keep = PARKED_FOLDERS): Promise<number> {
    if (this.store.agenda().status === "closed") return 0;
    let kept = 0;
    let removed = 0;
    for (const g of this.folderGroups()) {
      if (this.claimed.has(g.worktree)) continue;
      this.claimed.add(g.worktree);
      try {
        if (!(await this.isFree(g.worktree, g.members))) continue;
        if (kept < keep) {
          kept++;
          continue;
        }
        this.releaseFolder(g.worktree);
        await removeWorktree(this.project.repo, g.worktree);
        if (fs.existsSync(g.worktree)) this.log(`could not remove merged worktree ${path.basename(g.worktree)} (in use)`);
        else removed++;
      } finally {
        this.claimed.delete(g.worktree);
      }
    }
    if (removed) this.log(`removed ${removed} merged member worktree(s), kept ${kept} for reuse`);
    return removed;
  }

  /** what a folder is to a tidy (see FolderInfo.kind; parked is decided by the caller) */
  private async folderKind(worktree: string, ms: MemberRecord[]): Promise<{ kind: Exclude<FolderInfo["kind"], "parked">; changed?: number }> {
    if (ms.some((m) => this.running.has(m.id) || m.status === "starting" || m.status === "running" || m.status === "waiting")) return { kind: "busy" };
    try {
      const status = (await git(worktree, ["status", "--porcelain"])).split("\n").filter((l) => l.trim());
      // the council's own notes are archived before a removal; anything else would be lost
      const changed = status.filter((l) => !/^\?\? \.council\//.test(l) && !/^\?\? "?\.council\/?"?$/.test(l));
      if (changed.length) return { kind: "dirty", changed: changed.length };
      const ahead = (await logRange(this.project.repo, this.store.agenda().branch, ms[0].branch)).length;
      return { kind: ms.some((m) => m.merged) && ahead === 0 ? "free" : "unmerged" };
    } catch {
      // git could not read it (a half-removed folder): treat it like changes, never remove it blind
      return { kind: "dirty" };
    }
  }

  /** every member folder of this agenda and what a tidy would do with it */
  async folderReport(keep = PARKED_FOLDERS): Promise<FolderReport> {
    const groups = this.folderGroups();
    const kinds = new Array<{ kind: Exclude<FolderInfo["kind"], "parked">; changed?: number }>(groups.length);
    // a few at a time: a long agenda has dozens of folders, each a git status
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, groups.length) }, async () => {
        while (next < groups.length) {
          const i = next++;
          kinds[i] = await this.folderKind(groups[i].worktree, groups[i].members);
        }
      }),
    );
    let parked = 0;
    const folders: FolderInfo[] = groups.map((g, i) => {
      let kind: FolderInfo["kind"] = kinds[i].kind;
      // the newest free folders stay for new members to move into
      if (kind === "free" && parked < keep) {
        parked++;
        kind = "parked";
      }
      return { name: path.basename(g.worktree), members: g.members.map((m) => ({ id: m.id, status: m.status, merged: Boolean(m.merged) })), kind, ...(kinds[i].changed ? { changed: kinds[i].changed } : {}) };
    });
    const counts = { busy: 0, parked: 0, free: 0, unmerged: 0, dirty: 0 } as FolderReport["counts"];
    for (const f of folders) counts[f.kind]++;
    const sample = groups.find((_, i) => folders[i].kind === "free" || folders[i].kind === "unmerged") ?? groups[0];
    return { folders, counts, removable: counts.free + counts.unmerged, perFolderMb: sample ? folderSizeMb(sample.worktree) : undefined };
  }

  /**
   * Remove every member folder nobody needs: merged ones beyond the few kept for reuse, and finished
   * work not merged yet (its branch keeps it; the folder comes back for a handover or a check).
   * Folders someone works in and folders with uncommitted changes are never touched. Notes and
   * shots are archived first, branches are never deleted.
   */
  async tidyFolders(keep = PARKED_FOLDERS): Promise<{ removed: number; kept: number; busy: number; dirty: string[]; locked: string[] }> {
    const report = await this.folderReport(keep);
    const byName = new Map(this.folderGroups().map((g) => [path.basename(g.worktree), g]));
    let removed = 0;
    const locked: string[] = [];
    for (const f of report.folders) {
      if (f.kind !== "free" && f.kind !== "unmerged") continue;
      const g = byName.get(f.name);
      if (!g || this.claimed.has(g.worktree)) continue;
      this.claimed.add(g.worktree);
      try {
        // things may have moved since the report: look again right before removing
        const now = await this.folderKind(g.worktree, g.members);
        if (now.kind !== f.kind) continue;
        if (f.kind === "free") this.releaseFolder(g.worktree);
        else this.tidyFolder(g.worktree);
        await removeWorktree(this.project.repo, g.worktree);
        if (fs.existsSync(g.worktree)) locked.push(f.name);
        else removed++;
      } finally {
        this.claimed.delete(g.worktree);
      }
    }
    if (removed) this.log(`folder tidy: removed ${removed} member folder(s), kept ${report.counts.parked} for reuse${locked.length ? `, ${locked.length} in use` : ""}`);
    return { removed, kept: report.counts.parked, busy: report.counts.busy, dirty: report.folders.filter((f) => f.kind === "dirty").map((f) => f.name), locked };
  }

  /** Archive a folder whose work is not merged yet and mark its members so the folder can come back. */
  private tidyFolder(worktree: string): void {
    this.archiveCouncilFiles(worktree);
    const shots = this.archiveShots(worktree);
    const members = this.members();
    for (const m of members) {
      if (m.worktree !== worktree) continue;
      m.worktreeTidied = new Date().toISOString();
      if (m.shots) m.shots = m.shots.map((s) => shots.get(s) ?? s);
    }
    this.saveMembers(members);
  }

  /** A folder a tidy removed comes back from its branch, with its notes, before a handover or a check. */
  private async restoreTidiedFolder(prev: MemberRecord): Promise<void> {
    if (!prev.worktreeTidied || fs.existsSync(prev.worktree)) return;
    await ensureWorktree(this.project.repo, prev.worktree, prev.branch, this.store.agenda().branch);
    const archived = this.archiveDir(prev.worktree);
    const council = path.join(prev.worktree, ".council");
    fs.mkdirSync(council, { recursive: true });
    if (fs.existsSync(archived)) for (const f of fs.readdirSync(archived)) if (f.endsWith(".md")) fs.copyFileSync(path.join(archived, f), path.join(council, f));
    this.linkSharedInto(prev.worktree);
    const members = this.members();
    for (const m of members) if (m.worktree === prev.worktree) m.worktreeTidied = undefined;
    this.saveMembers(members);
    prev.worktreeTidied = undefined;
    this.log(`brought back ${path.basename(prev.worktree)}'s folder from its branch`);
  }

  /** Copy .council/shots/ next to the archived notes. Returns old path -> archived path. */
  private archiveShots(worktree: string): Map<string, string> {
    const out = new Map<string, string>();
    const src = path.join(worktree, ".council", "shots");
    if (!fs.existsSync(src)) return out;
    const dest = path.join(this.archiveDir(worktree), "shots");
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const from = path.join(src, f);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(dest, f));
      out.set(from, path.join(dest, f));
    }
    return out;
  }

  /** Remove the agenda's worktrees (notes archived first). Returns folders that stayed locked. */
  async clean(opts: { deleteBranches?: boolean } = {}): Promise<string[]> {
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
    const leftover = await removeDir(this.store.worktreeRoot());
    return leftover ? [leftover] : [];
  }
}

/**
 * Did the user ask to end the agenda? ("종료해", "마무리하자", "그만 끝내", "안건 닫아", "finish")
 * Negations ("종료하지 마", "끝내지 말고", "아직 종료 말고") do not count.
 */
/** the user's message asks to bring the agenda's results into the main branch now (without ending it) */
export function userAskedToMergeBase(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.replace(/^\[텔레그램\]\s*/, "").replace(/\s+/g, " ").trim();
  if (/(메인|main|베이스|base)[^.?!\n]{0,12}(합치|머지|반영|merge)[^.?!\n]{0,6}(지\s*마|말고|마세요|않|금지)/i.test(t)) return false;
  return /(메인|main|베이스|base)[^.?!\n]{0,12}(합치|합쳐|머지|반영|merge)/i.test(t);
}

export function userAskedToFinish(text: string | undefined): boolean {
  if (!text) return false;
  // messages relayed from Telegram carry a "[텔레그램] " source mark that is not part of what the user said
  const t = text.replace(/^\[텔레그램\]\s*/, "").replace(/\s+/g, " ").trim();
  if (/(종료|마무리|끝내|끝내|닫|close|finish)[^.?!\n]{0,8}(하지\s*마|하지\s*말|말고|마세요|안\s*돼|않|금지)/i.test(t)) return false;
  if (/(아직|나중에)[^.?!\n]{0,6}(종료|마무리|끝내|닫)/.test(t)) return false;
  return /(안건\s*)?(종료|마무리|끝내|끝내자|끝내줘|끝내 줘|닫아|닫자|그만\s*하자|close|finish)/i.test(t);
}

export interface DeleteAgendaResult {
  deleted: boolean;
  /** work that would be lost (only when not deleted) */
  lost: string[];
  /** where the agenda's records (transcript, notes) were moved */
  movedTo?: string;
}

/**
 * Delete an agenda: remove its worktrees and branches and move its records to
 * <project>/deleted/. Refuses (deleted: false, lost: [...]) when an open agenda has
 * commits that were never merged into the base branch, unless force is set.
 * The agenda's runtime must be closed first.
 */
export async function deleteAgenda(project: ProjectConfig, store: AgendaStore, opts: { force?: boolean } = {}): Promise<DeleteAgendaResult> {
  const repo = project.repo;
  const agenda = store.agenda();
  const members = store.members();
  const lost: string[] = [];
  if (agenda.status !== "closed") {
    if (await branchExists(repo, agenda.branch)) {
      const ahead = await logRange(repo, agenda.baseBranch, agenda.branch).catch(() => []);
      if (ahead.length) lost.push(`안건 브랜치 ${agenda.branch}: 베이스에 없는 커밋 ${ahead.length}개`);
    }
    for (const m of members) {
      if (!(await branchExists(repo, m.branch))) continue;
      const base = (await branchExists(repo, agenda.branch)) ? agenda.branch : agenda.baseBranch;
      const ahead = await logRange(repo, base, m.branch).catch(() => []);
      if (ahead.length && !lost.some((l) => l.includes(m.branch))) lost.push(`위원 ${m.id} (${m.branch}): 합치지 않은 커밋 ${ahead.length}개`);
    }
  }
  if (lost.length && !opts.force) return { deleted: false, lost };

  const seen = new Set<string>();
  for (const m of members) {
    if (!seen.has(m.worktree)) {
      seen.add(m.worktree);
      await removeWorktree(repo, m.worktree);
    }
  }
  await removeWorktree(repo, store.integrationWorktree());
  const leftover = await removeDir(store.worktreeRoot());
  if (leftover) throw new Error(`작업 폴더를 지우지 못했습니다: ${leftover}. 그 폴더를 쓰는 창이나 프로그램을 닫고 다시 시도하세요.`);
  for (const b of new Set(members.map((m) => m.branch))) await deleteBranch(repo, b);
  await deleteBranch(repo, agenda.branch);

  const trash = path.join(path.dirname(path.dirname(store.dir)), "deleted");
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${store.slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.renameSync(store.dir, dest);
  return { deleted: true, lost, movedTo: dest };
}
