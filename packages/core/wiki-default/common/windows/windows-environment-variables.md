---
title: Windows 환경변수 함정: 바꾼 사용자 PATH가 같은 세션에 안 보임·WMI로 띄운 프로세스(bg.mjs)는 셸 env를 못 받음(node 래퍼·파이썬 os.environ+runpy 래퍼·원래 환경 그대로 재시작은 env JSON+subprocess 래퍼)·bg.mjs 실행 파일은 전체 경로를 슬래시로 또는 8.3 짧은 경로(spawn ENOENT)·PROMPT엔 "$P$G"가 들어 있음
summary: 사용자 PATH를 바꿨는데 같은 세션의 자식 프로세스가 "없다"고 하거나, 셸에서 export한 PYTHONPATH·RUN_TAG·출력 폴더 같은 값이 bg.mjs 같은 WMI 기동 백그라운드 프로세스에서 안 보여 ModuleNotFoundError·ENOENT가 나거나 스크립트가 기본값(옛 입력)으로 돌거나, 실행 중 서버(ComfyUI 등)를 psutil environ()으로 읽은 원래 환경 그대로 bg.mjs로 재시작해야 하거나, bg.mjs로 띄운 node가 'spawn C:\Program Files\nodejs\node ENOENT'로 즉시 죽거나, 스크립트가 env PROMPT를 읽었더니 "$P$G"가 들어갈 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Windows 환경변수는 프로세스가 시작할 때 상속된 값이라 SetEnvironmentVariable로 바꿔도 지금 세션에는 반영되지 않는다. 반대로 WMI(`Win32_Process Create`)로 새로 띄운 프로세스는 지금 셸에서 설정한 값을 받지 못한다. 또 cmd가 쓰는 `PROMPT` 같은 이름은 설정하지 않아도 기본값이 들어 있다.

## 언제 쓰나
- 설치 뒤 사용자 PATH를 바꾸고 같은 위원 셸에서 확인할 때
- 셸에서 `export PYTHONPATH=…`·`$env:RUN_TAG=…` 한 뒤 bg.mjs 같은 백그라운드 실행기로 python·node를 띄울 때
- 실행 중 서버를 원래 프로세스의 전체 환경 그대로 bg.mjs로 다시 띄울 때
- bg.mjs 로그에 `spawn C:\Program Files\nodejs\node ENOENT`가 찍히고 바로 끝날 때
- Node·Python 스크립트가 환경변수로 입력(프롬프트 문장 등)을 받을 때

## 방법
### 바꾼 사용자 PATH 확인
- 같은 세션의 자식 프로세스는 옛 PATH를 상속해 "없다"고 나온다.
- Machine+User PATH를 레지스트리에서 읽어 `$env:Path`에 넣고 실행한다.
- 또는 `Invoke-CimMethod Win32_Process Create`로 띄운 프로세스(새 사용자 PATH를 받는다)에서 확인한다. 출력은 TEMP 대신 작업 폴더 파일로 리다이렉트해 읽는다.

### bg.mjs(WMI 새 콘솔)로 띄운 프로세스는 셸 env를 못 받는다
- 증상 1: 셸에서 `export PYTHONPATH=<패키지 폴더>` 한 뒤 bg.mjs로 venv python을 띄우면 `ModuleNotFoundError: No module named 'pyloudnorm'`. 같은 셸에서 직접 실행하면 된다.
- 증상 2: `$env:RUN_TAG='<태그>'; node bg.mjs ... -- node generate.mjs run ...`가 기본 jobs.json을 열다 ENOENT로 즉시 실패한다(exit 1, 0분).
- 증상 3: CDP 스크립트가 PORT를 못 받아 기본 포트(남의 Chrome)에 붙는다.
- 증상 4: 출력 폴더·입력 편집본을 고르는 변수가 무시돼 스크립트가 기본값(옛 편집본)으로 조용히 돈다.
- 원인: bg.mjs가 WMI로 새 콘솔을 띄워 지금 셸의 환경변수가 전달되지 않는다(위 '사용자 PATH 확인'과 같은 성질). 파이썬에서 `subprocess.run([node, bg.mjs, ...], env=env)`로 넘겨도 env는 node/powershell까지만 가고 WMI로 만든 실제 자식은 못 받는다(대조 확인: bg에 넘긴 변수가 자식에서 없음).
- bg.mjs에 넘기는 명령에는 인자만 쓴다(`FOO=1 python …` 같은 환경변수 접두 금지).
- 파이썬: 스크립트 맨 위에서 직접 넣는다.
  - `sys.path.append('<패키지 폴더>')`
  - PATH(ffprobe 등)가 필요하면 스크립트에서 `os.environ['PATH']` 앞에 붙인다.
  - 기존 스크립트를 고치지 않고 env를 줘야 하면, 래퍼 부명령이 `os.environ.update({...})` 한 뒤 `runpy.run_path('대상.py', run_name='__main__')`로 기존 스크립트를 실행한다. 또는 대상 스크립트가 인자로 받게 고친다.
- node: env를 인자로 받아 `process.env`에 넣고 chdir한 뒤 대상 스크립트를 `import`하는 작은 래퍼를 쓴다.
  - `node bg.mjs --title T --log L -- "C:/Program Files/nodejs/node.exe" <래퍼.mjs> <저장소 루트> [KEY=VAL ...] <원래 인자...>`
- 안 되는 우회: `cmd /c 파일.cmd`로 env를 설정하고 실행 → 한글·공백이 든 worktree 경로 때문에 "파일 이름이 올바르지 않습니다"로 실패한다.
- 기존 출력을 덮지 않는 스크립트가 "이미 있음"으로 건너뛰었다면, 잘못된 입력(기본값)으로 만든 중간 산출물(.council/render/*.mkv 등)을 지우고 다시 돌린다.

### 실행 중 서버를 원래 환경 그대로 재시작: env JSON 파일 + subprocess 래퍼
- 키 몇 개가 아니라 psutil `p.environ()`으로 읽은 전체 환경(예: ComfyUI)으로 다시 띄워야 할 때 쓴다.
- 원래 환경을 `tempfile.mkstemp()`(사용자 TEMP)에 JSON으로 쓰고, 명령줄에는 파일 경로만 넘긴다(값이 bg 로그·명령줄에 안 남는다).
- `node bg.mjs --title T --log L --cwd <원래 cwd> -- <python.exe 전체경로> -X utf8 -u run_with_env.py <env.json> <cwd> -- <원래 명령줄...>`
- 래퍼는 JSON을 읽자마자 지우고 `subprocess.call(cmd, cwd=cwd, env=env)`로 실행해 같은 exit 코드로 끝난다(bg 종료 마커가 곧 서버 종료 코드). 파이프 출력용으로 `PYTHONIOENCODING=utf-8`·`PYTHONUNBUFFERED=1`만 덮어쓴다.
- 래퍼를 `-X utf8` 없이 돌리면 한글 출력이 cp949로 나가 부모 디코딩이 깨진다.
- 재시작 뒤 새 리스너의 `environ()`과 원래 환경을 비교해 다른 키 이름만 기록한다.

### bg.mjs의 실행 파일은 확장자까지 전체 경로를 슬래시로
- `node bg.mjs ... -- "$(which node)" script.mjs`로 띄우면 공백이 든 경로가 쪼개져 로그에 `spawn C:\Program Files\nodejs\node ENOENT`로 즉시 실패한다(Git Bash cygpath 결과도 같다). bg.mjs는 공백 경로 인자를 따옴표 처리하지 않는다.
- `-- "C:/Program Files/nodejs/node.exe" <스크립트>`처럼 `.exe`까지 붙인 전체 경로를 슬래시로 쓴다. 파이썬도 전체 경로.
- 그래도 공백 경로가 문제면 8.3 짧은 경로(`C:\PROGRA~1\nodejs\node.exe`)로 node를 띄우고, 공백 경로 실행 파일(서버 등)은 공백 없는 경로에 둔 래퍼 .mjs 안에 경로를 박아 그 래퍼를 실행한다: `C:\PROGRA~1\nodejs\node.exe 래퍼.mjs`.

### bg.mjs 로그는 이어 쓰기(append)다
- 같은 로그 파일을 재사용하면 옛 줄이 남아, 끝났는지 기다릴 때 `until grep`으로 `끝남|실패`를 찾으면 옛 줄에 걸린다.
- 로그 이름을 매번 새로 쓰거나, 먼저 지우거나, 그 줄 수를 세서 늘었는지로 판정한다.

### env 이름 PROMPT 금지
- Node 스크립트가 `process.env.PROMPT || 기본문`으로 받으면, 설정하지 않았을 때 Windows cmd 기본 프롬프트 값 "$P$G"가 들어가 ComfyUI가 엉뚱한 그림(로고 등)을 낸다.
- 환경변수 이름은 `FACE_PROMPT`처럼 고유하게 쓴다.
- ComfyUI 결과가 이상하면 `/history`의 `prompt[2]`에서 실제 전달된 텍스트를 확인한다.

## 주의할 점
- Win32_Process Create의 CommandLine은 `>` 리다이렉트를 처리하지 않으니 cmd.exe로 감싼다([Windows에서 서버를 세션과 떼어 띄우고 재시작](common/windows/windows-detached-server-restart)).
- bg.mjs 로그 시각은 로컬 시간이라, UTC로 찍는 스크립트 로그와 시차(KST 9시간)가 난다.
