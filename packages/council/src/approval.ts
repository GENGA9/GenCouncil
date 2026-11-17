/**
 * "Chair approves" autonomy: a claude member runs with --permission-prompt-tool pointed at
 * the council; every permission request lands here. Obvious cases are decided by rules,
 * the rest by a one-shot call to the chair's model (same account), so the user doesn't
 * have to sit at the PC.
 */
import type { Account } from "./accounts.js";
import { claudeModelId, spawnCli, wireProcess } from "./drivers.js";

export interface PermissionRequest {
  memberId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** context for the reviewer */
  task: string;
  worktree: string;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  reason: string;
  by: "rule" | "chair" | "cache";
}

/** read-only or build/test commands that never need a second look */
const SAFE_COMMANDS: RegExp[] = [
  /^\s*git\s+(status|log|diff|show|add|commit|rev-parse|ls-files|branch\s+(--show-current|-a|--list)?\s*$|stash\s+list)\b/i,
  /^\s*(ls|dir|pwd|cat|type|head|tail|wc|echo|where|which|find|grep|rg|tree)\b/i,
  /^\s*(node\s+--test|node\s+--version|npm\s+(test|run\s+(test|build|lint|typecheck|check))|npx\s+(tsc|vitest|jest|eslint|prettier\s+--check)|tsc|pnpm\s+(test|build|lint)|yarn\s+(test|build|lint))\b/i,
  /^\s*(pytest|python\s+-m\s+(pytest|unittest|py_compile)|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|dotnet\s+(build|test))\b/i,
];

/** never allowed for a member, whatever the chair says */
const FORBIDDEN_COMMANDS: RegExp[] = [
  /\bgit\s+(push|checkout|switch|merge|rebase|reset\s+--hard|clean\s+-[a-z]*f|worktree|remote|config\s+--global)\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?\s+["']?(\/|~|[a-z]:[\\/]?["']?\s*($|[;&|])|\.\.)/i,
  /\b(format|shutdown|reboot|diskpart|reg\s+(add|delete)|schtasks|netsh|Set-ExecutionPolicy)\b/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|powershell|pwsh|iex|cmd)\b/i,
];

/** options that turn a read-only command into one that runs or deletes something */
const UNSAFE_OPTIONS: RegExp[] = [
  /^\s*find\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/i,
  /^\s*(rg|grep)\b.*\s--pre(=|\s)/i,
  /^\s*git\s+(diff|log|show)\b.*\s(--output(=|\s)|--ext-diff\b)/i,
  /^\s*git\s+(-c|--exec-path|-C)\b/i,
];

/**
 * A command line the rules may allow without a second look: every command in it is on the safe
 * list. It is cut at everything a shell cuts at (`&&`, `||`, `;`, a lone `&`, a pipe, a line break),
 * so `ls & rm -rf x` and `cat f | sh` are judged by their second half too. Anything that can run a
 * command the list never sees (substitution, a redirect into a file) is left for the reviewer.
 */
function isSafeCommandLine(cmd: string): boolean {
  // the two harmless redirects members use all the time
  const plain = cmd.replace(/\s*\d?>&\d\b/g, " ").replace(/\s*\d?>\s*(\/dev\/null|nul)\b/gi, " ");
  if (/[`<>]|\$\(|\$\{|<\(|>\(/.test(plain)) return false;
  const parts = plain.split(/&&|\|\||[;&|\r\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => SAFE_COMMANDS.some((re) => re.test(p)) && !UNSAFE_OPTIONS.some((re) => re.test(p)));
}

export function ruleDecision(req: Pick<PermissionRequest, "toolName" | "input">): PermissionDecision | undefined {
  const cmd = typeof req.input.command === "string" ? req.input.command : undefined;
  if (cmd) {
    if (FORBIDDEN_COMMANDS.some((re) => re.test(cmd))) return { behavior: "deny", reason: "위원에게 금지된 명령 (브랜치 이동·push·광역 삭제·시스템 변경 등)", by: "rule" };
    if (isSafeCommandLine(cmd)) return { behavior: "allow", reason: "읽기·빌드·테스트 명령", by: "rule" };
    return undefined;
  }
  // the member's own read-only helpers: the explorer and the advisor consult cannot change anything
  if (/^(Read|Glob|Grep|LS|TodoWrite|Task|mcp__council_member__(consult|explore)|mcp__gencouncil__memory_(search|read|index|list|propose))$/.test(req.toolName)) {
    return { behavior: "allow", reason: "읽기 전용 도구", by: "rule" };
  }
  return undefined;
}

function reviewerPrompt(req: PermissionRequest): string {
  return `너는 제작위원회의 의장이다. 위원 ${req.memberId}가 아래 도구 실행 허가를 요청했다. 사용자를 대신해 허가 여부를 정하라.

작업: ${req.task.slice(0, 1500)}
위원 작업 폴더(이 밖은 건드리면 안 된다): ${req.worktree}
요청 도구: ${req.toolName}
입력: ${JSON.stringify(req.input).slice(0, 3000)}

허가 기준:
- 작업에 필요하고, 영향이 작업 폴더 안에 머물면 허가한다 (패키지 설치, 빌드, 테스트, 스크립트 실행, 작업 폴더 안 파일 생성·삭제).
- 거절: 작업 폴더 밖 파일 수정·삭제, 시스템·계정 설정 변경, 비밀정보 읽기·전송, 외부로 데이터 업로드, git 브랜치 이동·push·merge, 작업과 무관한 것.
- 애매하면 거절하고 이유에 대안을 적는다.

JSON 한 줄로만 답하라: {"behavior":"allow"|"deny","reason":"한 문장"}`;
}

/** Ask the chair's model once. Never throws: failures deny. */
export function chairReview(req: PermissionRequest, opts: { model?: string; env: Record<string, string>; timeoutMs?: number }): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    const args = ["-p", reviewerPrompt(req), "--output-format", "json", "--tools", "", "--strict-mcp-config", "--permission-prompts", "none", "--effort", "low"];
    if (opts.model) args.push("--model", claudeModelId(opts.model));
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    delete env.CLAUDECODE;
    let out = "";
    let child;
    try {
      child = spawnCli("claude", args, { cwd: req.worktree, env });
    } catch (e) {
      resolve({ behavior: "deny", reason: `의장 검토 실행 실패: ${(e as Error).message}`, by: "chair" });
      return;
    }
    const proc = wireProcess(child, { cwd: req.worktree, prompt: "", autonomy: "edits" }, (stream, line) => {
      if (stream === "stdout") out += line + "\n";
    });
    const timer = setTimeout(() => proc.stop(), opts.timeoutMs ?? 120_000);
    void proc.done.then(() => {
      clearTimeout(timer);
      let text = out;
      try {
        const j = JSON.parse(out) as { result?: string };
        if (typeof j.result === "string") text = j.result;
      } catch {
        /* plain text */
      }
      const m = /\{[^{}]*"behavior"\s*:\s*"(allow|deny)"[^{}]*\}/.exec(text);
      if (!m) {
        resolve({ behavior: "deny", reason: `의장 응답을 해석하지 못함: ${text.slice(0, 200)}`, by: "chair" });
        return;
      }
      try {
        const d = JSON.parse(m[0]) as { behavior: "allow" | "deny"; reason?: string };
        resolve({ behavior: d.behavior, reason: d.reason ?? "", by: "chair" });
      } catch {
        resolve({ behavior: m[1] as "allow" | "deny", reason: "", by: "chair" });
      }
    });
  });
}

export type Reviewer = (req: PermissionRequest) => Promise<PermissionDecision>;

export class ChairApprover {
  private cache = new Map<string, PermissionDecision>();

  constructor(
    private readonly review: Reviewer,
    private readonly onDecision?: (req: PermissionRequest, d: PermissionDecision) => void,
  ) {}

  async decide(req: PermissionRequest): Promise<PermissionDecision> {
    const key = `${req.memberId}\u0000${req.toolName}\u0000${JSON.stringify(req.input)}`;
    let d = this.cache.get(key);
    if (d) d = { ...d, by: "cache" };
    else {
      d = ruleDecision(req) ?? (await this.review(req));
      if (d.by === "chair") this.cache.set(key, d);
    }
    this.onDecision?.(req, d);
    return d;
  }
}

/** Response body Claude Code expects from a --permission-prompt-tool. */
export function permissionToolResult(d: PermissionDecision, input: Record<string, unknown>): string {
  return JSON.stringify(d.behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `의장 거절: ${d.reason}` });
}

export function chairEnvFor(account: Account | undefined, env: (a: Account | undefined) => Record<string, string>): Record<string, string> {
  return env(account);
}
