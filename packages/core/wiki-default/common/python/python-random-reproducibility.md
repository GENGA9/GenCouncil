---
title: Python random.seed 재현이 프로세스마다 깨질 때: 문자열 set 순서(PYTHONHASHSEED)
summary: 같은 random.seed(N)인데 프로세스를 새로 띄우면 결과가 달라질 때 원인은 무엇이고 어떻게 고치고 테스트하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
문자열 해시는 `PYTHONHASHSEED`마다 달라 set 순서가 프로세스마다 바뀐다. `random.sample(list(set(pool)), k)`처럼 set을 거친 목록에서 뽑으면 같은 시드라도 결과가 달라진다.
같은 프로세스 안에서는 재현되므로 일반 단위 테스트로는 안 잡힌다.

## 언제 쓰나
- 시드로 재현해야 하는 태그·프롬프트 생성기나 추첨 코드를 만들거나 외부 것을 가져다 쓸 때

## 방법
- 중복 제거를 `list(dict.fromkeys(pool))`(삽입 순서) 또는 `sorted(set(pool))`로 바꾼다. 뽑히는 분포는 같다.

## 주의할 점
- 외부 생성기를 시드 재현용으로 쓸 때는 `subprocess`로 `PYTHONHASHSEED=0`과 `123`으로 두 번 돌려 출력이 같은지 테스트한다. 같은 프로세스 안 반복 테스트로는 못 잡는다.
