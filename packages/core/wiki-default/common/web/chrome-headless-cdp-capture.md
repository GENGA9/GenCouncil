---
title: Playwright 없이 Chrome headless CDP로 웹 화면 캡처 (Node 22 fetch·WebSocket)
summary: playwright·puppeteer·브라우저 MCP가 없을 때 Chrome headless와 Node 22 전역 fetch·WebSocket만으로 로그인한 앱 화면이나 한글 경로 정적 HTML을 어떻게 캡처하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
설치된 Chrome을 `--headless=new --remote-debugging-port`로 띄우고 Node 22+의 전역 fetch·WebSocket으로 CDP 명령을 직접 보내면 캡처 도구 없이도 화면을 찍을 수 있다.
한 장짜리 정적 캡처는 `chrome --headless=new --screenshot`만으로도 된다(아래 주의할 점). Playwright를 쓸 때의 함정은 [Playwright 캡처·테스트 함정](common/web/playwright-pitfalls).

## 언제 쓰나
- playwright·puppeteer·브라우저 MCP가 없어 캡처가 막힐 때
- 로그인 상태·앱 상태를 조작한 뒤 특정 요소만 캡처할 때

## 방법
### 띄우기
- `"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --remote-debugging-port=<포트> --user-data-dir=<ASCII 빈 폴더, os.tmpdir() 아래> --window-size=1280,720 about:blank`
- `http://127.0.0.1:<포트>/json`의 webSocketDebuggerUrl에 WebSocket으로 붙는다.

### 조작·캡처
- `Runtime.evaluate({awaitPromise:true, returnByValue:true})`, `Page.captureScreenshot({clip, captureBeyondViewport:true})`, `Emulation.setDeviceMetricsOverride`.
- 로그인 상태: `Network.setCookie`로 세션 쿠키를 넣거나, 페이지 안에서 `fetch('/api/auth/login')`을 evaluate로 부르면 쿠키가 남는다 → `Runtime.evaluate`로 버튼 클릭 → 캡처.
- vite 개발 서버면 evaluate에서 `await import('/src/app.ts')`로 앱 상태를 조작한다.
- React 제어 입력: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)` 후 `input` 이벤트 dispatch.

### 한글 경로의 정적 HTML
- `Page.navigate`에 `pathToFileURL(html).href`(자동 인코딩, 상대 이미지 정상).
- 로드 후 `document.images` 전부 `decode()`·naturalWidth 확인 → 요소 getBoundingClientRect로 clip 캡처.

## 주의할 점
- 한글 경로를 `--user-data-dir`로 주면 디버깅 포트가 안 열린다 → ASCII 경로.
- evaluate 코드 문자열 안 `\n`은 깨지므로 `String.fromCharCode(10)`. 스크립트는 heredoc 말고 파일로 쓴다(백틱·`${}` 깨짐, [Claude Code Bash 도구의 이스케이프 함정](common/ai-agents/claude-code-bash-escaping)).
- 끝나면 `Get-CimInstance Win32_Process | ? CommandLine -like '*<dir>*' | Stop-Process`로 내가 띄운 Chrome만 끄고 vite를 종료한 뒤 프로필 폴더를 지운다.
- 고정 크기 한 장 캡처(예: 1080×1350 카드): `chrome --headless=new --screenshot --window-size=1080,1350 --hide-scrollbars --force-device-scale-factor=1`.
- 로그인 판정·캐시 적중·글꼴 검사는 [Chrome CDP로 브라우저 상태 검사](common/web/chrome-cdp-checks).
