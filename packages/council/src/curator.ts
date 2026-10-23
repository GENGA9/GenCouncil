/**
 * Memory curator: a one-shot Fable (high effort) session with owner rights on the shared
 * memory. It reviews pending proposals — improves, merges, approves or rejects them.
 * Members and the chair only propose; this is the single place that approves.
 */
import fs from "node:fs";
import path from "node:path";
import { memoryDir, spaceDir } from "@gencouncil/core";
import { serverEntry } from "@gencouncil/mcp/install";
import { AccountRegistry } from "./accounts.js";
import { parseClaudeLine, spawnCli, wireProcess, type ClaudeEvent } from "./drivers.js";

export const CURATOR_MODEL = "fable";
export const CURATOR_EFFORT = "high";

export function curatorPrompt(): string {
  return `너는 공유 기억(Space Memory)의 관리자다. 위원과 의장이 올린 제안(proposed)을 처리한다.

1. memory_list(status: proposed)로 제안을 모두 본다. 없으면 "처리할 제안 없음"이라고만 답하고 끝낸다.
2. 제안마다 memory_read로 읽고, memory_search로 비슷한 기존 기억이 있는지 찾는다.
3. 판단:
   - 재사용 가치가 있고 정확하면: memory_update로 제목(45자 이내 검색어 문장), 본문("## 문제 / ## 해결 / ## 적용" 각 1~3줄 글머리표, 공용 600자·프로젝트 350자 이내, 명령·경로·값은 그대로, 경위·날짜별 기록은 뺀다), tags(소문자 키워드)를 압축해 다듬은 뒤 memory_approve.
   - 기존 기억과 겹치면: 새로 알게 된 부분만 기존 기억에 memory_update(append)로 보강하고, 제안은 memory_reject(reason: "중복: <기존 id>에 병합").
   - 일회성 사실, 틀리거나 검증 안 된 내용, 너무 모호한 것: memory_reject(reason에 이유).
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

/** size of the verified memory, shown to the reorganize run so it knows how hard to compress */
export interface MemoryStats {
  entries: number;
  common: number;
  project: number;
  avgTitle: number;
  longTitles: number;
  avgBody: number;
  longBodies: number;
  totalChars: number;
}

/** compression targets for the reorganize run */
export const COMPRESS_TARGETS = { title: 45, commonBody: 600, projectBody: 350, personaBody: 500 };

export function reorganizePrompt(projects: MemoryProjectInfo[], stats?: MemoryStats): string {
  const list = projects.length ? projects.map((p) => `- ${p.key} (${p.name})`).join("\n") : "- (등록된 프로젝트 없음)";
  const t = COMPRESS_TARGETS;
  const now = stats
    ? `지금 상태: 승인된 기억 ${stats.entries}개(공용 ${stats.common}, 프로젝트 ${stats.project}), 전체 ${stats.totalChars.toLocaleString()}자. 제목 평균 ${stats.avgTitle}자(60자 넘는 것 ${stats.longTitles}개), 본문 평균 ${stats.avgBody}자(1500자 넘는 것 ${stats.longBodies}개).`
    : "";
  return `너는 공유 기억(Space Memory)의 관리자다. 이번 일은 승인된(verified) 기억 전체를 "컨텍스트 압축"하듯 다시 분류하고, 합치고, 짧게 줄이는 것이다.
이 기억은 모든 의장과 위원의 지시문에 색인으로 들어가고 매 작업마다 검색된다. 길고 중복된 기억은 토큰을 낭비하고 중요한 것을 가린다. 목표는 같은 지식을 훨씬 적은 글자로, 찾기 쉽게 남기는 것이다.
${now}

목표치
- 항목 수: 지금의 절반 안팎. 같은 주제(같은 도구, 같은 절차, 같은 루틴·시스템, 같은 모델)는 한 항목으로 합친다.
- 제목: ${t.title}자 이내. 나중에 검색할 핵심어 위주의 짧은 문장. 설명·근거·괄호 나열을 빼고 "무엇을 / 어떻게"만 남긴다.
  예) "브라우저 MCP 도구 없이 Windows에서 실제 Chrome 창·마우스로 Gemini 이미지를 원본 그대로 일괄 다운로드하는 방법" → "Gemini 웹 이미지 원본 일괄 다운로드 (Chrome)"
- 본문: 공용 ${t.commonBody}자, 프로젝트 ${t.projectBody}자, 모델 성향 ${t.personaBody}자 이내. "## 문제 / ## 해결 / ## 적용" 세 절을 각각 1~3줄 글머리표로 쓴다.
  남길 것: 정확한 명령, 경로, 옵션, 주소·값, 오류 문구, 하지 말아야 할 것. 지울 것: 경위·발견 과정·날짜별 기록("## 추가 (날짜)" 누적분 포함), 같은 말 반복, 확인 과정 서술, 길게 붙인 로그.

프로젝트 키(project 필드에 쓰는 값):
${list}

순서
1. memory_list(status: verified, limit: 200)로 전부 본다. 제목만으로 주제별 묶음을 먼저 만든다. 묶음마다 memory_read로 본문을 읽는다.
2. 묶음마다 하나만 남긴다: 가장 좋은 항목에 memory_update로 짧은 제목·압축한 본문(body 전체 교체)·scope·tags를 쓰고, 나머지는 memory_retire(id, reason: "압축: <남긴 id>에 병합", merged_into: 남긴 id). 합칠 때 나머지 항목의 고유한 사실(명령·값·주의점)은 빠짐없이 옮긴다.
3. 혼자 남는 항목도 제목과 본문을 목표치로 줄인다(memory_update).
4. scope:
   - common(공용 지식): 다른 프로젝트에서도 그대로 쓰는 것. 공통 도구 사용법(음원·이미지 생성), 크롬으로 웹 서비스에서 결과물 받는 절차, Windows·셸·git·Node·테스트 도구 문제 해결, NAS·계정·GenCouncil 사용법, AI 모델별 성향.
   - project(프로젝트 전용): 한 프로젝트의 코드·데이터·도메인 사실(ROM 주소와 루틴, 게임 규칙, 저장소 구조, 테스트 스크립트). project 값은 위 키 중 하나로 맞춘다.
   - 프로젝트가 붙었어도 내용이 일반적이면 common으로 바꾸고 일반화한다. 프로젝트 예시는 "예: seisen" 한 줄로만 남기고 project 필드는 출처로 둔다.
5. 지운다(memory_retire): 이미 해결되어 다시 쓸 일 없는 일회성 상태, 코드에 이미 반영되어 저장소를 보면 아는 사실의 단순 기록, 틀린 내용, 다른 항목에 완전히 포함된 것.
6. persona(모델 성향)는 모델별로 하나: "잘하는 일 / 실수하는 곳 / 지시 요령"만 짧게.
7. 새 사실을 지어내지 않는다. 줄이면서 뜻을 바꾸지 않는다. 확실하지 않은 사실은 지우지 말고 짧게 남긴다. retire한 항목은 기록으로 보존되므로 과감하게 합쳐도 된다.
8. 끝나면 한국어로 보고한다: 전과 후의 항목 수와 대략 글자 수, 공용/프로젝트별 개수, 병합 n건, 정리 n건, 그리고 크게 합친 주제를 한 줄씩.`;
}

export interface CuratorResult {
  text: string;
  isError: boolean;
  costUsd?: number;
}

export function curatorLogFile(): string {
  return path.join(spaceDir(), "curator", "curator.log");
}

/** Fable relabels every verified entry as common/project knowledge and merges duplicates. */
export function runReorganize(
  projects: MemoryProjectInfo[],
  opts: { account?: string; model?: string; effort?: string; stats?: MemoryStats; onEvent?: (e: ClaudeEvent) => void } = {},
): Promise<CuratorResult> {
  return runCurator({ ...opts, prompt: reorganizePrompt(projects, opts.stats), label: "reorganize" });
}

export function runCurator(opts: { account?: string; model?: string; effort?: string; prompt?: string; label?: string; onEvent?: (e: ClaudeEvent) => void } = {}): Promise<CuratorResult> {
  const accounts = new AccountRegistry();
  const account = opts.account ? accounts.get(opts.account) : accounts.pick("claude");
  const dir = path.join(spaceDir(), "curator");
  fs.mkdirSync(dir, { recursive: true });
  const mcpEnv: Record<string, string> = { GENCOUNCIL_ROLE: "owner", GENCOUNCIL_AGENT: `curator:fable${opts.label ? ":" + opts.label : ""}` };
  if (process.env.GENCOUNCIL_HOME) mcpEnv.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
  const mcpFile = path.join(dir, "mcp.json");
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { gencouncil: { type: "stdio", command: process.execPath, args: [serverEntry()], env: mcpEnv } } }, null, 2),
    "utf8",
  );
  const model = opts.model ?? CURATOR_MODEL;
  const effort = opts.effort ?? CURATOR_EFFORT;
  const args = [
    "-p",
    opts.prompt ?? curatorPrompt(),
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
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
    const proc = wireProcess(child, { cwd, prompt: "", autonomy: "edits" }, (stream, line) => {
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
