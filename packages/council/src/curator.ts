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

export function reorganizePrompt(projects: MemoryProjectInfo[], stats?: MemoryStats, retireBudget?: number): string {
  const list = projects.length ? projects.map((p) => `- ${p.key} (${p.name})`).join("\n") : "- (등록된 프로젝트 없음)";
  const t = COMPRESS_TARGETS;
  const now = stats
    ? `지금 상태: 승인된 기억 ${stats.entries}개(공용 ${stats.common}, 프로젝트 ${stats.project}), 전체 ${stats.totalChars.toLocaleString()}자. 제목 평균 ${stats.avgTitle}자(60자 넘는 것 ${stats.longTitles}개), 본문 평균 ${stats.avgBody}자(1500자 넘는 것 ${stats.longBodies}개).`
    : "";
  return `너는 공유 기억(Space Memory)의 관리자다. 이번 일은 승인된(verified) 기억을 "찾기 쉽고 짧게" 정리하는 것이다. 목표는 지식을 줄이는 것이 아니라 같은 지식을 더 잘 찾히게 하는 것이다. 이 정리는 여러 번 반복해서 돌려도 지식이 줄면 안 된다.
${now}

원칙
- 항목 수 목표는 없다. 지식의 양(서로 다른 사실·절차의 수)을 그대로 지킨다. 줄이는 것은 반복된 말과 경위뿐이다.
- 한 항목 = 한 주제(한 도구, 한 절차, 한 시스템·루틴, 한 모델). 제목에 서로 다른 주제가 "·"로 3개 넘게 나열되어 있거나, 본문이 여러 주제를 다루면 그 항목은 주제별로 **나눈다**.
- 합치는 것은 **같은 절차·같은 사실이 실제로 겹칠 때만**이다. 비슷한 분야라는 이유로 다른 주제를 한 항목에 묶지 않는다.
- 제목: ${t.title}자 이내, 나중에 검색할 핵심어 문장.
- 본문: 공용 ${t.commonBody}자, 프로젝트 ${t.projectBody}자, 모델 성향 ${t.personaBody}자 안팎. "## 문제 / ## 해결 / ## 적용" 각 1~3줄 글머리표. 정확한 명령·경로·옵션·주소·값·오류 문구·하지 말 것은 반드시 남긴다. 경위·날짜별 기록·반복은 지운다. 한 주제인데 사실이 많아 길어지면 줄이려고 사실을 빼지 말고, 하위 주제로 나눈다.
- 이미 위 기준을 만족하는 항목은 건드리지 않는다. 고칠 것이 없으면 "변경 없음"이라고 보고하고 끝낸다.

프로젝트 키(project 필드에 쓰는 값):
${list}

순서
1. memory_list(status: verified, limit: 200)로 전부 본다. 기준을 넘는 항목(여러 주제를 묶은 것, 너무 긴 것, 제목이 긴 것)과 진짜 중복만 고른다.
2. 여러 주제를 묶은 항목을 나눌 때:
   - memory_read로 본문을 읽는다. 예전에 이 항목으로 합쳐진 원본들도 찾아 읽는다: memory_list(status: rejected, limit: 200)에서 mergedInto가 이 항목 id인 것. 합치면서 빠졌던 세부 사실(명령·주소·값)을 거기서 되살린다.
   - 주제마다 memory_write로 새 항목을 만든다(type, scope, project, tags를 원래대로 맞추고, 제목·본문은 위 기준).
   - 새 항목을 모두 만든 뒤에 원래 항목을 memory_retire(id, reason: "분할: <새 id들>")로 정리한다. 나눈 항목의 사실이 새 항목들에 빠짐없이 들어갔는지 먼저 확인한다.
3. 진짜 중복을 합칠 때: 남길 항목에 memory_update(body)로 두 쪽의 고유한 사실을 모두 담고, 나머지는 memory_retire(id, reason: "중복: <남긴 id>", merged_into: 남긴 id).
4. 혼자 너무 긴 항목은 memory_update로 경위·반복만 지워 줄인다. 사실은 지우지 않는다.
5. scope: common(다른 프로젝트에서도 그대로 쓰는 것: 공통 도구 사용법, 외부 서비스 절차, OS·셸·git·Node·테스트 도구 문제, NAS·계정·GenCouncil 사용법, 모델 성향) / project(한 프로젝트의 코드·데이터·도메인 사실). project 값은 위 키 중 하나로.
6. 틀린 것이 확실한 항목만 이유를 적어 memory_retire 한다. "오래돼 보인다"는 이유로는 지우지 않는다.${retireBudget ? `
7. 이번 정리에서 분할 외의 정리(합치기·삭제)는 최대 ${retireBudget}개까지만 된다. 그 이상은 도구가 거절한다. 거절되면 더 합치지 말고 나누기·줄이기만 한다.` : ""}
8. 새 사실을 지어내지 않는다. 뜻을 바꾸지 않는다.
9. 끝나면 한국어로 보고한다: 전과 후의 항목 수, 나눈 항목(원래 → 새 항목들), 합친 항목, 줄이기만 한 항목, 되살린 세부 사실이 있으면 그 내용.`;
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
  // merges and deletions per run are capped so repeated runs cannot shrink the memory; splits do not count
  const retireBudget = Math.max(5, Math.ceil((opts.stats?.entries ?? 25) * 0.2));
  return runCurator({ ...opts, prompt: reorganizePrompt(projects, opts.stats, retireBudget), label: "reorganize", retireBudget });
}

export function runCurator(
  opts: { account?: string; model?: string; effort?: string; prompt?: string; label?: string; retireBudget?: number; onEvent?: (e: ClaudeEvent) => void } = {},
): Promise<CuratorResult> {
  const accounts = new AccountRegistry();
  const account = opts.account ? accounts.get(opts.account) : accounts.pick("claude");
  const dir = path.join(spaceDir(), "curator");
  fs.mkdirSync(dir, { recursive: true });
  const mcpEnv: Record<string, string> = { GENCOUNCIL_ROLE: "owner", GENCOUNCIL_AGENT: `curator:fable${opts.label ? ":" + opts.label : ""}` };
  if (process.env.GENCOUNCIL_HOME) mcpEnv.GENCOUNCIL_HOME = process.env.GENCOUNCIL_HOME;
  if (opts.retireBudget) mcpEnv.GENCOUNCIL_RETIRE_BUDGET = String(opts.retireBudget);
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
