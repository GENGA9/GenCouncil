---
title: Windows GUI 창 캡처: Tkinter 앱 스크립트 구동·PowerShell PrintWindow로 그 창만 찍기 (Pillow 없이)
summary: 외부 패키지 없이 Tkinter GUI를 띄워 조작·캡처하거나, Kdenlive 같은 GUI 앱이 파일을 열었는지 다른 창에 가려져도 그 창만 PNG로 남기려면 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Windows GUI 창은 PowerShell System.Drawing + user32로 PNG로 찍는다. 화면 영역 캡처(CopyFromScreen)는 위에 있는 다른 창(사용자 브라우저 등)까지 찍히므로, 그 창만 필요하면 `PrintWindow`를 쓴다. Tkinter 앱은 임시 config를 받게 만들어 드라이버 스크립트에서 `root.after()`로 조작한다.

## 언제 쓰나
- Pillow 같은 외부 패키지 없이 Tkinter GUI를 테스트·캡처할 때
- Start-Process로 연 GUI 앱(Kdenlive 등)이 파일을 열었는지 스크린샷으로 남길 때

## 방법
### Tkinter 앱 구동
- 앱을 `App(root, config_path)`로 만들어 임시 config를 받게 한다.
- 드라이버에서 `root.after()`로 상태 조작 → 완료 대기 → 캡처 → `on_close`.
- 캡처는 `subprocess.run(["powershell","-NoProfile","-Command", ...])`로 아래 PowerShell을 부른다.

### 그 창만 찍기: PrintWindow (권장)
- `Add-Type`으로 user32 `PrintWindow`·`GetWindowRect` 선언 → `$p = Get-Process kdenlive` → `GetWindowRect($p.MainWindowHandle)` 크기로 Bitmap → `Graphics.GetHdc()` → `PrintWindow(h, hdc, 2)`(PW_RENDERFULLCONTENT) → `ReleaseHdc` → `Save(png)`.
- 가려져 있어도 그 창 내용만 나온다. 창 제목(`$p.MainWindowTitle`)으로 열린 파일도 확인된다.
- 확인이 끝나면 `Stop-Process`(저장 안 함)하고, 프로젝트 파일 수정 시각이 그대로인지 본다.

### 화면 영역 캡처: CopyFromScreen
- `Add-Type System.Drawing`, user32 `GetWindowRect`/`SetForegroundWindow`, `Graphics.CopyFromScreen`으로 창 영역을 PNG로 저장한다. 창은 `Get-Process`의 MainWindowTitle로 찾는다.
- 다른 창이 위에 있으면 엉뚱한 화면·사적인 내용이 찍힌다.

## 주의할 점
- 창이 사용자 화면에 보이므로 사용자가 만지면 캡처가 오염된다. 캡처 PNG는 직접 열어 확인한다: 포커스 링 있는 체크박스·최대화된 창은 사용자가 만진 흔적이다.
- 긴 스크립트는 Bash 인자 대신 Write 도구로 파일을 만든다(`ENAMETOOLONG` 회피).
