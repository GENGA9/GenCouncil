---
title: Windows Git Bash 함정: /tmp 경로를 python·node가 못 읽음·python heredoc의 한글·백슬래시가 깨짐·줄끝(CRLF/LF) 전체 변환과 되돌리기
summary: Git Bash(Claude Code Bash 도구)에서 /tmp에 받은 파일을 Windows python·node가 못 열거나, py -c 인용이 깨지거나, python heredoc(stdin)으로 넘긴 스크립트의 한글·백슬래시 경로 치환이 조용히 0건으로 끝나거나, sed -i·에디터 재저장으로 파일 줄끝이 통째로 바뀌어 git diff가 전체 파일로 부풀 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Windows의 Git Bash는 경로와 줄끝을 Windows 프로그램과 다르게 다룬다. `/tmp`는 Git Bash 안에서만 통하는 경로라 Windows python·node가 못 찾고, heredoc(stdin)으로 넘긴 스크립트는 한글·백슬래시가 달라지며, `sed -i`는 CRLF 파일을 통째로 LF로 바꾼다.
파이프로 넘기거나 Windows 경로를 쓰고, 스크립트는 파일로 써서 실행하며, 파일 편집은 줄끝을 지켜서 한다. 이미 줄끝이 통째로 바뀌었으면 `git show`로 원본 바이트를 복원한 뒤 필요한 줄만 고친다.

## 언제 쓰나
- Bash 도구에서 curl로 받은 JSON을 python·node로 읽을 때
- `py -c "..."` 한 줄 코드가 SyntaxError로 깨질 때
- `python - <<'E' ... E`로 넘긴 스크립트의 한글 문자열·백슬래시 경로 치환이 오류 없이 0건으로 끝날 때
- Git Bash로 소스 파일 한 줄을 고칠 때(core.autocrlf=true 저장소)
- git diff가 줄끝 변환으로 파일 전체 줄 수만큼 부풀 때

## 방법
### /tmp 파일과 Windows python·node
- `curl -o /tmp/x.json`으로 받은 파일을 Windows python으로 열면 FileNotFoundError. node도 같다: 스크립트 안의 `/tmp/x` 문자열은 현재 드라이브의 `\tmp\x`로 풀려 ENOENT.
- 파이프로 넘긴다: `curl -s URL | py -c "import sys,json; print(json.load(sys.stdin).get('job'))"`. 토큰 같은 비밀이 든 응답은 필요한 필드만 뽑아 출력한다.
- 파일이 필요하면 `cygpath -m /tmp/x`로 얻은 Windows 경로(`…/AppData/Local/Temp/x`)를 쓰거나, 스크립트를 작업 폴더(프로젝트 안 상대 경로)에 썼다가 지운다.
- `py -c`에 따옴표·괄호가 섞이면 bash가 인용을 깬다 → 여러 줄 코드는 PowerShell에서 `$env:TEMP` 아래 .py를 `Set-Content -Encoding utf8`로 쓰고 `python -I 파일.py`로 실행한 뒤 지운다.
- SQLite 읽기 전용 열기: `sqlite3.connect(pathlib.Path(r"<경로>\x.db").as_uri()+"?mode=ro", uri=True)`.

### python heredoc(stdin)에 한글·백슬래시를 넣지 않는다
- `python - <<'E' ... E`로 스크립트를 stdin에 넘기면 (1) 한글 문자열 리터럴이 CP949로 읽혀 깨지고(한글 폴더명을 찾는 replace·정규식이 0건) (2) 백슬래시 이스케이프가 한 겹 달라져 JSON 안의 `C:\\work\\...`(실제 백슬래시 2개)를 못 찾는다. 오류 없이 "0건 치환"으로 끝나 알아채기 어렵다.
- 스크립트는 Write 도구로 .py 파일에 쓰고 `python -I 파일.py 인자...`로 실행한다(파일은 UTF-8로 읽힌다. 출력 인코딩은 [Windows에서 Python 한글이 깨질 때](common/windows/windows-python-korean-encoding)의 `-X utf8`).
- 백슬래시는 `BS = chr(92)`로 만들어 `'C:' + BS*2 + 'work'`처럼 조립하거나, 정규식 대신 `str.find`로 head/tail 사이를 잘라 낸다.
- 경로 치환 스크립트는 치환 수를 출력하고 0이면 멈추며, 결과를 `json.loads`로 검증하고 `grep -c <옛 접두>`가 0인지 확인한다.
- node heredoc도 같은 문제가 있다 → [node로 소스 파일 패치하기](common/windows/node-source-patch-scripts).

### sed -i가 CRLF 파일을 LF로 바꿀 때
- Git Bash `sed -i`로 한 줄만 고쳐도 작업 사본 전체가 LF가 된다. autocrlf=true라 git diff엔 한 줄만 보이지만 "LF will be replaced by CRLF" 경고가 난다. `sed -i`는 LF 파일에만 쓴다.
- 편집은 Python으로: bytes로 읽어 `\r\n`→`\n`로 바꾼 뒤 고치고, 원래 CRLF였으면 `\r\n`으로 되돌려 bytes로 쓴다(텍스트로 열면 `open(..., newline='')`).
- 이미 바뀐 파일 되돌리기: `p.write_bytes(p.read_bytes().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))`.
- 긴 편집 스크립트는 Write 도구로 .py를 만들어 `py -X utf8 script.py`로 실행한다. 고친 뒤 `file <경로>`로 줄끝을 확인한다.

### git diff가 줄끝 변환으로 파일 전체가 바뀌었을 때
- 확인: `git diff --ignore-cr-at-eol <base> -- <file>`로 실제 바뀐 줄만 보고, CRLF 파일 목록은 `git ls-files --eol`.
- 작업 전 원래 CRLF인지: `git show HEAD:path | grep -c $'\r'`.
- 복원(checkout 불필요): `git show <base>:<path> > <path>`(bash 리다이렉트. PowerShell Set-Content는 금지) → 바뀔 줄만 Edit 도구로 고친다.
- 커밋 전 `git diff --stat`이 고친 줄 수뿐인지, `git diff ... | cat -A`에서 줄끝이 `^M$`인지 확인한다.
- 원인은 보통 에디터·스크립트의 LF 재저장이다. node로 CRLF 파일을 패치하는 법은 [node로 소스 파일 패치하기](common/windows/node-source-patch-scripts).

## 주의할 점
- heredoc·`node -e`의 이스케이프 문제는 [Claude Code Bash 도구의 이스케이프 함정](common/ai-agents/claude-code-bash-escaping), autocrlf와 파일 해시 테스트는 [core.autocrlf 저장소에서 파일 sha 테스트가 깨질 때](common/git/git-autocrlf-file-hash), 한글 경로는 [Windows 한글 경로를 subst로](common/windows/windows-hangul-path).
- Git Bash에서 Windows 프로세스를 찾고 끄는 법은 [Windows 프로세스 확인·종료](common/windows/windows-process-find-kill).
