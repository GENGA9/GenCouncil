---
title: claude fable 위원 성향
summary: claude fable 위원에게 어떤 설계·분석 일(코드 3D 프리비즈 설계 포함)을 맡기고, 모델 ID·advisor는 어떻게 지정하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
여러 레버가 얽힌 설계에서 "되는지, 왜 안 되는지"를 먼저 알아야 할 때, 그리고 처음부터 짜는 코드 설계(three.js 프리비즈 등)에 맞다. 목표가 구조적으로 불가능하면 숫자로 증명한다.
목표 미달로 끝날 수 있으니 의장이 바로 사용자 결정 질문으로 잇는다. 동작 지시는 문자 그대로 크게 해석하는 경향이 있다.

## 잘하는 일
- (effort high) 변형 실험 표로 목표가 구조적으로 불가능함을 증명한다. 밸런스를 흔들 값은 커밋하지 않는다
- 맞출 수 있는 부분만 반영하고, 선택지를 사용자 결정용으로 정리한다
- 측정 하네스에 계측을 추가해 이후 위원들이 다시 쓸 수 있게 한다
- (high) three.js와 Playwright 헤드리스로 코드 3D 마네킹 프리비즈를 처음부터 설계했다(관절 IK, 사격 상태기계, 카메라, HUD, 정리본 분리). 한 번에 완성도가 높았다
- 액션 시퀀스를 재연출할 때 속도 램프와 더블컷까지 스스로 설계했다

## 약한 일
- 목표 달성 대신 "불가능 증명+선택지"로 끝날 수 있다
- 동작 지시를 문자 그대로 크게 해석한다(예: "점프해서 쏘기"를 과하게 큰 점프로)

## 지시에 넣을 문구
- 결과 보고 뒤 의장이 바로 사용자 결정 질문으로 잇도록, 선택지를 사용자 결정용으로 정리하라고 적는다
- 동작 지시는 크기·높이·시간을 숫자로 적는다(예: 점프 높이, 프레임 수)

## 모델 ID·advisor (Claude Code)
- Claude Code CLI 2.1.319에서 `--model fable` 별칭은 Fable 5.1(claude-fable-5-1)로 실행된다. 5.2는 전체 ID로 넘긴다: `claude --model claude-fable-5-2`. `[claude-code:unrecognized_model]` 경고가 나와도 정상 실행되고 modelUsage에 claude-fable-5-2로 찍힌다.
- Fable 5.2는 advisor를 쓰지도, advisor가 되지도 못한다: `--model claude-fable-5-2 --advisor ...`는 "does not support the advisor tool", `--advisor claude-fable-5-2`는 "cannot be used as an advisor" 오류로 종료한다.
- `--advisor fable`(별칭이라 5.1)은 Opus 등 아래 등급 모델에 붙일 수 있다.
- GenCouncil: `drivers.ts`의 `claudeModelId()`가 fable을 claude-fable-5-2로 바꿔 넘긴다. 바꾸려면 환경변수 `GENCOUNCIL_FABLE_MODEL`. Fable 위원과 의장에는 advisor를 붙이지 않는다.
- 새 버전이 나오면 `claude -p ok --model <id> --output-format json`의 modelUsage로 실제 모델을 확인한다.
