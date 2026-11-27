/**
 * Memory curator: a one-shot session with owner rights on the shared memory. It reviews
 * pending proposals — improves, merges, approves or rejects them — and tidies verified
 * entries. Members and the chair only propose; this is the single place that approves.
 * Routine runs use Opus and only see entries picked by code.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { entryScope, memoryDir, spaceDir, type Entry, type MemoryStore } from "@gencouncil/core";
import { serverEntry } from "@gencouncil/mcp/install";
import { AccountRegistry } from "./accounts.js";
import { claudeModelId, parseClaudeLine, spawnCli, wireProcess, type ClaudeEvent } from "./drivers.js";

/** routine runs: proposals and the incremental tidy */
export const CURATOR_MODEL = "opus";
export const CURATOR_EFFORT = "medium";
/** the full check reads every verified entry */
export const FULL_CHECK_MODEL = "fable";
export const FULL_CHECK_EFFORT = "high";
/** entries per incremental tidy; the rest wait for the next run */
export const TIDY_BATCH = 30;

/** what makes a memory worth keeping: shared by approval, the tidy and the full check */
const KEEP_TEST = `남길 가치 기준: "앞으로 다른 일을 하다가도 다시 찾아 쓸 지식인가?"
- 공용(common) 항목과 모델 성향: 도구·외부 서비스 사용법, 절차, 환경·OS·라이브러리의 함정은 남긴다. 판단이 서지 않으면 남긴다.
- 프로젝트(project) 항목: 쳐내는 것이 기본이다. 아래 셋 중 하나를 본문으로 입증할 때만 남긴다.
  (a) 코드에 없는 지식: 사용자 결정, 의도, 하지 말 것, 외부 환경·배포·계정.
  (b) 여러 번 실행하는 절차: 실행·측정·캡처·배포·재현 방법과 그 도구.
  (c) 여러 파일에 걸친 작업 순서: 새 기능을 넣을 때 빠뜨리기 쉬운 곳 전체.
- 쳐낸다(일회성): 증상 하나와 그 수정이 짝인 항목(그 수정은 이미 코드에 있다), 함수·파일 하나의 위치나 동작, 그 작업의 결과와 수치, 끝난 이행 작업의 경위. "다시 생길 수도 있다", "구조나 함정이다"는 남길 이유가 아니다.
- 예: "Playwright waitForFunction에 async 함수를 주면 즉시 통과"(공용 함정)와 "reinforce 최대 웨이브 측정 실행"(절차)은 남긴다. "연옥 그림자 이름표가 화면 위로 잘릴 때", "range 슬라이더에 굵은 줄: 전역 input 스타일"(증상과 수정)은 쳐낸다.
- 일반 교훈이 있으면 교훈만 남기되, 그 교훈이 다른 프로젝트에도 통할 때만 그렇게 한다(common으로 올린다). 항목에 있는 내용만 쓴다.`;

export function curatorPrompt(): string {
  return `너는 공유 기억(Space Memory)의 관리자다. 위원과 의장이 올린 제안(proposed)을 처리한다.

1. memory_list(status: proposed)로 제안을 모두 본다. 없으면 "처리할 제안 없음"이라고만 답하고 끝낸다.
2. 제안마다 memory_read로 읽고, memory_search로 비슷한 기존 기억이 있는지 찾는다.
3. 판단. 승인은 아래 기준을 통과한 것만 한다.

${KEEP_TEST}

   - 기준을 통과하고 정확하면: memory_update로 제목(45자 이내 검색어 문장), 본문("## 문제 / ## 해결 / ## 적용" 각 1~3줄 글머리표, 공용 600자·프로젝트 350자 이내, 명령·경로·값은 그대로, 경위·날짜별 기록은 뺀다), tags(소문자 키워드)를 압축해 다듬은 뒤 memory_approve.
   - 기존 기억과 겹치면: 새로 알게 된 부분만 기존 기억에 memory_update(append)로 보강하고, 제안은 memory_reject(reason: "중복: <기존 id>에 병합").
   - 일회성, 틀리거나 검증 안 된 내용, 너무 모호한 것: memory_reject(reason에 이유). 한 프로젝트에만 맞는다는 것은 거절 이유가 아니지만, 되풀이되지 않는 일이면 거절한다.
   - persona(모델 성향) 제안은 같은 모델의 기존 persona가 있으면 append로 합친다.
   - 승인할 때 scope를 정한다(memory_update scope): 다른 프로젝트에서도 그대로 쓰는 지식(공통 도구 사용법, 외부 서비스 이용 절차, OS·셸·git·빌드 환경 문제, 모델 성향)은 common, 한 프로젝트 코드·데이터·도메인 사실은 project. common으로 올릴 때는 제목과 본문을 그 프로젝트 없이도 읽히게 일반화하고, project 필드는 출처로 남긴다.
4. 끝나면 처리 결과를 한국어로 짧게 보고한다: 승인 n건, 병합 n건, 거절 n건, 그리고 각 항목 한 줄.

기억을 새로 지어내지 마라. 제안에 없는 내용을 추가하지 마라.`;
}

/** projects the reorganize run must know: memory key (repo folder) and display name */
export interface MemoryProjectInfo {
  key: string;
  name: string;
}

/** length targets the tidy holds entries to */
export const COMPRESS_TARGETS = { title: 45, commonBody: 600, projectBody: 350, personaBody: 500 };

/** an old solution and the newer one that replaced it: keep one entry, the old way as a single line */
const SUPERSEDE_STEP = `2-1. 같은 주제의 낡은 해결법: 같은 문제·도구·절차를 다루는데 해결법·값·경로가 서로 다른 항목들이 있으면 memory_read로 모두 읽고 updated 날짜를 비교한다.
   - 새 쪽이 옛 쪽을 대신하는 것이 분명하면(새 쪽이 "이제는"·"바뀌었다"고 하거나, 같은 단계의 값만 다르고 새 쪽이 더 최근): 새 항목을 기준으로 memory_update 하고, 옛 항목에만 있던 아직 유효한 사실은 옮긴다. 옛 방법은 "예전 방식(이제 안 됨): <한 줄>"로만 남긴다(옛 방법을 다시 시도하지 않게).
   - 그다음 옛 항목을 memory_retire(id, reason: "대체됨: <무엇이 바뀌었나 한 줄>", merged_into: 새 id)로 정리한다.
   - 둘이 환경(OS·계정·프로젝트·모델)에 따라 각각 맞는 것이면 대체가 아니다: 한 항목에 "A일 때 / B일 때"로 정리하거나 그대로 둔다.
   - 어느 쪽이 맞는지 본문과 날짜로 판단이 안 서면 지우지 않고 보고서에 "확인 필요: <id들>"로 남긴다.`;

// ---------- incremental tidy: code picks the entries, the model only sees those ----------

/** what the tidy looks at: an edit to any of these makes the entry due again */
export function entryHash(e: Entry): string {
  const m = e.meta;
  return crypto.createHash("sha1").update([m.title, entryScope(m), m.project ?? "", m.type, e.body].join("\n")).digest("hex").slice(0, 16);
}

function reviewedFile(): string {
  return path.join(spaceDir(), "curator", "reviewed.json");
}

/** id -> entryHash at the time a tidy last looked at it; null before the first incremental run */
export function loadReviewed(): Record<string, string> | null {
  try {
    return JSON.parse(fs.readFileSync(reviewedFile(), "utf8")) as Record<string, string>;
  } catch {
    return null;
  }
}

function saveReviewed(map: Record<string, string>): void {
  fs.mkdirSync(path.dirname(reviewedFile()), { recursive: true });
  fs.writeFileSync(reviewedFile(), JSON.stringify(map, null, 1), "utf8");
}

/** hashes of every verified entry, used to see what a run changed */
export function verifiedHashes(store: MemoryStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of store.list({ status: "verified" })) {
    const e = store.get(m.id);
    if (e) out[m.id] = entryHash(e);
  }
  return out;
}

/** why an entry needs work regardless of whether it was seen before */
export function sizeProblems(e: Entry): string[] {
  const t = COMPRESS_TARGETS;
  const limit = e.meta.type === "persona" ? t.personaBody : entryScope(e.meta) === "common" ? t.commonBody : t.projectBody;
  const out: string[] = [];
  if (e.meta.title.length > t.title + 10) out.push(`제목 ${e.meta.title.length}자`);
  if (e.body.length > Math.round(limit * 1.3)) out.push(`본문 ${e.body.length}자`);
  if ((e.meta.title.match(/·/g) ?? []).length >= 3) out.push("제목에 여러 주제");
  return out;
}

export interface TidyCandidate {
  id: string;
  title: string;
  scope: string;
  project?: string;
  titleLen: number;
  bodyLen: number;
  reasons: string[];
  similar: { id: string; title: string }[];
}

/**
 * Entries that are new or edited since a tidy last saw them, oldest first. The first
 * incremental run counts every existing entry as seen (they came out of a full check);
 * entries Fable kept long on purpose are not picked again until someone edits them.
 */
export function selectTidyCandidates(store: MemoryStore, limit = TIDY_BATCH): { candidates: TidyCandidate[]; remaining: number } {
  let reviewed = loadReviewed();
  const verified = store.list({ status: "verified" });
  if (!reviewed) {
    reviewed = {};
    for (const m of verified) {
      const e = store.get(m.id);
      if (e) reviewed[m.id] = entryHash(e);
    }
    saveReviewed(reviewed);
  }
  const due: { e: Entry; reasons: string[] }[] = [];
  for (const m of verified) {
    const e = store.get(m.id);
    if (!e) continue;
    const seen = reviewed[m.id];
    if (seen === entryHash(e)) continue;
    due.push({ e, reasons: [seen ? "바뀐 항목" : "새 항목", ...sizeProblems(e)] });
  }
  due.sort((a, b) => String(a.e.meta.updated).localeCompare(String(b.e.meta.updated)));
  const picked = due.slice(0, limit);
  const candidates = picked.map(({ e, reasons }) => ({
    id: e.meta.id,
    title: e.meta.title,
    scope: entryScope(e.meta),
    project: e.meta.project,
    titleLen: e.meta.title.length,
    bodyLen: e.body.length,
    reasons,
    similar: store
      .search(e.meta.title, { status: "verified", limit: 4 })
      .filter((h) => h.id !== e.meta.id)
      .slice(0, 3)
      .map((h) => ({ id: h.id, title: h.title })),
  }));
  return { candidates, remaining: due.length - picked.length };
}

/**
 * After a successful run: the candidates and every entry the run wrote or edited count as seen.
 */
export function markReviewed(store: MemoryStore, opts: { before: Record<string, string>; candidates?: string[] }): void {
  const reviewed = loadReviewed() ?? {};
  const now = verifiedHashes(store);
  for (const id of Object.keys(reviewed)) if (!now[id]) delete reviewed[id];
  for (const [id, hash] of Object.entries(now)) {
    if (opts.candidates?.includes(id) || opts.before[id] !== hash) reviewed[id] = hash;
  }
  saveReviewed(reviewed);
}

export function tidyPrompt(projects: MemoryProjectInfo[], candidates: TidyCandidate[], retireBudget: number, pruneBudget = retireBudget): string {
  const list = projects.length ? projects.map((p) => `- ${p.key} (${p.name})`).join("\n") : "- (등록된 프로젝트 없음)";
  const t = COMPRESS_TARGETS;
  const lines = candidates
    .map((c) => {
      const where = c.scope === "project" ? `project:${c.project ?? "?"}` : "common";
      const sim = c.similar.length ? `\n  비슷한 항목: ${c.similar.map((s) => `${s.id} "${s.title}"`).join(", ")}` : "";
      return `- ${c.id} [${where}] "${c.title}" (제목 ${c.titleLen}자, 본문 ${c.bodyLen}자) 이유: ${c.reasons.join(", ")}${sim}`;
    })
    .join("\n");
  return `너는 공유 기억(Space Memory)의 관리자다. 이번 일은 아래 목록의 승인된 기억 ${candidates.length}개만 점검하는 것이다. 목록은 코드가 골랐다: 새로 들어왔거나 바뀐 항목, 길이 기준을 넘는 항목이다. 목록 밖의 항목은 중복을 확인할 때만 읽고, 고치지 않는다. memory_list로 전체를 훑지 않는다.

${KEEP_TEST}

기준
- 한 항목 = 한 주제. 여러 주제를 묶은 항목은 주제별로 나눈다. 같은 절차·같은 사실이 실제로 겹칠 때만 합친다.
- 제목 ${t.title}자 이내 검색어 문장. 본문 공용 ${t.commonBody}자, 프로젝트 ${t.projectBody}자, 모델 성향 ${t.personaBody}자 안팎, "## 문제 / ## 해결 / ## 적용" 각 1~3줄. 명령·경로·옵션·주소·값·오류 문구·하지 말 것은 남기고, 경위·날짜별 기록·반복만 지운다. 사실이 많으면 빼지 말고 나눈다.
- 이미 기준을 만족하면 건드리지 않는다. 대부분의 항목은 그대로 둬도 된다.
- scope: common(다른 프로젝트에서도 그대로 쓰는 것) / project(한 프로젝트의 코드·데이터·도메인 사실). project 값은 아래 키 중 하나.

프로젝트 키:
${list}

점검할 항목:
${lines}

순서
1. 항목마다 memory_read로 읽는다. "비슷한 항목"은 제목만 봐서 같은 내용일 것 같을 때만 memory_read 한다.
2. 일회성: 일반 교훈이 있으면 memory_update로 교훈만 남기고, 없으면 memory_retire(id, reason: "일회성: <한 줄 이유>"). 최대 ${pruneBudget}개.
3. 진짜 중복: 남길 항목에 memory_update(body)로 두 쪽의 고유한 사실을 모두 담고, 나머지는 memory_retire(id, reason: "중복: <남긴 id>", merged_into: 남긴 id).
${SUPERSEDE_STEP.replace(/^2-1\./, "3-1.")}
   - 점검할 항목이 목록 밖의 옛 항목을 대신하는 경우에는 그 옛 항목도 이렇게 정리해도 된다(목록 밖에서 고칠 수 있는 유일한 경우). 일회성과 합쳐 최대 ${pruneBudget}개.
4. 여러 주제를 묶은 항목: 주제마다 memory_write로 새 항목을 만든 뒤(type, scope, project, tags는 원래대로), 원래 항목을 memory_retire(id, reason: "분할: <새 id들>").
5. 너무 긴 항목·긴 제목: memory_update로 경위·반복만 줄인다. scope가 틀렸으면 고친다.
6. 합치기·삭제는 이번에 최대 ${retireBudget}개까지만 된다. 일회성·대체된 항목이 아니면 틀린 것이 확실할 때만 지운다. 새 사실을 지어내지 않는다.
7. 끝나면 한국어로 짧게 보고한다: 고친 항목(무엇을), 쳐낸 항목, 대체한 항목(옛 id → 남긴 id), 확인 필요로 남긴 충돌, 합친 항목, 나눈 항목, 그대로 둔 항목 수.`;
}

export interface CuratorResult {
  text: string;
  isError: boolean;
  costUsd?: number;
}

export function curatorLogFile(): string {
  return path.join(spaceDir(), "curator", "curator.log");
}

/** Incremental tidy: the routine model looks only at the candidates code picked. */
export function runTidy(
  projects: MemoryProjectInfo[],
  candidates: TidyCandidate[],
  opts: { account?: string; model?: string; effort?: string; onEvent?: (e: ClaudeEvent) => void } = {},
): Promise<CuratorResult> {
  const retireBudget = Math.max(3, Math.ceil(candidates.length * 0.3));
  const pruneBudget = Math.max(3, Math.ceil(candidates.length * 0.5));
  return runCurator({ ...opts, prompt: tidyPrompt(projects, candidates, retireBudget, pruneBudget), label: "tidy", retireBudget, pruneBudget });
}

/**
 * The curator's command line. `-p` carries no prompt: the prompt is written to stdin instead,
 * because a wiki check's prompt holds the whole diff and page list and would blow past the
 * command-line limit (Windows: 32,767 chars, spawn fails with ENAMETOOLONG).
 */
export function curatorArgs(model: string, effort: string, mcpFile: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    claudeModelId(model),
    "--effort",
    effort,
    "--mcp-config",
    mcpFile,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    "mcp__gencouncil",
  ];
}

export function runCurator(
  opts: { account?: string; model?: string; effort?: string; prompt?: string; label?: string; retireBudget?: number; pruneBudget?: number; wikiRemoveBudget?: number; onEvent?: (e: ClaudeEvent) => void } = {},
): Promise<CuratorResult> {
  const accounts = new AccountRegistry();
  const account = opts.account ? accounts.get(opts.account) : accounts.pick("claude");
  const dir = path.join(spaceDir(), "curator");
  fs.mkdirSync(dir, { recursive: true });
  const mcpEnv: Record<string, string> = { GENCOUNCIL_ROLE: "owner", GENCOUNCIL_AGENT: `curator:${opts.model ?? CURATOR_MODEL}${opts.label ? ":" + opts.label : ""}` };
  if (process.env.GENCOUNCIL_HOME) mcpEnv.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
  if (opts.retireBudget) mcpEnv.GENCOUNCIL_RETIRE_BUDGET = String(opts.retireBudget);
  if (opts.pruneBudget) mcpEnv.GENCOUNCIL_PRUNE_BUDGET = String(opts.pruneBudget);
  if (opts.wikiRemoveBudget) mcpEnv.GENCOUNCIL_WIKI_REMOVE_BUDGET = String(opts.wikiRemoveBudget);
  const mcpFile = path.join(dir, "mcp.json");
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { gencouncil: { type: "stdio", command: process.execPath, args: [serverEntry()], env: mcpEnv } } }, null, 2),
    "utf8",
  );
  const model = opts.model ?? CURATOR_MODEL;
  const effort = opts.effort ?? CURATOR_EFFORT;
  // the prompt goes on stdin, never in the arguments: a wiki check carries the whole diff and page
  // list, and Windows caps a command line at 32,767 chars (spawn fails with ENAMETOOLONG)
  const prompt = opts.prompt ?? curatorPrompt();
  const args = curatorArgs(model, effort, mcpFile);
  const env: NodeJS.ProcessEnv = { ...process.env, ...accounts.env(account) };
  delete env.CLAUDECODE;
  const log = fs.createWriteStream(curatorLogFile(), { flags: "a" });
  log.write(`=== ${new Date().toISOString()} curator${opts.label ? " (" + opts.label + ")" : ""} model=${model} effort=${effort} account=${account?.id ?? "default"}\n`);
  return new Promise((resolve) => {
    let child;
    const cwd = fs.existsSync(memoryDir()) ? memoryDir() : dir;
    try {
      child = spawnCli("claude", args, { cwd, env });
    } catch (e) {
      log.end(`=== spawn failed: ${(e as Error).message}\n`);
      resolve({ text: (e as Error).message, isError: true });
      return;
    }
    let text = "";
    let isError = false;
    let costUsd: number | undefined;
    let stderr = "";
    const proc = wireProcess(child, { cwd, prompt: "", stdinText: prompt, autonomy: "edits" }, (stream, line) => {
      log.write(`[${stream}] ${line}\n`);
      if (stream === "stderr") {
        stderr += line + "\n";
        return;
      }
      for (const ev of parseClaudeLine(line)) {
        if (ev.kind === "result") {
          text = ev.text;
          isError = ev.isError;
          costUsd = ev.costUsd;
        } else if (ev.kind !== "other") opts.onEvent?.(ev);
      }
    });
    void proc.done.then((exit) => {
      log.end(`=== exit code=${exit.code}\n`);
      if (exit.code !== 0 && !text) {
        isError = true;
        text = stderr.trim() || `claude exited with code ${exit.code}`;
      }
      if (account) accounts.touch(account.id);
      resolve({ text, isError, costUsd });
    });
  });
}
