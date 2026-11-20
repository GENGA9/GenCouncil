---
title: Windows Python 버전 고르기: 스토어 스텁(py -X utf8·pythoncore 실행 파일·bat 런처 폴백)·3.15 휠 없음·휴대용 3.12(NuGet)·ComfyUI python_embeded는 PYTHONPATH 무시·RTX 50 cu128
summary: Windows에서 python이 스토어 스텁으로 조용히 실패하거나(bat 런처가 where python만 보고 스텁을 고르는 경우 포함), 기본 py(3.15)로 pip install이 휠 없음으로 실패하거나, 설치 스크립트가 없는 3.12를 요구하거나, ComfyUI 포터블 python_embeded에서 PYTHONPATH가 안 먹어 unittest discover가 모듈을 못 찾거나, RTX 50에서 torch가 안 돌 때 어떤 파이썬을 어떻게 쓰고, 원본 폴더에 .pyc를 남기지 않고 문법 검사하려면 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Windows에서 `python`/`python3`이 WindowsApps 스토어 스텁일 수 있고, 기본 `py`가 3.15면 많은 패키지 휠이 없다. 스크립트는 `py -X utf8`(또는 버전 명시)로 돌리고, 없는 버전은 NuGet 휴대용 python으로 시스템을 건드리지 않고 쓴다.
한글 인코딩 문제는 [Windows에서 Python 한글이 깨질 때](common/windows/windows-python-korean-encoding).

## 언제 쓰나
- `python`·`python3` 명령이 exit 49로 실패하거나, Git Bash heredoc `python -`이 "Python" 한 줄만 찍고 아무것도 안 할 때(종료 코드 0이라 파일이 안 바뀐 걸 한참 뒤에 안다)
- PowerShell `Get-Command python`/`py`가 `AppData/Local/Microsoft/WindowsApps` 별칭을 가리키고 `python -c`·stdin 실행이 짧은 'Python ' 출력과 실패로 끝날 때
- 사용자용 .bat 런처가 `where python`으로 python을 찾았는데 실행하면 exit 49일 때
- `pip install -r requirements.txt`가 pydantic-core·pyyaml 소스 빌드에서 실패할 때
- 외부 설치 스크립트가 `py -3.12`·3.12 x64를 요구하는데 3.13+만 있을 때
- ComfyUI 포터블 `python_embeded`로 테스트를 돌리는데 top-level 모듈을 못 찾을 때
- RTX 50(Blackwell, sm_120)에서 torch를 설치할 때

## 방법
### 스토어 스텁 피하기: py 런처
- 저장소 스크립트는 `py -X utf8 <스크립트>`로 돌린다(UTF-8 모드라 한글 경로·소스에 안전).
- 특정 모듈이 필요하면 `py -0p`로 설치판을 확인하고 `py -3.14 -I -X utf8 script.py`처럼 버전을 명시하거나 프로젝트 venv의 python.exe를 직접 호출한다. 설치판마다 패키지가 다르다.
- `python` 실행 파일 경로가 꼭 필요하면 `%LOCALAPPDATA%/Python/bin/python.exe`. 인자 경로는 `C:/…` 형식으로 준다(`/c/…`는 못 읽는다).
- `-I`면 PYTHONIOENCODING·PYTHONUTF8가 무시되니 `-X utf8`을 함께 준다.
- 스텁이 조용히 실패하면 편집이 안 된 줄 모른다 → 편집 뒤 `git status`/`git diff --stat`으로 반영을 확인한다.

### bat 런처: 존재 확인 말고 실제 실행으로 판정하고 폴백
- `where python`에는 WindowsApps 스텁이 잡히므로 존재 확인만으로는 부족하다.
- bat에서 실제로 돌려 errorlevel로 판정한다: `python -c "import http.server" >nul 2>&1`(필요한 모듈로 바꾼다). 실패하면 `py -3`, 그다음 `node` 순으로 폴백한다.
- 런처를 만든 뒤 스텁만 있는 환경에서 실제로 실행해 폴백이 도는지 확인한다.

### 별칭도 py도 안 되면: pythoncore 실행 파일 직접
- Python Install Manager 설치는 실제 실행 파일이 `%LOCALAPPDATA%/Python/pythoncore-3.<버전>-64/python.exe`에 있다. 가상환경이나 다른 프로젝트 폴더를 건드리지 않고 표준 라이브러리 일에 쓸 수 있다.
- PowerShell: `Get-ChildItem "$env:LOCALAPPDATA/Python" -Directory -Filter 'pythoncore-*'`로 설치를 찾고 `& '<찾은 경로>/python.exe' -X utf8 <스크립트>`. 버전·경로를 상수로 가정하지 않는다.
- 문법(컴파일) 검사: `py_compile.compile(<파일>, cfile='<작업용 임시 폴더>/….pyc', doraise=True)`로 .pyc가 원본 폴더(`__pycache__`)에 생기지 않게 한다.

### 스크립트는 heredoc 말고 파일로
- bash heredoc에 한글·따옴표·역따옴표가 섞이면 `unexpected EOF while looking for matching`으로 터지는 일이 있다.
- Write 도구로 파일(예: `.council/x.py`)을 만들고 `py -X utf8 .council/x.py`로 돌린다.

### ComfyUI 포터블 python_embeded는 PYTHONPATH를 무시한다
- `python_embeded`에서는 PYTHONPATH 환경변수가 안 먹어 `unittest discover`가 top-level 모듈(`import project` 등)을 못 찾는다.
- sys.path를 코드로 넣는다: `python -c "import sys,os,unittest; sys.path[:0]=[repo, ComfyUI경로]; unittest.main(module=None, argv=['x','discover','-s','tests'])"`
- psutil·PIL 등이 이미 들어 있어 도구 스크립트용으로도 쓴다(`-I -X utf8`).

### 3.15는 휠이 없다: 3.13 venv
- `py -3.13 -m venv .venv` 또는 3.13 python.exe로 `-m pip install -r requirements.txt pytest httpx`, 테스트도 같은 실행 파일로 `-m pytest`.
- starlette TestClient 테스트엔 requirements에 없어도 httpx가 필요하다(없으면 수집 단계 오류).

### 없는 버전(3.12)은 NuGet 휴대용 python
- NuGet `python` 패키지는 완전한 CPython이고 레지스트리·PATH를 바꾸지 않는다. 풀면 venv·ensurepip가 되는 휴대용 3.12가 된다.
- `curl -sL -o py312.nupkg https://www.nuget.org/api/v2/package/python/3.12.10` → `unzip` → `tools/python.exe -m ensurepip --version`로 확인 → 설치 스크립트에 `-Python "<푼 폴더>\tools\python.exe"`.

### RTX 50 torch: cu128
- 구형 cu12x torch 휠은 sm_120에서 동작하지 않는다.
- `pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128`. torch 2.8.0+cu128로 동작 확인.
- 설치가 길다(torch cu128 약 8분) → run_in_background + 로그 until 루프([Claude Code 긴 작업](common/ai-agents/claude-code-long-running-jobs)).

## 주의할 점
- 파일을 고치는 스크립트의 `open(p,'w')`는 Windows에서 LF를 CRLF로 쓴다. 저장소가 LF면 `newline='\n'`, CRLF 파일이면 `newline='\r\n'`을 준다.
- Pillow quantize는 FASTOCTREE가 MEDIANCUT보다 PNG가 약 40% 작다(libimagequant 없음).
- Git Bash /tmp 경로·인용 문제는 [Windows Git Bash 함정](common/windows/git-bash-windows-pitfalls).
- bg.mjs로 런처·서버를 띄울 때 공백 경로·env 문제는 [Windows 환경변수 함정](common/windows/windows-environment-variables).
