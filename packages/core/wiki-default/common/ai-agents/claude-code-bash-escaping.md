---
title: Claude Code Bash 도구의 이스케이프 함정: heredoc \n·역슬래시 두 개가 하나로·따옴표 파싱 실패·백틱·CRLF 바늘(횟수 검사 치환)
summary: Bash 도구로 heredoc·node -e·py -에 코드나 마크다운을 넣을 때 \n이 실제 줄바꿈이 되거나 역슬래시 두 개가 하나로 줄어 생성 코드가 SyntaxError·치환 실패가 나고, 작은따옴표·백틱 때문에 셸 파싱이 끊기거나 명령으로 실행되며, CRLF 파일에서 여러 줄 바늘이 안 맞는 것을 어떻게 피하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Claude Code의 Bash 도구 호출 문자열은 셸에 닿기 전에 이스케이프가 풀릴 수 있다. heredoc이나 `node -e "..."`·`py - <<'EOF'`로 코드·마크다운을 쓰면 조용히 내용이 바뀌거나 셸이 일부를 명령으로 실행한다.
역슬래시·백틱·작은따옴표가 든 코드나 긴 스크립트는 Write/Edit 도구로 파일을 만들어 실행하는 것이 기본이다.

## 언제 쓰나
- Python·JS 소스, 정규식, TSX 문자열 리터럴을 셸 명령 안에서 만들 때
- node·python 변환 스크립트를 heredoc(`node - <<'EOF'`, `py - <<'EOF'`)으로 넘겨 다른 소스를 고칠 때
- 보고서·마크다운을 셸로 파일에 쓸 때

## 방법
- 백슬래시가 든 코드·긴 스크립트는 Write/Edit 도구로 스크립트 파일(예: `.council/` 아래)을 만들어 `node 파일`·`python 파일`로 돌린다(heredoc 금지). 대상 파일을 Write로 통째로 다시 쓰거나, 백슬래시가 든 치환은 Edit 도구로 하는 편이 가장 안전하다.
- heredoc 안에서 꼭 써야 하면 백슬래시는 `chr(92)`로 만들거나(`chr(92)+'n'`), 백슬래시 없는 앵커 문자열로 찾는다.
- 보고서·마크다운은 Write 도구로 쓰거나 `<<'EOF'` 따옴표 heredoc을 쓴다.
- 고친 JS는 `node --check 파일`로 확인한다. 작은따옴표 JS 문자열 안에 영어 소유격(예: Tom's)을 넣을 때는 `\'`로 이스케이프한다.
- core.autocrlf=true 작업 폴더의 파일은 CRLF라 여러 줄 바늘로 includes/replace하면 안 맞는다 → 읽어서 `\r`을 지우고(LF로) 바꾼 뒤, 원래 CRLF였으면 다시 CRLF로 써 준다. 치환마다 맞은 횟수를 검사해 0회(또는 기대와 다르면)면 멈춘다. 치환 일반은 [node로 소스 파일 패치하기](common/windows/node-source-patch-scripts).

### 횟수 검사 치환 도우미 (예)
```js
// .council/lib-rep.mjs
import fs from 'node:fs';
export function editFile(p, fn){ let s=fs.readFileSync(p,'utf8'); const crlf=s.includes('\r\n'); s=s.split('\r').join('');
  const api={ rep(a,b,cnt=1){ const n=s.split(a).length-1; if(cnt==='all'?n<1:n!==cnt) throw new Error(p+': '+n+'회'); s=s.split(a).join(b);} };
  fn(api); fs.writeFileSync(p, crlf ? s.split('\n').join('\r\n') : s); }
```
- `split/join`은 String.replace의 `$` 특수 패턴 문제도 피한다.

## 주의할 점
- heredoc으로 쓴 Python 소스의 `'\n'`이 실제 개행이 되어 생성한 TSX 문자열 리터럴이 깨진 일이 있다.
- 따옴표 heredoc(`<<'EOF'`)인데도 역슬래시 두 개가 하나로 줄어든다(Windows Git Bash). 정규식 `\\`가 `\`로 줄어 역슬래시 차단이 조용히 빠졌고, node 변환 스크립트 안의 백슬래시 두 개 + n(글자 그대로의 `\n`)이 백슬래시 하나 + n이 되어 생성 코드의 문자열이 실제 줄바꿈으로 끊기며 SyntaxError, `s.includes(...)` 바늘도 안 맞아 'missing' 오류가 났다. 파이썬 heredoc에서는 `'\\n'`·`\\d`가 하나로 들어가 `SyntaxWarning: invalid escape`와 치환 assert 실패가 난다. 백슬래시 하나(백틱·`${` 이스케이프)는 그대로 들어간다. heredoc으로 썼다면 Grep으로 `\\`를 재확인하고, 보안 검사 정규식엔 테스트를 붙인다.
- 긴 문자열 안에 작은따옴표·백틱이 섞이면 따옴표 heredoc이어도 `unexpected EOF while looking for matching '`로 셸 파싱이 실패하거나 중간에 끊긴다("here-document delimited by end-of-file").
- 큰따옴표 문자열(`node -e "..."`)이나 따옴표 없는 heredoc 안에 백틱 든 마크다운(예: `npm test`)을 넣으면 셸이 명령 치환으로 그 명령을 실행한다.
- Git Bash의 `grep -c $'\r'`는 CR을 0으로 셀 수 있다 → CR 개수는 node로 readFileSync 한 뒤 `/\r/g` 매치 수로 센다.
- CDP evaluate 문자열 안 줄바꿈은 `String.fromCharCode(10)`으로 대체한다.
