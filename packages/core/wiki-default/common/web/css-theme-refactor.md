---
title: 테마 CSS 리팩터: 런타임 테마를 정적 CSS로·전후 화면 동일 증명·!important와 키프레임
summary: styleSheets를 훑던 런타임 테마를 정적 CSS로 옮기거나 CSS 구조를 바꿀 때 화면이 그대로인지 어떻게 숫자로 증명하고, 테마의 !important가 키프레임 애니메이션을 덮을 때 어떻게 푸나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
테마 CSS를 손볼 때는 "화면이 그대로"를 눈이 아니라 computed style 덤프와 픽셀 diff로 증명한다. 런타임에 CSSOM을 고치던 테마를 정적 CSS로 옮길 때는 크롬 직렬화 값과 선택자 순위가 바뀌는 지점을 맞춘다.
테마가 `!important`로 거는 속성은 나중에 추가한 키프레임 애니메이션도 덮는다.

## 언제 쓰나
- `document.styleSheets`를 훑어 색을 바꾸던 런타임 테마를 걷어내고 결과를 소스 CSS에 적을 때
- CSS 구조를 바꾼 뒤 전과 같은지 증명해야 할 때
- 새 애니메이션 클래스(테두리·그림자 맥동)가 테마 화면에서 안 보일 때

## 방법
### 런타임 테마 → 정적 CSS 변환 규칙
- postcss로 같은 규칙을 적용하되 크롬 직렬화 값 기준으로 맞춘다: hex8은 rgba, 사용자 정의 속성·`var()` 값은 원문 그대로, `var()`가 든 단축 속성은 칠해지지 않음(건너뜀), `@keyframes` 안은 칠해짐.
- `html[data-theme] X` 접두를 떼면 순위가 낮아진다. 승패가 바뀌는 규칙만 `:root X`/`html:root X`로 보존한다. 이 접두는 우선순위용이니 나중에 떼지 않는다.
- 인라인 색: `color:바뀐색;--ink-raw:원래색` + `:where(맥락) [style*='--ink-raw']{color:var(--ink-raw)!important}`.

### 전후 화면 동일 증명: computed style + 픽셀 diff
- 변경 전 사본: `git archive HEAD | tar -x -C .council/before`. 전후를 vite 다른 포트로 띄운다.
- Playwright `page.clock.install`과 Math.random 시드 고정으로 같은 장면을 만든다.
- 모든 요소의 getComputedStyle을 DOM 경로 키로 덤프해 비교하고, 픽셀 diff도 본다.
- worktree의 node_modules junction은 `cmd /c rmdir`로 먼저 끊는다(junction 만들기·지우기는 [worktree의 node_modules junction](common/council-merge/worktree-node-modules-junction)).

### 테마 `!important`가 키프레임 맥동을 덮을 때
- 테마 CSS가 요소에 `box-shadow: ... !important`를 걸면 파생 클래스의 `@keyframes` box-shadow 맥동이 보이지 않는다.
- 테마의 `!important` 대상을 `:not(.애니메이션클래스)`로 좁혀 맥동 대상만 뺀다. 예: `.card:not(.pulse) { box-shadow: ... !important; }`.

## 주의할 점
- 동적 테두리·그림자 애니메이션 클래스를 추가할 때는 테마 파일의 `!important` 선언부터 검색한다.
- 캔버스 쪽 화면 동일 검증은 [캔버스 성능](common/web/canvas-performance), 시스템 글꼴 섞임 검사는 [Chrome CDP로 브라우저 상태 검사](common/web/chrome-cdp-checks).
