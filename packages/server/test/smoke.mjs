// Web server smoke test without any LLM: auth, project/agenda creation, runtime open, MCP endpoint, websocket.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startServer } from "@gencouncil/server";

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

const srv = await startServer({ port: 0, host: "127.0.0.1", token: "test-token", webDir: path.join(tmp, "nowhere"), log: () => {} });
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
await api("PUT", `/api/projects/${encodeURIComponent(proj.json.id)}/chair`, { model: "claude-opus-5-5", effort: "high" });
await new Promise((r) => setTimeout(r, 300));
check("ws hello + overview broadcast", msgs.some((m) => m.type === "hello") && msgs.some((m) => m.type === "overview"), JSON.stringify(msgs.map((m) => m.type)));
const a2 = await api("GET", `/api/a/${encodeURIComponent(proj.json.id)}/${encodeURIComponent("첫-안건")}`);
check("chair change applied to open runtime", a2.json.state.chair.model === "claude-opus-5-5" && a2.json.state.chair.effort === "high");
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
