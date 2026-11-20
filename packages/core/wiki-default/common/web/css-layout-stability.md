---
title: UI 크기·버튼 위치가 흔들릴 때 (스크롤바 되먹임·가변 글자)
summary: 다시 그릴 때마다 UI 크기가 번갈아 바뀌거나 모달의 버튼 위치가 글자 길이에 따라 튈 때 어떻게 고정하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
웹 UI에서 측정값이 이전 렌더에 되먹임되거나, 가변 길이 글자가 버튼 위에 있으면 크기·위치가 흔들린다.
측정은 스크롤바와 무관한 값으로, 가변 칸은 고정 높이로 만든다. 클릭이 안 먹는 문제는 [웹 버튼 클릭이 씹힐 때](common/web/web-click-pitfalls).

## 언제 쓰나
- 다시 그릴 때마다 크기가 커졌다 작아졌다 번갈아 바뀔 때(예: 643×373 ↔ 633×363)
- 선택 전후로 글자 길이가 바뀌어 모달 하단 버튼 Y좌표가 튀고 잘못 누르게 될 때

## 방법
### 스크롤바 되먹임
- 원인: 렌더 전 컨테이너를 clientWidth/Height로 재면, 이전 내용이 몇 px 넘쳐 생긴 스크롤바가 값에 섞인다. 20px 문턱 ResizeObserver로는 못 잡는다.
- offsetWidth/Height에서 테두리·padding을 뺀 값으로 잰다(스크롤바와 무관).
- 내용 높이는 margin·gap·고정 줄 높이를 상수로 빼서 넘치지 않게 하고, 이전 렌더에서 잰 높이는 쓰지 않는다.

### 모달 가변 글자 위 버튼
- 위쪽 가변 글자 칸을 고정 높이 말줄임으로:
  `height: 36px; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; text-overflow: ellipsis; word-break: break-all;`
- 가변 요약 표·경고 문구는 버튼 아래에 둔다.
- 빠른 선택·확인 같은 주 액션 버튼이 있는 모달은 제목·설명을 고정 높이로 통일하고, 버튼을 그 바로 아래 고정 슬롯에 둔다.

## 주의할 점
- 스크롤바 되먹임 테스트: 가짜 DOM(넘치면 client 크기를 줄이는 fakeBody)으로 render를 여러 번 불러 크기가 같은지 assert. 실기에서는 refresh마다 scroll==client 로그.
