// The left-hand wiki list: one row per project, its folders nested inside. No browser, no server.
// src/wikiTree.ts is TypeScript, so it is transpiled here and loaded from memory.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "../src/wikiTree.ts"), "utf8");
const js = transformSync(src, { loader: "ts", format: "esm" }).code;
const { buildSections, folderLabel } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

/** what GET /api/wiki returns, in the order it returns it (sorted by folder, then title) */
const page = (p, title) => ({ path: p, title, summary: "", section: p.split("/").slice(0, -1).join("/"), chars: 100 });
const PAGES = [
  page("common/git/index", "Git"),
  page("common/git/git-commit-identity", "커밋 작성자"),
  page("models/claude-opus", "Claude Opus"),
  page("projects/video_studio/server-access", "서버 접근"),
  page("projects/video_studio/output-folders", "결과물 폴더"),
  page("projects/video_studio/cuts/index", "컷 그림: 그리기·투표 루프"),
  page("projects/video_studio/cuts/vote-loop", "투표 루프"),
  page("projects/video_studio/post-ep01/index", "첫 작품 1화 후처리"),
  page("projects/video_studio/post-ep01/rerun", "다시 돌리기"),
  page("projects/video_studio/storyboard/index", "첫 작품 극본·스토리보드"),
  page("projects/video_studio/storyboard/script", "극본"),
  page("projects/web-console/deploy-live", "배포"),
];
const tree = buildSections(PAGES);
const byKey = Object.fromEntries(tree.map((g) => [g.key, g]));

// the complaint: video_studio took one row per folder, so one project looked like several
check("한 프로젝트는 한 줄이다", tree.filter((g) => g.key === "projects/video_studio").length === 1, tree.map((g) => g.key).join(", "));
check("깊은 폴더는 그 안에 들어간다", byKey["projects/video_studio"].subs.map((s) => s.key.split("/").pop()).join(",") === "cuts,post-ep01,storyboard");
check("다른 프로젝트는 합쳐지지 않는다", Boolean(byKey["projects/web-console"]) && byKey["projects/web-console"].subs.length === 0);
check("공용은 폴더마다 한 줄 그대로다 (더 깊은 폴더가 없다)", byKey["common/git"].subs.length === 0 && byKey["common/git"].pages.length === 1);
check("폴더가 없는 곳도 한 줄이 된다", byKey["models"].pages.length === 1 && byKey["models"].subs.length === 0);

// the count on a project row covers everything inside it, index pages excluded (they describe the folder)
check("프로젝트 줄의 쪽수는 안쪽까지 다 센다", byKey["projects/video_studio"].total === 5, String(byKey["projects/video_studio"].total));
check("index 는 쪽수에 들어가지 않는다", byKey["projects/video_studio"].subs.every((s) => s.index && s.pages.length === 1));

// the labels: two of video_studio's rows used to read "프로젝트 · video_studio · 첫 작품 …" and looked alike
const subLabels = byKey["projects/video_studio"].subs.map((s) => folderLabel(s, true));
check("안쪽 폴더는 프로젝트 이름을 되풀이하지 않는다", subLabels.every((l) => !l.includes("video_studio")), subLabels.join(" | "));
check("안쪽 폴더 이름끼리 겹치지 않는다", new Set(subLabels).size === subLabels.length, subLabels.join(" | "));
check("프로젝트 줄은 경로를 그대로 보여준다", folderLabel(byKey["projects/video_studio"], false) === "프로젝트 · video_studio");
check("index 가 있는 줄은 그 제목을 쓴다", folderLabel(byKey["common/git"], false) === "공용 · Git", folderLabel(byKey["common/git"], false));
check("index 가 없는 안쪽 폴더는 폴더 이름을 쓴다", folderLabel({ key: "projects/x/none", pages: [] }, true) === "none");

// the same rule against the wiki actually on this machine, when it is there
const real = path.join(process.env.GENCOUNCIL_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".gencouncil"), "space", "wiki");
if (fs.existsSync(real)) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(real)
    .filter((f) => f.endsWith(".md") && path.relative(real, f).includes(path.sep))
    .map((f) => path.relative(real, f).replace(/\\/g, "/").replace(/\.md$/, ""))
    .sort();
  const titleOf = (p) => fs.readFileSync(path.join(real, `${p}.md`), "utf8").match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? p.split("/").pop();
  const groups = buildSections(files.map((p) => page(p, titleOf(p))));
  const dupes = groups.map((g) => g.key).filter((k, i, a) => a.indexOf(k) !== i);
  check("실제 위키에도 같은 줄이 두 번 나오지 않는다", dupes.length === 0, dupes.join(", "));
  console.log(
    "\n실제 위키 줄 (쪽수):\n" +
      groups
        .map((g) => `  ${folderLabel(g, false)} ${g.total}` + g.subs.map((s) => `\n      └ ${folderLabel(s, true)} ${s.pages.length}`).join(""))
        .join("\n"),
  );
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall wiki tree checks passed");
process.exitCode = failed ? 1 : 0;
