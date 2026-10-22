import type { Account, FolderListing, MemoryHit, ModelsInfo, Overview, RuntimeState, TranscriptEntry } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText);
  return data as T;
}

const a = (key: string) => {
  const [id, slug] = key.split("/");
  return `/api/a/${encodeURIComponent(id)}/${encodeURIComponent(slug)}`;
};

export const api = {
  me: () => call<{ ok: boolean }>("GET", "/api/me"),
  login: (token: string) => call<{ ok: boolean }>("POST", "/api/login", { token }),
  overview: () => call<Overview>("GET", "/api/overview"),
  createProject: (b: Record<string, unknown>) => call<{ id: string }>("POST", "/api/projects", b),
  guidelines: (id: string) => call<{ text: string; path: string }>("GET", `/api/projects/${encodeURIComponent(id)}/guidelines`),
  saveGuidelines: (id: string, text: string) => call("PUT", `/api/projects/${encodeURIComponent(id)}/guidelines`, { text }),
  setChair: (id: string, model: string, effort: string, account?: string, advisor?: string) =>
    call("PUT", `/api/projects/${encodeURIComponent(id)}/chair`, {
      model,
      effort,
      ...(account !== undefined ? { account } : {}),
      ...(advisor !== undefined ? { advisor } : {}),
    }),
  accounts: () => call<Account[]>("GET", "/api/accounts"),
  accountLogin: (id: string) => call<{ hint: string }>("POST", `/api/accounts/${encodeURIComponent(id)}/login`),
  models: () => call<ModelsInfo>("GET", "/api/models"),
  fs: (p: string) => call<FolderListing>("GET", `/api/fs?path=${encodeURIComponent(p)}`),
  projectSettings: (id: string, b: Record<string, unknown>) => call("PUT", `/api/projects/${encodeURIComponent(id)}/settings`, b),
  openWeb: (key: string, id: string) => call("POST", `${a(key)}/members/${encodeURIComponent(id)}/open-web`),
  addAccount: (b: Record<string, unknown>) => call<Account>("POST", "/api/accounts", b),
  resetAccount: (id: string) => call<Account>("POST", `/api/accounts/${encodeURIComponent(id)}/reset`),
  removeAccount: (id: string) => call("DELETE", `/api/accounts/${encodeURIComponent(id)}`),
  packet: async (key: string, id: string) => {
    const res = await fetch(`${a(key)}/members/${encodeURIComponent(id)}/packet`, { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.text();
  },
  relay: (key: string, id: string, b: { response?: string; result?: string }) =>
    call<{ id: string; status: string; summary?: string }>("POST", `${a(key)}/members/${encodeURIComponent(id)}/relay`, b),
  handover: (key: string, id: string, b: { provider?: string; account?: string; model?: string }) =>
    call<{ id: string; provider: string; account?: string }>("POST", `${a(key)}/members/${encodeURIComponent(id)}/handover`, b),
  createAgenda: (id: string, title: string, goals: string[]) =>
    call<{ key: string }>("POST", `/api/projects/${encodeURIComponent(id)}/agendas`, { title, goals }),
  agenda: (key: string) => call<{ state: RuntimeState; transcript: TranscriptEntry[]; firstTurn: boolean }>("GET", a(key)),
  chat: (key: string, message: string) => call<{ started: boolean }>("POST", `${a(key)}/chat`, { message }),
  member: (key: string, id: string, opts: { tail?: number; diff?: boolean }) =>
    call<Record<string, unknown> & { logTail: string[]; diff?: string }>(
      "GET",
      `${a(key)}/members/${encodeURIComponent(id)}?tail=${opts.tail ?? 0}&diff=${opts.diff ? 1 : 0}`,
    ),
  merge: (key: string, id: string) => call<{ ok: boolean; conflicts: string[]; output: string }>("POST", `${a(key)}/members/${encodeURIComponent(id)}/merge`),
  stop: (key: string, id: string) => call("POST", `${a(key)}/members/${encodeURIComponent(id)}/stop`),
  reset: (key: string) => call("POST", `${a(key)}/reset`),
  finish: (key: string, retro: boolean) => call<{ ok: boolean; output: string; retro?: string }>("POST", `${a(key)}/finish`, { retro }),
  retrospect: (key: string) => call<{ ran: boolean; isError: boolean; text: string }>("POST", `${a(key)}/retrospect`),
  memorySearch: (q: string, all: boolean) => call<MemoryHit[]>("GET", `/api/memory/search?q=${encodeURIComponent(q)}&all=${all ? 1 : 0}`),
  memoryProposals: () => call<MemoryHit[]>("GET", "/api/memory/proposals"),
  memoryRecent: () => call<MemoryHit[]>("GET", "/api/memory/recent"),
  memoryEntry: (id: string) => call<MemoryHit & { body: string }>("GET", `/api/memory/entry/${encodeURIComponent(id)}`),
  memoryApprove: (id: string) => call("POST", `/api/memory/entry/${encodeURIComponent(id)}/approve`),
  memoryReject: (id: string) => call("POST", `/api/memory/entry/${encodeURIComponent(id)}/reject`, {}),
};

export function connectWs(onMessage: (msg: Record<string, unknown>) => void, onStatus: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: number | undefined;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) timer = window.setTimeout(open, 2000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
