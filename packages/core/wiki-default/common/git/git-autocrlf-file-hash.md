---
title: core.autocrlf 저장소에서 파일 sha 테스트가 머지·체크아웃 뒤 깨질 때·LF/CRLF 섞인 기존 해시·줄바꿈 의존 코드 변환기
summary: core.autocrlf=true 저장소에서 복사한 LF 파일의 sha256을 고정한 테스트가 다른 worktree·main 체크아웃 뒤 깨지면 어떻게 하고, 이미 LF·CRLF 기준이 섞여 동결된 manifest 해시는 어떻게 검사하며, '\n' marker로 코드를 고치는 변환기가 CRLF 체크아웃에서 코드를 망가뜨리지 않게 하려면 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Windows 저장소가 `core.autocrlf=true`면 LF로 커밋된 텍스트 파일이 다른 worktree나 main에 체크아웃될 때 CRLF로 바뀐다. 파일 바이트의 sha256을 고정한 테스트는 내 worktree에선 통과하고 머지 뒤 깨진다.
줄바꿈에 기대는 코드 변환기(문자열 marker 검색)도 CRLF 체크아웃에서 재실행하면 깨진다.

## 언제 쓰나
- 원본에서 복사한 파일이 그대로인지 sha256으로 검사하는 테스트를 만들 때
- `git add` 때 `LF will be replaced by CRLF` 경고가 보일 때
- 여러 체크아웃에서 이미 동결한 JSON manifest를 검사할 때
- 텍스트 marker를 찾아 코드를 고치는 이관·변환 스크립트를 만들 때

## 방법
### 새 해시 테스트: LF 기준으로 고정
- 확인: `git ls-files --eol <경로>`가 `i/lf w/lf`면 다른 체크아웃에서 `w/crlf`가 된다.
- 테스트는 `read_bytes().replace(b"\r\n", b"\n")` 뒤 해시하고, 기준 해시도 LF 기준으로 둔다. 새 manifest는 파일과 기준 해시 모두 같은 LF 정책으로 고정한다.
- 바이트까지 그대로 고정해야 하는 파일은 `.gitattributes`에 `-text`를 준다.

### 이미 동결한 해시가 LF·CRLF 기준으로 섞였을 때
- 여러 체크아웃에서 동결한 manifest는 어떤 해시는 LF, 다른 해시는 CRLF 바이트 기준일 수 있다. 파일만 LF로 바꿔 비교하면 원래 통과하던 CRLF 기준 항목이 실패한다.
- 기존 동결 해시를 유지해야 하면 세 가지 SHA256(원시 바이트, CRLF→LF, 그 LF→CRLF) 중 하나가 저장된 해시와 일치하는지만 허용한다.
- JSON 값·공백·다른 바이트는 정규화하지 않는다.
- 바이너리·실제 업로드 자산 해시는 원시 바이트 그대로 검사한다.

### 줄바꿈에 기대는 코드 변환기
- `'\n'`을 포함한 문자열로 bootstrap 끝 등을 찾는 변환기는 CRLF 체크아웃에서 marker 검색이 -1이 되어 코드를 훼손할 수 있다.
- marker 검색 전에 CRLF를 LF로 정규화하거나, CRLF/LF 양쪽 marker를 처리한다.
- 회귀 검사: 이미 이관한 파일을 CRLF로 바꾼 뒤 dry-run·재실행·추가 코드 변환이 멱등인지 확인한다.

## 주의할 점
- 내 worktree에서 통과했다고 끝내지 말고, 다른 worktree·main 체크아웃 기준으로 생각한다.
