import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, type EntryType } from "@gencouncil/core";
import {
  AccountRegistry,
  AgendaRuntime,
  AgendaStore,
  ProjectRegistry,
  currentBranch,
  handleCouncilMcpRequest,
  hasCommits,
  isRepo,
  type Autonomy,
  type CliProvider,
  type RuntimeEvent,
} from "@gencouncil/council";
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
        rt.on("event", (e: RuntimeEvent) => {
          broadcast({ key, ts: new Date().toISOString(), ...e });
          telegram?.notify(key, e);
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
              runningFamilies: [...new Set(running.map((m) => m.provider))],
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
    const repo = path.resolve(String(b.repo ?? ""));
    if (!name || !b.repo) throw new HttpError(400, "name and repo required");
    if (!(await isRepo(repo))) throw new HttpError(400, `not a git repository: ${repo}`);
    if (!(await hasCommits(repo))) throw new HttpError(400, `repository has no commits yet: ${repo}`);
    const p = registry.add({
      name,
      repo,
      baseBranch: (b.baseBranch as string) || (await currentBranch(repo)),
      chairModel: (b.chairModel as string) || undefined,
      chairEffort: (b.chairEffort as string) || undefined,
      chairAdvisor: b.chairAdvisor !== undefined ? String(b.chairAdvisor) : undefined,
      claudeModel: (b.claudeModel as string) || undefined,
      claudeAdvisor: b.claudeAdvisor !== undefined ? String(b.claudeAdvisor) : undefined,
      autonomy: (b.autonomy as Autonomy) || undefined,
      defaultProvider: (b.defaultProvider as CliProvider) || undefined,
      chairAccount: (b.chairAccount as string) || undefined,
    });
    broadcast({ type: "overview" });
    return p;
  });
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
  on("POST", "/api/accounts", async ({ body }) => {
    const b = await body();
    const id = String(b.id ?? "").trim();
    const provider = b.provider as CliProvider;
    if (!id || !["claude", "gemini"].includes(provider)) throw new HttpError(400, "id and provider (claude|gemini) required");
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
    const title = String(b.title ?? "").trim();
    if (!title) throw new HttpError(400, "title required");
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
    void rt.send(message).catch((e) => log(`turn failed: ${(e as Error).message}`));
    return { started: true };
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
  on("POST", "/api/a/:id/:slug/retrospect", async ({ params }) => {
    const rt = await getRuntime(params.id, params.slug);
    if (rt.chair.isBusy()) throw new HttpError(409, "chair is busy");
    const res = await rt.retrospect();
    return { ran: Boolean(res), isError: res?.isError ?? false, text: res?.text ?? "" };
  });
  on("POST", "/api/a/:id/:slug/finish", async ({ params, body }) => {
    const rt = await getRuntime(params.id, params.slug);
    const b = await body();
    if (rt.council.runningCount()) throw new HttpError(409, "members still running");
    let retro: string | undefined;
    if (b.retro) {
      if (rt.chair.isBusy()) throw new HttpError(409, "chair is busy");
      const r = await rt.retrospect();
      retro = r?.text;
    }
    const out = await rt.council.finish();
    rt.close({ closeMemory: false });
    runtimes.delete(rt.key);
    broadcast({ type: "overview" });
    void telegram?.send(`[${rt.key}] 안건 종료: 베이스 브랜치에 머지됨${retro ? "\n회고:\n" + retro.slice(0, 1500) : ""}`);
    return { ok: true, output: out, retro };
  });
  on("GET", "/api/telegram", () => ({
    configured: Boolean(config.telegram),
    user: telegramUser,
    chatId: config.telegram?.chatId,
    agenda: config.telegram?.agenda,
  }));
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
  on("GET", "/api/memory/recent", () => memory.list({ status: "verified", limit: 30 }));
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
    });
    try {
      telegramUser = await tg.verify();
      telegram = tg;
      tg.start();
      log(`telegram bot @${telegramUser} connected (chat ${config.telegram.chatId}${config.telegram.agenda ? ", agenda " + config.telegram.agenda : ""})`);
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
