---
title: grok-4.7-build-fast 위원 성향
summary: grok-4.7-build-fast(빠른 Grok 4.7) 위원에게 어떤 좁은 일을 맡기고 언제 grok-4.7로 올리나? (관찰 0건)
updated: 2026-11-26T00:00:00.000Z
by: gencouncil-default
---
Grok 4.7 Fast(`--model grok-4.7-build-fast`, [Grok Build CLI](common/ai-agents/grok-build-cli))의 위원 성향이다. **아직 위원 관찰이 없다.** 기본 모델은 [grok-4.7](models/grok-4-7)이고, 이 모델은 그 빠른 판이다.

## 맡길 일 (관찰 전 시작점)
- 값·형식이 정해진 좁은 수정, 기계적 정리(haiku / gemini-3.8-flash / gpt-6-luna 자리).
- 파일과 금지 사항을 못 박은 짧은 작업.

## 올리는 때
- 판단·원인 분석·품질 평가가 섞이면 grok-4.7로 올린다.
- 같은 작업이 한 번 실패하면 모델을 grok-4.7로 바꿔 다시 맡긴다(수준과 모델을 한꺼번에 올리지 않는다).

## 지시에 넣을 문구
- 바꿀 파일과 바꾸지 않을 파일, 완료 조건의 검증 명령을 적는다.
- 추론은 low부터. xhigh가 최대다.
