import type { Member } from "./types";

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

/** What the UI calls a member: the model it runs, not "claude-1". */
export function memberName(m: Pick<Member, "id" | "provider" | "model" | "label">): string {
  if (m.provider === "relay") return m.label || "릴레이";
  return prettyModel(m.model) ?? (m.provider === "claude" ? "Claude" : m.provider === "gpt" ? "GPT" : "Gemini");
}

export type Family = "claude" | "gemini" | "gpt" | "relay";

/** Which brand a member belongs to, for colors. Relay members are judged by their label. */
export function familyOf(m: Pick<Member, "provider" | "label" | "model"> & { site?: string }): Family {
  if (m.provider === "claude") return "claude";
  if (m.provider === "gemini") return "gemini";
  if (m.provider === "gpt") return "gpt";
  if (m.site === "gemini-web" || m.site === "aistudio") return "gemini";
  if (m.site === "chatgpt") return "gpt";
  const l = `${m.label ?? ""} ${m.model ?? ""}`.toLowerCase();
  if (/gemini|제미나이|agy|antigravity|aistudio|ai studio|google/.test(l)) return "gemini";
  if (/gpt|chatgpt|openai|codex|지피티/.test(l)) return "gpt";
  if (/claude|클로드|anthropic/.test(l)) return "claude";
  return "relay";
}

export const FAMILY_COLOR: Record<Family, string> = {
  claude: "var(--c-claude)",
  gemini: "var(--c-gemini)",
  gpt: "var(--c-gpt)",
  relay: "var(--c-relay)",
};

export function familyColor(m: Pick<Member, "provider" | "label" | "model"> & { site?: string }): string {
  return FAMILY_COLOR[familyOf(m)];
}

export function familyColorByName(family: string): string {
  return FAMILY_COLOR[(family as Family) in FAMILY_COLOR ? (family as Family) : "relay"];
}
