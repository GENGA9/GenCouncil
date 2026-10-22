/**
 * Account registry: which logins exist per provider and whether they are usable right now.
 * ~/.gencouncil/accounts.json. The implicit accounts "claude" and "gemini" are the normal
 * logins (no config dir override) and always exist.
 */
import fs from "node:fs";
import path from "node:path";
import { gencouncilHome } from "@gencouncil/core";
import type { CliProvider } from "./model.js";

export type AccountStatus = "ok" | "exhausted" | "auth" | "disabled";

export interface Account {
  id: string;
  provider: CliProvider;
  /** CLAUDE_CONFIG_DIR for claude, HOME/USERPROFILE for gemini; undefined = default login */
  configDir?: string;
  /** lower runs first (default 100; implicit defaults 50) */
  priority?: number;
  status: AccountStatus;
  exhaustedAt?: string;
  resetAt?: string;
  lastError?: string;
  lastUsed?: string;
  note?: string;
}

/** default cooldown when the error gives no reset time */
export const DEFAULT_COOLDOWN_MS: Record<CliProvider, number> = {
  claude: 5 * 60 * 60 * 1000,
  gemini: 60 * 60 * 1000,
};

export function accountsFile(): string {
  return path.join(gencouncilHome(), "accounts.json");
}

const IMPLICIT: Account[] = [
  { id: "claude", provider: "claude", priority: 50, status: "ok", note: "기본 로그인 (~/.claude)" },
  { id: "gemini", provider: "gemini", priority: 50, status: "ok", note: "기본 로그인 (~/.gemini)" },
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
      const base = byId.get(s.id) ?? { id: s.id, provider: s.provider as CliProvider, status: "ok" as AccountStatus };
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

  list(provider?: CliProvider): Account[] {
    return this.read()
      .filter((a) => !provider || a.provider === provider)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id));
  }

  get(id: string): Account | undefined {
    return this.read().find((a) => a.id === id);
  }

  upsert(input: Partial<Account> & { id: string; provider: CliProvider }): Account {
    const list = this.read();
    const i = list.findIndex((a) => a.id === input.id);
    const next: Account = { status: "ok", ...(i >= 0 ? list[i] : {}), ...input } as Account;
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
      a.resetAt = resetAt ?? new Date(Date.now() + DEFAULT_COOLDOWN_MS[a.provider]).toISOString();
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

  touch(id: string): void {
    try {
      this.patch(id, (a) => (a.lastUsed = new Date().toISOString()));
    } catch {
      /* unknown id: ignore */
    }
  }

  /** Pick a usable account: the preferred one if usable, else the best remaining. */
  pick(provider: CliProvider, opts: { prefer?: string; exclude?: string[] } = {}): Account | undefined {
    const usable = this.list(provider).filter((a) => a.status === "ok" && !opts.exclude?.includes(a.id));
    if (opts.prefer) {
      const p = usable.find((a) => a.id === opts.prefer);
      if (p) return p;
    }
    return usable[0];
  }

  /** Environment that routes a CLI process to this account's login. */
  env(account: Account | undefined): Record<string, string> {
    if (!account?.configDir) return {};
    if (account.provider === "claude") return { CLAUDE_CONFIG_DIR: account.configDir };
    return { HOME: account.configDir, USERPROFILE: account.configDir };
  }
}

// backwards-compatible helpers used by the CLI
export function loadAccounts(): Account[] {
  return new AccountRegistry().list();
}
