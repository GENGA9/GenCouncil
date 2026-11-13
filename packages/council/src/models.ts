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
  // Antigravity CLI (agy). The CLI takes "<model>-<low|medium|high>"; the driver adds the effort suffix.
  gemini: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "빠른 범용. 단순 수정·반복", match: /flash/i },
    { id: "gemini-4-argon", label: "Gemini 4 Argon", note: "최상위. 긴 맥락 분석·리서치·설계", match: /argon|pro/i },
  ],
  gpt: [
    { id: "gpt-6-luna", label: "GPT-6 Luna", note: "빠르고 저렴. 쉬운 작업", match: /luna|mini/i },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", note: "균형형. Sol보다 사용량 2배, 일반 작업", match: /terra/i },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "주력. 코딩·일상 작업", match: /sol/i },
    { id: "gpt-6-astra", label: "GPT-6 Astra", note: "최상위. 가장 어려운 작업", match: /astra|pro/i },
  ],
};

/** CLI accepts an effort setting */
export const SUPPORTS_EFFORT: Record<CliProvider, boolean> = { claude: true, gemini: true, gpt: true };

/** highest effort each CLI understands (Antigravity models come in low / medium / high) */
export const EFFORT_CAP: Record<CliProvider, Effort> = { claude: "max", gemini: "high", gpt: "max" };

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
  claude: { maxMembers: 3, maxModel: "fable", maxEffort: "high" },
  gemini: { maxMembers: 2, maxModel: "gemini-4-argon", maxEffort: "high" },
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
    let maxModel = v.maxModel ?? d.maxModel;
    // map older ids (e.g. gemini-2.5-pro) onto the current ladder
    if (maxModel && (CLI_PROVIDERS as readonly string[]).includes(k)) {
      const p = k as CliProvider;
      const t = tierOf(p, maxModel);
      if (t >= 0) maxModel = LADDERS[p][t].id;
    }
    out[k] = {
      maxMembers: Number.isFinite(Number(v.maxMembers)) ? Math.max(0, Math.floor(Number(v.maxMembers))) : d.maxMembers,
      maxModel,
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
  const cap = effortIndex(EFFORT_CAP[provider]);
  const lim = effortIndex(limit.maxEffort);
  const max = lim < 0 ? cap : Math.min(lim, cap);
  return EFFORTS.slice(0, max + 1);
}

export class LimitError extends Error {}

/**
 * The most expensive models are held back when that provider's weekly allowance runs low:
 * fable below 30% weekly remaining, gpt-6-astra below 50% (GPT allowances are tighter).
 */
export const TOP_MODEL_WEEKLY_FLOOR: Array<{ provider: CliProvider; match: RegExp; label: string; minWeeklyLeft: number }> = [
  { provider: "claude", match: /fable|mythos/i, label: "fable", minWeeklyLeft: 30 },
  { provider: "gpt", match: /astra/i, label: "gpt-6-astra", minWeeklyLeft: 50 },
];

/** throws when model is a top model and the provider's best account has too little weekly allowance left */
export function checkTopModelUsage(provider: CliProvider, model: string | undefined, weeklyLeft: number | undefined, override?: boolean): void {
  if (!model || weeklyLeft === undefined || override) return;
  const rule = TOP_MODEL_WEEKLY_FLOOR.find((r) => r.provider === provider && r.match.test(model));
  if (rule && weeklyLeft < rule.minWeeklyLeft)
    throw new LimitError(`${rule.label}은(는) ${provider} 주간 사용량이 ${rule.minWeeklyLeft}% 이상 남았을 때만 쓴다 (지금 ${weeklyLeft}% 남음). 한 단계 낮은 모델을 고른다. 사용자가 이 모델을 명시했다면 override_usage:true로 다시 배정한다.`);
}

/** the default rung when the chair names no model */
export const WORKHORSE: Record<CliProvider, string> = { claude: "sonnet", gemini: "gemini-4-argon", gpt: "gpt-6.1-sol" };

/** default = the "workhorse" clamped to the limit */
export function resolveModel(provider: CliProvider, requested: string | undefined, limit: ProviderLimit): string {
  const allowed = allowedModels(provider, limit);
  if (!requested) return allowed[Math.min(tierOf(provider, WORKHORSE[provider]), allowed.length - 1)].id;
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
 * A Fable main runs without an advisor: Fable 5.2 neither takes nor serves as one (Claude Code
 * exits at launch). An advisor named "fable" keeps the CLI alias (the older Fable), which works
 * for lower mains.
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
  if (/fable|mythos/i.test(main)) throw new LimitError("a Fable main model runs without an advisor (Fable 5.2 does not support one); pass advisor: none");
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
