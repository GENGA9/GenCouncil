/**
 * Subscription usage per CLI account: the 5-hour window and the weekly window.
 *   claude: the usage endpoint Claude Code's /usage uses, with the account's own login
 *   gpt:    `codex app-server` -> account/rateLimits/read
 *   gemini: `agy -p /usage` (Antigravity CLI prints tab-separated remaining quota)
 * Every reader is best effort; a failure becomes an `error` string for the UI.
 */
import { spawn } from "node:child_process";
import { grokEnv } from "./accounts.js";
import { geminiEnabled } from "./optin.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable } from "./drivers.js";
import { isCliProvider, type Account, type AccountRegistry } from "./accounts.js";
import { LADDERS, tierOf, type CliProvider } from "./models.js";

export interface UsageWindow {
  /** 0..100 */
  usedPct: number;
  resetsAt?: string;
}

export interface AccountUsage {
  provider: CliProvider;
  account: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  /** the plan has no such window (e.g. GPT Pro Lite has weekly only) */
  noFiveHour?: boolean;
  /** every limit the CLI reports (Gemini: model groups and per-model limits such as Argon) */
  details?: UsageDetail[];
  error?: string;
  checkedAt: string;
}

export interface UsageDetail {
  group: string;
  label: string;
  /** 0..100 */
  usedPct: number;
  resetsAt?: string;
}

type UsageData = Omit<AccountUsage, "provider" | "account" | "checkedAt">;

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function killTree(pid: number | undefined, child: { kill: () => boolean }): void {
  if (process.platform === "win32" && pid) spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
  else child.kill();
}

// ---------- Claude ----------

export async function claudeUsage(configDir?: string): Promise<UsageData> {
  const dir = configDir ?? path.join(os.homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  if (!fs.existsSync(file)) return { error: "로그인 정보 없음" };
  const cred = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string } };
  const token = cred.claudeAiOauth?.accessToken;
  if (!token) return { error: "로그인 정보 없음" };
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "gencouncil" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) return { error: "토큰 만료 (claude를 한 번 실행하면 갱신)" };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = (await res.json()) as Record<string, { utilization?: number; resets_at?: string } | null>;
  const w = (k: string): UsageWindow | undefined => {
    const v = j[k];
    return v && typeof v.utilization === "number" ? { usedPct: clampPct(v.utilization), resetsAt: v.resets_at ?? undefined } : undefined;
  };
  return { fiveHour: w("five_hour"), weekly: w("seven_day") };
}

// ---------- GPT (Codex) ----------

interface CodexWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export function parseCodexRateLimits(result: Record<string, unknown>): UsageData {
  const rl = (result.rateLimits ?? {}) as { primary?: CodexWindow | null; secondary?: CodexWindow | null };
  const out: UsageData = {};
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const win: UsageWindow = { usedPct: clampPct(w.usedPercent), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined };
    if ((w.windowDurationMins ?? 0) <= 600) out.fiveHour = win;
    else out.weekly = win;
  }
  if (!out.fiveHour && out.weekly) out.noFiveHour = true;
  if (!out.fiveHour && !out.weekly) out.error = "한도 정보 없음 (로그인 확인)";
  return out;
}

export async function gptUsage(codexHome?: string): Promise<UsageData> {
  const exe = findExecutable("codex");
  if (!exe) return { error: "codex 없음" };
  const env = { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
  const child = /\.(cmd|bat)$/i.test(exe)
    ? spawn("cmd.exe", ["/d", "/s", "/c", `""${exe}" app-server"`], { env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(exe, ["app-server"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("응답 없음")), 25000);
      let buf = "";
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      // codex app-server may exit before we finish writing (update, login problem): never let that crash the host
      child.stdin.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id === 1) {
            child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
            child.stdin.write(JSON.stringify({ id: 2, method: "account/rateLimits/read" }) + "\n");
          } else if (m.id === 2) {
            clearTimeout(timer);
            if (m.error) reject(new Error(m.error.message ?? "error"));
            else resolve(m.result ?? {});
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "gencouncil", version: "0.1.0" } } }) + "\n");
    });
    return parseCodexRateLimits(result);
  } finally {
    killTree(child.pid, child);
  }
}

// ---------- Gemini (Antigravity CLI) ----------

/** parse `agy -p /usage` lines: "<group>\t<label>\t<remaining%>\t<reset ISO>" */
export function parseAgyUsage(text: string): UsageData {
  const out: UsageData = {};
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const [group, label, pct, reset] = cols;
    const remaining = Number(pct.replace("%", "").trim());
    if (!Number.isFinite(remaining)) continue;
    const win: UsageWindow = { usedPct: clampPct(100 - remaining), resetsAt: reset?.trim() || undefined };
    (out.details ??= []).push({ group: group.trim(), label: label.trim(), ...win });
    if (!/^gemini models$/i.test(group.trim())) continue;
    if (/five hour/i.test(label)) out.fiveHour = win;
    else if (/weekly/i.test(label)) out.weekly = win;
  }
  if (!out.fiveHour && !out.weekly) out.error = text.trim() ? text.trim().split(/\r?\n/)[0].slice(0, 120) : "한도 정보 없음";
  return out;
}

export async function geminiUsage(home?: string): Promise<UsageData> {
  // reading the quota runs agy too
  if (!geminiEnabled()) return { error: "꺼짐 (설정에서 켤 수 있음)" };
  const exe = findExecutable("agy");
  if (!exe) return { error: "Antigravity CLI(agy) 없음" };
  const env = { ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}) };
  const text = await new Promise<string>((resolve) => {
    const child = spawn(exe, ["-p", "/usage"], { cwd: os.homedir(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => killTree(child.pid, child), 60000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`error: ${e.message}`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  return parseAgyUsage(text);
}

// ---------- Grok Build ----------

/** the signed-in Grok login in a GROK_HOME (auth.json holds one entry per issuer) */
function grokLogin(grokHome: string): { key: string; expiresAt?: number } | undefined {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(grokHome, "auth.json"), "utf8")) as Record<string, { key?: string; expires_at?: string }>;
    const entry = Object.values(all).find((e) => typeof e?.key === "string" && e.key);
    if (!entry?.key) return undefined;
    const t = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
    return { key: entry.key, expiresAt: Number.isFinite(t) ? t : undefined };
  } catch {
    return undefined;
  }
}

/** run grok once without a model call (it lists models), which refreshes an expired login token */
function refreshGrokLogin(grokHome: string): Promise<void> {
  const exe = findExecutable("grok");
  if (!exe) return Promise.resolve();
  const env = { ...process.env, ...grokEnv(grokHome) };
  return new Promise((resolve) => {
    const child = spawn(exe, ["models"], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      killTree(child.pid, child);
      resolve();
    }, 30000);
    child.on("error", () => resolve());
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Grok Build's plan usage. `grok usage` refuses headless, but the /usage window reads the billing
 * service the CLI talks to (cli-chat-proxy /v1/billing?format=credits) with the login's bearer token:
 * one weekly window (creditUsagePercent, billingPeriodEnd). An expired token is refreshed once by
 * running grok, then read again.
 */
export async function grokUsage(grokHome?: string): Promise<UsageData> {
  const home = grokHome ?? path.join(os.homedir(), ".grok");
  let login = grokLogin(home);
  if (!login) return { error: "로그인 필요" };
  if (login.expiresAt !== undefined && login.expiresAt < Date.now() + 60_000) {
    await refreshGrokLogin(home);
    login = grokLogin(home);
    if (!login) return { error: "로그인 필요" };
  }
  const ask = async (key: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      return await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let res = await ask(login.key);
    if (res.status === 401) {
      await refreshGrokLogin(home);
      const again = grokLogin(home);
      if (!again) return { error: "로그인 필요" };
      res = await ask(again.key);
      if (res.status === 401) return { error: "로그인 필요" };
    }
    if (!res.ok) return { error: `사용량 서버 오류 (HTTP ${res.status})` };
    const body = (await res.json()) as { config?: { creditUsagePercent?: number; currentPeriod?: { end?: string }; billingPeriodEnd?: string } };
    const c = body.config;
    if (typeof c?.creditUsagePercent !== "number") return { error: "사용량을 읽지 못함" };
    return { weekly: { usedPct: clampPct(c.creditUsagePercent), resetsAt: c.currentPeriod?.end ?? c.billingPeriodEnd }, noFiveHour: true };
  } catch (e) {
    return { error: `사용량을 읽지 못함: ${(e as Error).message}`.slice(0, 120) };
  }
}

// ---------- all accounts ----------

const READERS: Record<CliProvider, (dir?: string) => Promise<UsageData>> = {
  claude: claudeUsage,
  gpt: gptUsage,
  gemini: geminiUsage,
  grok: grokUsage,
};

export async function accountUsage(a: Account & { provider: CliProvider }): Promise<AccountUsage> {
  const checkedAt = new Date().toISOString();
  try {
    return { provider: a.provider, account: a.id, ...(await READERS[a.provider](a.configDir)), checkedAt };
  } catch (e) {
    return { provider: a.provider, account: a.id, error: (e as Error).message, checkedAt };
  }
}

/**
 * Read usage of every enabled CLI account and keep the registry honest:
 * a full window marks the account exhausted until that window resets,
 * an account that has room again is marked usable.
 */
export async function collectUsage(registry: AccountRegistry): Promise<AccountUsage[]> {
  const accounts = registry
    .list()
    .filter((a): a is Account & { provider: CliProvider } => isCliProvider(a.provider) && a.status !== "disabled");
  const results = await Promise.all(accounts.map((a) => accountUsage(a)));
  applyUsageToAccounts(registry, results);
  return results;
}

/** What a usage reading means for the registry (separate from reading it, so it can be tested). */
export function applyUsageToAccounts(registry: AccountRegistry, results: AccountUsage[]): void {
  for (const u of results) {
    if (u.error) continue;
    const acct = registry.get(u.account);
    if (!acct) continue;
    const full = [u.fiveHour, u.weekly].filter((w): w is UsageWindow => Boolean(w && w.usedPct >= 100));
    if (full.length) {
      const resetAt = full.map((w) => w.resetsAt ?? "").sort().pop() || undefined;
      if (acct.status !== "exhausted" || acct.resetAt !== resetAt) registry.markExhausted(u.account, "사용 한도 소진 (사용량 확인)", resetAt);
    } else if (acct.status !== "ok") {
      registry.markOk(u.account);
    } else {
      // room on an account that already reads ok: drop the message a past failure left behind
      registry.clearError(u.account);
    }
    applyModelLimits(registry, u);
  }
}

/**
 * Per-model limits the CLI reports (Antigravity counts Gemini 4 Argon on its own). A model with
 * nothing left is blocked until its reset, one with room again has its block lifted — otherwise a
 * model stays blocked until something marks the whole account ok, and the chair is told a model is
 * spent long after it came back.
 */
function applyModelLimits(registry: AccountRegistry, u: AccountUsage): void {
  if (!isCliProvider(u.provider) || !u.details?.length) return;
  const ladder = LADDERS[u.provider];
  for (const d of u.details) {
    // only a limit of one model's own, not a whole model group ("Gemini Models", "Claude and GPT models")
    if (/\bmodels\b/i.test(d.group)) continue;
    const t = tierOf(u.provider, d.group);
    if (t < 0) continue;
    registry.setModelBlock(u.account, ladder[t].id, d.usedPct >= 100 ? (d.resetsAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()) : undefined);
  }
}
