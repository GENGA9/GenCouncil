export interface Tailscale {
  ip?: string;
  dnsName?: string;
}

export type CliProvider = "claude" | "gemini" | "gpt";
export type Provider = CliProvider | "relay";

export interface LimitEntry {
  maxMembers: number;
  maxModel?: string;
  maxEffort?: string;
}
export type Limits = Record<string, LimitEntry>;

export interface ModelsInfo {
  providers: Array<{ id: string; models: Array<{ id: string; label: string; note: string }>; effort: boolean }>;
  sites: Array<{ id: string; label: string; url: string; family: string }>;
  efforts: string[];
  defaults: Limits;
}

export interface FolderListing {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string; git?: boolean }>;
  roots: Array<{ name: string; path: string }>;
}

export interface Account {
  id: string;
  /** claude | gemini | gpt | gemini-web | aistudio | chatgpt */
  provider: string;
  loginOpenedAt?: string;
  configDir?: string;
  priority?: number;
  status: "ok" | "exhausted" | "auth" | "disabled";
  exhaustedAt?: string;
  resetAt?: string;
  lastError?: string;
  lastUsed?: string;
  note?: string;
}

export interface AgendaOv {
  slug: string;
  title: string;
  goals: string[];
  status: "open" | "closed";
  branch: string;
  key: string;
  taskCounts: { total: number; done: number };
  running: number;
  /** families of the running members (claude / gemini / relay), for spinner colors */
  runningFamilies: string[];
  chairBusy: boolean;
  open: boolean;
}

export interface ProjectOv {
  id: string;
  name: string;
  repo: string;
  mode?: "git" | "folder";
  source?: string;
  baseBranch: string;
  chair: { model?: string; effort?: string; advisor?: string; account?: string };
  members: { autonomy: string; defaultProvider: string; limits?: Limits; explorers?: boolean };
  agendas: AgendaOv[];
}

export interface Overview {
  projects: ProjectOv[];
  memory: { verified: number; proposed: number };
  accounts: Account[];
  server: { host: string; port: number; tailscale: Tailscale };
}

export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked";

export interface Task {
  id: string;
  title: string;
  description: string;
  goal?: number;
  status: TaskStatus;
  memberId?: string;
  note?: string;
}

export type MemberStatus = "starting" | "running" | "waiting" | "done" | "failed" | "stopped" | "handed_over";

export interface Member {
  id: string;
  provider: Provider;
  label?: string;
  site?: string;
  model?: string;
  effort?: string;
  advisor?: string;
  account?: string;
  taskId: string;
  branch: string;
  worktree: string;
  status: MemberStatus;
  toolCalls: number;
  lastText?: string;
  commits?: string[];
  diffstat?: string;
  merged?: boolean;
  error?: string;
  failure?: { kind: "quota" | "auth" | "other"; message: string; resetAt?: string };
  handoverFrom?: string;
  handoverTo?: string;
  relayFiles?: string[];
  result?: { summary: string; unfinished: string };
  startedAt: string;
  endedAt?: string;
}

export interface RuntimeState {
  key: string;
  project: { id: string; name: string; repo: string; baseBranch: string };
  agenda: { slug: string; title: string; goals: string[]; branch: string; status: string };
  tasks: Task[];
  members: Member[];
  integrationWorktree: string;
  chairState: string;
  chair: { model?: string; effort?: string; advisor?: string; account?: string; sessionId?: string; busy: boolean };
  activity: Record<string, number[]>;
  accounts: Account[];
  limits: Limits;
  active: Record<string, number>;
  mode: "git" | "folder";
  source?: string;
}

export interface TranscriptEntry {
  ts: string;
  role: "user" | "assistant" | "event";
  text: string;
  isError?: boolean;
  costUsd?: number;
}

export type ChatRole = "user" | "assistant" | "event" | "tool" | "error" | "system";

export interface ChatItem {
  id: number;
  role: ChatRole;
  text: string;
  ts: string;
}

export interface MemoryHit {
  id: string;
  title: string;
  type: string;
  status: string;
  tags: string[];
  project?: string;
  score?: number;
  snippet?: string;
  updated: string;
  source?: string;
}
