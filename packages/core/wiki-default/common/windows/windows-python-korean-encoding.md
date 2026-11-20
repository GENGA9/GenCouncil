---
title: Windows 한글 인코딩 함정: python -I는 PYTHONUTF8 무시(-X utf8)·PowerShell 파이프는 ?로 바꿈·BOM 없는 UTF-8 .ps1의 한글 경로가 깨짐
summary: Windows 한국어 로케일에서 python -I 출력·소스 읽기가 cp949로 깨지거나, PowerShell 파이프로 넘긴 한글이 ?로 바뀌어 문자열 치환이 조용히 0건이거나, BOM 없는 UTF-8 .ps1을 Windows PowerShell로 실행했더니 한글 경로가 깨져 Image.FromFile 등이 경로 오류를 낼 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Windows 한국어 로케일에서 Python의 기본 인코딩은 cp949다. `python -I`는 PYTHON* 환경변수를 전부 무시하고, PowerShell 기본 파이프는 한글을 ?로 바꾸며, Windows PowerShell은 BOM 없는 .ps1을 UTF-8로 읽지 않는다. 대개 오류 없이 한글 치환이 0건 매치되거나 엉뚱한 경로 오류로 나타난다.
인코딩은 명령줄 옵션이나 스크립트 안에서 정하고, 한글이 든 코드는 파이프 대신 파일·편집 도구로 넘긴다.

## 언제 쓰나
- `python -I`로 돌린 스크립트의 한글 출력이 깨지거나 한글 문자열 치환이 0건일 때
- PowerShell here-string을 Python stdin으로 보내 소스를 고칠 때
- 한글 경로가 든 .ps1(이미지 비교·검수 스크립트 등)을 실행했더니 `System.Drawing.Image.FromFile`이 경로 오류를 낼 때

## 방법
### python -I에서 cp949로 깨질 때
- `python -I`(격리 모드, -E 포함)는 PYTHONUTF8·PYTHONIOENCODING 등 PYTHON* 환경변수를 무시한다 → stdout·소스 읽기가 cp949.
- `python -I -X utf8 script.py` 또는 스크립트 첫 줄 `sys.stdout.reconfigure(encoding="utf-8")`. env 변수로 고치려 하지 않는다.
- 이미 저장된 출력은 `open(f,'rb').read().decode('cp949')`로 다시 읽는다(데이터 자체는 정상).

### PowerShell 파이프로 넘긴 한글이 ?가 될 때
- Windows PowerShell 기본 파이프 인코딩으로 한글 here-string을 Python stdin에 보내면 한글이 ?로 바뀌고 소스 패턴 치환이 조용히 실패한다.
- 한글 코드 편집은 apply_patch(또는 편집 도구)로 한다.
- 파이프가 필요하면 `$OutputEncoding`을 UTF8Encoding으로, Python stdin도 UTF-8로 명시한다.
- `write_text(encoding='utf-8')`로는 stdin에서 이미 잃은 문자가 복구되지 않는다.

### BOM 없는 UTF-8 .ps1의 한글 경로가 깨질 때
- UTF-8 BOM 없는 ps1을 Windows PowerShell에서 직접 실행하면 스크립트 안 한글 경로가 잘못 해석된다(예: `System.Drawing.Image.FromFile` 경로 오류).
- UTF-8을 명시해 읽어 실행한다: `& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 .council/build-shots.ps1)))`
- 또는 스크립트를 UTF-8 BOM 형식으로 저장한다.

## 주의할 점
- 편집 스크립트는 Write 도구로 파일을 만들고 경로를 인자로 넘긴다. 편집 직후 git diff로 새 한글 문자열을 확인한다.
- Git Bash heredoc `python - <<EOF`·/tmp 경로 문제는 [Windows Git Bash 함정](common/windows/git-bash-windows-pitfalls).
- WindowsApps python은 스토어 스텁일 수 있으니 venv python.exe를 직접 지정한다.
- 한글 경로 자체가 문제면 [Windows 한글 경로를 subst로](common/windows/windows-hangul-path).
