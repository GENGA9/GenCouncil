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
   - 재사용 가치가 있고 정확하면: 필요하면 memory_update로 제목(나중에 검색할 문장), 본문("문제 / 해결 / 적용 방법" 구조, 명령·경로 그대로), tags(소문자 키워드)를 다듬은 뒤 memory_approve.
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

export function reorganizePrompt(projects: MemoryProjectInfo[]): string {
  const list = projects.length ? projects.map((p) => `- ${p.key} (${p.name})`).join("\n") : "- (등록된 프로젝트 없음)";
  return `너는 공유 기억(Space Memory)의 관리자다. 이번 일은 이미 승인된(verified) 기억 전체를 다시 분류하고 정리하는 것이다. 목표는 모든 프로젝트가 함께 쓸 공용 지식이 잘 보이고, 프로젝트 전용 팁은 그 프로젝트에만 붙게 하는 것이다.

프로젝트 키(project 필드에 쓰는 값):
${list}

1. memory_list(status: verified, limit: 200)로 전부 본다. 필요한 것은 memory_read로 본문을 읽는다.
2. 항목마다 scope를 정해 memory_update로 기록한다.
   - common(공용 지식): 다른 프로젝트에서도 그대로 쓸 수 있는 것. 예: 공통 도구 사용법(음원 생성 도구, 이미지 생성 절차), 크롬으로 웹 서비스(제미나이 웹 등)에서 결과물을 받는 절차, Windows·셸·git·Node·테스트 도구 문제 해결, NAS·계정·GenCouncil 사용법, AI 모델별 성향.
   - project(프로젝트 전용): 한 프로젝트의 코드·데이터·도메인에만 맞는 사실. 예: ROM 주소와 루틴, 게임 규칙, 그 저장소의 파일 구조와 테스트 스크립트.
   - 프로젝트가 붙어 있어도 내용이 일반적이면 common으로 바꾸고, 제목과 본문을 그 프로젝트를 몰라도 이해되게 일반화한다(프로젝트 예시는 "예: seisen에서는 …" 한 줄로 남긴다). project 필드는 출처로 그대로 둔다.
   - project로 남는 항목은 project 값을 위 프로젝트 키 중 하나로 맞춘다(대소문자·별칭 통일).
3. 겹치는 항목은 하나로 합친다. 가장 좋은 항목을 남겨 memory_update(body)로 두 내용을 모두 담은 본문을 쓰고, 나머지는 memory_retire(id, reason, merged_into: 남긴 id).
4. 틀렸거나 이미 의미가 없어진 일회성 상태 기록은 memory_retire(reason에 이유).
5. persona(모델 성향)는 모델별로 하나씩 남도록 합친다. 프로젝트 특화 관찰은 "예:"로 줄인다.
6. 기억을 새로 지어내지 않는다. 있는 내용만 옮기고 다듬는다. 모르는 사실을 추가하지 않는다.
7. 끝나면 한국어로 보고한다: 공용 n개, 프로젝트별 n개, 병합 n건, 정리(retire) n건, 그리고 common으로 바꾼 항목과 병합한 항목을 한 줄씩.`;
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
export function runReorganize(projects: MemoryProjectInfo[], opts: { account?: string; model?: string; effort?: string; onEvent?: (e: ClaudeEvent) => void } = {}): Promise<CuratorResult> {
  return runCurator({ ...opts, prompt: reorganizePrompt(projects), label: "reorganize" });
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
