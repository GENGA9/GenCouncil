import type { MemberFailure } from "./model.js";
import type { CliProvider } from "./models.js";

/**
 * Classify a CLI failure from its output. Best effort: the CLIs change their wording,
 * so patterns are loose and the default cooldown covers the rest.
 */
export function classifyFailure(provider: CliProvider, text: string, exitCode: number | null): MemberFailure {
  const t = text.slice(-20_000);
  const lower = t.toLowerCase();

  // Claude Code -p prints "Claude AI usage limit reached|<epoch seconds>"
  const epoch = /usage limit reached\|(\d{9,13})/i.exec(t);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n > 1e12 ? n : n * 1000;
    return { kind: "quota", message: firstLine(t, /usage limit/i), resetAt: new Date(ms).toISOString() };
  }

  const quotaWords = [
    "usage limit",
    "rate limit",
    "rate_limit",
    "ratelimit",
    "resource_exhausted",
    "resource exhausted",
    "quota",
    "too many requests",
    "429",
    "capacity",
    "limit reached",
    "hit your limit",
    "out of extra usage",
  ];
  if (quotaWords.some((w) => lower.includes(w))) {
    return { kind: "quota", message: firstLine(t, new RegExp(quotaWords.map(escape).join("|"), "i")), resetAt: parseReset(t) };
  }

  const authWords = [
    "not logged in",
    "please log in",
    "please login",
    "login required",
    "authentication",
    "unauthorized",
    "invalid api key",
    "oauth",
    "set an auth",
    "auth method",
    "credentials",
    "401",
  ];
  if (authWords.some((w) => lower.includes(w))) {
    return { kind: "auth", message: firstLine(t, new RegExp(authWords.map(escape).join("|"), "i")) };
  }

  return { kind: "other", message: lastLine(t) || `${provider} exited with code ${exitCode}` };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstLine(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l));
  return (line ?? text).trim().slice(0, 300);
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

/** "try again in 23.5s", "retry in 2 minutes", "resets at 3pm", "reset in 4 hours", "retryDelay: 30s" */
export function parseReset(text: string, now = Date.now()): string | undefined {
  const rel = /(?:try again|retry|reset(?:s)?|available)\s+(?:in|after)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)/i.exec(text);
  const delay = /retry[_ -]?delay\D{0,5}(\d+(?:\.\d+)?)\s*s/i.exec(text);
  const m = rel ?? (delay ? [delay[0], delay[1], "s"] : null);
  if (m) {
    const unitMs = (u: string) => (u.toLowerCase().startsWith("h") ? 3_600_000 : u.toLowerCase().startsWith("m") ? 60_000 : 1000);
    let ms = Number(m[1]) * unitMs(m[2]);
    // compound durations ("Resets in 59h36m39s"): add the parts after the first
    if (rel) {
      const rest = /^(?:\s*\d+(?:\.\d+)?\s*[smh](?![a-z]))+/i.exec(text.slice(rel.index + rel[0].length));
      for (const p of rest?.[0].matchAll(/(\d+(?:\.\d+)?)\s*([smh])/gi) ?? []) ms += Number(p[1]) * unitMs(p[2]);
    }
    return new Date(now + Math.max(ms, 30_000)).toISOString();
  }
  const abs = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (abs) {
    let h = Number(abs[1]);
    const min = Number(abs[2] ?? 0);
    const ap = abs[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return undefined;
}
