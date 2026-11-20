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
  check("[member] wiki: read and propose only", ["wiki_toc", "wiki_search", "wiki_read", "wiki_propose"].every((t) => tools.includes(t)) && !tools.includes("wiki_write") && !tools.includes("wiki_remove"));
  const wp = await call(c, "wiki_propose", { path: "Projects/Seisen/Build", change: "빌드 명령이 바뀜", body: "예전: npm run b\n이제: npm run build:all" });
  check("[member] wiki_propose ok", !wp.isError && /projects\/seisen\/build/.test(wp.content[0].text), wp.content[0].text);
  const bad = await call(c, "wiki_propose", { path: "../x", change: "경로 밖 제안", body: "0123456789 본문" });
  check("[member] wiki path outside the layout refused", bad.isError === true);
});

await session("owner", async (c) => {
  const list = JSON.parse((await call(c, "memory_list", { status: "proposed" })).content[0].text);
  check("[owner] sees member proposal", list.some((m) => m.title === "member proposal"));
  const wikiProp = list.find((m) => m.title.startsWith("위키 수정: projects/seisen/build"));
  check("[owner] wiki edit proposal carries its page and project", Boolean(wikiProp) && wikiProp.tags.includes("wiki:projects/seisen/build") && wikiProp.project === "seisen", JSON.stringify(wikiProp));
  const ap = await call(c, "memory_approve", { id: list.find((m) => m.title === "member proposal").id });
  check("[owner] approve ok", !ap.isError);
  const idx = (await call(c, "memory_index", {})).content[0].text;
  check("[owner] index includes approved", idx.includes("member proposal"));
  const rd = JSON.parse((await call(c, "memory_read", { id: a.meta.id })).content[0].text);
  check("[owner] read returns body", rd.body.includes("C:\\tools\\ffmpeg"));
});

// ---- a curator run can only merge/delete so many entries; splits are free ----
process.env.GENCOUNCIL_RETIRE_BUDGET = "1";
await session("owner", async (c) => {
  const w = async (title) => JSON.parse(JSON.stringify((await call(c, "memory_write", { title, type: "tool", body: "본문 열 글자 이상입니다" })).content[0].text)).match(/written (\S+)/)[1];
  const e1 = await w("예산 시험 하나");
  const e2 = await w("예산 시험 둘");
  const e3 = await w("예산 시험 셋");
  check("[budget] first merge allowed", !(await call(c, "memory_retire", { id: e1, reason: "중복: 둘", merged_into: e2 })).isError);
  const second = await call(c, "memory_retire", { id: e3, reason: "중복: 둘", merged_into: e2 });
  check("[budget] merge beyond the cap refused", second.isError && /까지만/.test(second.content[0].text), second.content[0].text);
  await w("예산 시험 셋 A");
  await w("예산 시험 셋 B");
  check("[budget] split after writing its parts still allowed", !(await call(c, "memory_retire", { id: e3, reason: "분할: 셋 A, 셋 B" })).isError);
});
process.env.GENCOUNCIL_PRUNE_BUDGET = "1";
await session("owner", async (c) => {
  const w = async (title) => (await call(c, "memory_write", { title, type: "solution", body: "본문 열 글자 이상입니다" })).content[0].text.match(/written (\S+)/)[1];
  const a = await w("일회성 시험 하나");
  const b = await w("일회성 시험 둘");
  const d = await w("일회성 시험 셋");
  const first = await call(c, "memory_retire", { id: a, reason: "일회성: 버그 수정 기록" });
  check("[prune] one-off cut allowed", !first.isError, first.content[0].text);
  const over = await call(c, "memory_retire", { id: b, reason: "일회성: 버그 수정 기록" });
  check("[prune] cut beyond the cap refused", over.isError && /일회성/.test(over.content[0].text), over.content[0].text);
  const merge = await call(c, "memory_retire", { id: d, reason: "중복: 둘", merged_into: b });
  check("[prune] cuts do not spend the merge budget", !merge.isError, merge.content[0].text);
});
await session("owner", async (c) => {
  const w = async (title) => (await call(c, "memory_write", { title, type: "solution", body: "본문 열 글자 이상입니다" })).content[0].text.match(/written (\S+)/)[1];
  const oldA = await w("대체 시험 옛 방법");
  const newA = await w("대체 시험 새 방법");
  const oldB = await w("대체 시험 옛 방법 둘");
  const x = await w("대체 시험 중복");
  const y = await w("대체 시험 중복 남김");
  const sup = await call(c, "memory_retire", { id: oldA, reason: "대체됨: 옵션 이름이 바뀜", merged_into: newA });
  check("[supersede] old solution folded into the new one", !sup.isError, sup.content[0].text);
  const merge = await call(c, "memory_retire", { id: x, reason: "중복: 남김", merged_into: y });
  check("[supersede] does not spend the merge budget", !merge.isError, merge.content[0].text);
  const over = await call(c, "memory_retire", { id: oldB, reason: "대체됨: 또 바뀜", merged_into: newA });
  check("[supersede] shares the one-off cap", over.isError && /대체/.test(over.content[0].text), over.content[0].text);
});
delete process.env.GENCOUNCIL_PRUNE_BUDGET;
delete process.env.GENCOUNCIL_RETIRE_BUDGET;

// ---- scope: common vs project knowledge ----
const scoped = new MemoryStore({ git: false });
await scoped.init();
const common = scoped.write({ title: "ace-step으로 음원 만들기", type: "tool", body: "공통 도구 폴더의 ace-step을 실행한다." });
const proj = scoped.write({ title: "seisen 84:A370 wR2 의미", type: "solution", body: "진영 슬롯 번호", project: "seisen" });
const other = scoped.write({ title: "강화게임 스킬 칸 제한", type: "solution", body: "skillLevel에서 막는다", project: "card_game" });
check("no project -> common by default", common.meta.scope === "common");
check("project set -> project scope by default", proj.meta.scope === "project");
const idxSeisen = scoped.renderIndex({ project: "SEISEN" });
check("project index: own project first, then common, others left out", idxSeisen.indexOf("84:A370") < idxSeisen.indexOf("ace-step") && !idxSeisen.includes("강화게임") && /다른 프로젝트 전용 1개/.test(idxSeisen), idxSeisen);
const idxAll = scoped.renderIndex();
check("index without project: common first", idxAll.indexOf("ace-step") < idxAll.indexOf("84:A370"));
check("index lines carry no tags", !/\]\s*$/m.test(scoped.renderIndex({ project: "seisen" }).split("\n").filter((l) => l.startsWith("- ")).join("\n")));
const promoted = scoped.update(other.meta.id, { scope: "common", title: "스킬 칸 제한은 레벨 검사 한 곳에서 막는다" });
check("update can promote to common and keeps origin project", promoted.meta.scope === "common" && promoted.meta.project === "card_game");
check("search filters by scope", scoped.search("스킬 칸", { scope: "common" }).length === 1 && scoped.search("스킬 칸", { scope: "project" }).length === 0);
const dup = scoped.write({ title: "ace-step 실행법 (중복)", type: "tool", body: "같은 내용" });
const retired = scoped.retire(dup.meta.id, "중복", common.meta.id);
check("retire merges into another entry", retired.meta.status === "rejected" && retired.meta.mergedInto === common.meta.id && !scoped.list({ status: "verified" }).some((m) => m.id === dup.meta.id));
check("retire refuses unknown merge target", (() => { try { scoped.retire(proj.meta.id, "x", "nope"); return false; } catch { return true; } })());
const reread = new MemoryStore({ git: false });
await reread.init();
check("scope survives reload", reread.get(promoted.meta.id)?.meta.scope === "common" && reread.get(proj.meta.id)?.meta.scope === "project");

// a file dropped into proposals/ by hand is a proposal, whatever its status line says
for (const [id, statusLine] of [["drop-nostatus", ""], ["drop-claims", "status: verified\n"]]) {
  fs.writeFileSync(path.join(reread.dir, "proposals", `${id}.md`), `---\nid: ${id}\ntitle: 몰래 넣은 항목 ${id}\ntype: solution\n${statusLine}---\n본문\n`);
}
reread.load();
check("a dropped proposal without status stays proposed", reread.get("drop-nostatus")?.meta.status === "proposed");
check("a dropped proposal claiming verified stays proposed", reread.get("drop-claims")?.meta.status === "proposed");
check("dropped proposals are not in the verified list", !reread.list({ status: "verified" }).some((m) => m.id.startsWith("drop-")));
reread.remove("drop-nostatus");
reread.remove("drop-claims");

// clearAll: everything goes, a backup copy stays
const before = reread.size();
reread.propose({ type: "tool", title: "지울 제안", body: "x" });
const cleared = reread.clearAll();
check("clearAll removes every entry", reread.size() === 0 && cleared.removed === before + 1, JSON.stringify(cleared));
check("clearAll keeps a backup", fs.existsSync(cleared.backup) && fs.readdirSync(path.join(cleared.backup, "proposals")).length >= 1);
check("index empty after clear", !reread.renderIndex().includes(promoted.meta.id));
check("clear survives reload", (() => { const r = new MemoryStore({ git: false }); r.load(); return r.size() === 0; })());

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exitCode = failed ? 1 : 0;
