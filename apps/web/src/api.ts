import type { Account, Attachment, CurateStatus, GeminiOptIn, FolderListing, MemoryHit, ModelsInfo, Overview, RuntimeState, TranscriptEntry, UsageSnapshot, WikiHit, WikiPage, WikiPageMeta, WikiStatus } from "./types";

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
  // the chair is per agenda: key is "<projectId>/<agendaSlug>"
  setChair: (key: string, model: string, effort: string, account?: string, advisor?: string) =>
    call("PUT", `/api/a/${key.split("/").map(encodeURIComponent).join("/")}/chair`, {
      model,
      effort,
      ...(account !== undefined ? { account } : {}),
      ...(advisor !== undefined ? { advisor } : {}),
    }),
  accounts: () => call<Account[]>("GET", "/api/accounts"),
  geminiSetting: () => call<GeminiOptIn>("GET", "/api/settings/gemini"),
  setGemini: (enabled: boolean, accept: boolean) => call<GeminiOptIn>("PUT", "/api/settings/gemini", { enabled, accept }),
  accountLogin: (id: string) => call<{ hint: string }>("POST", `/api/accounts/${encodeURIComponent(id)}/login`),
  models: () => call<ModelsInfo>("GET", "/api/models"),
  fs: (p: string) => call<FolderListing>("GET", `/api/fs?path=${encodeURIComponent(p)}`),
  projectSettings: (id: string, b: Record<string, unknown>) => call<{ scanSummary?: string }>("PUT", `/api/projects/${encodeURIComponent(id)}/settings`, b),
  curate: () => call<CurateStatus>("POST", "/api/memory/curate"),
  reorganize: () => call<CurateStatus>("POST", "/api/memory/reorganize"),
  tidy: () => call<CurateStatus>("POST", "/api/memory/tidy"),
  clearMemory: () => call<{ removed: number; backup: string }>("POST", "/api/memory/clear", { confirm: "전체 삭제" }),
  memoryStats: () => call<{ verified: number; common: number; byProject: Record<string, number> }>("GET", "/api/memory/stats"),
  wikiStatus: () => call<WikiStatus>("GET", "/api/wiki/status"),
  wikiList: () => call<WikiPageMeta[]>("GET", "/api/wiki"),
  wikiSearch: (q: string) => call<WikiHit[]>("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`),
  wikiPage: (p: string) => call<WikiPage>("GET", `/api/wiki/page?path=${encodeURIComponent(p)}`),
  wikiSave: (b: { path: string; title: string; summary: string; body: string; reason?: string }) => call<WikiPage>("PUT", "/api/wiki/page", b),
  wikiRemove: (p: string) => call<{ removed: boolean }>("DELETE", `/api/wiki/page?path=${encodeURIComponent(p)}`),
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
  chat: (key: string, message: string, attachments: Attachment[] = []) => call<{ started: boolean; queued?: boolean }>("POST", `${a(key)}/chat`, { message, attachments }),
  stopChair: (key: string) => call<{ stopped: boolean }>("POST", `${a(key)}/chair/stop`),
  clearQueue: (key: string) => call<{ cleared: number }>("POST", `${a(key)}/chat/queue/clear`),
  upload: (key: string, file: File, onProgress?: (pct: number) => void) =>
    new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${a(key)}/attachments?name=${encodeURIComponent(file.name || "image.png")}`);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.min(100, Math.floor((e.loaded / e.total) * 100)));
      };
      xhr.onerror = () => reject(new ApiError(0, "서버에 연결할 수 없거나 연결이 끊겼습니다"));
      xhr.onabort = () => reject(new ApiError(0, "업로드가 취소되었습니다"));
      xhr.onload = () => {
        let data: { error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as Attachment);
        else reject(new ApiError(xhr.status, data.error ?? (xhr.statusText || `HTTP ${xhr.status}`)));
      };
      xhr.send(file);
    }),
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
  telegram: () => call<{ configured: boolean; user?: string; autoNotify: boolean }>("GET", "/api/telegram"),
  setTelegramAuto: (key: string, on: boolean) => call<{ ok: boolean; telegramAuto: boolean }>("POST", `${a(key)}/telegram-auto`, { on }),
  dismissFinish: (key: string) => call<{ ok: boolean }>("POST", `${a(key)}/finish/dismiss`),
  mergeBase: (key: string) => call<{ ok: boolean; output: string; notIncluded: string[] }>("POST", `${a(key)}/merge-base`),
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
