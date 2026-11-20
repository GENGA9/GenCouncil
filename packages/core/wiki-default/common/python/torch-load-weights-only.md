---
title: torch.load "Can only SETITEMS for dict…" 오류: pickle 전역 점검 후 weights_only=False
summary: transformers 객체(DynamicCache 등)가 든 .pt를 torch.load가 safe_globals로 허용해도 UnpicklingError로 못 읽을 때 어떻게 안전하게 읽나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
transformers `BaseModelOutputWithPast`·`DynamicCache`가 든 .pt를 `weights_only=True`(기본)로 읽으면, `safe_globals`로 클래스를 허용해도 `UnpicklingError: Can only SETITEMS for dict, OrderedDict, Counter …`가 난다(torch 2.11).
신뢰할 출처 파일만, pickle 안의 전역을 먼저 점검한 뒤 `weights_only=False`로 읽는다.

## 언제 쓰나
- 모델 중간 출력·캐시를 저장한 .pt를 새 torch에서 다시 읽을 때 위 오류가 날 때

## 방법
- .pt(zip) 안의 `data.pkl`을 `pickletools.genops`로 돌려 GLOBAL/STACK_GLOBAL 전역을 모은다.
- 아는 클래스뿐인지 확인한 뒤 `torch.load(path, weights_only=False)`.

## 주의할 점
- 출처 불명 파일에는 쓰지 않는다(`weights_only=False`는 임의 코드 실행이 가능하다).
