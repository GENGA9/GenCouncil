// Smoke test: store round-trip + MCP server over stdio.
// Run: npm test   (uses an isolated GENCOUNCIL_HOME in the OS temp dir)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "@gencouncil/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(here, "../../mcp/dist/server.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-test-"));
process.env.GENCOUNCIL_HOME = home;

let failed = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
}

// ---- store ----
const store = new MemoryStore({ git: false });
await store.init();
const a = store.write({ type: "solution", title: "ffmpeg가 PATH에 없을 때 실행 경로", body: "## 문제\nnot found\n## 해결\nC:\\tools\\ffmpeg", tags: ["ffmpeg"] });
const p = store.propose({ type: "tool", title: "blender 렌더 명령", body: "blender -b x.blend -a", source: "gemini-cli" });
check("korean bigram search hits", store.search("ffmpeg 경로를")[0]?.id === a.meta.id);
check("proposed hidden by default", store.search("blender").length === 0);
check("proposed visible with status any", store.search("blender", { status: "any" })[0]?.id === p.meta.id);
store.approve(p.meta.id);
check("approve moves file", store.get(p.meta.id).file.includes(`${path.sep}tools${path.sep}`));
check("index lists both", store.renderIndex().includes(a.meta.id) && store.renderIndex().includes(p.meta.id));
const fresh = new MemoryStore({ git: false });
fresh.load();
check("reload from disk", fresh.size() === store.size(), `${fresh.size()} vs ${store.size()}`);

// ---- MCP over stdio ----
function rpc(role) {
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, GENCOUNCIL_ROLE: role, GENCOUNCIL_AGENT: "smoke" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      } catch {}
    }
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      waiters.set(msgId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { send, notify, close: () => child.kill() };
}

async function session(role, fn) {
  const c = rpc(role);
  try {
    const init = await c.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    check(`[${role}] initialize`, init.result?.serverInfo?.name === "gencouncil");
    c.notify("notifications/initialized", {});
    await fn(c);
  } finally {
    c.close();
  }
}

const call = (c, name, args) => c.send("tools/call", { name, arguments: args }).then((r) => r.result);

await session("member", async (c) => {
  const tools = (await c.send("tools/list", {})).result.tools.map((t) => t.name);
  check("[member] tools listed", tools.includes("memory_search") && tools.includes("memory_propose"), tools.join(","));
  const s = await call(c, "memory_search", { query: "ffmpeg" });
  check("[member] search finds entry", s.content[0].text.includes(a.meta.id));
  const w = await call(c, "memory_write", { type: "solution", title: "should be refused", body: "0123456789" });
  check("[member] write refused", w.isError === true);
  const pr = await call(c, "memory_propose", { type: "convention", title: "member proposal", body: "proposal body text" });
  check("[member] propose ok", !pr.isError && pr.content[0].text.startsWith("proposed "));
});

await session("owner", async (c) => {
  const list = JSON.parse((await call(c, "memory_list", { status: "proposed" })).content[0].text);
  check("[owner] sees member proposal", list.some((m) => m.title === "member proposal"));
  const ap = await call(c, "memory_approve", { id: list.find((m) => m.title === "member proposal").id });
  check("[owner] approve ok", !ap.isError);
  const idx = (await call(c, "memory_index", {})).content[0].text;
  check("[owner] index includes approved", idx.includes("member proposal"));
  const rd = JSON.parse((await call(c, "memory_read", { id: a.meta.id })).content[0].text);
  check("[owner] read returns body", rd.body.includes("C:\\tools\\ffmpeg"));
});

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
