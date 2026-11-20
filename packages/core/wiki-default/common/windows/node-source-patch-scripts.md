---
title: node로 소스 파일 패치하기: String.replace의 $ 특수 패턴·CRLF 유지·heredoc 한글 앵커 실패
summary: node 스크립트로 소스 파일을 문자열 치환할 때 치환문의 $'·$&·$`가 파일을 깨뜨리거나, CRLF 파일의 여러 줄 치환이 안 맞거나, Git Bash heredoc에 넣은 한글 문자열을 못 찾아 패치가 조용히 빠질 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
node 스크립트로 소스를 고칠 때 `String.prototype.replace`의 치환 문자열은 `$'`·`$&`·`` $` ``를 특수 패턴으로 해석한다. 정규식 리터럴 같은 코드를 치환문에 넣으면 매치 앞/뒤 텍스트가 끼어 파일이 통째로 깨진다. CRLF 파일은 패턴의 `\n`을 `\r\n`으로 맞춰야 한다. Git Bash heredoc으로 넘긴 한글 문자열은 파일 속 같은 문장과 맞지 않을 수 있다.

## 언제 쓰나
- 위원·스크립트가 node `fs`로 소스 파일 일부를 바꿀 때
- 패치 뒤 파일이 이상하게 길어지거나 앞뒤 코드가 중복될 때
- Windows CRLF 파일에서 여러 줄 치환을 할 때
- 한글 주석·메시지가 든 줄을 고칠 때

## 방법
- 치환은 `t.split(a).join(b)`로 한다(특수 패턴 없음). `t.replace(a, b)`는 b에 `$`가 없을 때만.
- CRLF 여러 줄 치환: `fs.readFileSync` → `\r\n` 포함 여부 감지 → 패턴·치환문의 `\n`을 `\r\n`으로 바꿔 치환 → 그대로 쓴다.
- 치환 직전에 `if (!s.includes(a)) throw new Error(...)` 가드를 넣는다. replace·split/join은 못 찾아도 에러가 없어서, 가드가 없으면 패치가 안 들어간 줄 모르고 지나간다. 패치 후 `grep -n`으로 반영을 확인한다.
- 깨진 파일은 `git show HEAD:경로 > 경로`로 복원한다(bash 리다이렉트).
- 임시 파일은 프로젝트 안 상대 경로에 쓰고 끝나면 지운다(Git Bash `/tmp/x.json`은 node에서 현재 드라이브의 `\tmp\x.json`으로 풀려 ENOENT).

### heredoc에 한글 앵커를 넣지 않는다
- Windows Git Bash(Bash 도구)에서 `node - <<'EOF' … s.includes('한글 문장') … EOF`로 패치하면, 파일에 있는 같은 한글 문장을 못 찾는다(includes가 false → `… line not found` 같은 가드 에러, 가드가 없으면 조용히 no-op). 파일 인코딩은 멀쩡하고 stdin으로 넘어간 한글 리터럴이 달라지는 것으로 보인다. 영문만 쓰는 패치(sed -i, 영문 includes)는 정상이다.
- 한글이 든 줄을 고칠 때는 Edit 도구(old_string/new_string)를 쓴다.
- heredoc 패치는 영문 문자열만 앵커로 쓰거나, 스크립트를 Write 도구로 .mjs 파일에 써서 실행한다.

## 주의할 점
- 백슬래시가 많은 스크립트는 heredoc 대신 Write 도구로 파일을 만든다([Claude Code Bash 도구의 이스케이프 함정](common/ai-agents/claude-code-bash-escaping)).
- PowerShell 파이프로 넘긴 한글도 ?로 바뀐다 → [Windows에서 Python 한글이 깨질 때](common/windows/windows-python-korean-encoding).
- 줄끝 확인·복원은 [Windows Git Bash 함정](common/windows/git-bash-windows-pitfalls).
