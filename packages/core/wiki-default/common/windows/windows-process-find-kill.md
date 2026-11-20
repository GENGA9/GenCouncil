---
title: Windows 프로세스 확인·종료: Git Bash pgrep 대신 CommandLine으로 내 것만·대기 루프는 횟수 제한·부모 죽은 tail/grep 고아(GenCouncil 자동 정리)
summary: Git Bash에서 pgrep·pkill이 Windows 프로세스를 못 볼 때 실행 여부를 어떻게 확인하고, 병렬 위원·사용자 프로세스를 죽이지 않고 내 프로세스만 어떻게 끄며, tail -f | grep·until 루프 같은 고아 파이프라인이 쌓이지 않게 대기 루프를 어떻게 쓰고 남은 고아는 어떻게 세나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Git Bash의 `pgrep`·`pkill`은 Windows 프로세스를 못 본다(`until ! pgrep …` 루프는 즉시 끝나고 종료도 안 된다). 이름 단위 `taskkill`은 병렬 위원·다른 worktree·사용자 프로세스까지 죽인다.
확인은 tasklist·로그 조건으로, 종료는 PowerShell `Win32_Process`의 CommandLine에서 내 worktree 경로나 내 스크립트 이름으로 골라서 한다. Windows는 고아 프로세스를 거두지 않으므로, 백그라운드 셸에 띄운 `tail -f | grep`·무한 대기 루프는 셸이 죽은 뒤에도 남는다.

## 언제 쓰나
- Bash 도구에서 백그라운드 생성·측정 프로세스가 끝났는지 기다릴 때
- 내가 띄운 python·node·codex 프로세스만 멈춰야 할 때
- 백그라운드 작업을 멈춘 뒤 입력을 바꿔 다시 띄울 때
- tail·grep·sleep 프로세스가 수십~수백 개 쌓여 메모리·핸들을 잡고 있을 때

## 방법
### 실행 여부 확인·대기
- 실행 여부: `ps aux | grep node`, 산출 파일 존재, 또는 `tasklist | grep -qi "x.exe"`.
- 종료 대기는 로그 조건으로, 횟수 상한을 둔다: `for i in $(seq 1 60); do grep -q 끝 x.log && break; sleep 20; done`. 패턴이 N번 찍힐 때까지면 조건을 `[ $(grep -c "패턴" run.log) -ge N ] && break`로, 프로세스가 끝날 때까지면 `tasklist | grep -qi "x.exe" || break`로 바꾼다.
- 백그라운드 셸에 상한 없는 `until …; do sleep N; done`·`while …; do sleep N; done`·`tail -f x.log | grep …`를 띄우지 않는다(셸이 죽으면 고아로 남는다, 아래 절). 상한 없는 폴링 금지는 GenCouncil 위원 기본 규칙에도 들어 있다.
- Monitor 도구에 걸 때는 `tail -n 0 -F log | grep --line-buffered -E "패턴"`. Monitor는 10분 후 만료되니 다시 건다.
- Git Bash의 `python`은 스토어 스텁이라 exit 49 → `py`나 전체 경로를 쓴다.

### 내 프로세스만 종료 (PowerShell)
- worktree 경로로 고르기: `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*<내 worktree 폴더명>*' -and $_.Name -eq 'python.exe' } | % { Stop-Process -Id $_.ProcessId -Force }`(부모 env.exe와 python 둘 다). 스크립트 이름(`*bench.py*`)으로 골라도 된다.
- CommandLine에 작업 폴더가 없을 때(`python -X utf8 gen.py`)는 스크립트 이름으로 뽑고 부모 PID(py.exe 런처)·CreationDate·그 폴더 산출물 시각을 함께 본다: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'gen\.py' } | Select ProcessId,ParentProcessId,CreationDate,CommandLine`. 자식 python 먼저, 남은 부모 py.exe 다음. 종료 뒤 같은 조건으로 재조회해 0건을 확인한다.
- 래퍼는 자기가 spawn한 PID만 `taskkill /PID <pid> /T /F`(트리 종료, Git Bash에선 `//PID <pid> //T //F`)하고, 자식 stdout을 줄 단위로 파싱해 조건(예: 같은 컷 FAIL 3회)에서만 끊는다.

### 자기 자신을 매칭하지 않기
- `-match '_gem_vote\.mjs'`로 세면 검사하는 powershell 자신의 CommandLine도 걸려 영원히 1 이상이다 → `'_gem_vot[e][.]mjs'`처럼 한 글자를 [x]로 감싼다(찾기·종료 모두). 예: `@(Get-CimInstance Win32_Process | ?{$_.CommandLine -match '_gem_vot[e][.]mjs'}).Count`
- `CommandLine -match 'lane-x.sh A'`처럼 셸 명령줄에도 있는 문자열로 고르면 그 명령을 실행한 셸 자신도 죽는다 → `--lane xA`처럼 대상(node) 명령줄에만 있는 문자열로 고른다.

### 부모 죽은 파이프라인 필터(고아)
- 백그라운드 셸이 죽어도 tail·grep·sleep은 남고, 부모가 이미 없으므로 `taskkill /t`로도 닿지 않는다(171개가 최대 5일째 떠 메모리 166MB·핸들 2만 개를 잡은 적이 있다).
- GenCouncil 위원이 남긴 고아 필터 정리는 이제 프로그램이 자동으로 한다(위원 종료 때와 15분마다 스윕).
- 남은 수를 볼 때(PowerShell): 살아 있는 pid로 해시를 만들고 `Get-CimInstance Win32_Process`에서 `ParentProcessId`가 그 해시에 없는 것을 센다.
- GenCouncil 밖에서 직접 정리할 때 대상은 "필터 이름 + 부모 사망" 두 조건으로 좁힌다: tail/grep/sleep/cut/head/sed/awk/wc/sort/uniq/tr/xargs. 부모가 죽은 필터는 출력을 읽는 쪽이 없어 죽여도 일이 끊기지 않는다.
- node·python·ffmpeg·CLI처럼 스스로 일하는 프로그램은 부모가 없어도 대상에 넣지 않는다. `bin/bg.mjs`로 띄운 렌더·변환은 일부러 위원보다 오래 살게 띄운 것이다.

## 주의할 점
- 이름 단위 종료 금지: `taskkill /IM python.exe`·`taskkill /IM codex.exe /F`·`taskkill /IM chrome.exe`는 남의 프로세스(사용자 코덱스·Chrome 포함)를 죽인다.
- worktree 경로가 든 프로세스를 통째로 끄면 bg.mjs로 띄운 진행 중 렌더·변환까지 죽는다. 경로 매칭을 단순 substring으로 하면 `claude-6`이 `claude-69`를 잡는다 → 경로 뒤에 따옴표·공백·슬래시·콤마·세미콜론·문장 끝이 오도록 정규식으로 맞춘다.
- 백그라운드 작업을 `TaskStop`으로 멈춰도 그 작업이 띄운 자식(예: codex 그리기)은 계속 돌아 옛 입력으로 산출물을 끝낸다 → 다시 띄우기 전에 자식까지 CommandLine으로 찾아 종료하고, 이미 만들어진 산출물을 치운다.
- 산출물 폴더를 남이 재편할 수 있으니 "파일 수 증가 없음"만으로 끝났다고 판단하지 않는다.
- 위원을 멈춘 뒤 남은 스크립트는 [위원 정지 후 남은 생성 스크립트 정리](common/council-members/council-stop-member-orphan-process), 세션과 떼어 띄우는 법은 [Claude Code에서 2시간 넘는 작업](common/ai-agents/claude-code-long-running-jobs).
