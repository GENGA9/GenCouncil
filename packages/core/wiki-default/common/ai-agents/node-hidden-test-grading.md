---
title: node --test로 숨긴 테스트 채점: 임시 폴더에서 대상 src 동적 import·TAP '# pass N' 파싱
summary: 에이전트(위원·외부 CLI)가 만든 Node 저장소를 저장소에 흔적 없이 숨긴 테스트로 채점할 때, 테스트 파일을 어디에 두고 대상 코드를 어떻게 불러오며, 통과 수는 node --test 출력에서 어떻게 읽나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
에이전트가 만든 Node 저장소를 숨긴 테스트로 채점하는 방법이다. 숨긴 테스트는 대상 저장소 밖 OS 임시 폴더에서 돌리고, 대상 코드는 경로를 환경변수로 받아 동적 import한다. 통과 수는 TAP 출력의 `# pass N`에서 읽는다.

## 언제 쓰나
- 에이전트·위원이 만든 Node(ESM) 저장소를, 그 저장소에 테스트 흔적을 남기지 않고 채점할 때
- 여러 에이전트 결과를 같은 숨긴 테스트로 비교할 때

## 방법
### 임시 폴더에서 실행
- 숨긴 테스트 파일을 `os.tmpdir()` 아래 새 폴더에 복사해 실행하고, 끝나면 `rmSync`로 지운다. 대상 저장소는 건드리지 않는다.
- 임시 폴더에 `package.json`(`{"type":"module"}`)을 같이 둔다. 없으면 `.js`가 CJS로 해석되어 import에서 문법 오류가 난다.

### 대상 코드 불러오기: 동적 import
- 대상 경로는 환경변수(예: `LEDGER_TARGET`)로 넘긴다.
- 테스트 안에서 `await import(pathToFileURL(join(target, "src", "x.js")).href)`로 읽는다. 정적 import는 쓰지 않는다.
- 없는 export는 `mod.fn`으로 호출하는 그 테스트 안에서만 실패하므로, 파일 전체가 죽지 않고 나머지 테스트가 채점된다.

### 실행과 통과 수 읽기
- `spawnSync(process.execPath, ["--test", "--test-reporter=tap", "hidden.test.js"], {cwd: tmp, env})`.
- stdout에서 정규식 `^# pass (\d+)$`(여러 줄 모드)로 통과 수를 읽는다. 전체 개수는 테스트 파일의 `^test\(` 호출 수로 센다.
- 출력·기대값 비교 전에 `\r\n`을 `\n`으로 바꿔 줄끝 차이를 무시한다.

## 주의할 점
- Windows에서 전역 `core.autocrlf=true`이면 새 채점용 git 저장소에서 "LF will be replaced by CRLF" 경고가 뜬다. 채점용 저장소에는 `git config core.autocrlf false`를 설정한다([core.autocrlf 파일 해시](common/git/git-autocrlf-file-hash)).
- 루트 `npm test`가 node --test 기본 패턴을 쓰면 `**/*.test.js`를 모두 잡는다. 시험 파일이 저장소 안에 있으면 충돌할 수 있으니, 루트 test 스크립트가 파일 목록을 명시하는지 먼저 확인한다.
