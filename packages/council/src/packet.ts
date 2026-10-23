import type { AgendaConfig, MemberRecord, MemberResult, MemoryProposal, ProjectConfig, Task } from "./model.js";

export interface PacketInput {
  project: ProjectConfig;
  agenda: AgendaConfig;
  task: Task;
  member: MemberRecord;
  instructions: string;
  memoryIndex: string;
}

export const MEMBER_PROMPT =
  "당신은 제작위원회의 위원(자율 실행 에이전트)입니다. 작업 패킷이 입력(stdin)으로 전달되었고 .council/TASK.md 에도 같은 내용이 있습니다. " +
  "패킷의 지시를 이 폴더(현재 작업 디렉토리) 안에서 끝까지 수행하고, 변경을 전부 git 커밋한 뒤, 패킷의 양식대로 .council/RESULT.md 를 작성하고 종료하세요.";

export function buildPacket(i: PacketInput): string {
  const goal = i.task.goal && i.agenda.goals[i.task.goal - 1] ? `${i.task.goal}. ${i.agenda.goals[i.task.goal - 1]}` : "(없음)";
  return `# 작업 패킷: ${i.task.title}

- 위원: ${i.member.id} (${i.member.provider}${i.member.model ? ", " + i.member.model : ""})
- 프로젝트: ${i.project.name} / 안건: ${i.agenda.title}
- 작업 폴더(worktree): ${i.member.worktree}
- 내 브랜치: ${i.member.branch} (베이스: ${i.agenda.branch})
- 관련 목표: ${goal}

## 지시 (의장)

${i.instructions.trim()}

## 작업 설명

${i.task.description.trim() || "(위 지시 참고)"}

## 규칙
${i.project.localGit ? `
0. 이 작업 폴더에는 git이 관리하는 파일만 있다. 파이썬 가상환경, 실행 파일·라이브러리, 큰 이미지·영상·압축·모델 파일은 원본 폴더(${i.project.repo})에만 있다. 그런 파일이 필요하면 원본 경로에서 읽기만 하고, 원본 폴더에는 절대 쓰지 않는다.
` : ""}
1. 현재 폴더 안에서만 작업한다. 상위 폴더, 다른 worktree, 다른 브랜치를 건드리지 않는다. \`git checkout\`, \`git switch\`, \`git merge\`, \`git rebase\`, \`git push\` 는 금지.
2. 완료하면 \`git add -A && git commit -m "${i.task.title}: <요약>"\` 으로 전부 커밋한다. 중간 커밋을 여러 번 해도 된다. \`.council/\` 폴더는 커밋하지 않는다(이미 제외되어 있다).
3. 마지막에 \`.council/RESULT.md\` 를 아래 양식으로 작성한다.
4. 재사용 가치가 있는 발견(비자명한 해결책, 도구 위치, 규약)은 \`memory_propose\` 도구가 있으면 그걸로, 없으면 RESULT.md의 '기억 제안' 절에 적는다. 다른 프로젝트에서도 쓰는 지식(공통 도구 사용법, 외부 서비스 절차, 환경 문제)은 scope: common으로, 이 프로젝트 코드·데이터에만 맞는 사실은 scope: project로 제안한다. 작업을 시작할 때 쓸 도구·절차가 있으면 먼저 \`memory_search\`로 찾는다.
5. 막히면 억지로 진행하지 말고 RESULT.md의 '미완료·막힌 점'에 이유를 쓰고 종료한다.
6. 사용자에게 질문할 수 없다. 모호하면 패킷의 완료 조건을 가장 보수적으로 해석해서 진행하고, 가정을 RESULT.md에 적는다.
7. 의미 있는 단계가 끝날 때마다 \`.council/STATE.md\` 를 갱신한다(한 일 / 남은 일 / 주의할 점, 10줄 이내). 세션이 한도로 끊기면 다른 위원이 이 파일과 커밋을 보고 이어받는다. 큰 단계가 끝나면 중간 커밋도 한다.
8. 역할 분담: 탐색은 서브에이전트에게, 결정은 advisor에게. \`search\`(관련 파일 찾기), \`grep\`(정의·호출처), \`docs\`(API 레퍼런스) 서브에이전트가 있으면 저장소를 직접 뒤지지 말고 그들에게 맡겨 병렬로 돌린다. advisor 도구가 있으면 세 시점에 반드시 상담한다: (a) 계획을 확정하기 전 (b) 같은 오류가 두 번째 나왔을 때 (c) 완료라고 선언하기 전.

## RESULT.md 양식

\`\`\`markdown
## 결과
(무엇을 했는지 3~6줄. 완료 조건을 어떻게 확인했는지 포함)

## 변경 파일
- path/to/file: 한 줄 설명

## 미완료·막힌 점
없음  (또는 구체적으로)

## 기억 제안
### <나중에 검색할 문장으로 된 제목>
type: solution
tags: a, b
(문제 / 해결 / 적용 방법)
\`\`\`

## 공유 기억 색인 (자세한 내용은 memory_search / memory_read)

${i.memoryIndex.trim()}
`;
}

export interface HandoverInput {
  original: string;
  fromMember: string;
  toMember: string;
  reason: string;
  stateMd: string;
  commits: string[];
  diffstat: string;
  uncommitted: string;
  previousResult?: string;
}

/** Packet for a member that continues another member's work in the same worktree/branch. */
export function buildHandoverPacket(i: HandoverInput): string {
  return `# 인계 패킷: ${i.fromMember} → ${i.toMember}

이전 위원(${i.fromMember})이 아래 작업을 하다가 중단되었다 (${i.reason}).
당신(${i.toMember})은 **같은 작업 폴더, 같은 브랜치**에서 이어받는다. 처음부터 다시 하지 말고 남은 부분만 한다.

## 먼저 할 일
1. \`git log --oneline -10\`, \`git status\`, \`git diff\` 로 지금까지의 커밋과 미커밋 변경을 확인한다.
2. \`.council/STATE.md\`(아래 복사본)와 이미 있으면 \`.council/RESULT.md\` 를 읽는다.
3. 남은 일을 끝내고, 원래 패킷의 규칙대로 커밋 + RESULT.md 를 작성한다.

## 이전 위원의 STATE.md
${i.stateMd.trim() || "(없음)"}

## 지금까지의 커밋 (안건 브랜치 이후)
${i.commits.length ? i.commits.map((c) => `- ${c}`).join("\n") : "(없음)"}

## diffstat
${i.diffstat || "(변경 없음)"}

## 미커밋 변경 (git status --porcelain)
${i.uncommitted.trim() || "(없음)"}
${i.previousResult ? `\n## 이전 위원의 RESULT.md (미완성일 수 있음)\n${i.previousResult.trim()}\n` : ""}
---

# 원래 작업 패킷

${i.original.trim()}
`;
}

// ---------- RESULT.md parsing ----------

function sections(md: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  const lines = md.split(/\r?\n/);
  let cur: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push({ title: cur.title, body: cur.body.join("\n").trim() });
      cur = { title: m[1], body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push({ title: cur.title, body: cur.body.join("\n").trim() });
  return out;
}

function pick(secs: Array<{ title: string; body: string }>, ...keys: string[]): string {
  const hit = secs.find((s) => keys.some((k) => s.title.toLowerCase().includes(k.toLowerCase())));
  return hit?.body ?? "";
}

export function parseProposals(text: string): MemoryProposal[] {
  const out: MemoryProposal[] = [];
  const blocks = text.split(/^###\s+/m).slice(1);
  for (const b of blocks) {
    const [titleLine, ...rest] = b.split(/\r?\n/);
    const title = titleLine.trim();
    if (!title) continue;
    let type = "solution";
    let tags: string[] | undefined;
    const bodyLines: string[] = [];
    for (const line of rest) {
      const t = /^type:\s*(\w+)/i.exec(line);
      const g = /^tags:\s*(.+)/i.exec(line);
      if (t && bodyLines.length === 0) type = t[1].toLowerCase();
      else if (g && bodyLines.length === 0) tags = g[1].split(",").map((s) => s.trim()).filter(Boolean);
      else bodyLines.push(line);
    }
    const body = bodyLines.join("\n").trim();
    if (body.length >= 10) out.push({ title, type, tags, body });
  }
  return out;
}

export function parseResult(md: string): MemberResult {
  const secs = sections(md);
  return {
    summary: pick(secs, "결과", "summary", "result"),
    changedFiles: pick(secs, "변경", "changed", "files"),
    unfinished: pick(secs, "미완료", "막힌", "unfinished", "blocked", "todo"),
    proposals: parseProposals(pick(secs, "기억", "memory", "proposal")),
    raw: md,
  };
}
