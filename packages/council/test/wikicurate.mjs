// Memory settles into the wiki: the registration batch, the change review since the last check,
// and the owner tools that mark entries moved and cap cleanup deletions. No LLM.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-wikicur-"));
process.env.GENCOUNCIL_HOME = home;
const { MemoryStore, WikiStore } = await import("@gencouncil/core");
const { selectWikiInbox, wikiChanges, saveWikiReviewed, wikiRegisterPrompt, wikiReviewPrompt } = await import("@gencouncil/council");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const store = new MemoryStore();
await store.init();
const wiki = new WikiStore();
await wiki.init();
const v1 = store.write({ title: "ComfyUI 메모리 비우기", type: "tool", body: "/free 를 부른다" });
const v2 = store.write({ title: "H3 영상 잡 순서", type: "solution", body: "jobs.json 먼저", project: "h3_studio" });
const p1 = store.propose({ title: "ComfyUI 큐 확인", type: "tool", body: "/queue 가 비었는지 본다" });
const editProp = store.propose({ title: "위키 수정: common/comfyui — 포트가 바뀜", type: "solution", body: "이제 8189", tags: ["wiki:common/comfyui"] });

// ---- registration batch: proposals first, then pre-wiki memory ----
const inbox = selectWikiInbox(store, 3);
check("batch takes proposals first", inbox.proposals.length === 2 && inbox.proposals[0].meta.id === p1.meta.id);
check("batch fills with pre-wiki memory and counts the rest", inbox.entries.length === 1 && inbox.remaining === 1, `${inbox.entries.length}/${inbox.remaining}`);
const rp = wikiRegisterPrompt([{ key: "h3_studio", name: "H3" }], selectWikiInbox(store), wiki.renderToc());
check("register prompt lists every item and says how to mark them", [v1, v2, p1, editProp].every((e) => rp.includes(e.meta.id)) && rp.includes("memory_to_wiki"));
check("wiki edit proposals are shown with their page", rp.includes(`${editProp.meta.id} [위키 수정 제안 → common/comfyui]`));

// ---- review: first check sees the whole wiki, later checks only the changes ----
await wiki.write("common/comfyui", { title: "ComfyUI", summary: "로컬 생성", body: "## 방법\n- /free 로 메모리 비우기", sources: [v1.meta.id] }, "editor");
let ch = await wikiChanges();
check("first review sees every page", ch.files.length === 1 && ch.files[0].path === "common/comfyui" && ch.diff.includes("/free"), JSON.stringify(ch.files));
saveWikiReviewed(ch.head);
ch = await wikiChanges();
check("nothing changed right after a review", ch.files.length === 0);
await wiki.write("projects/h3_studio/video-jobs", { title: "H3 영상 잡", summary: "순서", body: "jobs.json을 먼저 만든다" }, "claude-1");
fs.appendFileSync(path.join(wiki.dir, "common", "comfyui.md"), "- 사용자가 파일을 직접 고침\n");
ch = await wikiChanges();
check("review sees tool edits and hand edits since the last check", ch.files.map((f) => f.path).sort().join(",") === "common/comfyui,projects/h3_studio/video-jobs", JSON.stringify(ch.files));
const rv = wikiReviewPrompt([{ key: "h3_studio", name: "H3" }], ch, wiki.renderToc(), wiki.list(), 3);
check("review prompt has both parts: change review and cleanup", rv.includes("1부") && rv.includes("2부") && rv.includes("직접 고침") && rv.includes("최대 3개"));
const quiet = wikiReviewPrompt([], { ...ch, files: [], diff: "" }, "", wiki.list(), 3);
check("with no changes the review still does the cleanup", quiet.includes("1부는 건너뛰고 2부만"));
check("cleanup flags pages of unregistered projects", wikiReviewPrompt([], ch, "", wiki.list()).includes("등록되지 않은 프로젝트"));

// ---- owner MCP tools: memory_to_wiki and the removal cap ----
const serverJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp/dist/server.js");
function rpc(env) {
  const child = spawn(process.execPath, [serverJs], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
        if (waiters.has(msg.id)) waiters.get(msg.id)(msg);
      } catch {}
    }
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiters.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      setTimeout(() => reject(new Error("timeout " + method)), 8000);
    });
  return { send, close: () => child.kill() };
}
const c = rpc({ GENCOUNCIL_ROLE: "owner", GENCOUNCIL_AGENT: "test", GENCOUNCIL_WIKI_REMOVE_BUDGET: "1" });
await c.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
const call = async (name, args) => (await c.send("tools/call", { name, arguments: args })).result;

const notListed = await call("memory_to_wiki", { id: p1.meta.id, path: "common/comfyui" });
check("memory_to_wiki refuses when the page does not list the id", notListed.isError && /sources/.test(notListed.content[0].text), notListed.content[0].text);
await call("wiki_write", { path: "common/comfyui", title: "ComfyUI", summary: "로컬 생성", body: "## 방법\n- /queue 확인 뒤 생성\n- /free 로 메모리 비우기", sources: [p1.meta.id] });
check("rewrite keeps earlier sources", (wiki.read("common/comfyui")?.sources ?? []).join(",") === [v1.meta.id, p1.meta.id].join(","), JSON.stringify(wiki.read("common/comfyui")?.sources));
const moved = await call("memory_to_wiki", { id: p1.meta.id, path: "common/comfyui" });
const movedV = await call("memory_to_wiki", { id: v1.meta.id, path: "common/comfyui" });
check("proposal and memory entry marked as moved", !moved.isError && !movedV.isError, moved.content[0].text + " / " + movedV.content[0].text);
const fresh = new MemoryStore({ git: false });
fresh.load();
check("moved entries leave the inbox with the wiki path recorded", fresh.get(p1.meta.id).meta.status === "rejected" && fresh.get(v1.meta.id).meta.status === "rejected" && selectWikiInbox(fresh, 99).entries.every((e) => e.meta.id !== v1.meta.id));

await call("wiki_write", { path: "common/old-a", title: "옛 페이지 A", summary: "이제 안 쓰는 방법", body: "더 이상 안 쓰는 방법이다" });
await call("wiki_write", { path: "common/old-b", title: "옛 페이지 B", summary: "이제 안 쓰는 방법", body: "더 이상 안 쓰는 방법이다" });
await call("wiki_write", { path: "common/dup", title: "중복", summary: "합칠 중복 페이지", body: "comfyui 페이지와 같은 내용" });
const r1 = await call("wiki_remove", { path: "common/old-a", reason: "정리: 안 쓰는 방법" });
const r2 = await call("wiki_remove", { path: "common/old-b", reason: "정리: 안 쓰는 방법" });
const r3 = await call("wiki_remove", { path: "common/dup", reason: "통합: common/comfyui" });
check("cleanup removal allowed up to the cap", !r1.isError, r1.content[0].text);
check("cleanup removal beyond the cap refused", r2.isError && /까지만/.test(r2.content[0].text), r2.content[0].text);
check("merge removal not counted against the cap", !r3.isError, r3.content[0].text);
c.close();

// ---- members drill down: a long page shows its outline first, then one section ----
const longBody = "## 언제 쓰나\n" + "설명 문장. ".repeat(600) + "\n## 방법\n- /queue 확인 뒤 /prompt\n## 주의할 점\n- 생성 중 /free 금지";
await wiki.write("common/comfyui/long-guide", { title: "긴 안내", summary: "긴 페이지", body: longBody }, "editor");
const mem = rpc({ GENCOUNCIL_ROLE: "member", GENCOUNCIL_AGENT: "test-member", GENCOUNCIL_PROJECT: "h3_studio" });
await mem.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
const mcall = async (name, args) => (await mem.send("tools/call", { name, arguments: args })).result.content[0].text;
const outline = await mcall("wiki_read", { path: "common/comfyui/long-guide" });
check("member sees only the outline of a long page", outline.includes("목차만") && outline.includes("- 방법 (") && !outline.includes("설명 문장. 설명 문장. 설명 문장."), outline.slice(0, 300));
const sec = await mcall("wiki_read", { path: "common/comfyui/long-guide", section: "방법" });
check("member reads one section", sec.includes("/queue 확인 뒤 /prompt") && !sec.includes("생성 중 /free"), sec);
const tocRoot = await mcall("wiki_toc", {});
const tocCommon = await mcall("wiki_toc", { path: "common" });
check("wiki_toc goes one level at a time", !tocRoot.includes("long-guide") && tocCommon.includes("common/comfyui/") && !tocCommon.includes("long-guide"), tocRoot + " | " + tocCommon);
mem.close();

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall wiki curation checks passed");
process.exitCode = failed ? 1 : 0;
