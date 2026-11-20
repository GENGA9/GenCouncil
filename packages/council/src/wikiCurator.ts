/**
 * Shared memory now settles into Gen Wiki.
 *
 * - Proposal processing ("제안 처리") registers into the wiki: proposals from members and the
 *   chair, plus memory entries from before the wiki, are folded into topic pages, and each entry
 *   is marked "위키 등록: <path>" (memory_to_wiki). Code picks the batch; Opus does the writing.
 * - The full check ("전체 점검") is Fable reviewing what changed in the wiki since the last
 *   check (git diff of space/wiki): it corrects mistakes, restores facts lost by accident, folds
 *   revised methods into one current method and merges duplicate pages.
 */
import fs from "node:fs";
import path from "node:path";
import { commitAll, entryScope, spaceDir, WikiStore, type Entry, type MemoryStore, type WikiPageMeta } from "@gencouncil/core";
import { runCurator, FULL_CHECK_EFFORT, FULL_CHECK_MODEL, type CuratorResult, type MemoryProjectInfo } from "./curator.js";
import type { ClaudeEvent } from "./drivers.js";
import { git } from "./git.js";

/** entries per registration run: proposals first, then pre-wiki memory */
export const WIKI_REGISTER_BATCH = 40;
/** git's empty tree: the base of the first review */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF_CHARS = 60_000;
/** to-do list for GenCouncil code: workarounds and per-instruction rules the program should take over */
export const INTERNALIZE_PAGE = "common/council/gencouncil-internalize";

const WORTH = `위키에 올릴 가치 기준: "앞으로 다른 일을 하다가도 다시 찾아 쓸 지식인가?"
- 올린다: 도구·외부 서비스 사용법, 여러 번 실행하는 절차(실행·측정·생성·배포), 환경·OS·라이브러리의 함정, 코드에 없는 지식(사용자 결정, 하지 말 것, 계정·배포), 여러 파일에 걸친 작업 순서, 모델 성향.
- 버린다(일회성): 증상 하나와 그 수정이 짝인 기록(그 수정은 이미 코드에 있다), 함수·파일 하나의 위치, 그 작업의 결과와 수치, 끝난 작업의 경위.`;

const PAGE_RULES = `위키 구조와 쓰는 법
- 경로: common/<페이지>(어느 프로젝트에서나 쓰는 도구·절차·환경), models/<페이지>(모델 하나의 성향), projects/<프로젝트키>/<페이지>(한 프로젝트의 구조·규칙·절차). 페이지 이름은 영문 소문자와 하이픈(예: common/comfyui, common/windows-shell, models/claude-sonnet, projects/video_studio/video-jobs).
- 한 페이지 = 한 주제(도구 하나, 절차 하나, 시스템 하나, 모델 하나). 항목 하나에 페이지 하나가 아니다: 같은 주제의 항목들을 한 페이지에 모은다. 서로 다른 주제를 한 페이지에 묶지도 않는다.
- 계층: 위원·의장은 위키 전체를 보지 않고 맨 위에서 wiki_toc로 한 단계씩 내려가며 찾는다. 그래서 한 폴더에 바로 든 페이지는 12개 안팎으로 유지한다. 넘으면 주제 폴더로 나눈다: common/<주제>/<페이지>, projects/<프로젝트키>/<주제>/<페이지>(주제 폴더는 한 단계까지, models/는 나누지 않는다). 예: common/comfyui/sam3-mask, common/windows/junction, projects/video_studio/video/chain-jobs.
- 주제 폴더에는 index 페이지(<폴더>/index)를 둔다: summary 한 줄이 "이 폴더에 무엇이 있나"이고, 본문은 폴더 안 페이지 각각 한 줄 안내. 폴더를 볼 때 이 한 줄이 보이므로 갈래를 고르는 단서가 된다.
- 페이지 summary는 목록에서 이 페이지를 열지 말지 정하는 한 줄이다: 무엇을 할 때 보는 페이지인지 구체적으로.
- 본문: 맨 위에 2~3줄 개요, 그다음 "## 언제 쓰나 / ## 방법 / ## 주의할 점" 같은 절(주제에 맞게). 긴 페이지는 읽는 쪽이 목차를 보고 필요한 절만 읽으므로, 절 제목을 짧고 구체적으로 쓰고 한 절이 한 가지를 다루게 한다. models/ 페이지는 "## 잘하는 일 / ## 약한 일 / ## 지시에 넣을 문구".
- 명령·경로·옵션·주소·값·오류 문구·하지 말 것은 그대로 옮긴다. 경위·날짜별 기록·반복 문장은 뺀다.
- 같은 주제에서 방법이 바뀌었으면 새 방법만 본문에 쓰고, 옛 방법은 "예전 방식(이제 안 됨): <한 줄>"로만 남긴다.
- 다른 위키 페이지는 [제목](경로)로 링크한다.
- 비밀값(키·토큰·비밀번호)은 넣지 않는다.
- 새 사실을 지어내지 않는다. 항목과 페이지에 있는 내용만 쓴다.`;

export interface WikiInbox {
  proposals: Entry[];
  entries: Entry[];
  /** pre-wiki entries still waiting after this batch */
  remaining: number;
}

/** What the next registration run takes: every proposal (up to the batch), then pre-wiki entries grouped by project and topic. */
export function selectWikiInbox(store: MemoryStore, limit = WIKI_REGISTER_BATCH): WikiInbox {
  const get = (id: string) => store.get(id);
  const proposals = store
    .list({ status: "proposed" })
    .map((m) => get(m.id))
    .filter((e): e is Entry => Boolean(e))
    .sort((a, b) => String(a.meta.created ?? a.meta.updated).localeCompare(String(b.meta.created ?? b.meta.updated)))
    .slice(0, limit);
  const verified = store
    .list({ status: "verified" })
    .map((m) => get(m.id))
    .filter((e): e is Entry => Boolean(e))
    .sort((a, b) => {
      const ka = `${entryScope(a.meta) === "project" ? a.meta.project ?? "" : ""}|${a.meta.type}|${a.meta.title}`;
      const kb = `${entryScope(b.meta) === "project" ? b.meta.project ?? "" : ""}|${b.meta.type}|${b.meta.title}`;
      return ka.localeCompare(kb);
    });
  const entries = verified.slice(0, Math.max(0, limit - proposals.length));
  return { proposals, entries, remaining: verified.length - entries.length };
}

function entryLine(e: Entry, kind: string): string {
  const where = e.meta.type === "persona" ? "모델 성향" : entryScope(e.meta) === "project" ? `project:${e.meta.project ?? "?"}` : `common${e.meta.project ? ` (출처 ${e.meta.project})` : ""}`;
  return `- ${e.meta.id} [${kind}] [${where}] "${e.meta.title}" (${e.body.length}자)`;
}

export function wikiRegisterPrompt(projects: MemoryProjectInfo[], inbox: WikiInbox, toc: string): string {
  const keys = projects.length ? projects.map((p) => `- ${p.key} (${p.name})`).join("\n") : "- (등록된 프로젝트 없음)";
  const items = [
    ...inbox.proposals.map((e) => {
      const target = e.meta.tags.find((t) => t.startsWith("wiki:"))?.slice(5);
      return entryLine(e, target ? `위키 수정 제안 → ${target}` : "제안");
    }),
    ...inbox.entries.map((e) => entryLine(e, "기억")),
  ].join("\n");
  return `너는 Gen Wiki의 편집자다. 이번 일은 아래 "등록할 항목" ${inbox.proposals.length + inbox.entries.length}개를 위키에 옮기는 것이다. [제안]은 위원·의장이 새로 올린 지식, [위키 수정 제안 → 경로]는 위원·의장이 그 페이지의 절차가 틀렸거나 바뀌었다고 올린 수정안, [기억]은 위키가 생기기 전에 쌓인 공유 기억이다. 위원·의장은 위키를 직접 고치지 못하고 제안만 하므로, 위키를 고치는 것은 너다.

${PAGE_RULES}

${WORTH}

프로젝트 키(projects/<키>/ 에 쓰는 값):
${keys}

지금 위키 목차:
${toc || "(아직 페이지 없음)"}

등록할 항목:
${items}

순서
1. 항목을 memory_read로 모두 읽고, 같은 주제끼리 묶는다.
2. 주제마다 맞는 페이지를 목차와 wiki_search로 찾는다. 있으면 wiki_read로 읽고, 새 사실을 알맞은 절에 넣은 전체 본문을 wiki_write로 다시 저장한다(이미 있는 사실은 다시 쓰지 않는다). 없으면 새 페이지를 만든다. 저장할 때 sources에 이번에 이 페이지로 옮긴 항목 id를 넣는다(이전 sources는 자동으로 유지된다).
3. 페이지에 옮긴 항목마다 memory_to_wiki(id, path)를 부른다. 이것을 빠뜨리면 다음 실행에 같은 항목이 또 온다.
4. 위키에 올릴 가치가 없는 항목: [제안]이면 memory_reject(id, reason: "일회성: <한 줄 이유>"), [기억]이면 memory_retire(id, reason: "일회성: <한 줄 이유>").
4-1. [위키 수정 제안 → 경로]: 그 페이지를 wiki_read로 읽고, 제안이 맞으면 해당 부분을 고친 전체 본문을 wiki_write(sources에 제안 id)로 저장한 뒤 memory_to_wiki(id, 경로). 옛 방법은 "예전 방식(이제 안 됨): <한 줄>"로 남긴다. 페이지가 없으면 새로 만든다. 제안이 페이지의 다른 내용과 어긋나는데 어느 쪽이 맞는지 판단이 안 서면 고치지 말고 memory_reject(id, reason: "확인 필요: <무엇이 어긋나나>")로 남기고 보고서에 적는다.
4-2. 프로그램 내재화 후보: GenCouncil 자체(council_* 도구, 의장·위원 운영, 머지·핸드오버·안건 종료 등)의 버그를 사람이 우회하는 법이거나, 의장이 위원 지시에 매번 넣어야 하는 규칙이면, 위키에 옮기는 것과 함께 ${INTERNALIZE_PAGE} 페이지에 한 항목을 더한다: "### <한 줄 제목>" 아래 "- 문제 / - 지금 우회법 / - 프로그램이 할 일 / - 출처: <위키 경로>". 이 페이지는 GenCouncil 코드를 고칠 사람이 보는 할 일 목록이다. 이미 같은 항목이 있으면 더하지 않는다.
5. 틀렸거나 검증되지 않은 [제안]은 memory_reject(id, reason)로 이유를 적는다.
6. 끝나면 한국어로 짧게 보고한다: 만든 페이지(경로), 보강한 페이지(무엇을 더했나 한 줄), 반영한 수정 제안(경로와 무엇을), 프로그램 내재화 후보로 올린 것(제목), 위키로 옮긴 항목 수, 버린 항목(id와 이유), 확인 필요.`;
}

// ---------- full check: Fable reviews the wiki's changes since the last check ----------

function reviewStateFile(): string {
  return path.join(spaceDir(), "curator", "wiki-reviewed.json");
}

export function loadWikiReviewed(): { commit: string; at: string } | null {
  try {
    return JSON.parse(fs.readFileSync(reviewStateFile(), "utf8")) as { commit: string; at: string };
  } catch {
    return null;
  }
}

export function saveWikiReviewed(commit: string): void {
  fs.mkdirSync(path.dirname(reviewStateFile()), { recursive: true });
  fs.writeFileSync(reviewStateFile(), JSON.stringify({ commit, at: new Date().toISOString() }, null, 1), "utf8");
}

export interface WikiChanges {
  base: string;
  head: string;
  since?: string;
  files: Array<{ status: string; path: string }>;
  diff: string;
  truncated: boolean;
}

/** Wiki changes since the last full check (all of the wiki before the first one). */
export async function wikiChanges(): Promise<WikiChanges> {
  const root = spaceDir();
  if (!fs.existsSync(path.join(root, ".git"))) return { base: "", head: "", files: [], diff: "", truncated: false };
  await commitAll(root, "wiki: edits made outside the tools");
  const head = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  const state = loadWikiReviewed();
  let base = state?.commit ?? EMPTY_TREE;
  if (state && !(await git(root, ["cat-file", "-e", `${base}^{commit}`]).then(() => true, () => false))) base = EMPTY_TREE;
  const files = (await git(root, ["diff", "--name-status", base, head, "--", "wiki"]).catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status: status[0], path: rest[rest.length - 1].replace(/^wiki\//, "").replace(/\.md$/, "") };
    })
    .filter((f) => f.path !== "README");
  let diff = files.length ? await git(root, ["diff", "--unified=2", base, head, "--", "wiki"]).catch(() => "") : "";
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS);
  return { base, head, since: state?.at, files, diff, truncated };
}

/** a page longer than this is a compression candidate in the full check */
export const WIKI_LONG_PAGE = 8_000;

export function wikiReviewPrompt(
  projects: MemoryProjectInfo[],
  ch: WikiChanges,
  toc: string,
  pages: WikiPageMeta[] = [],
  removeBudget?: number,
): string {
  const keys = projects.length ? projects.map((p) => `- ${p.key} (${p.name})`).join("\n") : "- (등록된 프로젝트 없음)";
  const label: Record<string, string> = { A: "새 페이지", M: "고침", D: "지움", R: "옮김" };
  const files = ch.files.map((f) => `- ${f.path} (${label[f.status] ?? f.status})`).join("\n");
  const known = new Set(projects.map((p) => p.key.toLowerCase()));
  const inventory = pages
    .map((p) => {
      const flags = [
        p.chars > WIKI_LONG_PAGE ? "긺" : "",
        p.path.startsWith("projects/") && !known.has(p.path.split("/")[1]) ? "등록되지 않은 프로젝트" : "",
      ].filter(Boolean);
      return `- ${p.path} ${p.chars}자 · 수정 ${p.updated.slice(0, 10)}${flags.length ? ` · ${flags.join(", ")}` : ""}`;
    })
    .join("\n");
  const total = pages.reduce((a, p) => a + p.chars, 0);
  const review = ch.files.length
    ? `## 1부. 변경 감수: ${ch.since ? `지난 점검(${ch.since}) 이후` : "위키가 생긴 뒤 처음으로"} 바뀐 내용

위원·의장·편집자·사용자가 페이지를 고쳐 왔으므로 틀린 내용, 실수로 지워진 사실, 서로 겹치는 페이지, 낡은 방법이 섞여 있을 수 있다.

바뀐 페이지 (${ch.files.length}개):
${files}

변경 내역 (git diff${ch.truncated ? ", 길어서 앞부분만" : ""}):
\`\`\`diff
${ch.diff}
\`\`\``
    : "## 1부. 변경 감수\n\n지난 점검 이후 바뀐 페이지가 없다. 1부는 건너뛰고 2부만 한다.";
  return `너는 Gen Wiki의 감수자다. 이번 일은 두 가지다. 1부: 지난 점검 이후 바뀐 내용을 검토해 바로잡는다. 2부: 위키 전체에서 이제 필요 없는 페이지를 정리하고 지나치게 긴 페이지를 압축해, 위키가 계속 가볍고 찾기 쉽게 유지되게 한다.

${PAGE_RULES}

${WORTH}

프로젝트 키(등록된 프로젝트):
${keys}

지금 위키 목차:
${toc || "(없음)"}

${review}

## 2부. 전체 정리

전체 ${pages.length}쪽, ${total.toLocaleString()}자. 페이지 목록(긴 순서가 아니라 경로 순):
${inventory || "- (없음)"}

할 일 (1부)
1. 바뀐 페이지를 wiki_read로 읽고, diff에서 무엇이 더해지고 빠졌는지 본다.
2. 바로잡기: 페이지 안이나 다른 페이지와 모순되는 내용, 명령·경로·값의 오타, 비밀값은 고친다. diff에서 빠진 줄 가운데 아직 유효한 사실(명령·경로·값·하지 말 것)이 실수로 지워졌으면 되살린다.
3. 개정된 방법 통합: 같은 주제에서 새 방법이 옛 방법을 대체했으면 본문을 새 방법 기준으로 정리하고, 옛 방법은 "예전 방식(이제 안 됨): <한 줄>"로만 남긴다. 환경(OS·계정·프로젝트·모델)마다 각각 맞는 방법이면 대체가 아니다: "A일 때 / B일 때"로 나눠 쓴다.
4. 중복 통합: 바뀐 페이지와 같은 주제를 다루는 다른 페이지가 있으면(목차와 wiki_search로 확인) 하나로 합친다. 남길 페이지에 두 쪽의 고유한 사실을 모두 담아 wiki_write(sources에 지울 페이지의 sources도 넣는다) 한 뒤, 다른 쪽은 wiki_remove(path, reason: "통합: <남긴 경로>"). 지운 페이지를 링크하던 페이지가 있으면 링크를 고친다.
5. 구조: 한 페이지 한 주제인지, 알맞은 절(common / models / projects/<키>)에 있는지 본다. 여러 주제를 묶은 페이지는 나누고, 잘못된 절에 있는 페이지는 새 경로로 옮긴다(새 경로에 쓰고 옛 경로는 wiki_remove).
6. 일회성 기록(증상 하나와 그 수정, 작업 결과 수치, 경위)만 담긴 부분은 걷어낸다. 다시 쓸 사실은 줄이려고 빼지 않는다.
7. 어느 쪽이 맞는지 판단이 서지 않는 충돌은 고치지 말고 보고서에 "확인 필요"로 남긴다.
7-1. ${INTERNALIZE_PAGE}의 "프로그램에 반영됨" 절에 있는 항목은 이제 GenCouncil이 자동으로 한다. 다른 페이지에 그 우회법·수동 절차가 남아 있으면 "이제 프로그램이 자동으로 한다" 한 줄로 바꾼다.
8. 새 사실을 지어내지 않는다.

할 일 (2부)
9. 페이지 목록을 보고 정리할 후보를 고른다. 제목만으로 정하지 말고 wiki_read로 읽고 정한다.
10. 이제 필요 없는 페이지: 끝난 일의 경위·결과만 담긴 페이지, 더 이상 쓰지 않는 도구·방법만 남은 페이지(다른 페이지가 그것을 대체했다고 적혀 있거나 "예전 방식"뿐인 것), 다른 페이지에 내용이 이미 다 들어 있는 페이지, 등록되지 않은 프로젝트의 페이지 가운데 다시 쓸 일이 없는 것. 아직 다시 쓸 사실(명령·경로·값·하지 말 것)이 있으면 알맞은 페이지로 옮긴 뒤 지운다. 지울 때는 wiki_remove(path, reason: "정리: <한 줄 이유>")${removeBudget ? `. "정리:" 삭제는 이번에 최대 ${removeBudget}개까지만 된다(합친 페이지의 "통합:" 삭제는 세지 않는다). 나머지는 다음 점검에 맡긴다` : ""}. 판단이 서지 않으면 지우지 않는다.
11. 긴 페이지("긺" 표시, ${WIKI_LONG_PAGE.toLocaleString()}자 넘음)와 군더더기가 많은 페이지: 경위·날짜별 기록·반복 문장·지나간 작업 결과를 걷어내 압축한다. 사실은 빼지 않는다. 한 주제인데도 길면 하위 주제 페이지로 나누고 링크한다.
11-1. 계층 정리: 한 폴더에 바로 든 페이지가 12개를 크게 넘으면 비슷한 주제끼리 주제 폴더로 옮긴다(새 경로에 wiki_write, 옛 경로는 wiki_remove(reason: "통합: <새 경로>"), 링크도 고친다). 주제 폴더마다 index 페이지가 있는지, summary가 갈래를 고를 수 있게 구체적인지 본다. 페이지가 한두 개뿐인 주제 폴더는 위 폴더로 되돌린다.
12. 2부가 끝나면 위키 전체 글자 수가 정리 전보다 줄어야 한다. 단, 다시 쓸 사실을 글자 수 때문에 빼지 않는다.

보고 (한국어)
- 1부: 바로잡은 것(페이지와 무엇을), 되살린 사실, 통합한 방법, 합친 페이지(지운 경로 → 남긴 경로), 나누거나 옮긴 페이지, 확인 필요.
- 2부: 지운 페이지(경로와 이유), 압축한 페이지(전 → 후 글자 수), 나눈 페이지, 정리 전후 전체 글자 수(어림).
- 고칠 것이 없으면 "변경 없음".`;
}

export function runWikiRegister(
  projects: MemoryProjectInfo[],
  inbox: WikiInbox,
  opts: { account?: string; model?: string; effort?: string; onEvent?: (e: ClaudeEvent) => void } = {},
): Promise<CuratorResult> {
  const n = inbox.proposals.length + inbox.entries.length;
  return runCurator({
    ...opts,
    prompt: wikiRegisterPrompt(projects, inbox, new WikiStore().renderToc()),
    label: "wiki-register",
    // one-off cuts are part of registering; the cap only stops a run from cutting more than it was given
    pruneBudget: Math.max(5, n),
    retireBudget: Math.max(5, Math.ceil(n * 0.3)),
  });
}

export function runWikiReview(
  projects: MemoryProjectInfo[],
  changes: WikiChanges,
  opts: { account?: string; model?: string; effort?: string; onEvent?: (e: ClaudeEvent) => void } = {},
): Promise<CuratorResult> {
  const wiki = new WikiStore();
  const pages = wiki.list();
  // cleanup deletions per run are capped so repeated checks cannot hollow out the wiki; merges do not count
  const removeBudget = Math.max(3, Math.ceil(pages.length * 0.15));
  return runCurator({
    model: FULL_CHECK_MODEL,
    effort: FULL_CHECK_EFFORT,
    ...opts,
    prompt: wikiReviewPrompt(projects, changes, wiki.renderToc(), pages, removeBudget),
    label: "wiki-review",
    wikiRemoveBudget: removeBudget,
  });
}
