---
title: Chrome CDP로 브라우저 상태 검사: 로그인 판정·캐시 적중·시스템 글꼴 섞임
summary: CDP(Playwright 포함)로 로그인 여부를 오류 화면과 구분해 판정하고, 응답이 캐시·304였는지 재고, 렌더에 시스템 대체 글꼴이 섞였는지 어떻게 검사하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
화면 캡처·fetch 결과·CSS grep만으로는 알 수 없는 브라우저 상태를 Chrome DevTools Protocol(CDP)로 직접 재는 방법이다. Playwright의 CDP 세션에서도 같다.

## 언제 쓰나
- 로그인 세션을 재사용하는 DOM 수집기(스크레이퍼)에서 인증 상태를 판정할 때
- 응답이 브라우저 캐시에서 왔는지, 304였는지 확인할 때
- 이모지·기호·다국어 글자가 번들 글꼴로 그려졌는지 검사할 때

## 방법
### 로그인 판정: Chrome 오류 화면과 비로그인 구분
- "로그인 버튼 없음"·"article 없음"만으로 추정하면 Chrome HTTP 오류·접근 차단 화면을 로그인 성공·빈 목록으로 오인한다.
- URL의 `chrome-error:`와 오류 DOM을 먼저 검사하고, 로그인 리다이렉트·로그인 CTA·사용자명 입력을 따로 판정한다.
- 로그인 신호도 정상 콘텐츠도 없으면 "인증 상태 미확인" 경고를 낸다.
- 연결 실패·비로그인·콘텐츠 없음 경로를 분리하고, 실제 오류 화면 검증과 fixture 검증을 구별해 보고한다.

### 캐시 적중·304 실측
- fetch는 304를 200으로 숨기고, 화면으로는 알 수 없다.
- CDP Network `loadingFinished.encodedDataLength`로 본다: 0 B면 캐시 적중, 약 300 B면 304.
- 서버 쪽 ETag/304 구현은 [FastAPI·Starlette 함정](common/python/fastapi-starlette-pitfalls).

### 렌더에 시스템 글꼴이 섞였는지
- 이모지·기호·스택에 없는 글자는 시스템 대체 글꼴로 그려지고 CSS grep으론 모른다. `document.fonts.ready`만 기다리면 지연 로드 글꼴이 빠진다.
- 렌더 전 `Promise.all([...document.fonts].map(f=>f.load()))`, `status!=='loaded'`면 throw.
- 글자 노드에 `data-fc`를 달고 CDP `CSS.getPlatformFontsForNode` → `isCustomFont:false`면 시스템 글꼴.
- 막는 법: 번들 글꼴을 별칭 `@font-face`로 두고, 스택 끝 sans-serif·Windows 글꼴명을 지우고, Noto Color Emoji/Math/Symbols(OFL)를 추가한다.
- 언어별 한자 자형은 `html[lang]`별 CSS 변수로 스택 순서를 바꾼다.
- 도트체는 `unicode-range`로 라틴·한글만. 가변 Noto에 `font-weight: 400 700`이면 900이 700으로 잘린다.

## 주의할 점
- Windows 글꼴로 만든 이미지의 상업 사용은 Windows 기본 글꼴 라이선스를 확인한다.
