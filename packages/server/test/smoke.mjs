// Web server smoke test without any LLM: auth, project/agenda creation, runtime open, MCP endpoint, websocket.
import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { chairScope, memberScope, scopedToken, startServer } from "@gencouncil/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-web-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
sh(["init", "-q", "-b", "main"]);
sh(["config", "user.email", "t@t"]);
sh(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
sh(["add", "-A"]);
sh(["commit", "-q", "-m", "init"]);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const srv = await startServer({ port: 0, host: "127.0.0.1", token: "test-token", webDir: path.join(tmp, "nowhere"), log: () => {}, maxUploadBytes: 40 * 1024 * 1024 });
const base = srv.url.replace(/:\d+$/, "") + ":" + srv.config.port; // url uses config.port
const api = async (method, p, body, token = "test-token") => {
  const res = await fetch(`http://127.0.0.1:${srv.config.port}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
void base;

check("401 without token", (await api("GET", "/api/overview", undefined, "")).status === 401);
check("401 wrong token", (await api("GET", "/api/overview", undefined, "nope")).status === 401);
check("login sets cookie", (await api("POST", "/api/login", { token: "test-token" }, "")).status === 200);
check("static 503 when web not built", (await fetch(`http://127.0.0.1:${srv.config.port}/`)).status === 503);

const models = await api("GET", "/api/models");
const geminiModels = models.json.providers.find((p) => p.id === "gemini");
check("model API lists the four gemini tiers", geminiModels.models.map((m) => m.id).join() === "gemini-3.8-flash,gemini-4-hydrogen,gemini-4-neon,gemini-4-argon");
check("limits UI can select gemini xhigh", geminiModels.efforts.join() === "low,medium,high,xhigh" && models.json.defaults.gemini.maxEffort === "high" && models.json.defaults.gemini.maxModel === "gemini-4-argon");

const ov0 = await api("GET", "/api/overview");
check("overview empty", ov0.status === 200 && ov0.json.projects.length === 0 && ov0.json.memory.verified === 0);

const bad = await api("POST", "/api/projects", { name: "x", repo: path.join(tmp, "notrepo") });
check("project rejects non-repo", bad.status === 400, JSON.stringify(bad.json));
const proj = await api("POST", "/api/projects", { name: "웹 테스트", repo, chairModel: "claude-sonnet-5-5" });
check("project created", proj.status === 200 && proj.json.id === "웹-테스트-제작위원회", JSON.stringify(proj.json));
const ag = await api("POST", `/api/projects/${encodeURIComponent(proj.json.id)}/agendas`, { title: "첫 안건", goals: ["a.txt 수정", "b.txt 생성"] });
check("agenda created", ag.status === 200 && ag.json.key === "웹-테스트-제작위원회/첫-안건", JSON.stringify(ag.json));

const g = await api("GET", `/api/projects/${encodeURIComponent(proj.json.id)}/guidelines`);
check("guidelines readable", g.status === 200 && g.json.text.includes("분장"));
check("guidelines writable", (await api("PUT", `/api/projects/${encodeURIComponent(proj.json.id)}/guidelines`, { text: "# custom" })).status === 200);
check("guidelines persisted", (await api("GET", `/api/projects/${encodeURIComponent(proj.json.id)}/guidelines`)).json.text === "# custom");

const a = await api("GET", `/api/a/${encodeURIComponent(proj.json.id)}/${encodeURIComponent("첫-안건")}`);
check("agenda opens runtime", a.status === 200 && a.json.firstTurn === true && a.json.state.agenda.branch === "agenda/첫-안건", JSON.stringify(a.json).slice(0, 200));
check("integration worktree created", fs.existsSync(path.join(repo, ".worktrees", "첫-안건", "_integration", "a.txt")));
check("chair model from project", a.json.state.chair.model === "claude-sonnet-5-5");

const ov1 = await api("GET", "/api/overview");
check("overview shows open agenda", ov1.json.projects[0].agendas[0].open === true);

// chair MCP endpoint: tools/list over streamable http
const mcpUrl = `http://127.0.0.1:${srv.config.port}/mcp/${encodeURIComponent(proj.json.id)}/${encodeURIComponent("첫-안건")}`;
const mcpRes = await fetch(mcpUrl, {
  method: "POST",
  headers: { authorization: "Bearer test-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
const mcpText = await mcpRes.text();
check("mcp tools/list answers", mcpRes.status === 200 && mcpText.includes("council_assign") && mcpText.includes("council_finish"), mcpText.slice(0, 120));
check("mcp 401 without token", (await fetch(mcpUrl, { method: "POST" })).status === 401);

// scoped tokens: the chair's and a member's token open their own endpoint and nothing else
{
  const pid = proj.json.id;
  const slug = "첫-안건";
  const chairTok = scopedToken("test-token", chairScope(pid, slug));
  const memberTok = scopedToken("test-token", memberScope(pid, slug, "claude-1"));
  const list = (url, tok) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }).then((r) => r.status);
  const memberUrl = (mid) => `http://127.0.0.1:${srv.config.port}/mcp-member/${encodeURIComponent(pid)}/${encodeURIComponent(slug)}/${mid}`;
  check("chair token opens the chair endpoint", (await list(mcpUrl, chairTok)) === 200);
  check("member token is refused by the chair endpoint", (await list(mcpUrl, memberTok)) === 401);
  check("member token is refused by the web api", (await api("GET", "/api/overview", undefined, memberTok)).status === 401);
  check("chair token is refused by the web api", (await api("GET", "/api/overview", undefined, chairTok)).status === 401);
  check("member token is refused by another member's endpoint", (await list(memberUrl("claude-2"), memberTok)) === 401);
  check("member token passes its own endpoint's auth", (await list(memberUrl("claude-1"), memberTok)) !== 401);
  check("chair token is refused by another agenda's endpoint", (await list(mcpUrl.replace(encodeURIComponent(slug), "other"), chairTok)) === 401);
}

// memory endpoints
check("memory search empty ok", (await api("GET", "/api/memory/search?q=abc")).status === 200);

// websocket: receives hello, then a state broadcast after a merge-less action (chair PUT broadcasts overview)
const ws = new WebSocket(`ws://127.0.0.1:${srv.config.port}/ws?token=test-token`);
const msgs = [];
ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
const chairUrl = `/api/a/${encodeURIComponent(proj.json.id)}/${encodeURIComponent("첫-안건")}/chair`;
await api("PUT", chairUrl, { model: "claude-opus-5-5", effort: "high" });
await new Promise((r) => setTimeout(r, 300));
check("ws hello + overview broadcast", msgs.some((m) => m.type === "hello") && msgs.some((m) => m.type === "overview"), JSON.stringify(msgs.map((m) => m.type)));
const a2 = await api("GET", `/api/a/${encodeURIComponent(proj.json.id)}/${encodeURIComponent("첫-안건")}`);
check("chair change applied to open runtime", a2.json.state.chair.model === "claude-opus-5-5" && a2.json.state.chair.effort === "high");
// the chair belongs to the agenda: the project default and other agendas are untouched
const ov = await api("GET", "/api/overview");
const projAfter = (ov.json.projects ?? []).find((x) => x.id === proj.json.id);
check("project default chair untouched", projAfter?.chair?.model !== "claude-opus-5-5", JSON.stringify(projAfter?.chair));
const wsBad = new WebSocket(`ws://127.0.0.1:${srv.config.port}/ws?token=bad`);
const wsBadResult = await new Promise((resolve) => {
  wsBad.on("open", () => resolve("open"));
  wsBad.on("error", () => resolve("error"));
});
check("ws rejects bad token", wsBadResult === "error");
ws.close();

check("close agenda", (await api("POST", `/api/a/${encodeURIComponent(proj.json.id)}/${encodeURIComponent("첫-안건")}/close`)).status === 200);

// a new agenda is a blank chat; the chair names it and sets goals
const blank = await api("POST", `/api/projects/${encodeURIComponent(proj.json.id)}/agendas`, {});
check("blank agenda created", blank.status === 200 && blank.json.title === "새 안건" && blank.json.goals.length === 0, JSON.stringify(blank.json));
const blank2 = await api("POST", `/api/projects/${encodeURIComponent(proj.json.id)}/agendas`, {});
check("second blank agenda numbered", blank2.json.title === "새 안건 2", blank2.json.title);
const [bid, bslug] = blank.json.key.split("/");
await api("GET", `/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}`);
const setRes = await fetch(`http://127.0.0.1:${srv.config.port}/mcp/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}`, {
  method: "POST",
  headers: { authorization: "Bearer test-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "council_set_agenda", arguments: { title: "로그인 개선", goals: ["로그인 오류 수정", "테스트 추가"] } } }),
});
await setRes.text();
const after = await api("GET", `/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}`);
check("chair set title and goals", after.json.state.agenda.title === "로그인 개선" && after.json.state.agenda.goals.length === 2, JSON.stringify(after.json.state.agenda));

// per-agenda Telegram auto sending: on by default (unset), the API switches it, it lands in the state and agenda.json
check("telegramAuto is on by default", after.json.state.agenda.telegramAuto === true, JSON.stringify(after.json.state.agenda));
const taPath = `/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/telegram-auto`;
check("telegram-auto rejects a non-boolean", (await api("POST", taPath, { on: "yes" })).status === 400);
check("telegram-auto off", (await api("POST", taPath, { on: false })).status === 200 && (await api("GET", `/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}`)).json.state.agenda.telegramAuto === false);
check("telegram-auto on", (await api("POST", taPath, { on: true })).json.telegramAuto === true);
const taOn = await api("GET", `/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}`);
check("telegramAuto shows in the agenda state", taOn.json.state.agenda.telegramAuto === true, JSON.stringify(taOn.json.state.agenda));

// attachments: upload then read back
const upRes = await fetch(`http://127.0.0.1:${srv.config.port}/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments?name=${encodeURIComponent("사진 1.png")}`, {
  method: "POST",
  headers: { authorization: "Bearer test-token", "content-type": "image/png" },
  body: Buffer.from([137, 80, 78, 71, 1, 2, 3]),
});
const up = await upRes.json();
check("attachment uploaded", upRes.status === 200 && up.size === 7 && up.type === "image/png" && up.id.endsWith("사진 1.png"), JSON.stringify(up));
const getRes = await fetch(`http://127.0.0.1:${srv.config.port}/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments/${encodeURIComponent(up.id)}`, { headers: { authorization: "Bearer test-token" } });
check("attachment served", getRes.status === 200 && getRes.headers.get("content-type") === "image/png" && (await getRes.arrayBuffer()).byteLength === 7);
const missRes = await fetch(`http://127.0.0.1:${srv.config.port}/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments/${encodeURIComponent("../state.md")}`, { headers: { authorization: "Bearer test-token" } });
check("attachment path traversal blocked", missRes.status === 404);

// large upload streams to disk (30MB ok), over the limit gets a readable 413 JSON, no temp files left
const upUrl = `/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments?name=big.bin`;
const big = Buffer.alloc(30 * 1024 * 1024, 7);
const bigRes = await fetch(`http://127.0.0.1:${srv.config.port}${upUrl}`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "video/mp4" }, body: big });
const bigUp = await bigRes.json();
const bigGet = await fetch(`http://127.0.0.1:${srv.config.port}/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments/${encodeURIComponent(bigUp.id)}`, { headers: { authorization: "Bearer test-token" } });
check("30MB upload succeeds with exact size", bigRes.status === 200 && bigUp.size === big.length && (await bigGet.arrayBuffer()).byteLength === big.length, JSON.stringify(bigUp));
const overRes = await fetch(`http://127.0.0.1:${srv.config.port}${upUrl}`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "video/mp4" }, body: Buffer.alloc(41 * 1024 * 1024) });
const overJson = await overRes.json().catch(() => null);
check("over-limit upload (content-length) -> 413 JSON", overRes.status === 413 && /file too large/.test(overJson?.error ?? ""), `${overRes.status} ${JSON.stringify(overJson)}`);
const chunked = await new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: srv.config.port, path: upUrl, method: "POST", headers: { authorization: "Bearer test-token", "content-type": "video/mp4" } }, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  r.on("error", reject);
  const piece = Buffer.alloc(1024 * 1024, 1);
  for (let i = 0; i < 45; i++) r.write(piece);
  r.end();
});
check("over-limit upload (chunked) -> 413 JSON", chunked.status === 413 && /file too large/.test(JSON.parse(chunked.body).error), JSON.stringify(chunked));
const attDirs = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : /\.part$/.test(e.name) && attDirs.push(e.name); };
walk(tmp);
check("no temp upload files left behind", attDirs.length === 0, attDirs.join(","));
const htmlUp = await (await fetch(`http://127.0.0.1:${srv.config.port}/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments?name=${encodeURIComponent("mock.html")}`, {
  method: "POST",
  headers: { authorization: "Bearer test-token", "content-type": "text/html" },
  body: "<h1>시안</h1><script>fetch('/api/overview')</script>",
})).json();
const htmlRes = await fetch(`http://127.0.0.1:${srv.config.port}/api/a/${encodeURIComponent(bid)}/${encodeURIComponent(bslug)}/attachments/${encodeURIComponent(htmlUp.id)}`, { headers: { authorization: "Bearer test-token" } });
check("shown HTML is served sandboxed", htmlRes.status === 200 && /text\/html/.test(htmlRes.headers.get("content-type")) && /sandbox/.test(htmlRes.headers.get("content-security-policy") ?? "") && !/allow-same-origin/.test(htmlRes.headers.get("content-security-policy") ?? ""), htmlRes.headers.get("content-security-policy"));

// settings: rename and move to another folder
const ren = await api("PUT", `/api/projects/${encodeURIComponent(proj.json.id)}/settings`, { name: "웹 테스트 개정" });
check("rename keeps id, adds suffix", ren.status === 200 && ren.json.name === "웹 테스트 개정 제작위원회" && ren.json.id === proj.json.id, JSON.stringify(ren.json.name));
const other = path.join(tmp, "other folder");
fs.mkdirSync(other);
fs.writeFileSync(path.join(other, "x.txt"), "x\n");
const blockedMove = await api("PUT", `/api/projects/${encodeURIComponent(proj.json.id)}/settings`, { path: other });
check("folder change works when no agenda has work", blockedMove.status === 200 && blockedMove.json.repo === path.resolve(other) && blockedMove.json.localGit === true && /git으로 관리/.test(blockedMove.json.scanSummary ?? ""), JSON.stringify(blockedMove.json).slice(0, 200));
await srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall web checks passed");
process.exitCode = failed ? 1 : 0;
