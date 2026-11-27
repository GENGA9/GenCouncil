export interface Tailscale {
  ip?: string;
  dnsName?: string;
}

export type CliProvider = "claude" | "gemini" | "gpt" | "grok";
export type Provider = CliProvider | "relay";

export interface LimitEntry {
  maxMembers: number;
  maxModel?: string;
  maxEffort?: string;
  topModelMinWeeklyLeft?: number;
}
export type Limits = Record<string, LimitEntry>;

export interface ModelsInfo {
  providers: Array<{ id: string; models: Array<{ id: string; label: string; note: string }>; effort: boolean; efforts?: string[] }>;
  sites: Array<{ id: string; label: string; url: string; family: string }>;
  efforts: string[];
  defaults: Limits;
}

export interface CurateStatus {
  kind?: "proposals" | "reorganize" | "tidy";
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  pending?: number;
  /** tidy: entries still due after this batch */
  remaining?: number;
  steps?: number;
  text?: string;
  isError?: boolean;
  costUsd?: number;
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

export interface WaitingForUser {
  question: string;
  options?: string[];
  at: string;
  /** "finish": the chair proposes ending the agenda */
  kind?: "finish";
}

export interface AgendaOv {
  slug: string;
  title: string;
  goals: string[];
  waitingForUser?: WaitingForUser;
  status: "open" | "closed";
  branch: string;
  key: string;
  taskCounts: { total: number; done: number };
  /** the task it is on now (doing, else review, else the next to do) */
  now?: string;
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
  localGit?: boolean;
  baseBranch: string;
  chair: { model?: string; effort?: string; advisor?: string; account?: string; directEdit?: boolean };
  members: { autonomy: string; defaultProvider: string; limits?: Limits; explorers?: boolean; verifyGeminiFlash?: boolean };
  agendas: AgendaOv[];
}

export interface UsageWindow {
  usedPct: number;
  resetsAt?: string;
}

export interface AccountUsage {
  provider: "claude" | "gemini" | "gpt" | "grok";
  account: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  noFiveHour?: boolean;
  details?: Array<{ group: string; label: string; usedPct: number; resetsAt?: string }>;
  error?: string;
  checkedAt: string;
}

export interface UsageSnapshot {
  at: number;
  items: AccountUsage[];
}

/** Gemini through Antigravity CLI: off until the user accepts the terms risk */
export interface GeminiOptIn {
  enabled: boolean;
  acceptedAt?: string;
}

export interface Overview {
  projects: ProjectOv[];
  memory: { verified: number; proposed: number };
  accounts: Account[];
  server: { host: string; port: number; tailscale: Tailscale };
  /** absent on a server older than the setting */
  gemini?: GeminiOptIn;
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
  failure?: { kind: "quota" | "auth" | "model" | "other"; message: string; resetAt?: string };
  handoverFrom?: string;
  handoverTo?: string;
  relayFiles?: string[];
  result?: { summary: string; unfinished: string };
  startedAt: string;
  endedAt?: string;
}

/** one member folder of an agenda, and what a tidy does with it */
export interface FolderInfo {
  name: string;
  members: Array<{ id: string; status: Member["status"]; merged: boolean }>;
  kind: "busy" | "parked" | "free" | "unmerged" | "dirty";
  changed?: number;
}
export interface FolderReport {
  folders: FolderInfo[];
  counts: Record<FolderInfo["kind"], number>;
  removable: number;
  perFolderMb?: number;
}

export interface RuntimeState {
  key: string;
  project: { id: string; name: string; repo: string; baseBranch: string };
  agenda: { slug: string; title: string; goals: string[]; branch: string; status: string; waitingForUser?: WaitingForUser; telegramAuto?: boolean };
  tasks: Task[];
  members: Member[];
  integrationWorktree: string;
  chairState: string;
  chair: { provider?: "claude" | "gpt" | "gemini" | "grok"; model?: string; modelId?: string; effort?: string; advisor?: string; account?: string; sessionId?: string; busy: boolean; queued?: string[] };
  activity: Record<string, number[]>;
  accounts: Account[];
  limits: Limits;
  active: Record<string, number>;
  mode: "git" | "folder";
  source?: string;
  /** member folders on disk (absent on an older server) */
  folders?: number;
  /** work cut off by an app shutdown or agenda close */
  resume?: {
    members: Array<{ id: string; provider: string; model?: string; taskId: string; taskTitle: string }>;
    chair?: { at: string; message: string };
  };
}

export interface TranscriptEntry {
  ts: string;
  role: "user" | "assistant" | "event";
  text: string;
  isError?: boolean;
  costUsd?: number;
  attachments?: Attachment[];
}

export type ChatRole = "user" | "assistant" | "event" | "tool" | "error" | "system";

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface ChatItem {
  id: number;
  role: ChatRole;
  text: string;
  ts: string;
  attachments?: Attachment[];
}

export interface MemoryHit {
  id: string;
  title: string;
  type: string;
  status: string;
  tags: string[];
  project?: string;
  scope?: "common" | "project";
  score?: number;
  snippet?: string;
  updated: string;
  source?: string;
}

/** Progress/failure callbacks for the files being uploaded with a chat message (index into the files array). */
export interface UploadHooks {
  onProgress: (index: number, pct: number) => void;
  onFail: (index: number, message: string) => void;
}

export interface WikiPageMeta {
  path: string;
  title: string;
  summary: string;
  updated: string;
  by: string;
  sources: string[];
  section: string;
  chars: number;
}
export interface WikiPage extends WikiPageMeta {
  body: string;
  history?: Array<{ commit: string; date: string; subject: string }>;
}
export interface WikiHit extends WikiPageMeta {
  score: number;
  snippet: string;
}
export interface WikiStatus {
  proposals: number;
  unmigrated: number;
  pages: number;
  changed: number;
  lastReview?: string;
}

/** the meeting room (server: packages/server/src/meeting.ts) */
export type MeetingSeatId = "claude" | "gpt" | "gemini" | "grok" | "dots";
export interface MeetingSeat {
  seat: MeetingSeatId;
  name: string;
  available: boolean;
  reason?: string;
  /** the chair's own character sitting in: a chibi on the table */
  desk?: boolean;
  model?: string;
  effort?: string;
}
export interface MeetingSettings {
  chair: "claude" | "gpt" | "gemini" | "grok";
  chairModel?: string;
  chairEffort?: string;
  members: MeetingSeatId[];
  /** each member seat's model and reasoning effort (unset: the workhorse model, low) */
  seats?: Partial<Record<MeetingSeatId, { model?: string; effort?: string }>>;
}
/** a past meeting in the list */
export interface MeetingSummary {
  id: string;
  topic: string;
  startedAt: string;
  status: "running" | "done" | "stopped" | "failed";
  chair: string;
  turns: number;
}
export interface MeetingTurn {
  who: MeetingSeatId | "chair";
  name: string;
  model?: string;
  phase: "opinion" | "debate" | "summary";
  round: number;
  text: string;
  at: string;
  seconds?: number;
  error?: string;
}
export interface Meeting {
  id: string;
  topic: string;
  chair: { seat: MeetingSeatId; name: string; provider: string; model?: string; effort?: string };
  seats: MeetingSeat[];
  turns: MeetingTurn[];
  phase: "opinion" | "debate" | "summary" | "done";
  speaking?: MeetingSeatId | "chair";
  status: "running" | "done" | "stopped" | "failed";
  startedAt: string;
  endedAt?: string;
  error?: string;
}
