/**
 * Relay members: a web AI that cannot see the repository. The packet bundles the files
 * it needs; the answer comes back as FILE blocks the server applies to the worktree.
 */
import fs from "node:fs";
import path from "node:path";

export const RELAY_FORMAT = `## 답변 양식 (반드시 이 양식으로)

바꾸거나 새로 만드는 파일마다 아래 블록을 쓴다. 파일 전체 내용을 넣는다(부분 diff 금지). 블록 밖의 설명은 무시된다.

=== FILE: 상대/경로/파일명 ===
(파일 전체 내용)
=== END ===

마지막에 결과 보고 블록을 쓴다.

=== RESULT ===
## 결과
(무엇을 했는지 3~6줄)
## 변경 파일
- 경로: 한 줄 설명
## 미완료·막힌 점
없음
## 기억 제안
(없으면 "없음")
=== END ===

파일을 바꿀 필요가 없는 작업(리서치, 리뷰)이면 RESULT 블록만 쓴다. 파일 삭제가 필요하면 RESULT의 '변경 파일'에 "삭제: 경로"라고 적는다(사람이 처리).`;

const MAX_FILE_CHARS = 60_000;

export function bundleFiles(worktree: string, files: string[]): string {
  const parts: string[] = [];
  for (const rel of files) {
    const abs = path.resolve(worktree, rel);
    if (!abs.startsWith(path.resolve(worktree))) continue;
    if (!fs.existsSync(abs)) {
      parts.push(`=== FILE: ${rel} ===\n(파일 없음: 새로 만들어야 함)\n=== END ===`);
      continue;
    }
    if (fs.statSync(abs).isDirectory()) {
      const list = fs.readdirSync(abs).map((f) => `${rel.replace(/\/$/, "")}/${f}`).join("\n");
      parts.push(`=== DIR: ${rel} ===\n${list}\n=== END ===`);
      continue;
    }
    let text = fs.readFileSync(abs, "utf8");
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + `\n… (truncated, ${text.length} chars)`;
    parts.push(`=== FILE: ${rel} ===\n${text}\n=== END ===`);
  }
  return parts.join("\n\n");
}

export interface RelayResponse {
  files: Array<{ path: string; content: string }>;
  result?: string;
}

/** Parse "=== FILE: p ===" / "=== RESULT ===" blocks; tolerant of code fences around block bodies. */
export function parseRelayResponse(text: string): RelayResponse {
  const out: RelayResponse = { files: [] };
  const re = /^===\s*(FILE:\s*(.+?)|RESULT)\s*===\s*\r?\n([\s\S]*?)^===\s*END\s*===/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let body = m[3].replace(/\r\n/g, "\n");
    // strip a wrapping code fence if the AI added one
    body = body.replace(/^```[\w-]*\n/, "").replace(/\n```\s*$/, "");
    if (m[2]) {
      const p = m[2].trim().replace(/^[`'"]|[`'"]$/g, "");
      if (p && !p.includes("..") && !path.isAbsolute(p)) out.files.push({ path: p, content: body.endsWith("\n") ? body : body + "\n" });
    } else {
      out.result = body.trim();
    }
  }
  return out;
}

export function applyRelayFiles(worktree: string, files: RelayResponse["files"]): string[] {
  const written: string[] = [];
  const root = path.resolve(worktree);
  for (const f of files) {
    const abs = path.resolve(root, f.path);
    if (!abs.startsWith(root)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
    written.push(f.path);
  }
  return written;
}
