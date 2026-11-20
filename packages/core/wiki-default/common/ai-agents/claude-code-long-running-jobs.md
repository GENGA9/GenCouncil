---
title: Claude Code 긴 작업: 2시간 넘는 작업 떼어 띄우기·끝 알림(횟수 제한 루프)·전경 sleep은 바로 돌아옴·run_in_background 함정(TaskStop·timeout 뒤에도 대기열·자식 생존) (Windows)
summary: Claude Code(Windows)에서 run_in_background 2시간 제한을 넘는 측정·생성 작업을 어떻게 세션과 떼어 띄우고 끝 알림을 받으며(대기 루프는 횟수 상한, 전경 sleep은 막혀 바로 돌아옴), & 래퍼 종료로 작업이 죽거나 TaskStop·timeout "killed" 뒤에도 대기열 셸·자식이 살아 중복 실행되는 함정은 어떻게 확인(ps·/proc/PID/cmdline)하고 피하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Claude Code의 run_in_background는 최대 2시간, Monitor는 최대 10분이고 10분 넘는 foreground 대기는 타임아웃된다. `nohup cmd &`는 하네스가 추적하지 않아 끝나도 알림이 없다. Windows Git Bash에서는 TaskStop이나 시간 제한으로 '중지됨/killed' 알림이 와도 안의 bash·node 자식이 살아 있을 수 있다.
그래서 긴 작업은 WMI로 세션과 떼어 띄우고, 완료 표시를 기다리는 가벼운 루프만 run_in_background로 건다. 2시간 안에 끝나는 작업은 `&` 없이 스크립트 전체를 run_in_background로 직접 돌린다. 다시 띄우기 전에는 알림이 아니라 프로세스를 직접 확인한다.

## 언제 쓰나
- 2시간 넘는 측정·시뮬레이션·일괄 생성을 위원·의장 세션에서 돌릴 때
- 백그라운드 작업이 끝나기를 기다릴 때
- run_in_background로 생성 러너·대기열(구간을 하나씩 generate하는 루프)을 돌리다 "killed"·중지·완료 알림을 받았을 때

## 방법
### 세션과 떼어 띄우기
- PowerShell: `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c node script.mjs ... > out.txt 2>&1'; CurrentDirectory = '<작업 폴더>' }` → ReturnValue 0이면 성공.
- 띄운 직후 로그가 자라는지 확인한다.

### 끝 알림 받기: 횟수 상한을 둔 루프
- `for i in $(seq 1 350); do grep -q '끝 표시' out.txt && break; sleep 20; done`(파일이면 조건을 `[ -f DONE ] && break`로) 루프를 Bash run_in_background(timeout 최대 7200000)로 걸면 완료 알림이 한 번 온다. 2시간이 넘으면 루프를 다시 건다.
- 긴 대기는 sleep 연쇄 대신 Monitor(10분 만료)나 완료 알림. 파일 생성 대기는 foreground에서 9분 이내 횟수로 끊어 반복한다(예: `for i in $(seq 1 27); do [ -f … ] && break; sleep 20; done`). 결과는 산출 파일·`status` 서브커맨드·run.log로 확인한다.
- 전경 Bash에서 `sleep`만 단독으로 부르면 막혀 바로 돌아온다(기다린 것이 아니다). 기다릴 때는 Monitor나 위의 run_in_background 루프를 쓴다.
- 로그 끝 줄로 완료를 판정할 때, 같은 로그 파일에 이전 시도의 `실패`·`끝남` 줄이 남아 있으면 루프가 바로 끝난다(bg.mjs 로그는 이어 붙는다) → 다시 띄우기 전에 로그를 비우거나(`: > log`) 마지막 줄만 본다.
- 예전 방식(이제 안 됨): 상한 없는 `until grep -q '끝 표시' out.txt; do sleep 20; done` — 셸이 죽으면 sleep·grep이 고아로 남는다([Windows 프로세스 확인·종료](common/windows/windows-process-find-kill)).

### run_in_background 함정: 래퍼 종료
- `bash run.sh > log 2>&1 &` 뒤에 `sleep 60; cat log`을 붙여 run_in_background로 돌리면 래퍼 셸이 끝날 때 안쪽 작업(node 등)도 종료된다. 완료 알림은 래퍼의 것이다 → `&` 없이 스크립트 전체를 run_in_background 명령으로 직접 실행하고 완료 알림을 기다린다. 이미 죽었으면 남은 단계만 다시 돌린다(서버 쪽에서 끝나는 작업은 결과가 남아 있다).

### run_in_background 함정: TaskStop·timeout 뒤에도 살아 있음
- 반대로 TaskStop이나 timeout 한도(7200000)로 '중지됨/killed' 알림이 와도 안의 `bash queue.sh`·`bash run_main.sh`·`node` 자식은 계속 돈다. 알림만 믿고 새 대기열을 띄우면 generate.mjs 두 개가 동시에 돌아 state 파일을 번갈아 덮어쓰고 같은 구간을 두 번 만든다.
- Git Bash에서 확인: `for p in $(ps | awk '/bash|node/{print $1}'); do c=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null); case "$c" in *queue*|*run_seg*|*generate*) echo "$p ppid=$(awk '{print $4}' /proc/$p/stat) $c";; esac; done`
- PowerShell에서 확인: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'generate.mjs|run_main' } | Select ProcessId,ParentProcessId,CreationDate`.
- 대기열 셸만 끄려면 그 bash PID만 `kill <pid>`(자식 run_seg·node는 계속 돌아 현재 구간은 끝까지 간다). 중복이면 부모 bash 루프부터 끈 뒤(`taskkill //PID <pid> //F`) node를 지운다. `for i in 1..6; node …` 루프 bash가 살아 있으면 node만 죽여도 루프가 새 node를 띄운다.
- 생성 중인 node를 끄면 서버(ComfyUI) 작업은 남는다 → 필요하면 `POST /interrupt {"prompt_id":…}`·`POST /queue {"delete":[…]}`로 내 작업만 지운다.

### 대기열 스크립트 작성 요령
- '앞 구간 끝날 때까지 기다림' 조건을 로그 파일 내용으로 걸 때, 재시도로 같은 로그를 다시 쓰면 옛 OK 줄 때문에 바로 시작될 수 있다 → 재시도 전 로그를 다른 이름으로 옮긴다.
- 긴 대기열은 2시간 제한 안에 끝나게 짧게 나눈다.

### 한글 경로
- 명령을 BOM 없는 .ps1에 넣어 `powershell -File`로 돌리면 ANSI로 읽혀 경로가 깨지고 출력 파일도 안 생긴다.
- CurrentDirectory에 한글 경로를 주면 ReturnValue 8.
- 명령을 PowerShell 도구에 직접 넣고 CurrentDirectory는 비운 채 `cmd.exe /c "<python>" -X utf8 <스크립트 절대경로> > 로그 2>&1`(스크립트 안의 한글 절대경로는 python이 처리). 다른 우회는 [Windows 한글 경로를 subst로](common/windows/windows-hangul-path).

## 주의할 점
- 끝나면 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`로 남은 프로세스를 확인한다. 프로세스 확인·종료 명령은 [Windows 프로세스 확인·종료](common/windows/windows-process-find-kill).
- 이렇게 띄운 프로세스는 위원을 멈춰도 계속 돈다 → [위원 정지 후 남은 생성 스크립트 정리](common/council-members/council-stop-member-orphan-process).
- ComfyUI 잡은 제출 스크립트가 죽어도 /history에서 회수한다.
