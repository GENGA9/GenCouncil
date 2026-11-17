/**
 * One-shot CLI calls that answer a question and exit: the advisor consult and the read-only
 * repository explorer, for every provider.
 *
 * Claude Code has both built in (`--advisor`, `--agents`), so claude members got them for free
 * while Codex and Antigravity members — and every chair that is not Claude — had neither and did
 * the exploring themselves, inside the session that should have been handing work out. These run
 * the same thing as a child process instead, so the tools exist for all three providers.
 *
 * Nothing here can write: the sandbox/tool flags are read-only, and a failure returns an error
 * string rather than throwing, because a failed consult must not kill the caller's turn.
 */
import { agyModelId, claudeModelId, makeAgyParser, parseClaudeLine, parseCodexLine, spawnCli, wireProcess, type ClaudeEvent } from "./drivers.js";
import { LADDERS, type CliProvider } from "./models.js";

/** read-only Claude Code tools for the explorer (the consult runs with no tools at all) */
const EXPLORE_ALLOWED = ["Read", "Glob", "Grep"];
const EXPLORE_DENIED = ["Edit", "Write", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch"];

export interface OneShotSpec {
  provider: CliProvider;
  model?: string;
  effort?: string;
  /** folder the call may read (member worktree, or the chair's integration worktree) */
  cwd: string;
  prompt: string;
  /** account env (CLAUDE_CONFIG_DIR / USERPROFILE / …) */
  env?: Record<string, string>;
  /** "none" = answer from the prompt alone (advisor); "read" = may read the folder (explorer) */
  tools: "none" | "read";
  timeoutMs?: number;
}

export interface OneShotResult {
  text: string;
  seconds: number;
  /** set when the call failed; `text` then holds whatever came out before it did */
  error?: string;
}

function claudeArgs(spec: OneShotSpec): string[] {
  const args = ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--permission-prompts", "none"];
  if (spec.tools === "none") args.push("--tools", "");
  else args.push("--allowedTools", ...EXPLORE_ALLOWED, "--disallowedTools", ...EXPLORE_DENIED, "--add-dir", spec.cwd);
  if (spec.model) args.push("--model", claudeModelId(spec.model));
  if (spec.effort) args.push("--effort", spec.effort);
  return args;
}

function codexArgs(spec: OneShotSpec): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", spec.cwd, "-c", "sandbox_mode='read-only'", "-c", "approval_policy='never'"];
  if (spec.model) args.push("-m", spec.model);
  if (spec.effort) args.push("-c", `model_reasoning_effort='${spec.effort}'`);
  args.push(spec.prompt);
  return args;
}

function agyArgs(spec: OneShotSpec): string[] {
  const args = ["--output-format", "stream-json", "--print", spec.prompt];
  const model = agyModelId(spec.model, spec.effort);
  if (model) args.push("--model", model);
  if (spec.tools === "read") args.push("--add-dir", spec.cwd);
  return args;
}

/**
 * Run one CLI call and return its answer. Never throws and never leaves a process behind: the
 * timeout kills the tree.
 */
export function oneShot(spec: OneShotSpec): Promise<OneShotResult> {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 100) / 10;
  return new Promise((resolve) => {
    const cmd = spec.provider === "claude" ? "claude" : spec.provider === "gpt" ? "codex" : "agy";
    const args = spec.provider === "claude" ? claudeArgs(spec) : spec.provider === "gpt" ? codexArgs(spec) : agyArgs(spec);
    const parse = spec.provider === "claude" ? parseClaudeLine : spec.provider === "gpt" ? parseCodexLine : makeAgyParser();
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    delete env.CLAUDECODE; // a nested Claude Code refuses to start when it thinks it is already inside one
    let child;
    try {
      child = spawnCli(cmd, args, { cwd: spec.cwd, env });
    } catch (e) {
      resolve({ text: "", seconds: secs(), error: `${cmd} 실행 실패: ${(e as Error).message}` });
      return;
    }
    const texts: string[] = [];
    let resultText = "";
    let failed: string | undefined;
    let stderr = "";
    const take = (e: ClaudeEvent) => {
      if (e.kind === "text" && e.text.trim()) texts.push(e.text.trim());
      else if (e.kind === "result") {
        if (e.text.trim()) resultText = e.text.trim();
        if (e.isError) failed = e.text.trim() || "CLI reported an error";
      }
    };
    const proc = wireProcess(child, { cwd: spec.cwd, prompt: spec.prompt, autonomy: "edits" }, (stream, line) => {
      if (stream === "stderr") {
        stderr = (stderr + line + "\n").slice(-2000);
        return;
      }
      for (const e of parse(line)) take(e);
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        proc.stop();
      },
      spec.timeoutMs ?? 300_000,
    );
    void proc.done.then(({ code }) => {
      clearTimeout(timer);
      // the final result line is the answer for claude; codex/agy say it in the last text block
      const text = resultText || texts.at(-1) || texts.join("\n\n");
      const error = timedOut
        ? `시간 초과 (${Math.round((spec.timeoutMs ?? 300_000) / 1000)}초)`
        : (failed ?? (text ? undefined : `${cmd}가 답을 내지 않았다 (exit ${code ?? "?"})${stderr ? ": " + stderr.trim().split("\n").at(-1) : ""}`));
      resolve({ text, seconds: secs(), error });
    });
  });
}

// ---------- what we ask ----------

export interface ConsultInput {
  /** the question, written by the caller */
  question: string;
  /** what the advisor needs to know: plan, error, diff, decision so far */
  context?: string;
  /** who is asking, for the opening line */
  asker: string;
}

export function consultPrompt(i: ConsultInput): string {
  return `너는 제작위원회의 advisor다. ${i.asker}가 판단을 물었다. 코드를 고치지 말고 판단만 돌려준다.

## 질문
${i.question.slice(0, 6000)}
${i.context ? `\n## 맥락\n${i.context.slice(0, 20000)}\n` : ""}
## 답하는 방식
- 결론 먼저, 한 문장. 그 다음 근거 3줄 이내.
- 틀렸다고 보면 무엇이 틀렸고 대신 무엇을 할지 분명히 적는다. 애매한 동의는 도움이 되지 않는다.
- 놓친 위험(깨질 것, 빠진 경우, 되돌리기 어려운 것)이 있으면 그것부터 말한다.
- 맥락이 부족해 판단할 수 없으면 무엇이 더 필요한지만 적는다. 추측으로 답하지 않는다.
- 전체 10줄 이내. 한국어.`;
}

export type ExploreKind = "search" | "grep" | "docs";

const EXPLORE_TASK: Record<ExploreKind, string> = {
  search: "주제와 관련된 파일·폴더를 찾아, 각각 왜 관련되는지 한 줄로 적는다. 중심이 되는 것부터. 경로는 저장소 기준 상대 경로로 쓴다.",
  grep: "주어진 이름·문자열·패턴의 정의와 사용처를 모두 찾아 `경로:줄번호`와 그 줄을 파일별로 묶어 적는다. 정의한 곳을 표시한다.",
  docs: "주어진 API·모듈이 이 저장소에서 어떻게 쓰이는지 찾아 정리한다: 시그니처, 옵션, 예시, 함정. 사실마다 출처 경로를 적는다.",
};

export function explorePrompt(kind: ExploreKind, query: string): string {
  return `너는 읽기 전용 탐색기다. 파일을 고치거나 명령을 실행하지 않는다(그럴 도구도 없다).

## 할 일
${EXPLORE_TASK[kind]}

## 찾을 것
${query.slice(0, 4000)}

## 답하는 방식
경로와 짧은 설명만. 긴 코드 덩어리는 붙이지 않는다(필요하면 묻는 쪽이 직접 읽는다). 못 찾으면 어디를 봤는지 적고 없다고 답한다. 전체 40줄 이내. 한국어.`;
}

/** the cheapest rung of a provider's ladder: what the explorer runs on */
export function explorerModel(provider: CliProvider): string {
  return LADDERS[provider][0].id;
}

/** the strongest rung at or below `cap` (the user's limit): what a consult falls back to */
export function strongestWithin(provider: CliProvider, cap: string | undefined): string {
  const ladder = LADDERS[provider];
  const i = cap ? ladder.findIndex((m) => m.id === cap || m.match.test(cap)) : -1;
  return (i >= 0 ? ladder[i] : ladder[ladder.length - 1]).id;
}

/**
 * Which provider a model id belongs to, by the ladders (undefined when no ladder claims it).
 * Exact ids win over the patterns, and gemini is tried before gpt: "gemini" contains "mini", which
 * the gpt-6-luna pattern matches.
 */
export function providerOfModel(model: string): CliProvider | undefined {
  const order = ["claude", "gemini", "gpt"] as CliProvider[];
  for (const p of order) if (LADDERS[p].some((m) => m.id === model)) return p;
  for (const p of order) if (LADDERS[p].some((m) => m.match.test(model))) return p;
  return undefined;
}
