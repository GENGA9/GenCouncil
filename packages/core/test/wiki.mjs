// Gen Wiki: page layout rules, write/read/search, contents list per project, git history.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-wiki-"));
process.env.GENCOUNCIL_HOME = home;
const { WikiStore, normalizeWikiPath } = await import("@gencouncil/core");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

check("path normalised", normalizeWikiPath("Projects\\Video_studio\\Video Jobs.md") === "projects/video_studio/video-jobs");
check("path outside the layout refused", throws(() => normalizeWikiPath("../secret")) && throws(() => normalizeWikiPath("misc/page")) && throws(() => normalizeWikiPath("common/a/b/c")) && throws(() => normalizeWikiPath("models/a/b")) && throws(() => normalizeWikiPath("projects/h3")) && throws(() => normalizeWikiPath("projects/h3/a/b/c")));
check("one topic folder allowed under common and projects", normalizeWikiPath("common/ComfyUI/SAM3 mask") === "common/comfyui/sam3-mask" && normalizeWikiPath("projects/video_studio/video/chain-jobs") === "projects/video_studio/video/chain-jobs");

const wiki = new WikiStore();
await wiki.init();
check("layout created", ["common", "models", "projects"].every((d) => fs.existsSync(path.join(wiki.dir, d))) && fs.existsSync(path.join(wiki.dir, "README.md")));

await wiki.write("common/comfyui", { title: "ComfyUI 쓰는 법", summary: "로컬 ComfyUI로 이미지·영상 만들기", body: "## 언제\n이미지가 필요할 때\n\n## 방법\n- 8188 포트 API\n- 끝나면 /free 로 메모리 비우기" }, "claude-1", "첫 작성");
await wiki.write("models/claude-sonnet", { title: "Claude Sonnet", summary: "범위가 분명한 절차 작업", body: "강점: 선례 본뜬 확장\n약점: 검증 보고 실수" }, "chair");
await wiki.write("projects/video_studio/video-jobs", { title: "영상 잡", summary: "구간별 영상 생성 순서", body: "jobs.json을 만들고 ComfyUI로 돌린다.", sources: ["sol-1"] }, "claude-2");
await wiki.write("projects/card_game/balance", { title: "밸런스 기준", summary: "적정 레벨", body: "코드 기준으로 맞춘다. 문서 수치는 낡았다." }, "user");

const page = wiki.read("common/comfyui");
check("page reads back", page?.title === "ComfyUI 쓰는 법" && page.by === "claude-1" && page.body.includes("/free"));
check("short body refused", await wiki.write("common/x", { title: "x", body: "짧음" }, "u").then(() => false, () => true));

const toc = wiki.renderToc({ project: "video_studio" });
check("toc: own project first, common and models included", toc.indexOf("projects/video_studio") < toc.indexOf("common/comfyui") && toc.includes("models/claude-sonnet"), toc);
check("toc leaves other projects out", !toc.includes("card_game"));

const hits = wiki.search("comfyui 메모리", { project: "video_studio" });
check("search finds the page", hits[0]?.path === "common/comfyui", JSON.stringify(hits.map((h) => h.path)));
check("search keeps other projects out", wiki.search("밸런스", { project: "video_studio" }).length === 0 && wiki.search("밸런스").length === 1);

await wiki.write("common/comfyui", { title: "ComfyUI 쓰는 법", body: "## 방법\n- 8188 포트 API\n- /free 로 메모리 비우기\n- 큐가 비었는지 먼저 본다" }, "user", "큐 확인 추가");
const edited = wiki.read("common/comfyui");
check("edit keeps the summary", edited.summary === "로컬 ComfyUI로 이미지·영상 만들기" && edited.by === "user");
const hist = await wiki.history("common/comfyui");
check("history lists both edits", hist.length === 2 && /큐 확인 추가/.test(hist[0].subject), JSON.stringify(hist));

// ---- drilling down instead of reading the whole contents ----
await wiki.write("common/comfyui/index", { title: "ComfyUI", summary: "ComfyUI 설치·생성·마스크 페이지 모음", body: "- sam3-mask: 인물 마스크" }, "editor");
await wiki.write("common/comfyui/sam3-mask", { title: "SAM3 인물 마스크", summary: "텍스트로 인물 마스크 따기", body: "## 방법\n노드 연결" }, "editor");
const long = "## 언제 쓰나\n" + "긴 설명. ".repeat(300) + "\n## 방법\n- 8188 포트로 보낸다\n## 주의할 점\n- 생성 중에는 /free 금지";
await wiki.write("projects/video_studio/video/chain-jobs", { title: "체인 생성", summary: "구간 체인 생성", body: long }, "editor");
const root = wiki.renderRoot({ project: "video_studio" });
check("root overview is short and names folders, not pages", root.length < 400 && root.includes("projects/video_studio/ (2쪽)") && root.includes("common/ (2쪽)") && root.includes("하위: comfyui") && !root.includes("SAM3"), root);
const top = wiki.children("", { project: "video_studio" });
check("root lists only top folders", top.pages.length === 0 && top.folders.map((f) => f.path).join(",") === "common,models,projects", JSON.stringify(top));
const common = wiki.children("common");
check("folder lists its pages and sub-folders with the index summary", common.pages.map((p) => p.path).join(",") === "common/comfyui" && common.folders[0]?.path === "common/comfyui" && common.folders[0].pages === 1 && common.folders[0].summary === "ComfyUI 설치·생성·마스크 페이지 모음", JSON.stringify(common));
check("index page is not listed as a page", !wiki.children("common/comfyui").pages.some((p) => p.path.endsWith("/index")) && wiki.children("common/comfyui").summary === "ComfyUI 설치·생성·마스크 페이지 모음");
check("other projects stay hidden while drilling", !wiki.children("projects", { project: "video_studio" }).folders.some((f) => f.path.includes("reinforce")));
const { pageOutline, pageSection } = await import("@gencouncil/core");
check("long page outline", pageOutline(long).map((o) => o.heading).join("/") === "언제 쓰나/방법/주의할 점");
check("one section read alone", pageSection(long, "방법") === "## 방법\n- 8188 포트로 보낸다" && pageSection(long, "주의") === "## 주의할 점\n- 생성 중에는 /free 금지" && pageSection(long, "없는 절") === undefined);

check("remove", (await wiki.remove("projects/card_game/balance", "user")) && !wiki.read("projects/card_game/balance"));
check("list after remove", wiki.list().length === 6, JSON.stringify(wiki.list().map((p) => p.path)));

// a lock left by a killed git must not block every later commit
const { commitAll, clearStaleLock } = await import("@gencouncil/core");
const { execFileSync } = await import("node:child_process");
const repo = path.dirname(wiki.dir);
const lock = path.join(repo, ".git", "index.lock");
const headCount = () => Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo }).toString().trim());
fs.writeFileSync(lock, "");
check("a fresh lock is left alone", !clearStaleLock(repo) && fs.existsSync(lock));
const old = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(lock, old, old);
const before = headCount();
fs.writeFileSync(path.join(wiki.dir, "common", "after-lock.md"), "---\ntitle: t\nsummary: s\n---\nbody\n");
await commitAll(repo, "after stale lock");
check("an old lock is cleared and the commit goes through", !fs.existsSync(lock) && headCount() === before + 1, `${before} -> ${headCount()}`);

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall wiki checks passed");
process.exitCode = failed ? 1 : 0;
