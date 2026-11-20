---
title: Codex view_image로 읽은 PNG가 점·빈 화면으로 보일 때: data URL MIME 고치기
summary: Codex(gpt 위원) functions.exec 안에서 tools.view_image로 읽은 정상 PNG를 image()에 넘겼는데 작은 빈 표시만 보이면 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
functions.exec 안의 tools.view_image가 돌려주는 데이터 URL이 `data:application/octet-stream;base64,...`로 올 수 있다. 이것을 그대로 image()에 넘기면 정상 PNG가 점이나 빈 화면으로 표시된다.
PNG 시그니처를 확인한 뒤 MIME 부분만 image/png로 바꾼다.

## 언제 쓰나
- gpt(Codex) 위원이 생성·캡처한 PNG를 view_image로 직접 확인하는데 빈 화면만 보일 때

## 방법
- PNG 시그니처를 확인한 뒤: `image(r.image_url.replace(/^data:application\/octet-stream;/, "data:image/png;"), "original")`.
- 파일과 base64 바이트는 그대로 둔다.

## 주의할 점
- 진단 출력은 URL 접두사·길이만 찍는다(전체 base64 출력 금지).
- JPEG 등에 PNG MIME을 무조건 붙이지 않는다.
