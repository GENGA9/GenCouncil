import fs from "node:fs";
import path from "node:path";
import { gencouncilHome, slugify } from "@gencouncil/core";
import { normalizeLimits, type CliProvider, type Effort, type Limits, type WebSite } from "./models.js";

/** claude/gemini/gpt run as headless CLIs; relay = a human copies the packet into a web AI and pastes the answer back */
export type Provider = CliProvider | "relay";
/** full: no checks; chair: the chair's model approves each permission request; edits: file edits only */
export type Autonomy = "full" | "chair" | "edits";
/** git: work in the user's repository; folder: work in a private shadow repo and copy results back on finish */
export type ProjectMode = "git" | "folder";

export const COUNCIL_SUFFIX = "제작위원회";

/** "RF PROJECT" -> "RF PROJECT 제작위원회" (unchanged if it already ends with it) */
export function councilName(name: string): string {
  const n = name.trim();
  return n.endsWith(COUNCIL_SUFFIX) ? n : `${n} ${COUNCIL_SUFFIX}`;
}

export interface ProjectConfig {
  id: string;
  name: string;
  /** absolute path of the git repository the council works on (the shadow repo in folder mode) */
  repo: string;
  /** default "git" */
  mode?: ProjectMode;
  /** legacy copy mode only */
  source?: string;
  /** the folder was not a repository: GenCouncil created a local git there (never pushed) and commits the user's edits itself */
  localGit?: boolean;
  /** extra folder names to keep out of git (on top of environments, caches, binaries, big media) */
  ignore?: string[];
  /** branch agendas are cut from and merged back into (default: current branch at creation) */
  baseBranch: string;
  chair: {
    provider: "claude";
    model?: string;
    effort?: string;
    /** stronger model consulted at key decisions (claude --advisor); "" = off */
    advisor?: string;
    /** account id from the registry (default: "claude" = the normal login) */
    account?: string;
  };
  members: {
    autonomy: Autonomy;
    defaultProvider: CliProvider;
    /** per-provider member caps; the chair picks models/efforts within these */
    limits?: Partial<Limits>;
    claudeModel?: string;
    geminiModel?: string;
    /** advisor for claude members (default opus); "" = off */
    claudeAdvisor?: string;
    /** give claude members read-only Haiku explorer subagents (search / grep / docs); default true */
    explorers?: boolean;
    /** extra Claude Code flags for members, e.g. ["--max-turns","60"] */
    claudeArgs?: string[];
    /** replace a member automatically when it dies of a quota/auth error (default true) */
    autoHandover?: boolean;
    /** how many times one task may be handed over (default 2) */
    maxHandovers?: number;
    /** provider to fall back to when no account of the same provider is available */
    fallbackProvider?: CliProvider;
  };
  created: string;
}

export type AgendaStatus = "open" | "closed";

export interface AgendaConfig {
  slug: string;
  title: string;
  goals: string[];
  status: AgendaStatus;
  /** integration branch, e.g. agenda/balance */
  branch: string;
  baseBranch: string;
  created: string;
  closed?: string;
  /** the chair was in the middle of a turn when the app stopped */
  chairInterrupted?: { at: string; message: string };
}

export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked";

export interface Task {
  id: string;
  title: string;
  description: string;
  /** 1-based index into agenda.goals */
  goal?: number;
  status: TaskStatus;
  memberId?: string;
  note?: string;
  created: string;
  updated: string;
}

export type MemberStatus = "starting" | "running" | "waiting" | "done" | "failed" | "stopped" | "handed_over";

export type FailureKind = "quota" | "auth" | "other";

export interface MemberFailure {
  kind: FailureKind;
  message: string;
  /** ISO time when the account is expected to work again (quota only) */
  resetAt?: string;
}

export interface MemoryProposal {
  title: string;
  type: string;
  tags?: string[];
  body: string;
}

export interface MemberResult {
  summary: string;
  changedFiles: string;
  unfinished: string;
  proposals: MemoryProposal[];
  raw: string;
}

export interface MemberRecord {
  id: string;
  provider: Provider;
  /** display label for relay members, e.g. "제미나이(agy)" or "aistudio" */
  label?: string;
  /** relay members: which web AI */
  site?: WebSite;
  model?: string;
  effort?: Effort;
  /** claude members: advisor the chair attached */
  advisor?: string;
  account?: string;
  taskId: string;
  /** previous member whose worktree/branch this one continues */
  handoverFrom?: string;
  /** member that took this one's work over */
  handoverTo?: string;
  /** why it failed, when classified */
  failure?: MemberFailure;
  /** files bundled into a relay packet */
  relayFiles?: string[];
  branch: string;
  worktree: string;
  status: MemberStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** how many tool calls we saw in the stream */
  toolCalls: number;
  /** last assistant text we saw */
  lastText?: string;
  result?: MemberResult;
  commits?: string[];
  diffstat?: string;
  merged?: boolean;
  error?: string;
  /** cut off by an app shutdown / agenda close; can be resumed */
  interrupted?: boolean;
}

// ---------- model names ----------

/** "claude-sonnet-5-5" -> "Sonnet 5.5", "gemini-2.5-pro" -> "Gemini 2.5 Pro", "opus" -> "Opus" */
export function prettyModel(model?: string): string | undefined {
  if (!model) return undefined;
  const m = model.trim();
  const claude = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(m);
  if (claude) return `${cap(claude[1])} ${claude[2]}${claude[3] ? "." + claude[3] : ""}`;
  if (/^(fable|opus|sonnet|haiku)$/i.test(m)) return cap(m);
  const gem = /^gemini-(.+)$/i.exec(m);
  if (gem) return "Gemini " + gem[1].split("-").map(cap).join(" ");
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(m);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? " " + gpt[2].split("-").map(cap).join(" ") : ""}`;
  return m;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What the UI shows for a member: the model it actually runs, not "claude-1". */
export function memberDisplayName(m: Pick<MemberRecord, "id" | "provider" | "model" | "label">): string {
  if (m.provider === "relay") return m.label || "relay";
  return prettyModel(m.model) ?? (m.provider === "claude" ? "Claude" : m.provider === "gpt" ? "GPT" : "Gemini");
}

/**
 * The advisor to attach for a main model, or undefined when the pairing cannot work
 * (Fable mains accept only Fable advisors; Claude Code exits at launch on a bad pairing).
 */
export function advisorFor(mainModel: string | undefined, advisor: string | undefined): string | undefined {
  const a = advisor?.trim();
  if (!a || a === "off" || a === "none") return undefined;
  if (/fable|mythos/i.test(mainModel ?? "") && !/fable/i.test(a)) return undefined;
  return a;
}

// ---------- paths ----------

export function projectsDir(): string {
  return path.join(gencouncilHome(), "projects");
}

export function projectDir(id: string): string {
  return path.join(projectsDir(), id);
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// ---------- projects ----------

export class ProjectRegistry {
  list(): ProjectConfig[] {
    const dir = projectsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((d) => path.join(dir, d, "project.json"))
      .filter((f) => fs.existsSync(f))
      .map((f) => readJson<ProjectConfig>(f, null as unknown as ProjectConfig));
  }

  /** find by id or (case-insensitive) name */
  get(ref: string): ProjectConfig | undefined {
    const all = this.list();
    return (
      all.find((p) => p.id === ref) ??
      all.find((p) => p.name.toLowerCase() === ref.toLowerCase()) ??
      all.find((p) => p.id === slugify(ref, 60))
    );
  }

  add(input: {
    name: string;
    repo: string;
    baseBranch: string;
    mode?: ProjectMode;
    source?: string;
    localGit?: boolean;
    chairModel?: string;
    chairEffort?: string;
    chairAdvisor?: string;
    chairAccount?: string;
    autonomy?: Autonomy;
    defaultProvider?: CliProvider;
    limits?: Partial<Limits>;
  }): ProjectConfig {
    const name = councilName(input.name);
    const id = slugify(name, 60);
    if (this.get(id)) throw new Error(`project already exists: ${id}`);
    // The chair is judgment-heavy and token-light: Opus by default. Members' models are the chair's call within the limits.
    const cfg: ProjectConfig = {
      id,
      name,
      repo: path.resolve(input.repo),
      baseBranch: input.baseBranch,
      mode: input.mode ?? "git",
      source: input.source ? path.resolve(input.source) : undefined,
      localGit: input.localGit || undefined,
      chair: {
        provider: "claude",
        model: input.chairModel ?? "opus",
        effort: input.chairEffort,
        advisor: input.chairAdvisor || undefined,
        account: input.chairAccount,
      },
      members: {
        autonomy: input.autonomy ?? "full",
        defaultProvider: input.defaultProvider ?? "claude",
        limits: normalizeLimits(input.limits),
        explorers: true,
        autoHandover: true,
        maxHandovers: 2,
      },
      created: new Date().toISOString(),
    };
    this.save(cfg);
    const g = path.join(projectDir(id), "guidelines.md");
    if (!fs.existsSync(g)) fs.writeFileSync(g, GUIDELINES_TEMPLATE(cfg), "utf8");
    return cfg;
  }

  save(cfg: ProjectConfig): void {
    writeJson(path.join(projectDir(cfg.id), "project.json"), cfg);
  }

  guidelines(cfg: ProjectConfig): string {
    const g = path.join(projectDir(cfg.id), "guidelines.md");
    return fs.existsSync(g) ? fs.readFileSync(g, "utf8") : "";
  }

  guidelinesPath(cfg: ProjectConfig): string {
    return path.join(projectDir(cfg.id), "guidelines.md");
  }
}

// ---------- agendas ----------

export class AgendaStore {
  readonly dir: string;
  constructor(
    readonly project: ProjectConfig,
    readonly slug: string,
  ) {
    this.dir = path.join(projectDir(project.id), "agendas", slug);
  }

  static list(project: ProjectConfig): AgendaConfig[] {
    const dir = path.join(projectDir(project.id), "agendas");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((d) => path.join(dir, d, "agenda.json"))
      .filter((f) => fs.existsSync(f))
      .map((f) => readJson<AgendaConfig>(f, null as unknown as AgendaConfig));
  }

  static find(project: ProjectConfig, ref: string): AgendaStore | undefined {
    const all = AgendaStore.list(project);
    const hit =
      all.find((a) => a.slug === ref) ??
      all.find((a) => a.title.toLowerCase() === ref.toLowerCase()) ??
      all.find((a) => a.slug === slugify(ref, 40));
    return hit ? new AgendaStore(project, hit.slug) : undefined;
  }

  static create(project: ProjectConfig, title: string, goals: string[]): AgendaStore {
    let slug = slugify(title, 40);
    const existing = new Set(AgendaStore.list(project).map((a) => a.slug));
    let n = 2;
    while (existing.has(slug)) slug = `${slugify(title, 40)}-${n++}`;
    const store = new AgendaStore(project, slug);
    const cfg: AgendaConfig = {
      slug,
      title,
      goals,
      status: "open",
      branch: `agenda/${slug}`,
      baseBranch: project.baseBranch,
      created: new Date().toISOString(),
    };
    store.saveAgenda(cfg);
    store.saveTasks([]);
    store.saveMembers([]);
    fs.mkdirSync(path.join(store.dir, "chair"), { recursive: true });
    fs.mkdirSync(path.join(store.dir, "members"), { recursive: true });
    return store;
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.dir, "agenda.json"));
  }

  agenda(): AgendaConfig {
    return readJson<AgendaConfig>(path.join(this.dir, "agenda.json"), null as unknown as AgendaConfig);
  }
  saveAgenda(a: AgendaConfig): void {
    writeJson(path.join(this.dir, "agenda.json"), a);
  }

  tasks(): Task[] {
    return readJson<Task[]>(path.join(this.dir, "tasks.json"), []);
  }
  saveTasks(t: Task[]): void {
    writeJson(path.join(this.dir, "tasks.json"), t);
  }

  members(): MemberRecord[] {
    return readJson<MemberRecord[]>(path.join(this.dir, "members.json"), []);
  }
  saveMembers(m: MemberRecord[]): void {
    writeJson(path.join(this.dir, "members.json"), m);
  }

  memberLog(id: string): string {
    return path.join(this.dir, "members", `${id}.log`);
  }

  chairDir(): string {
    return path.join(this.dir, "chair");
  }
  chairState(): string {
    const f = path.join(this.chairDir(), "state.md");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }
  saveChairState(md: string): void {
    fs.mkdirSync(this.chairDir(), { recursive: true });
    fs.writeFileSync(path.join(this.chairDir(), "state.md"), md.trim() + "\n", "utf8");
  }
  chairSession(): { sessionId?: string; model?: string } {
    return readJson(path.join(this.chairDir(), "session.json"), {});
  }
  saveChairSession(s: { sessionId?: string; model?: string }): void {
    writeJson(path.join(this.chairDir(), "session.json"), s);
  }

  appendTranscript(entry: Record<string, unknown>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(
      path.join(this.dir, "transcript.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      "utf8",
    );
  }

  /** worktree locations live inside the repo so relative paths in tools stay short */
  worktreeRoot(): string {
    return path.join(this.project.repo, ".worktrees", this.slug);
  }
  integrationWorktree(): string {
    return path.join(this.worktreeRoot(), "_integration");
  }
  memberWorktree(memberId: string): string {
    return path.join(this.worktreeRoot(), memberId);
  }
  memberBranch(memberId: string): string {
    return `member/${this.slug}/${memberId}`;
  }
}

export const GUIDELINES_TEMPLATE = (p: ProjectConfig): string => `# ${p.name} 업무 분장 가이드라인

의장이 작업을 쪼개고 위원을 고를 때 따르는 규칙. 자유롭게 고쳐도 된다.

## 위원 성향 (관찰되면 갱신)

- claude: 긴 맥락의 리팩터링, 테스트 작성, 꼼꼼한 검증에 강함. 지시가 명확할수록 좋다.
- gemini: 넓은 탐색, 대안 비교, 문서/리서치, 대량 반복 작업. 결과 양식을 고정해 주면 안정적이다.
- gpt (Codex CLI): 코딩 주력의 다른 시각. 클로드와 같은 작업을 교차 구현·교차 리뷰시킬 때 좋다.
- relay(웹 제미나이·AI Studio·Antigravity, 사람이 복사해 전달): 느리지만 한도가 따로다. 저장소를 못 보므로 필요한 파일을 files에 넣어 줘야 한다. 리서치, 대안 설계, 긴 리뷰, 독립 파일 작성에 쓴다. 사용자가 자리에 없으면 오래 걸린다.

## 분장 규칙

- 한 작업은 한 위원이 한 worktree에서 끝낸다. 같은 파일을 두 위원에게 동시에 맡기지 않는다.
- 바이너리/리소스 파일(이미지, 모델, 오디오)은 머지가 안 되므로 반드시 한 위원에게만 배정한다.
- 작업 지시에는 "완료 조건"(테스트 통과, 파일 존재 등)을 반드시 넣는다.
- 위원이 막혔다고 보고하면 작업을 더 작게 쪼개서 다시 배정한다.
- 결과를 머지하기 전에 diff를 읽고, 완료 조건을 확인한다.

## 금지

- 의장은 코드를 직접 수정하지 않는다. 읽기만 한다.
- 위원은 main/베이스 브랜치를 만지지 않는다.
`;
