import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, entryScope, type EntryType } from "@gencouncil/core";
import {
  AccountRegistry,
  collectUsage,
  type AccountUsage,
  AgendaRuntime,
  AgendaStore,
  CLI_PROVIDERS,
  DEFAULT_LIMITS,
  EFFORTS,
  LADDERS,
  ProjectRegistry,
  SITE_INFO,
  SHOW_TYPES,
  SUPPORTS_EFFORT,
  EFFORT_CAP,
  WEB_SITES,
  createProject,
  updateProject,
  handleCouncilMcpRequest,
  handleMemberMcpRequest,
  runCurator,
  deleteAgenda,
  runReorganize,
  runTidy,
  selectTidyCandidates,
  markReviewed,
  verifiedHashes,
  projectMemoryKey,
  isCliProvider,
  isRepo,
  isWebSite,
  normalizeLimits,
  openLoginWindow,
  openWebSite,
  type AccountProvider,
  type Autonomy,
  type CliProvider,
  type Attachment,
  type RuntimeEvent,
} from "@gencouncil/council";

const MAX_UPLOAD = 25 * 1024 * 1024;
import { listFolder } from "./fsbrowse.js";
import { WebSocketServer, type WebSocket } from "ws";
import { detectTailscale, loadServerConfig, saveServerConfig, type ServerConfig, type TailscaleInfo } from "./config.js";
import { TelegramBridge } from "./telegram.js";

export interface ServerOptions extends Partial<ServerConfig> {
  /** directory with the built web app (apps/web/dist) */
  webDir?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  config: ServerConfig;
  url: string;
  tailscale: TailscaleInfo;
  /** bot username when Telegram is configured and reachable */
  telegram?: string;
  close(): Promise<void>;
}

type Params = Record<string, string>;
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Params;
  body: () => Promise<Record<string, unknown>>;
}
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function defaultWebDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist");
}

function compile(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/\/:(\w+)/g, (_m, k: string) => {
        keys.push(k);
        return "/([^/]+)";
      }) +
      "/?$",
  );
  return { method, re, keys, handler };
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  // port 0 = ephemeral (tests); never persist it
  const config = loadServerConfig({ token: opts.token, port: opts.port && opts.port > 0 ? opts.port : undefined, host: opts.host });
  const listenPort = opts.port === 0 ? 0 : config.port;
  const log = opts.log ?? ((l: string) => console.error(`[web] ${l}`));
  const webDir = opts.webDir ?? defaultWebDir();
  const registry = new ProjectRegistry();
  const accounts = new AccountRegistry();
  // subscription usage (5h / weekly) per CLI account, cached; reading it spawns codex / agy
  const USAGE_TTL = 5 * 60 * 1000;
  let usageCache: { at: number; items: AccountUsage[] } | undefined;
  let usageRun: Promise<void> | undefined;
  const refreshUsage = (): Promise<void> =>
    (usageRun ??= collectUsage(accounts)
      .then((items) => {
        usageCache = { at: Date.now(), items };
        broadcast({ type: "usage", ...usageCache });
      })
      .catch((e) => log(`usage check failed: ${(e as Error).message}`))
      .finally(() => {
        usageRun = undefined;
      }));
  const memory = new MemoryStore({ watch: true });
  await memory.init();
  const tailscale = await detectTailscale();

  // ---------- runtimes ----------
  const runtimes = new Map<string, Promise<AgendaRuntime>>();
  const clients = new Set<WebSocket>();
  const broadcast = (msg: Record<string, unknown>) => {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
  };
  let telegram: TelegramBridge | undefined;
  let curate: {
    kind?: "proposals" | "reorganize" | "tidy";
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    pending?: number;
    /** tidy: entries still due after this batch */
    remaining?: number;
    steps?: number;
    text?: string;
    isError?: boolean;
    costUsd?: number;
  } = { running: false };
  let telegramUser: string | undefined;

  const findAgenda = (id: string, slug: string) => {
    const project = registry.get(id);
    if (!project) throw new HttpError(404, `unknown project: ${id}`);
    const store = AgendaStore.find(project, slug);
    if (!store) throw new HttpError(404, `unknown agenda: ${slug}`);
    return { project, store };
  };

  const getRuntime = (id: string, slug: string): Promise<AgendaRuntime> => {
    const { project, store } = findAgenda(id, slug);
    const key = `${project.id}/${store.slug}`;
    let p = runtimes.get(key);
    if (!p) {
      p = AgendaRuntime.open(store, memory, {
        councilUrl: `http://127.0.0.1:${config.port}/mcp/${encodeURIComponent(project.id)}/${encodeURIComponent(store.slug)}`,
        councilHeaders: { Authorization: `Bearer ${config.token}` },
      }).then((rt) => {
        rt.council.setUsageProvider(() => usageCache?.items);
        // council_telegram: the chair sends to Telegram only when the user told it to
        rt.council.setTelegramSender(async (req) => (telegram ? telegram.sendRequested(key, req) : { ok: false, detail: "텔레그램 봇이 연결되어 있지 않다" }));
        rt.council.setMemberMcp((mid) => ({
          url: `http://127.0.0.1:${config.port}/mcp-member/${encodeURIComponent(project.id)}/${encodeURIComponent(store.slug)}/${encodeURIComponent(mid)}`,
          headers: { Authorization: `Bearer ${config.token}` },
        }));
        rt.on("event", (e: RuntimeEvent) => {
          broadcast({ key, ts: new Date().toISOString(), ...e });
          telegram?.notify(key, e);
          if (e.type === "chair:show") void telegram?.sendShown(key, e.text, e.attachments.map((a) => ({ ...a, path: rt.attachmentPath(a.id) })));
          if (e.type === "agenda:finished") {
            // the chair ended the agenda (council_finish); it is merged and closed now
            runtimes.delete(key);
            broadcast({ type: "overview" });
            void telegram?.finishFor(key, `[${key}] 의장이 안건을 종료했습니다: ${e.reason}`);
          }
        });
        log(`opened ${key}`);
        return rt;
      });
      p.catch(() => runtimes.delete(key));
      runtimes.set(key, p);
    }
    return p;
  };

  // ---------- auth ----------
  const tokenOf = (req: http.IncomingMessage, url: URL): string | undefined => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
    const q = url.searchParams.get("token");
    if (q) return q;
    const cookie = req.headers.cookie ?? "";
    const m = /(?:^|;\s*)gc_token=([^;]+)/.exec(cookie);
    return m ? decodeURIComponent(m[1]) : undefined;
  };
  const authorized = (req: http.IncomingMessage, url: URL) => tokenOf(req, url) === config.token;

  // ---------- overview helpers ----------
  const overview = async () => {
    const projects = await Promise.all(
      registry.list().map(async (p) => ({
        ...p,
        agendas: await Promise.all(
          AgendaStore.list(p).map(async (a) => {
            const key = `${p.id}/${a.slug}`;
            const store = new AgendaStore(p, a.slug);
            const tasks = store.tasks();
            const rtp = runtimes.get(key);
            const rt = rtp ? await rtp.catch(() => undefined) : undefined;
            const members = rt ? rt.council.members() : store.members();
            const running = members.filter((m) => m.status === "running" || m.status === "waiting");
            return {
              ...a,
              key,
              taskCounts: { total: tasks.length, done: tasks.filter((t) => t.status === "done").length },
              running: running.length,
              runningFamilies: [...new Set(running.map((m) => (m.provider === "relay" ? (m.site ? SITE_INFO[m.site].family : "relay") : m.provider)))],
              chairBusy: rt?.chair.isBusy() ?? false,
              open: Boolean(rt),
            };
          }),
        ),
      })),
    );
    return {
      projects,
      memory: { verified: memory.list({ status: "verified" }).length, proposed: memory.list({ status: "proposed" }).length },
      accounts: accounts.list(),
      server: { host: config.host, port: config.port, tailscale },
    };
  };

  // ---------- routes ----------
  const routes: Route[] = [];
  const on = (method: string, pattern: string, handler: Handler) => routes.push(compile(method, pattern, handler));

  on("POST", "/api/login", async ({ res, body }) => {
    const b = await body();
    if (b.token !== config.token) throw new HttpError(401, "invalid token");
    res.setHeader("Set-Cookie", `gc_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return { ok: true };
  });
  on("GET", "/api/me", () => ({ ok: true }));
  on("GET", "/api/overview", () => overview());

  on("POST", "/api/projects", async ({ body }) => {
    const b = await body();
    const name = String(b.name ?? "").trim();
    const folder = String(b.path ?? b.repo ?? "").trim();
    if (!name || !folder) throw new HttpError(400, "name and folder required");
    let p;
    try {
      p = await createProject({
        name,
        path: folder,
        mode: (b.mode as "auto" | "git" | "folder") || "auto",
        chairModel: (b.chairModel as string) || undefined,
        chairEffort: (b.chairEffort as string) || undefined,
        chairDirectEdit: b.chairDirectEdit === true,
        chairAccount: (b.chairAccount as string) || undefined,
        autonomy: (b.autonomy as Autonomy) || undefined,
        defaultProvider: (b.defaultProvider as CliProvider) || undefined,
        limits: (b.limits as Record<string, never>) || undefined,
      }, registry);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    broadcast({ type: "overview" });
    return p;
  });
  on("PUT", "/api/projects/:id/settings", async ({ params, body }) => {
    const p = registry.get(params.id);
    if (!p) throw new HttpError(404, "unknown project");
    const b = await body();
    let scanSummary: string | undefined;
    if (b.name !== undefined || b.path !== undefined) {
      const before = p.repo;
      try {
        const u = await updateProject(p.id, { name: b.name as string | undefined, path: b.path as string | undefined }, registry);
        p.name = u.name;
        p.repo = u.repo;
        p.localGit = u.localGit;
        p.baseBranch = u.baseBranch;
        scanSummary = u.scanSummary;
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (p.repo !== before) {
        // agendas opened on the old folder must reopen on the new one
        for (const a of AgendaStore.list(p)) {
          const key = `${p.id}/${a.slug}`;
          const rtp = runtimes.get(key);
          if (rtp) {
            (await rtp).close({ closeMemory: false });
            runtimes.delete(key);
          }
        }
      }
    }
    const chair = (b.chair ?? {}) as { model?: string; effort?: string; directEdit?: boolean };
    const members = (b.members ?? {}) as { autonomy?: Autonomy; limits?: Record<string, never>; verifyGeminiFlash?: boolean };
    if (chair.model !== undefined) p.chair.model = chair.model || undefined;
    if (chair.effort !== undefined) p.chair.effort = chair.effort || undefined;
    if (chair.directEdit !== undefined) p.chair.directEdit = Boolean(chair.directEdit) || undefined;
    if (members.autonomy) p.members.autonomy = members.autonomy;
    if (members.limits) p.members.limits = normalizeLimits(members.limits);
    if (members.verifyGeminiFlash !== undefined) p.members.verifyGeminiFlash = Boolean(members.verifyGeminiFlash);
    registry.save(p);
    // open agendas keep their own copy of the project object: update it in place
    for (const a of AgendaStore.list(p)) {
      const rtp = runtimes.get(`${p.id}/${a.slug}`);
      if (!rtp) continue;
      const rt = await rtp;
      Object.assign(rt.council.project, { name: p.name });
      Object.assign(rt.council.project.chair, { model: p.chair.model, effort: p.chair.effort });
      Object.assign(rt.council.project.members, { autonomy: p.members.autonomy, limits: p.members.limits });
      rt.chair.setOverrides({});
    }
    broadcast({ type: "overview" });
    return { ...p, scanSummary };
  });
  on("GET", "/api/models", () => ({
    providers: CLI_PROVIDERS.map((p) => ({ id: p, models: LADDERS[p].map(({ id, label, note }) => ({ id, label, note })), effort: SUPPORTS_EFFORT[p], efforts: EFFORTS.slice(0, EFFORTS.indexOf(EFFORT_CAP[p]) + 1) })),
    sites: WEB_SITES.map((s) => ({ id: s, ...SITE_INFO[s] })),
    efforts: EFFORTS,
    defaults: DEFAULT_LIMITS,
  }));
  on("GET", "/api/fs", async ({ url }) => listFolder(url.searchParams.get("path") ?? "", isRepo));
  on("GET", "/api/projects/:id/guidelines", ({ params }) => {
    const p = registry.get(params.id);
    if (!p) throw new HttpError(404, "unknown project");
    return { text: registry.guidelines(p), path: registry.guidelinesPath(p) };
  });
  on("PUT", "/api/projects/:id/guidelines", async ({ params, body }) => {
    const p = registry.get(params.id);
    if (!p) throw new HttpError(404, "unknown project");
    const b = await body();
    fs.writeFileSync(registry.guidelinesPath(p), String(b.text ?? ""), "utf8");
    return { ok: true };
  });
  on("PUT", "/api/projects/:id/chair", async ({ params, body }) => {
    const p = registry.get(params.id);
    if (!p) throw new HttpError(404, "unknown project");
    const b = await body();
    p.chair.model = (b.model as string) || undefined;
    p.chair.effort = (b.effort as string) || undefined;
    if (b.advisor !== undefined) p.chair.advisor = String(b.advisor);
    const accountChanged = b.account !== undefined && ((b.account as string) || undefined) !== p.chair.account;
    if (b.account !== undefined) p.chair.account = (b.account as string) || undefined;
    registry.save(p);
    for (const a of AgendaStore.list(p)) {
      const rt = runtimes.get(`${p.id}/${a.slug}`);
      if (rt)
        (await rt).setChair({
          model: p.chair.model ?? "",
          effort: p.chair.effort ?? "",
          advisor: p.chair.advisor,
          ...(accountChanged ? { account: p.chair.account ?? "" } : {}),
        });
    }
    broadcast({ type: "overview" });
    return p.chair;
  });

  // ---------- accounts ----------
  on("GET", "/api/accounts", () => accounts.list());
  on("GET", "/api/usage", async ({ url }) => {
    const force = url.searchParams.get("refresh") === "1";
    if (force || !usageCache || Date.now() - usageCache.at > USAGE_TTL) await refreshUsage();
    return usageCache ?? { at: 0, items: [] };
  });
  on("POST", "/api/accounts", async ({ body }) => {
    const b = await body();
    const id = String(b.id ?? "").trim();
    const provider = String(b.provider ?? "") as AccountProvider;
    if (!id || !(isCliProvider(provider) || isWebSite(provider))) throw new HttpError(400, "id and provider (claude|gemini|gpt|gemini-web|aistudio|chatgpt) required");
    const a = accounts.upsert({
      id,
      provider,
      configDir: b.configDir ? path.resolve(String(b.configDir)) : undefined,
      priority: b.priority !== undefined && b.priority !== "" ? Number(b.priority) : undefined,
      note: (b.note as string) || undefined,
    });
    broadcast({ type: "overview" });
    return a;
  });
  on("POST", "/api/accounts/:id/login", ({ params }) => {
    const a = accounts.get(params.id);
    if (!a) throw new HttpError(404, "unknown account");
    try {
      return { hint: openLoginWindow(a, accounts) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  on("POST", "/api/accounts/:id/reset", ({ params }) => {
    const a = accounts.markOk(params.id);
    broadcast({ type: "overview" });
    return a;
  });
  on("DELETE", "/api/accounts/:id", ({ params }) => {
    const ok = accounts.remove(params.id);
    broadcast({ type: "overview" });
    return { removed: ok };
  });
  on("POST", "/api/projects/:id/agendas", async ({ params, body }) => {
    const p = registry.get(params.id);
    if (!p) throw new HttpError(404, "unknown project");
    const b = await body();
    // a new agenda is just a new chat: the chair names it and sets goals from the first request
    const existing = AgendaStore.list(p).filter((a) => a.title.startsWith("새 안건")).length;
    const title = String(b.title ?? "").trim() || (existing ? `새 안건 ${existing + 1}` : "새 안건");
    const goals = Array.isArray(b.goals) ? b.goals.map(String).filter((g) => g.trim()) : [];
    const store = AgendaStore.create(p, title, goals);
    broadcast({ type: "overview" });
    return { ...store.agenda(), key: `${p.id}/${store.slug}` };
  });

  on("GET", "/api/a/:id/:slug", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    return { state: rt.state(), transcript: rt.transcript(), firstTurn: rt.isFirstTurn() };
  });
  on("POST", "/api/a/:id/:slug/chat", async ({ params, body }) => {
    const rt = await getRuntime(params.id, params.slug);
    const b = await body();
    if (rt.chair.isBusy()) throw new HttpError(409, "chair is busy");
    const message = String(b.message ?? "");
    const attachments = (Array.isArray(b.attachments) ? (b.attachments as Attachment[]) : []).filter((a) => a && typeof a.id === "string" && rt.attachmentPath(a.id));
    void rt.send(message, "user", attachments).catch((e) => log(`turn failed: ${(e as Error).message}`));
    return { started: true };
  });
  on("POST", "/api/a/:id/:slug/attachments", async ({ params, req, url }) => {
    const rt = await getRuntime(params.id, params.slug);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_UPLOAD) throw new HttpError(413, `file too large (max ${MAX_UPLOAD / 1024 / 1024}MB)`);
      chunks.push(c as Buffer);
    }
    const name = url.searchParams.get("name") ?? "file";
    const type = String(req.headers["content-type"] ?? "application/octet-stream");
    return rt.saveAttachment(name, type, Buffer.concat(chunks));
  });
  on("GET", "/api/a/:id/:slug/attachments/:file", async ({ params, res }) => {
    const rt = await getRuntime(params.id, params.slug);
    const p = rt.attachmentPath(params.file);
    if (!p) throw new HttpError(404, "not found");
    const ext = path.extname(p).toLowerCase();
    const types: Record<string, string> = { ...SHOW_TYPES, ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };
    const headers: Record<string, string> = { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" };
    // member-made HTML/SVG runs in an isolated sandbox: no access to this app's cookies or API
    if ([".html", ".htm", ".svg"].includes(ext)) headers["content-security-policy"] = "sandbox allow-scripts allow-popups";
    res.writeHead(200, headers);
    fs.createReadStream(p).pipe(res);
  });
  on("GET", "/api/a/:id/:slug/members/:mid", async ({ params, url }) => {
    const rt = await getRuntime(params.id, params.slug);
    return rt.council.memberInfo(params.mid, {
      tail: Number(url.searchParams.get("tail") ?? 0) || undefined,
      diff: url.searchParams.get("diff") === "1",
    });
  });
  on("POST", "/api/a/:id/:slug/members/:mid/merge", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    const r = await rt.council.merge(params.mid);
    broadcast({ key: rt.key, type: "state" });
    return r;
  });
  on("POST", "/api/a/:id/:slug/members/:mid/stop", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    return { stopped: rt.council.stopMember(params.mid) };
  });
  on("POST", "/api/a/:id/:slug/members/:mid/open-web", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    const m = rt.council.members().find((x) => x.id === params.mid);
    if (!m || m.provider !== "relay" || !m.site) throw new HttpError(400, "not a web relay member");
    try {
      openWebSite(m.site, m.account ? accounts.get(m.account) : undefined);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return { ok: true };
  });
  on("GET", "/api/a/:id/:slug/members/:mid/packet", async ({ params, res }) => {
    const rt = await getRuntime(params.id, params.slug);
    const text = rt.council.relayPacket(params.mid);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  });
  on("POST", "/api/a/:id/:slug/members/:mid/relay", async ({ params, body }) => {
    const rt = await getRuntime(params.id, params.slug);
    const b = await body();
    const m = await rt.council.relaySubmit(params.mid, { response: b.response as string | undefined, result: b.result as string | undefined });
    return { id: m.id, status: m.status, commits: m.commits, summary: m.result?.summary };
  });
  on("POST", "/api/a/:id/:slug/members/:mid/handover", async ({ params, body }) => {
    const rt = await getRuntime(params.id, params.slug);
    const b = await body();
    const m = await rt.council.handover(params.mid, {
      provider: (b.provider as CliProvider) || undefined,
      model: (b.model as string) || undefined,
      account: (b.account as string) || undefined,
      reason: (b.reason as string) || "manual (web)",
    });
    return { id: m.id, provider: m.provider, account: m.account, handoverFrom: m.handoverFrom };
  });
  on("POST", "/api/a/:id/:slug/reset", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    rt.resetChair();
    return { ok: true };
  });
  on("POST", "/api/a/:id/:slug/resume", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    const res = await rt.resume();
    broadcast({ type: "overview" });
    return res;
  });
  on("POST", "/api/a/:id/:slug/resume/dismiss", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    rt.dismissResume();
    return { ok: true };
  });
  on("POST", "/api/a/:id/:slug/retrospect", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    if (rt.chair.isBusy()) throw new HttpError(409, "chair is busy");
    const res = await rt.retrospect();
    return { ran: Boolean(res), isError: res?.isError ?? false, text: res?.text ?? "" };
  });
  on("POST", "/api/a/:id/:slug/finish/dismiss", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    rt.council.clearWaiting();
    return { ok: true };
  });
  on("POST", "/api/a/:id/:slug/merge-base", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    let out: string;
    try {
      out = await rt.council.mergeToBase("user");
    } catch (e) {
      throw new HttpError(409, `메인 반영 실패: ${(e as Error).message}`);
    }
    rt.council.store.appendTranscript({ role: "event", text: "[council event] 사용자가 지금까지의 안건 결과를 메인(베이스 브랜치)에 반영했다. 안건은 계속 열려 있다." });
    broadcast({ type: "overview" });
    return { ok: true, output: out, notIncluded: rt.council.unmergedMembers().map((m) => m.id) };
  });
  on("POST", "/api/a/:id/:slug/finish", async ({ params, body }) => {
    const rt = await getRuntime(params.id, params.slug);
    const b = await body();
    if (rt.council.runningCount()) throw new HttpError(409, "members still running");
    // every finish runs the chair's retrospective first (once per agenda); retro:false skips it
    let retro: string | undefined;
    if (b.retro !== false) {
      if (rt.chair.isBusy()) throw new HttpError(409, "chair is busy");
      const r = await rt.retrospectOnce();
      retro = r?.text;
    }
    const out = await rt.council.finish();
    rt.close({ closeMemory: false });
    runtimes.delete(rt.key);
    broadcast({ type: "overview" });
    void telegram?.finishFor(rt.key, `[${rt.key}] 안건 종료: 베이스 브랜치에 머지됨${retro ? "\n회고:\n" + retro.slice(0, 1500) : ""}`);
    return { ok: true, output: out, retro };
  });
  on("POST", "/api/a/:id/:slug/telegram-auto", async ({ params, body }) => {
    const b = await body();
    if (typeof b.on !== "boolean") throw new HttpError(400, "on (boolean) required");
    const rt = await getRuntime(params.id, params.slug);
    if (rt.council.store.agenda().status === "closed") throw new HttpError(409, "closed agenda");
    rt.council.setTelegramAuto(b.on);
    return { ok: true, telegramAuto: b.on };
  });
  on("GET", "/api/telegram", () => ({
    configured: Boolean(config.telegram),
    user: telegramUser,
    chatId: config.telegram?.chatId,
    agenda: config.telegram?.agenda,
    forumChatId: config.telegram?.forumChatId,
    topics: Object.keys(config.telegram?.topics ?? {}).length,
    autoNotify: Boolean(config.telegram?.autoNotify),
  }));
  on("DELETE", "/api/a/:id/:slug", async ({ params, url }) => {
    const { project, store } = findAgenda(params.id, params.slug);
    const key = `${project.id}/${store.slug}`;
    const p = runtimes.get(key);
    if (p) {
      const rt = await p;
      if (rt.chair.isBusy() || rt.council.runningCount()) throw new HttpError(409, "의장이나 위원이 작업 중입니다. 멈춘 뒤 삭제하세요.");
      rt.close({ closeMemory: false });
      runtimes.delete(key);
    }
    let res;
    try {
      res = await deleteAgenda(project, store, { force: url.searchParams.get("force") === "1" });
    } catch (e) {
      throw new HttpError(500, `삭제 실패: ${(e as Error).message}`);
    }
    broadcast({ type: "overview" });
    if (res.deleted) log(`deleted agenda ${key} -> ${res.movedTo}`);
    return res;
  });
  on("POST", "/api/a/:id/:slug/close", async ({ params }) => {
    const { project, store } = findAgenda(params.id, params.slug);
    const key = `${project.id}/${store.slug}`;
    const p = runtimes.get(key);
    if (p) {
      (await p).close({ closeMemory: false });
      runtimes.delete(key);
    }
    broadcast({ type: "overview" });
    return { ok: true };
  });

  on("GET", "/api/memory/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return [];
    return memory.search(q, {
      status: url.searchParams.get("all") === "1" ? "any" : "verified",
      type: (url.searchParams.get("type") as EntryType) || undefined,
      limit: 20,
    });
  });
  on("GET", "/api/memory/proposals", () => memory.list({ status: "proposed" }));
  on("GET", "/api/memory/curate", () => curate);
  on("POST", "/api/memory/curate", () => {
    if (curate.running) throw new HttpError(409, "already running");
    const pending = memory.list({ status: "proposed" }).length;
    curate = { kind: "proposals", running: true, startedAt: new Date().toISOString(), pending, steps: 0 };
    broadcast({ type: "curate", running: true });
    void runCurator({ onEvent: (e) => { if (e.kind === "tool") curate.steps = (curate.steps ?? 0) + 1; } }).then((r) => {
      memory.load();
      memory.writeIndex();
      curate = { kind: "proposals", running: false, startedAt: curate.startedAt, finishedAt: new Date().toISOString(), pending, steps: curate.steps, text: r.text, isError: r.isError, costUsd: r.costUsd };
      broadcast({ type: "curate", running: false, isError: r.isError });
      broadcast({ type: "overview" });
      log(`curator finished (${r.isError ? "error" : "ok"})`);
    });
    return curate;
  });
  // routine tidy: code picks new/edited entries, Opus looks only at those
  on("POST", "/api/memory/tidy", () => {
    if (curate.running) throw new HttpError(409, "already running");
    const projects = registry.list().map((p) => ({ key: projectMemoryKey(p), name: p.name }));
    const { candidates, remaining } = selectTidyCandidates(memory);
    const startedAt = new Date().toISOString();
    if (!candidates.length) {
      curate = { kind: "tidy", running: false, startedAt, finishedAt: startedAt, pending: 0, remaining: 0, steps: 0, text: "점검할 새 항목이나 바뀐 항목이 없습니다." };
      return curate;
    }
    curate = { kind: "tidy", running: true, startedAt, pending: candidates.length, remaining, steps: 0 };
    broadcast({ type: "curate", running: true });
    const before = verifiedHashes(memory);
    void runTidy(projects, candidates, { onEvent: (e) => { if (e.kind === "tool") curate.steps = (curate.steps ?? 0) + 1; } }).then((r) => {
      memory.load();
      memory.writeIndex();
      if (!r.isError) markReviewed(memory, { before, candidates: candidates.map((c) => c.id) });
      curate = { kind: "tidy", running: false, startedAt, finishedAt: new Date().toISOString(), pending: candidates.length, remaining, steps: curate.steps, text: r.text, isError: r.isError, costUsd: r.costUsd };
      broadcast({ type: "curate", running: false, isError: r.isError });
      broadcast({ type: "overview" });
      log(`memory tidy finished (${r.isError ? "error" : "ok"}, ${candidates.length} entries, ${remaining} left)`);
    });
    return curate;
  });
  // full check: Fable reads every verified entry
  on("POST", "/api/memory/reorganize", () => {
    if (curate.running) throw new HttpError(409, "already running");
    const pending = memory.list({ status: "verified" }).length;
    const projects = registry.list().map((p) => ({ key: projectMemoryKey(p), name: p.name }));
    curate = { kind: "reorganize", running: true, startedAt: new Date().toISOString(), pending, steps: 0 };
    const before = verifiedHashes(memory);
    broadcast({ type: "curate", running: true });
    const verifiedList = memory.list({ status: "verified" });
    const lens = verifiedList.map((m) => ({ title: m.title.length, body: memory.get(m.id)?.body.length ?? 0 }));
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    const stats = {
      entries: verifiedList.length,
      common: verifiedList.filter((m) => entryScope(m) === "common").length,
      project: verifiedList.filter((m) => entryScope(m) === "project").length,
      avgTitle: avg(lens.map((l) => l.title)),
      longTitles: lens.filter((l) => l.title > 60).length,
      avgBody: avg(lens.map((l) => l.body)),
      longBodies: lens.filter((l) => l.body > 1500).length,
      totalChars: lens.reduce((a, l) => a + l.title + l.body, 0),
    };
    void runReorganize(projects, { stats, onEvent: (e) => { if (e.kind === "tool") curate.steps = (curate.steps ?? 0) + 1; } }).then((r) => {
      memory.load();
      memory.writeIndex();
      if (!r.isError) markReviewed(memory, { before, all: true });
      curate = { kind: "reorganize", running: false, startedAt: curate.startedAt, finishedAt: new Date().toISOString(), pending, steps: curate.steps, text: r.text, isError: r.isError, costUsd: r.costUsd };
      broadcast({ type: "curate", running: false, isError: r.isError });
      broadcast({ type: "overview" });
      log(`memory reorganize finished (${r.isError ? "error" : "ok"})`);
    });
    return curate;
  });
  // delete every memory entry; the folder is backed up first and the tidy bookkeeping starts over
  on("POST", "/api/memory/clear", async ({ body }) => {
    const b = await body();
    if (b.confirm !== "전체 삭제") throw new HttpError(400, 'confirm must be "전체 삭제"');
    if (curate.running) throw new HttpError(409, "기억 정리가 진행 중입니다. 끝난 뒤에 지우세요.");
    const r = memory.clearAll();
    fs.rmSync(path.join(memory.root, "curator", "reviewed.json"), { force: true });
    log(`memory cleared: ${r.removed} entries, backup ${r.backup}`);
    broadcast({ type: "overview" });
    return r;
  });
  on("GET", "/api/memory/recent", () => memory.list({ status: "verified", limit: 30 }).map((m) => ({ ...m, scope: entryScope(m) })));
  on("GET", "/api/memory/stats", () => {
    const verified = memory.list({ status: "verified" });
    const common = verified.filter((m) => entryScope(m) === "common").length;
    const byProject: Record<string, number> = {};
    for (const m of verified) if (entryScope(m) === "project") byProject[m.project ?? "?"] = (byProject[m.project ?? "?"] ?? 0) + 1;
    return { verified: verified.length, common, byProject };
  });
  on("GET", "/api/memory/entry/:id", ({ params }) => {
    const e = memory.get(params.id);
    if (!e) throw new HttpError(404, "not found");
    return { ...e.meta, body: e.body };
  });
  on("POST", "/api/memory/entry/:id/approve", ({ params }) => memory.approve(params.id, { source: "web" }).meta);
  on("POST", "/api/memory/entry/:id/reject", async ({ params, body }) => memory.reject(params.id, String((await body()).reason ?? "")).meta);

  // ---------- http server ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    try {
      // browser login by link (desktop launcher / Tauri window): sets the cookie and redirects home
      if (url.pathname === "/auth") {
        if (!authorized(req, url)) throw new HttpError(401, "unauthorized");
        res.writeHead(302, {
          "set-cookie": `gc_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          location: "/",
        });
        res.end();
        return;
      }
      // member permission endpoint (autonomy "chair")
      const mm = /^\/mcp-member\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
      if (mm) {
        if (!authorized(req, url)) throw new HttpError(401, "unauthorized");
        const rt = await getRuntime(decodeURIComponent(mm[1]), decodeURIComponent(mm[2]));
        await handleMemberMcpRequest(rt.council, decodeURIComponent(mm[3]), req, res);
        return;
      }
      // chair MCP endpoints
      const mcp = /^\/mcp\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
      if (mcp) {
        if (!authorized(req, url)) throw new HttpError(401, "unauthorized");
        const rt = await getRuntime(decodeURIComponent(mcp[1]), decodeURIComponent(mcp[2]));
        await handleCouncilMcpRequest(rt.council, req, res);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname !== "/api/login" && !authorized(req, url)) throw new HttpError(401, "unauthorized");
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params: Params = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          const ctx: Ctx = {
            req,
            res,
            url,
            params,
            body: () =>
              new Promise((resolve, reject) => {
                let data = "";
                req.setEncoding("utf8");
                req.on("data", (c: string) => (data += c));
                req.on("end", () => {
                  try {
                    resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
                  } catch (e) {
                    reject(new HttpError(400, `bad json: ${(e as Error).message}`));
                  }
                });
                req.on("error", reject);
              }),
          };
          const out = await r.handler(ctx);
          if (!res.headersSent) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(out ?? null));
          }
          return;
        }
        throw new HttpError(404, `no route: ${method} ${url.pathname}`);
      }
      serveStatic(webDir, url.pathname, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`${method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  // ---------- websocket ----------
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !authorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
    });
  });
  const ping = setInterval(() => {
    for (const c of clients) if (c.readyState === c.OPEN) c.ping();
  }, 30_000);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(listenPort, config.host, resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) config.port = addr.port;
  const shownHost = config.host === "0.0.0.0" ? "localhost" : config.host;
  log(`listening on http://${shownHost}:${config.port} (web: ${fs.existsSync(webDir) ? webDir : "NOT BUILT - run npm run build:web"})`);

  // ---------- telegram ----------
  if (config.telegram?.botToken && config.telegram.chatId) {
    const tg = new TelegramBridge(config.telegram, {
      log,
      listAgendas: () =>
        registry.list().flatMap((p) => AgendaStore.list(p).map((a) => ({ key: `${p.id}/${a.slug}`, title: a.title, status: a.status }))),
      getRuntime: (key) => {
        const [id, slug] = key.split("/");
        return getRuntime(id, slug);
      },
      onBind: (key) => {
        config.telegram = { ...config.telegram!, agenda: key };
        saveServerConfig({ telegram: config.telegram });
      },
      onConfig: (patch) => {
        config.telegram = { ...config.telegram!, ...patch };
        saveServerConfig({ telegram: config.telegram });
      },
      // per-agenda automatic sending: read the agenda's own setting, written by the web button or /auto
      isAuto: (key) => {
        const [id, slug] = key.split("/");
        const project = registry.get(id);
        const store = project ? AgendaStore.find(project, slug) : undefined;
        return store?.agenda().telegramAuto !== false;
      },
      setAuto: async (key, on) => {
        const [id, slug] = key.split("/");
        (await getRuntime(id, slug)).council.setTelegramAuto(on);
      },
    });
    try {
      telegramUser = await tg.verify();
      telegram = tg;
      tg.start();
      log(`telegram bot @${telegramUser} connected (${config.telegram.autoNotify ? "auto notify forced on for all agendas" : "auto sending on by default per agenda (web button, /auto off); chair questions always"}; chat ${config.telegram.chatId}${config.telegram.agenda ? ", agenda " + config.telegram.agenda : ""}${config.telegram.forumChatId ? ", forum " + config.telegram.forumChatId : ""})`);
    } catch (e) {
      log(`telegram disabled: ${(e as Error).message}`);
    }
  }

  return {
    config,
    tailscale,
    telegram: telegramUser,
    url: `http://${shownHost}:${config.port}`,
    close: async () => {
      clearInterval(ping);
      telegram?.stop();
      for (const p of runtimes.values()) (await p).close({ closeMemory: false });
      runtimes.clear();
      memory.close();
      for (const c of clients) c.close();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function serveStatic(webDir: string, pathname: string, res: http.ServerResponse): void {
  if (!fs.existsSync(webDir)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("web app not built. run: npm run build:web");
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  let file = path.join(webDir, rel);
  if (!file.startsWith(webDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, "index.html"); // SPA fallback
  const ext = path.extname(file).toLowerCase();
  const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream" };
  headers["cache-control"] = ext === ".html" || file.endsWith("sw.js") ? "no-cache" : "public, max-age=31536000, immutable";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
