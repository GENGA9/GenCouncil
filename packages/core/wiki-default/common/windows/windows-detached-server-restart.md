---
title: Windows에서 서버를 세션과 떼어 띄우고 재시작 (ComfyUI 등): WMI 기동·잠긴 로그·큐 확인
summary: ComfyUI·백엔드 같은 서버를 Claude 세션이 끝나도 살아 있게 띄우고, 큐를 깨지 않고 재시작하며, 재시작 cmd가 잠긴 로그 파일 때문에 바로 죽거나 로그가 안 생길 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
서버는 `Invoke-CimMethod Win32_Process Create`로 띄우면 부모가 WmiPrvSE가 되어 세션과 떨어지고 창도 없다. 리다이렉트는 cmd.exe로 감싸고, 로그 이름엔 매번 타임스탬프를 붙인다. 재시작 전에는 큐가 비었는지 보고 그 포트를 쥔 PID만 끈다.
2시간 넘는 측정·생성 작업을 떼어 띄우는 법은 [Claude Code 긴 작업](common/ai-agents/claude-code-long-running-jobs), 위원이 의장을 띄운 서버를 재시작할 때는 [의장을 띄운 서버를 위원이 재시작할 때](common/council-members/council-member-server-restart).

## 언제 쓰나
- ComfyUI 같은 서버를 세션과 떼어 띄우거나 재시작할 때
- 재시작 cmd가 스크립트 한 줄도 안 돌고 바로 끝날 때, 로그 파일이 안 생길 때

## 방법
### 떼어 띄우기
- `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "<절대경로>\start_comfyui.cmd > %TEMP%\comfy_detached.log 2>&1"' }`
- 스크립트는 worktree가 아닌 메인 저장소 경로를 쓴다.
- Win32_Process Create의 CommandLine은 `>`를 처리하지 않는다: `powershell ... > log 2>&1`을 그대로 넣으면 로그가 안 생긴다 → `cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File x.ps1 > log 2>&1`처럼 cmd.exe로 감싼다.

### 로그는 매번 새 파일
- 이전 cmd가 같은 로그 파일을 열고 있으면, 같은 이름으로 리다이렉트하는 새 cmd가 리다이렉트 단계에서 바로 종료된다(스크립트 한 줄도 안 돈다).
- 로그 이름에 타임스탬프를 붙이고 기존 cmd는 건드리지 않는다:
  `$log = "$env:TEMP\name_$(Get-Date -Format yyyyMMddHHmmss).log"; $cmd = "cmd.exe /c `"<script.cmd> > $log 2>&1`""; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = '<dir>' }`
- 새 로그 내용과 새 PID·CreationDate로 확인한다.

### 재시작
- 재시작 전 `/queue`가 비었는지 확인한다.
- `Get-NetTCPConnection -LocalPort 8188 -State Listen`의 소유 PID만 Stop-Process한다.
- 기동 확인은 `/object_info/<노드>`를 5초 간격으로 폴링(1~2분).

## 주의할 점
- 남의 프로세스를 이름으로 일괄 종료하지 않는다([Windows 프로세스 확인·종료](common/windows/windows-process-find-kill)).
- 한글 경로를 CurrentDirectory로 주면 ReturnValue 8이다([Claude Code 긴 작업](common/ai-agents/claude-code-long-running-jobs)의 한글 경로).
