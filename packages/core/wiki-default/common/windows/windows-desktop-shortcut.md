---
title: Windows 바탕화면에 cmd 실행 바로가기(.lnk) 만들기 (OneDrive 바탕화면 대응)
summary: 저장소의 실행 cmd를 사용자 바탕화면에서 누를 수 있게 하려면 어떻게 바로가기를 만들고 확인하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
cmd 파일을 바탕화면에 복사하면 `%~dp0` 기준 상대경로가 깨진다. cmd는 저장소에 두고 .lnk만 만든다. 바탕화면은 OneDrive 폴더로 리디렉션돼 있을 수 있으니 경로를 하드코딩하지 않는다.

## 언제 쓰나
- 사용자가 "바탕화면에서 실행하게 해 줘"라고 할 때

## 방법
```powershell
$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut("$d\Backend.lnk")
$s.TargetPath='C:\Windows\System32\cmd.exe'; $s.Arguments='/c ""<저장소 경로>\x.cmd""'; $s.WorkingDirectory='<저장소 경로>'; $s.Save()
```
- 생성 뒤 다시 읽어 TargetPath·Arguments를 확인한다. 같은 이름이 있으면 덮기 전에 기존 대상을 기록한다.
- cmd에 `--check` 옵션을 두고, 다른 폴더에서 `cmd /c`로 돌려 종료 코드 0을 확인한다.

## 주의할 점
- 위원에게 맡길 땐 지시에 "저장소 밖(바탕화면) 쓰기 허용"을 명시한다.
