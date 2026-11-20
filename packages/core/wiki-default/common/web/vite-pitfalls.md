---
title: Vite 함정: HMR 뒤 dynamic import 다른 인스턴스·define 상수 트리셰이킹·SSR 로더 24678 포트
summary: vite 개발 서버 캡처 중 import('/src/x.ts')가 다른 모듈을 받거나, define 상수로 플랫폼별 구현을 번들에서 빼고 싶거나, SSR 전용 로더가 24678 WebSocket 포트로 충돌할 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Vite에서 오류 없이 엉뚱하게 동작하는 함정 세 가지다. HMR을 거친 모듈은 `?t=` URL로 다시 읽혀 다른 인스턴스가 되고, define 상수는 변수를 거치면 트리셰이킹이 안 되며, middlewareMode 로더도 기본 WebSocket 포트 24678을 연다.
캡처 일반은 [Playwright 캡처·테스트 함정](common/web/playwright-pitfalls)·[Chrome headless CDP로 웹 화면 캡처](common/web/chrome-headless-cdp-capture), vitest의 파일 확인은 [vitest에서 파일 존재·내용 확인](common/web/vitest-file-checks).

## 언제 쓰나
- 페이지 안(CDP·Playwright evaluate)에서 `await import('/src/app.ts')`로 앱 상태를 만지며 캡처할 때
- 웹·Steam(Electron) 같은 플랫폼별 구현을 빌드마다 하나만 넣고 싶을 때
- 테스트·리플레이용으로 `createServer({server:{middlewareMode:true}})` SSR 로더를 만들 때

## 방법
### 개발 서버 캡처 중 소스를 고치면 import가 다른 모듈을 받는다
- 증상: 캡처 도중 소스를 고치면 `app.state`가 undefined가 된다. HMR을 거친 모듈은 `?t=타임스탬프` URL로 다시 읽혀서, 쿼리 없는 URL은 다른 인스턴스다.
- 해결: `performance.getEntriesByType('resource')`에서 같은 경로의 실제 URL(?t= 포함)로 import한다. `page.addInitScript`로 `window.__imp = (n) => import(resourceUrlContaining('/src/'+n) || '/src/'+n)`을 심어 모든 evaluate에서 쓴다.
- 또는 캡처 중엔 소스를 고치지 않고, 고쳤으면 vite를 완전히 껐다 다시 띄운다(재시작 뒤 또 고치면 다시 생긴다).

### define 상수로 플랫폼별 구현을 번들에서 빼기
- 함정: `const id = __PLATFORM__`처럼 변수를 거치거나, 구현 모듈이 맨 위에서 객체를 만들면 부수 효과로 보여 안 쓰는 구현이 번들에 남는다.
- `define: { __PLATFORM__: JSON.stringify(id) }`, d.ts에 `declare const __PLATFORM__`. 구현 모듈은 팩토리만 export한다(`createSteamPlatform()`).
- 고르는 곳에서 직접 비교·호출: `typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'steam' ? createSteamPlatform() : createWebPlatform()`(typeof는 define 없는 도구용, 빌드에서 접힌다).
- 확인: 빌드 결과를 grep할 때 백틱 문자열(`` `steam` ``)도 찾는다.
- vitest는 config의 define을 쓰니 브리지는 getter로 읽게 한다. 셸 env 차이는 `node <빌드 스크립트>.mjs <id>`로 감싼다.

### SSR 전용 로더의 24678 포트 충돌: server.ws=false
- `createServer({server:{middlewareMode:true}})`는 HTTP listen만 안 할 뿐 기본 WebSocket 포트 24678을 열려고 해 테스트·리플레이 로더가 다른 서버와 충돌한다.
- 루트 vite.config 옵션은 `configFile:false` 로더에 적용되지 않는다 → 로더 생성부에 직접 `server:{middlewareMode:true, watch:null, ws:false}`.
- 같이 쓰는 값: `configFile:false`, `appType:'custom'`, `optimizeDeps:{noDiscovery:true}` → ssrLoadModule·close까지 exit 0, 포트 경고 없음(Vite 8.3.2 확인: createWebSocketServer는 server.ws===false면 listen이 noop).
- 하지 말 것: 다른 프로세스를 끄거나 공용 포트를 재할당하기. `hmr:false`만으로 WebSocket 생성도 막힌다고 가정하기.

## 주의할 점
- 백그라운드 작업이 '중지'돼도 node가 포트를 쥐면 strictPort 오류가 난다: `Get-NetTCPConnection -LocalPort N -State Listen`로 PID → CommandLine이 `vite ... --port N`인지 확인 후 Stop-Process. 남의 서버는 건드리지 않는다([Windows 프로세스 확인·종료](common/windows/windows-process-find-kill)).
- 다른 Vite 버전은 로컬 구현·실행을 확인하고 적용한다.
