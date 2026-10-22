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
import { CLI_PROVIDERS, SITE_INFO, WEB_SITES, type CliProvider, type WebSite } from "./models.js";

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
}

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
  { id: "gemini", provider: "gemini", priority: 50, status: "ok", note: "기본 로그인 (Antigravity)" },
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
    }
    return list;
  }

  private write(list: Account[]): void {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(list, null, 2) + "\n", "utf8");
  }

  list(provider?: AccountProvider): Account[] {
    return this.read()
      .filter((a) => !provider || a.provider === provider)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id));
  }

  get(id: string): Account | undefined {
    return this.read().find((a) => a.id === id);
  }

  /** Add or update. A new account without a folder gets ~/.gencouncil/accounts/<id>. */
  upsert(input: Partial<Account> & { id: string; provider: AccountProvider }): Account {
    if (!isCliProvider(input.provider) && !isWebSite(input.provider)) throw new Error(`unknown provider: ${input.provider}`);
    const list = this.read();
    const i = list.findIndex((a) => a.id === input.id);
    const prev = i >= 0 ? list[i] : undefined;
    const implicit = IMPLICIT.some((a) => a.id === input.id);
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
