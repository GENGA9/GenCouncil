---
title: python 스크립트를 JS로 옮길 때 출력 바이트 맞추기: 2.0 같은 float 표기(JSON.parse reviver context.source)·cmp 비교
summary: json.load + f-string으로 출력하던 python 스크립트를 node로 옮겼더니 2.0이 2로 찍혀 출력이 달라질 때 원문 숫자 표기를 어떻게 살리고, 두 판의 출력이 같은지 어떻게 확인하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
JSON의 `2.0`은 python에서는 `2.0`으로, JS에서는 `2`로 찍힌다. JS의 JSON.parse는 정수와 실수를 구분하지 않기 때문이다. Node 21 이상에서는 reviver의 세 번째 인자 `context.source`에 숫자의 원문 표기가 들어 있어 그대로 쓸 수 있다.

## 언제 쓰나
- python 생성 스크립트(json.load + f-string)를 JS로 옮기면서 출력이 바이트 단위로 같아야 할 때

## 방법
- 숫자를 원문 문자열로 남겨 읽는다: `JSON.parse(text, (k, v, ctx) => (typeof v === 'number' ? ctx.source : v))`
- python json.dump가 쓴 파일이면 원문 표기가 python `str(float)`와 같다. 템플릿에는 그대로 찍히고, 계산에 쓸 숫자는 `Number()`로 바꿔 쓴다.
- 옮긴 뒤 같은 입력으로 python 판과 JS 판의 출력을 파일로 저장해 `cmp`로 비교한다.

## 주의할 점
- Node 21 미만에는 `context.source`가 없다(확인한 판: v24).