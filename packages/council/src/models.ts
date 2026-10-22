/**
 * Model ladders, effort levels and the per-provider limits the user sets.
 * The chair picks provider / model / effort / advisor for each task; the council
 * rejects anything above the user's limits so the chair can re-pick.
 */
export const CLI_PROVIDERS = ["claude", "gemini", "gpt"] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

/** web AIs reached through a relay member (human carries the packet) */
export const WEB_SITES = ["gemini-web", "aistudio", "chatgpt"] as const;
export type WebSite = (typeof WEB_SITES)[number];

/** everything that can have a member limit */
export type LimitKey = CliProvider | WebSite;
export const LIMIT_KEYS: LimitKey[] = [...CLI_PROVIDERS, ...WEB_SITES];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelInfo {
  id: string;
  label: string;
  note: string;
  /** matches full ids / older versions of the same tier */
  match: RegExp;
}

/** lowest to highest */
export const LADDERS: Record<CliProvider, ModelInfo[]> = {
  claude: [
    { id: "haiku", label: "Haiku", note: "가볍고 빠름. 탐색, 단순 수정, 대량 반복", match: /haiku/i },
    { id: "sonnet", label: "Sonnet", note: "주력. 대부분의 코딩", match: /sonnet/i },
    { id: "opus", label: "Opus", note: "어려운 설계·디버깅, advisor", match: /opus/i },
    { id: "fable", label: "Fable", note: "최상위. 가장 어려운 장기 작업", match: /fable|mythos/i },
  ],
  gemini: [
    { id: "gemini-2.5-flash-lite", label: "Gemini Flash-Lite", note: "가장 가벼움", match: /flash-lite/i },
    { id: "gemini-2.5-flash", label: "Gemini Flash", note: "빠른 범용", match: /flash(?!-lite)/i },
    { id: "gemini-2.5-pro", label: "Gemini Pro", note: "긴 맥락 분석·리서치", match: /pro/i },
  ],
  gpt: [
    { id: "gpt-6-luna", label: "GPT-6 Luna", note: "빠르고 저렴. 쉬운 작업", match: /luna|terra|mini/i },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "주력. 코딩·일상 작업", match: /sol/i },
    { id: "gpt-6-astra", label: "GPT-6 Astra", note: "최상위. 가장 어려운 작업", match: /astra|pro/i },
  ],
};

/** CLI accepts an effort setting (Gemini CLI has none) */
export const SUPPORTS_EFFORT: Record<CliProvider, boolean> = { claude: true, gemini: false, gpt: true };

export const SITE_INFO: Record<WebSite, { label: string; url: string; family: "gemini" | "gpt" }> = {
  "gemini-web": { label: "웹 제미나이", url: "https://gemini.google.com/app", family: "gemini" },
  aistudio: { label: "AI Studio", url: "https://aistudio.google.com/prompts/new_chat", family: "gemini" },
  chatgpt: { label: "ChatGPT 웹", url: "https://chatgpt.com/", family: "gpt" },
};

export interface ProviderLimit {
  /** max members of this kind working at the same time; 0 = not allowed */
  maxMembers: number;
  /** highest model the chair may pick (CLI providers only) */
  maxModel?: string;
  /** highest effort the chair may pick (providers that support effort) */
  maxEffort?: Effort;
}

export type Limits = Record<LimitKey, ProviderLimit>;

export const DEFAULT_LIMITS: Limits = {
  claude: { maxMembers: 3, maxModel: "opus", maxEffort: "high" },
  gemini: { maxMembers: 2, maxModel: "gemini-2.5-pro" },
  gpt: { maxMembers: 2, maxModel: "gpt-6.1-sol", maxEffort: "high" },
  "gemini-web": { maxMembers: 1 },
  aistudio: { maxMembers: 1 },
  chatgpt: { maxMembers: 0 },
};

export function normalizeLimits(l?: Partial<Record<string, Partial<ProviderLimit>>>): Limits {
  const out = {} as Limits;
  for (const k of LIMIT_KEYS) {
    const d = DEFAULT_LIMITS[k];
    const v = l?.[k] ?? {};
    out[k] = {
      maxMembers: Number.isFinite(Number(v.maxMembers)) ? Math.max(0, Math.floor(Number(v.maxMembers))) : d.maxMembers,
      maxModel: v.maxModel ?? d.maxModel,
      maxEffort: (v.maxEffort && EFFORTS.includes(v.maxEffort as Effort) ? v.maxEffort : d.maxEffort) as Effort | undefined,
    };
  }
  return out;
}

/** index in the ladder, or -1 for an unknown model */
export function tierOf(provider: CliProvider, model?: string): number {
  if (!model) return -1;
  const ladder = LADDERS[provider];
  const exact = ladder.findIndex((m) => m.id === model);
  if (exact >= 0) return exact;
  for (let i = ladder.length - 1; i >= 0; i--) if (ladder[i].match.test(model)) return i;
  return -1;
}

export function effortIndex(e?: string): number {
  return e ? EFFORTS.indexOf(e as Effort) : -1;
}

/** models the chair may pick under a limit, lowest first */
export function allowedModels(provider: CliProvider, limit: ProviderLimit): ModelInfo[] {
  const max = tierOf(provider, limit.maxModel);
  const ladder = LADDERS[provider];
  return max < 0 ? ladder : ladder.slice(0, max + 1);
}

export function allowedEfforts(provider: CliProvider, limit: ProviderLimit): Effort[] {
  if (!SUPPORTS_EFFORT[provider]) return [];
  const max = effortIndex(limit.maxEffort);
  return max < 0 ? [...EFFORTS] : EFFORTS.slice(0, max + 1);
}

export class LimitError extends Error {}

/** default = the "workhorse" (2nd rung) clamped to the limit */
export function resolveModel(provider: CliProvider, requested: string | undefined, limit: ProviderLimit): string {
  const allowed = allowedModels(provider, limit);
  if (!requested) return allowed[Math.min(1, allowed.length - 1)].id;
  const t = tierOf(provider, requested);
  const max = tierOf(provider, limit.maxModel);
  if (t < 0) throw new LimitError(`unknown ${provider} model "${requested}". allowed: ${allowed.map((m) => m.id).join(", ")}`);
  if (max >= 0 && t > max) throw new LimitError(`${provider} model "${requested}" is above the user's limit (${limit.maxModel}). allowed: ${allowed.map((m) => m.id).join(", ")}`);
  return requested;
}

/** default = medium clamped to the limit; undefined when the CLI has no effort setting */
export function resolveEffort(provider: CliProvider, requested: string | undefined, limit: ProviderLimit): Effort | undefined {
  if (!SUPPORTS_EFFORT[provider]) return undefined;
  const allowed = allowedEfforts(provider, limit);
  if (!requested) return allowed.includes("medium") ? "medium" : allowed[allowed.length - 1];
  if (!EFFORTS.includes(requested as Effort)) throw new LimitError(`unknown effort "${requested}". use one of ${EFFORTS.join(", ")}`);
  if (!allowed.includes(requested as Effort)) throw new LimitError(`${provider} effort "${requested}" is above the user's limit (${limit.maxEffort}). allowed: ${allowed.join(", ")}`);
  return requested as Effort;
}

/**
 * Claude advisor: must rank at or above the main model and within the limit.
 * Fable mains accept only Fable advisors (Claude Code exits on a bad pairing).
 */
export function resolveAdvisor(main: string, advisor: string | undefined, limit: ProviderLimit): string | undefined {
  const a = advisor?.trim();
  if (!a || a === "none" || a === "off") return undefined;
  const ta = tierOf("claude", a);
  const tm = tierOf("claude", main);
  const max = tierOf("claude", limit.maxModel);
  if (ta < 0) throw new LimitError(`unknown advisor "${a}"`);
  if (max >= 0 && ta > max) throw new LimitError(`advisor "${a}" is above the user's limit (${limit.maxModel})`);
  if (ta < tm) throw new LimitError(`advisor "${a}" ranks below the main model "${main}"; pick an equal or stronger advisor or none`);
  if (/fable|mythos/i.test(main) && !/fable/i.test(a)) throw new LimitError("a Fable main model only accepts a Fable advisor");
  return a;
}

/** Markdown block for the chair prompt. */
export function limitsMarkdown(limits: Limits, active: Partial<Record<LimitKey, number>>): string {
  const lines: string[] = ["| 종류 | 동시 한도 (지금 사용 중) | 고를 수 있는 모델 | 최대 추론 |", "|---|---|---|---|"];
  for (const p of CLI_PROVIDERS) {
    const l = limits[p];
    const models = l.maxMembers === 0 ? "사용 안 함" : allowedModels(p, l).map((m) => `${m.id} (${m.note})`).join(" · ");
    const eff = SUPPORTS_EFFORT[p] ? allowedEfforts(p, l).slice(-1)[0] ?? "-" : "지원 안 함";
    lines.push(`| ${p} | ${l.maxMembers} (${active[p] ?? 0}) | ${models} | ${eff} |`);
  }
  for (const s of WEB_SITES) {
    const l = limits[s];
    lines.push(`| relay:${s} (${SITE_INFO[s].label}) | ${l.maxMembers} (${active[s] ?? 0}) | 웹에서 사람이 고른 모델 | - |`);
  }
  return lines.join("\n");
}
