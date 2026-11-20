/**
 * Account registry: which logins exist per provider and whether they are usable right now.
 * ~/.gencouncil/accounts.json. The implicit accounts "claude", "gemini" and "gpt" are the normal
 * logins (no config dir override) and always exist.
 *
 * CLI accounts keep their login in their own folder (CLAUDE_CONFIG_DIR / HOME for gemini = Antigravity CLI / CODEX_HOME).
 * Web accounts (web Gemini, AI Studio, ChatGPT) are dedicated Chrome profiles the user logs into once;
 * relay members then open the site in that profile.
 */
import fs from "node:fs";
import path from "node:path";
import { gencouncilHome } from "@gencouncil/core";
import { CLI_PROVIDERS, LADDERS, SITE_INFO, WEB_SITES, tierOf, type CliProvider, type WebSite } from "./models.js";
import { assertGeminiEnabled, GEMINI_OFF, geminiEnabled } from "./optin.js";

export type AccountProvider = CliProvider | WebSite;
export type AccountStatus = "ok" | "exhausted" | "auth" | "disabled";

export interface Account {
  id: string;
  provider: AccountProvider;
  /** CLI: config dir for that login; web: Chrome profile dir. undefined = the default login (CLI only) */
  configDir?: string;
  /** lower runs first (default 100; implicit defaults 50) */
  priority?: number;
  status: AccountStatus;
  exhaustedAt?: string;
  resetAt?: string;
  lastError?: string;
  lastUsed?: string;
  /** set after a login window was opened at least once */
  loginOpenedAt?: string;
  note?: string;
  /** Antigravity limits each model on its own: ladder model id -> when it is usable again */
  modelBlocks?: Record<string, string>;
}

/** CLIs whose quota runs out per model, not per login (Antigravity: Argon can be spent while Flash still runs) */
const PER_MODEL_QUOTA: ReadonlySet<CliProvider> = new Set(["gemini"]);

/** default cooldown when the error gives no reset time */
export const DEFAULT_COOLDOWN_MS: Record<CliProvider, number> = {
  claude: 5 * 60 * 60 * 1000,
  gemini: 60 * 60 * 1000,
  gpt: 5 * 60 * 60 * 1000,
};

export function accountsFile(): string {
  return path.join(gencouncilHome(), "accounts.json");
}

/** where new accounts keep their login when the user doesn't pick a folder */
export function defaultAccountDir(id: string): string {
  return path.join(gencouncilHome(), "accounts", id);
}

export function isCliProvider(p: string): p is CliProvider {
  return (CLI_PROVIDERS as readonly string[]).includes(p);
}

export function isWebSite(p: string): p is WebSite {
  return (WEB_SITES as readonly string[]).includes(p);
}

const IMPLICIT: Account[] = [
  { id: "claude", provider: "claude", priority: 50, status: "ok", note: "기본 로그인 (~/.claude)" },
  { id: "gemini", provider: "gemini", priority: 50, status: "ok", note: "기본 로그인 (Antigravity, PC당 하나)" },
  { id: "gpt", provider: "gpt", priority: 50, status: "ok", note: "기본 로그인 (~/.codex)" },
];

export class AccountRegistry {
  private read(): Account[] {
    const f = accountsFile();
    let stored: Partial<Account>[] = [];
    if (fs.existsSync(f)) {
      try {
        stored = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<Account>[];
      } catch {
        stored = [];
      }
    }
    const byId = new Map<string, Account>();
    for (const a of IMPLICIT) byId.set(a.id, { ...a });
    for (const s of stored) {
      if (!s.id || !s.provider) continue;
      const base = byId.get(s.id) ?? { id: s.id, provider: s.provider as AccountProvider, status: "ok" as AccountStatus };
      byId.set(s.id, { ...base, ...s, status: (s.status as AccountStatus) ?? base.status });
    }
    const now = Date.now();
    const list = [...byId.values()];
    // lazy reset of expired cooldowns
    for (const a of list) {
      if (a.status === "exhausted" && a.resetAt && Date.parse(a.resetAt) <= now) {
        a.status = "ok";
        a.exhaustedAt = undefined;
        a.resetAt = undefined;
      }
      if (a.modelBlocks) {
        for (const [m, at] of Object.entries(a.modelBlocks)) if (Date.parse(at) <= now) delete a.modelBlocks[m];
        if (!Object.keys(a.modelBlocks).length) a.modelBlocks = undefined;
      }
    }
    return list;
  }

  private write(list: Account[]): void {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(list, null, 2) + "\n", "utf8");
  }

  /**
   * While Gemini (Antigravity CLI) is switched off, its login reads as disabled everywhere: nothing
   * picks it, the usage check skips it, the chair sees it is off. Only how it reads: the stored
   * status is left alone, so switching back on finds the account as it was.
   */
  private shown(a: Account, geminiOn: boolean): Account {
    return a.provider === "gemini" && !geminiOn ? { ...a, status: "disabled", lastError: GEMINI_OFF } : a;
  }

  list(provider?: AccountProvider): Account[] {
    const on = geminiEnabled();
    return this.read()
      .filter((a) => !provider || a.provider === provider)
      .map((a) => this.shown(a, on))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id));
  }

  get(id: string): Account | undefined {
    const a = this.read().find((x) => x.id === id);
    return a && this.shown(a, geminiEnabled());
  }

  /** Add or update. A new account without a folder gets ~/.gencouncil/accounts/<id>. */
  upsert(input: Partial<Account> & { id: string; provider: AccountProvider }): Account {
    if (!isCliProvider(input.provider) && !isWebSite(input.provider)) throw new Error(`unknown provider: ${input.provider}`);
    const list = this.read();
    const i = list.findIndex((a) => a.id === input.id);
    const prev = i >= 0 ? list[i] : undefined;
    const implicit = IMPLICIT.some((a) => a.id === input.id);
    // an id names one login of one kind; never turn an existing account into another kind
    if (prev && prev.provider !== input.provider)
      throw new Error(`'${input.id}' 이름은 이미 ${providerLabel(prev.provider)} 계정이 쓰고 있습니다. 다른 이름으로 추가하세요.`);
    // Antigravity CLI keeps a single login per Windows user (OS keyring), so extra folders would all be the same account
    if (!prev && input.provider === "gemini")
      throw new Error("안티그래비티 CLI는 이 PC(윈도우 사용자)에서 로그인 하나만 쓸 수 있어 제미나이 CLI 계정을 더 추가할 수 없습니다. 다른 구글 계정은 웹 제미나이나 AI Studio 계정으로 추가하세요.");
    const next: Account = { status: "ok", ...(prev ?? {}), ...input } as Account;
    if (!next.configDir && !implicit) next.configDir = defaultAccountDir(input.id);
    if (next.configDir) fs.mkdirSync(next.configDir, { recursive: true });
    if (i >= 0) list[i] = next;
    else list.push(next);
    this.write(list);
    return next;
  }

  remove(id: string): boolean {
    if (IMPLICIT.some((a) => a.id === id)) throw new Error(`cannot remove implicit account ${id}`);
    const list = this.read();
    const next = list.filter((a) => a.id !== id);
    this.write(next);
    return next.length !== list.length;
  }

  private patch(id: string, fn: (a: Account) => void): Account {
    const list = this.read();
    const a = list.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account: ${id}`);
    fn(a);
    this.write(list);
    return a;
  }

  markExhausted(id: string, error: string, resetAt?: string): Account {
    return this.patch(id, (a) => {
      a.status = "exhausted";
      a.exhaustedAt = new Date().toISOString();
      const cooldown = isCliProvider(a.provider) ? DEFAULT_COOLDOWN_MS[a.provider] : 60 * 60 * 1000;
      a.resetAt = resetAt ?? new Date(Date.now() + cooldown).toISOString();
      a.lastError = error.slice(0, 500);
    });
  }

  /**
   * A quota error on a per-model CLI blocks only that model. Returns false when the CLI is not
   * per-model or no lower model is left; the caller then marks the whole account exhausted.
   */
  blockModel(id: string, model: string | undefined, error: string, resetAt?: string): boolean {
    const a = this.get(id);
    if (!a || !isCliProvider(a.provider) || !PER_MODEL_QUOTA.has(a.provider)) return false;
    const t = tierOf(a.provider, model);
    if (t < 0) return false;
    const provider = a.provider;
    const until = resetAt ?? new Date(Date.now() + DEFAULT_COOLDOWN_MS[provider]).toISOString();
    this.patch(id, (x) => {
      x.modelBlocks = { ...(x.modelBlocks ?? {}), [LADDERS[provider][t].id]: until };
      x.lastError = error.slice(0, 500);
    });
    return this.fitModel(id, LADDERS[provider][t].id) !== undefined;
  }

  /** the model itself, or the closest lower one this account can still run; undefined when none is left */
  fitModel(id: string, model: string | undefined): string | undefined {
    const a = this.get(id);
    if (!model || !a?.modelBlocks || !isCliProvider(a.provider)) return model;
    const ladder = LADDERS[a.provider];
    const t = tierOf(a.provider, model);
    const blocked = (mid: string) => {
      const until = a.modelBlocks?.[mid];
      // a block ends at its reset time: past it the model is usable again
      return Boolean(until) && new Date(until as string).getTime() > Date.now();
    };
    if (t < 0 || !blocked(ladder[t].id)) return model;
    for (let i = t - 1; i >= 0; i--) if (!blocked(ladder[i].id)) return ladder[i].id;
    return undefined;
  }

  /** Block a model until `until`, or lift the block when `until` is undefined. */
  setModelBlock(id: string, modelId: string, until: string | undefined): void {
    const a = this.get(id);
    if (!a) return;
    const cur = a.modelBlocks?.[modelId];
    if ((cur ?? undefined) === (until ?? undefined)) return;
    this.patch(id, (x) => {
      const blocks = { ...(x.modelBlocks ?? {}) };
      if (until) blocks[modelId] = until;
      else delete blocks[modelId];
      x.modelBlocks = Object.keys(blocks).length ? blocks : undefined;
    });
  }

  /**
   * A usage check found room on this account: forget the error left by an older failure. The chair
   * reads the account list, and a stale message there had it believing a usable CLI was spent.
   */
  clearError(id: string): void {
    const a = this.get(id);
    if (!a?.lastError) return;
    this.patch(id, (x) => (x.lastError = undefined));
  }

  markAuth(id: string, error: string): Account {
    return this.patch(id, (a) => {
      a.status = "auth";
      a.lastError = error.slice(0, 500);
    });
  }

  markOk(id: string): Account {
    return this.patch(id, (a) => {
      a.status = "ok";
      a.exhaustedAt = undefined;
      a.resetAt = undefined;
      a.lastError = undefined;
      a.modelBlocks = undefined;
    });
  }

  markLoginOpened(id: string): void {
    try {
      this.patch(id, (a) => (a.loginOpenedAt = new Date().toISOString()));
    } catch {
      /* ignore */
    }
  }

  touch(id: string): void {
    try {
      this.patch(id, (a) => (a.lastUsed = new Date().toISOString()));
    } catch {
      /* unknown id: ignore */
    }
  }

  /** Pick a usable CLI account: the preferred one if usable, else the best remaining. */
  pick(provider: CliProvider, opts: { prefer?: string; exclude?: string[] } = {}): Account | undefined {
    const usable = this.list(provider).filter((a) => a.status === "ok" && !opts.exclude?.includes(a.id));
    if (opts.prefer) {
      const p = usable.find((a) => a.id === opts.prefer);
      if (p) return p;
    }
    return usable[0];
  }

  /** Pick a web profile for a site (least recently used first so work spreads across logins). */
  pickWeb(site: WebSite, prefer?: string): Account | undefined {
    const usable = this.list(site).filter((a) => a.status === "ok");
    if (prefer) {
      const p = usable.find((a) => a.id === prefer);
      if (p) return p;
    }
    return usable.sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? ""))[0];
  }

  /** Environment that routes a CLI process to this account's login. */
  env(account: Account | undefined): Record<string, string> {
    if (!account?.configDir) return {};
    if (account.provider === "claude") return { CLAUDE_CONFIG_DIR: account.configDir };
    if (account.provider === "gpt") return { CODEX_HOME: account.configDir };
    if (account.provider === "gemini") return { HOME: account.configDir, USERPROFILE: account.configDir };
    return {};
  }
}

/** Command that lets the user log in once for an account (run in a visible window). */
export interface LoginCommand {
  /** "cli": a console window running the CLI; "browser": a Chrome window on the site */
  kind: "cli" | "browser";
  exe: string;
  args: string[];
  env: Record<string, string>;
  hint: string;
}

/** Korean label of an account kind, for messages */
export function providerLabel(p: AccountProvider): string {
  if (isWebSite(p)) return SITE_INFO[p].label;
  return p === "claude" ? "클로드" : p === "gpt" ? "GPT" : "제미나이(안티그래비티)";
}

export function loginCommand(account: Account, registry: AccountRegistry, chromeExe?: string): LoginCommand {
  if (isWebSite(account.provider)) {
    if (!chromeExe) throw new Error("Chrome not found; web accounts need Chrome");
    const site = SITE_INFO[account.provider];
    return {
      kind: "browser",
      exe: chromeExe,
      args: [`--user-data-dir=${account.configDir}`, "--no-first-run", "--no-default-browser-check", "--new-window", site.url],
      env: {},
      hint: `${site.label}에 이 계정으로 로그인한 뒤 창을 닫으세요. 이 프로필에 로그인이 저장됩니다.`,
    };
  }
  const env = registry.env(account);
  switch (account.provider) {
    case "claude":
      return { kind: "cli", exe: "claude", args: [], env, hint: "/login 을 입력해 로그인한 뒤 /exit" };
    case "gemini":
      assertGeminiEnabled();
      return { kind: "cli", exe: "agy", args: [], env, hint: "Antigravity 창에서 이 구글 계정으로 로그인한 뒤 창을 닫으세요 (/login 으로 다시 로그인 가능)" };
    case "gpt":
      return { kind: "cli", exe: "codex", args: ["login"], env, hint: "브라우저에서 ChatGPT 계정으로 로그인하면 창이 닫힙니다" };
  }
  throw new Error(`no login command for ${account.provider}`);
}

export const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChrome(): string | undefined {
  return CHROME_PATHS.find((p) => fs.existsSync(p));
}

// backwards-compatible helper used by the CLI
export function loadAccounts(): Account[] {
  return new AccountRegistry().list();
}
