---
title: Antigravity CLI(agy): 쓸 수 있는 Gemini 모델 이름·추론 단계 확인(agy models)·새 모델 붙이기 전 확인
summary: 새 Gemini 모델(예: Gemini 4 Hydrogen)이 나왔을 때 Antigravity CLI(agy)가 받는 정확한 --model 문자열과 추론 단계(low~xhigh)를 사용량 없이 어떻게 확인하고, 위원·도구에 붙일 때 단계 상한을 어떻게 다루나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Antigravity CLI `agy`는 `--model <모델>-<단계>` 형태로 Gemini 모델을 부른다. 공식 블로그·문서에는 agy용 id가 없으므로 새 모델이 나오면 `agy models` 출력으로 id와 단계를 확정한다. 작업 요청(`-p`)을 보내지 않으므로 사용량이 들지 않는다.

## 언제 쓰나
- 새 Gemini 모델이 공개돼 위원·도구(모델 사다리)에 붙일 때
- agy가 받는 모델 문자열이나 추론 단계를 모를 때

## 방법
- `agy --help`: `models` 하위 명령과 `--effort (low|medium|high|xhigh|max)` 옵션을 보여 준다.
- `agy models`: 계정에서 쓸 수 있는 모델을 `<모델>-<단계>`로 나열한다. 2026-11-13 기준:
  - `gemini-3.8-flash-{low,medium,high}`
  - `gemini-4-argon-{low,medium,high}`
  - `gemini-4-hydrogen-{low,medium,high,xhigh}` (xhigh는 Hydrogen에만 있다)
- 단계는 모델마다 다르니 모델별 상한으로 다룬다(한 모델의 상한을 다른 모델에 그대로 쓰지 않는다).
- 웹 검색은 "Gemini 4 Hydrogen"처럼 세대 번호를 넣는다("antigravity hydrogen"은 물리학 결과가 섞인다).

## 주의할 점
- Hydrogen은 Pro·Ultra 구독자만 Antigravity에서 쓸 수 있다.
- 확인은 `agy --help`·`agy models`로만 한다. 실제 `-p` 실행은 사용량이 들고, GenCouncil에서는 다른 AI CLI 직접 실행이 사용자 지시 없이 금지다.
