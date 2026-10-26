import type { Account, Attachment, CurateStatus, FolderListing, MemoryHit, ModelsInfo, Overview, RuntimeState, TranscriptEntry, UsageSnapshot } from "./types";

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
  usage: (refresh = false) => call<UsageSnapshot>("GET", `/api/usage${refresh ? "?refresh=1" : ""}`),
  createProject: (b: Record<string, unknown>) => call<{ id: string; scanSummary?: string }>("POST", "/api/projects", b),
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
  projectSettings: (id: string, b: Record<string, unknown>) => call<{ scanSummary?: string }>("PUT", `/api/projects/${encodeURIComponent(id)}/settings`, b),
  curate: () => call<CurateStatus>("POST", "/api/memory/curate"),
  reorganize: () => call<CurateStatus>("POST", "/api/memory/reorganize"),
  tidy: () => call<CurateStatus>("POST", "/api/memory/tidy"),
  memoryStats: () => call<{ verified: number; common: number; byProject: Record<string, number> }>("GET", "/api/memory/stats"),
  curateStatus: () => call<CurateStatus>("GET", "/api/memory/curate"),
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
  createAgenda: (id: string, title?: string, goals?: string[]) =>
    call<{ key: string }>("POST", `/api/projects/${encodeURIComponent(id)}/agendas`, { title, goals }),
  agenda: (key: string) => call<{ state: RuntimeState; transcript: TranscriptEntry[]; firstTurn: boolean }>("GET", a(key)),
  chat: (key: string, message: string, attachments: Attachment[] = []) => call<{ started: boolean }>("POST", `${a(key)}/chat`, { message, attachments }),
  upload: async (key: string, file: File) => {
    const res = await fetch(`${a(key)}/attachments?name=${encodeURIComponent(file.name || "image.png")}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
    return data as Attachment;
  },
  attachmentUrl: (key: string, id: string) => `${a(key)}/attachments/${encodeURIComponent(id)}`,
  member: (key: string, id: string, opts: { tail?: number; diff?: boolean }) =>
    call<Record<string, unknown> & { logTail: string[]; diff?: string }>(
      "GET",
      `${a(key)}/members/${encodeURIComponent(id)}?tail=${opts.tail ?? 0}&diff=${opts.diff ? 1 : 0}`,
    ),
  merge: (key: string, id: string) => call<{ ok: boolean; conflicts: string[]; output: string }>("POST", `${a(key)}/members/${encodeURIComponent(id)}/merge`),
  stop: (key: string, id: string) => call("POST", `${a(key)}/members/${encodeURIComponent(id)}/stop`),
  reset: (key: string) => call("POST", `${a(key)}/reset`),
  finish: (key: string, retro: boolean) => call<{ ok: boolean; output: string; retro?: string }>("POST", `${a(key)}/finish`, { retro }),
  resume: (key: string) => call<{ resumed: Array<{ from: string; to: string }>; failed: Array<{ id: string; error: string }> }>("POST", `${a(key)}/resume`),
  dismissResume: (key: string) => call<{ ok: boolean }>("POST", `${a(key)}/resume/dismiss`),
  deleteAgenda: (key: string, force = false) => call<{ deleted: boolean; lost: string[]; movedTo?: string }>("DELETE", `${a(key)}${force ? "?force=1" : ""}`),
  dismissFinish: (key: string) => call<{ ok: boolean }>("POST", `${a(key)}/finish/dismiss`),
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
