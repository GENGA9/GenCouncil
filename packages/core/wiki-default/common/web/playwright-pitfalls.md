---
title: Playwright 캡처·테스트 함정: 패키지 없는 저장소·networkidle 타임아웃·setContent의 file:// 이미지·async waitForFunction·부분 일치 이름·업로드 폼 모킹·고아 chrome.exe
summary: Playwright로 화면을 캡처하거나 폼을 테스트할 때 저장소에 playwright가 없거나, goto가 타임아웃되거나, 이미지가 16×16 깨진 그림으로 찍히거나, 준비 전에 진행되거나, 엉뚱한 버튼을 누르거나, 로그인 벽 뒤 업로드 폼을 검증해야 하거나, timeout으로 죽인 뒤 chrome.exe가 남을 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Playwright 캡처·테스트 스크립트에서 오류 없이 틀린 결과를 내는 함정들이다. 대기 조건, 페이지 출처(about:blank), 비동기 판정, 이름 부분 일치가 대표적이다.
Playwright 없이 CDP로 직접 캡처하는 법은 [Chrome headless CDP로 웹 화면 캡처](common/web/chrome-headless-cdp-capture), CDP로 상태를 재는 법은 [Chrome CDP로 브라우저 상태 검사](common/web/chrome-cdp-checks).

## 언제 쓰나
- 앱 화면 캡처, 일괄 렌더(HTML → PNG), 폼 E2E 테스트를 Playwright로 할 때

## 방법
### playwright가 없는 저장소: 다른 프로젝트 것을 require
- 설치하면 package.json·lock이 바뀐다.
- 같은 PC의 다른 프로젝트에 있는 `node_modules/playwright`와 브라우저 `%LOCALAPPDATA%/ms-playwright/chromium-<버전>`을 쓴다.
- 커밋하지 않는 곳(.council/ 등)의 스크립트에서 `const { chromium } = require("<다른 프로젝트>/node_modules/playwright");`

### 상태 폴링이 있는 앱: networkidle 대신 domcontentloaded
- 폴링 API가 도는 앱(Next 등)에서 `page.goto(..., {waitUntil:"networkidle"})`은 30초 타임아웃된다.
- `waitUntil:"domcontentloaded"` 후 `waitForTimeout(2500)`.

### setContent 페이지는 file:// 이미지를 못 읽는다
- `page.setContent()`의 about:blank에서 `<img src="file:///...">`는 차단되고 오류 없이 16×16 깨진 그림이 찍힌다.
- HTML을 임시 파일로 쓰고 `page.goto(pathToFileURL(file).href)`.
- `await page.evaluate(() => document.querySelector('img').decode())`로 실제 디코드를 기다린다(실패 시 오류).
- 일괄 생성 결과의 해시·크기가 전부 같으면 의심한다. 알파 bbox가 16×16이면 확정.

### waitForFunction에 async 함수를 주면 즉시 통과
- `page.waitForFunction(async ...)`는 반환된 Promise가 truthy라 바로 통과해 앱 상태 준비 전에 진행한다.
- 동기 함수를 넘기거나(모듈은 미리 `window.__mods`에 저장), node 쪽 루프에서 `page.evaluate`로 폴링한다.

### 이름 부분 일치·fixed 요소
- `getByRole("button",{name:"로그"})`는 부분 일치라 "로그아웃"을 누른다 → `exact: true`.
- fullPage 캡처에서 position:fixed 요소는 원래 뷰포트 위치에 찍혀 본문을 가린다 → 접거나 따로 찍는다.

### 로그인 벽 뒤 업로드 폼 테스트 (백엔드 없이)
- 인증은 `page.route("**/api/auth/me", ...)`로 모킹한다.
- 업로드는 `route.request().postDataBuffer()`로 multipart 필드를 세어 검증한다.
- 같은 파일 중복 검사는 `setInputFiles`에 경로를 준다. buffer로 주면 lastModified가 매번 달라져 중복으로 안 잡힌다.

## 주의할 점
- `timeout`으로 Playwright 스크립트를 죽이면 띄운 chrome.exe가 고아로 남아 다음 캡처·테스트에 부하를 준다. 프로세스 CommandLine에 `playwright_chromiumdev_profile`이 있고 시작 시각이 내 실행 이후인 chrome.exe만 골라 닫는다([Windows 프로세스 확인·종료](common/windows/windows-process-find-kill)).
- `taskkill /IM chrome.exe`는 사용자 Chrome까지 닫으니 쓰지 않는다. 위원 지시에는 "네가 띄운 Chrome만 PID로 종료"를 적는다.
- 캡처 결과 PNG는 직접 열어 확인한다([위원 지시에 넣을 공통 조건](common/council-members/council-member-instructions)).
- vite 개발 서버 앱을 evaluate로 조작할 때의 HMR 함정은 [Vite 함정](common/web/vite-pitfalls).
