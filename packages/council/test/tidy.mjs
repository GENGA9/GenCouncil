// Incremental memory tidy: code picks new/edited/oversized entries; the model sees only those.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-tidy-"));
process.env.GENCOUNCIL_HOME = home;
const { MemoryStore } = await import("@gencouncil/core");
const { selectTidyCandidates, markReviewed, verifiedHashes, tidyPrompt, reorganizePrompt, curatorPrompt, loadReviewed } = await import("@gencouncil/council");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const store = new MemoryStore({ git: false });
await store.init();
const ok = store.write({ title: "ffmpeg 경로 찾기", type: "tool", body: "## 해결\n- C:\\tools\\ffmpeg" });
const long = store.write({ title: "긴 본문 항목", type: "tool", body: "가".repeat(900) });
const bundled = store.write({ title: "A 설정 · B 설정 · C 설정 · D 설정", type: "tool", body: "여러 주제" });

// first run: every existing entry counts as seen
let sel = selectTidyCandidates(store);
check("bootstrap picks nothing", sel.candidates.length === 0, sel.candidates.map((c) => c.id).join(","));
check("reviewed file written", loadReviewed() !== null);

// an edit makes an entry due, and size problems are named
store.update(long.meta.id, { body: "나".repeat(900) });
store.update(bundled.meta.id, { body: "여러 주제 (바뀜)" });
sel = selectTidyCandidates(store);
const ids = sel.candidates.map((c) => c.id);
check("edited oversized and bundled entries picked", ids.includes(long.meta.id) && ids.includes(bundled.meta.id), ids.join(","));
check("reasons name the problem", sel.candidates.find((c) => c.id === long.meta.id).reasons.some((r) => r.startsWith("본문")) && sel.candidates.find((c) => c.id === bundled.meta.id).reasons.includes("제목에 여러 주제"));

// after a run, candidates and anything the run touched are seen
const before = verifiedHashes(store);
store.update(bundled.meta.id, { title: "A 설정" });
markReviewed(store, { before, candidates: ids });
sel = selectTidyCandidates(store);
check("nothing due after a run", sel.candidates.length === 0, JSON.stringify(sel.candidates));

// new and edited entries come back, with similar entries for the duplicate check
const dup = store.write({ title: "ffmpeg 실행 경로", type: "tool", body: "C:\\tools\\ffmpeg\\bin" });
store.update(ok.meta.id, { body: "## 해결\n- C:\\tools\\ffmpeg (바뀜)" });
sel = selectTidyCandidates(store);
const byId = Object.fromEntries(sel.candidates.map((c) => [c.id, c]));
check("new entry picked", byId[dup.meta.id]?.reasons[0] === "새 항목");
check("edited entry picked", byId[ok.meta.id]?.reasons[0] === "바뀐 항목");
check("similar entries listed", byId[dup.meta.id]?.similar.some((s) => s.id === ok.meta.id), JSON.stringify(byId[dup.meta.id]?.similar));

// batch limit
for (let i = 0; i < 5; i++) store.write({ title: `추가 항목 ${i}`, type: "tool", body: "짧은 본문" });
sel = selectTidyCandidates(store, 3);
check("batch limit keeps the rest for later", sel.candidates.length === 3 && sel.remaining === 4, `${sel.candidates.length} / ${sel.remaining}`);

const prompt = tidyPrompt([{ key: "demo", name: "Demo" }], sel.candidates, 3);
check("prompt lists only the candidates", sel.candidates.every((c) => prompt.includes(c.id)) && !prompt.includes(long.meta.id));

check("every memory pass applies the one-off test", [prompt, reorganizePrompt([], undefined, 5, 8), curatorPrompt()].every((p) => p.includes("남길 가치 기준") && p.includes("일회성")));
check("full check and tidy fold old solutions into the newer entry", [reorganizePrompt([], undefined, 5, 8), prompt].every((p) => p.includes('"대체됨: <무엇이 바뀌었나 한 줄>"') && p.includes("updated 날짜") && p.includes("확인 필요")));
check("full check shrinks the total every run", reorganizePrompt([], undefined, 5, 8).includes("전체 글자 수가 정리 전보다 줄어야"));
check("full check says how to cut and its cap", reorganizePrompt([], undefined, 5, 8).includes('"일회성: <한 줄 이유>"') && reorganizePrompt([], undefined, 5, 8).includes("최대 8개"));

// full check marks everything
markReviewed(store, { before: verifiedHashes(store), all: true });
check("full check marks all", selectTidyCandidates(store).candidates.length === 0);

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall tidy checks passed");
process.exitCode = failed ? 1 : 0;
