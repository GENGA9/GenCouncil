---
title: 웹 버튼 클릭이 씹히거나 엉뚱한 곳에 갈 때 (ghost click·:active transform)
summary: 모바일에서 띄운 창이 바로 닫히거나, 버튼이 눌림 효과만 나고 가끔 클릭이 안 될 때 원인과 해결은?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
포인터 이벤트 순서와 히트 영역 때문에 click이 의도와 다른 요소에 떨어지는 두 경우다.
터치에서는 pointerup 뒤의 click이 새로 뜬 overlay에, `:active` transform 버튼에서는 click이 부모로 간다.

## 언제 쓰나
- pointerup/pointerdown에서 띄운 "바깥 누르면 닫힘" 창이 터치일 때만 곧바로 닫힐 때
- `.btn:active{transform:translateY(Npx)}` 버튼이 "가끔 안 눌린다"는 보고(특히 이벤트 위임 `closest('[data-act]')`)

## 방법
### 모바일 ghost click
- 순서: pointerdown → pointerup(창 뜸) → touchend → click. 이 click이 새 overlay에 떨어져 '바깥 클릭'이 된다.
- 누르는 칸에 `el.addEventListener('touchend', e => { if (e.cancelable) e.preventDefault(); }, { passive: false })`를 붙이거나, 동작을 click에서 한다.
- 재현: Playwright `newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true })` + `page.touchscreen.tap(x,y)`, capture 리스너로 click target이 overlay인지 확인.

### :active transform이 click을 부모로 보냄
- 버튼 위 가장자리(N px 안)를 누르면 pointerup 때 포인터가 버튼 밖이라 click이 공통 조상(부모)으로 간다.
- 눌린 동안 원래 윗자리를 덮는다(버튼은 position:relative):
  `.btn:active:not(:disabled)::before{content:'';position:absolute;left:0;right:0;top:calc(-1*이동량*여유);height:calc(이동량*여유)}`
- 또는 transform 대신 box-shadow/안쪽 요소만 움직여 히트 영역을 유지한다.
- 재현: 실제 마우스·CDP `Input.dispatchMouseEvent`로 위 가장자리 0.5~3px을 누르고 70ms 뒤 떼며 down/up/click target을 기록.
- 회귀 테스트: 눌린 스타일에서 원래 윗자리의 elementFromPoint가 버튼인지.

## 주의할 점
- 레이아웃 흔들림 문제는 [UI 크기·버튼 위치가 흔들릴 때](common/web/css-layout-stability).
