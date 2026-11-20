---
title: 실행 중인 위원 지시 바꾸기: 정지 후 재배정
summary: 이미 돌고 있는 위원에게 추가·정정 지시를 어떻게 전하나(SendMessage가 보류되거나 작업이 끝난 뒤에야 읽힐 때)?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원(claude CLI 세션)에게 SendMessage로 추가·정정 지시를 보내면 권한 모드가 달라 "[Cross-session delivery notice] held"로 보류되어 전달되지 않는다. 한 안건에서도 실행 중 보낸 추가 지시가 3번 중 3번 반영되지 않았다(위원이 작업을 끝낸 뒤에 읽음). council_handover에는 지시 칸이 없다.
그래서 진행 정도에 따라 정지 후 재배정하거나, 그대로 두고 후속 작업으로 처리한다.

## 언제 쓰나
- 배정한 뒤 사용자가 지시를 바꾸거나 더할 때, 의장이 지시 오류를 알았을 때

## 방법
- 착수 직후(몇 분)이고 정정이 결과를 바꾸면: council_stop_member → 같은 task_id로 수정 지시를 담아 council_assign(멈춘 브랜치 커밋은 "참고만").
- 많이 진행됐고 정정이 뒤 단계(예: 마지막 수치 고르기)에만 영향: 그대로 두고 머지 후 후속 작업.
- 같은 파일을 만지는 후속 지시는 add_task로 등록해 앞 위원 머지 직후 배정한다(동시 배정하면 충돌).

## 주의할 점
- SendMessage로 보낸 추가 요청이 반영됐을 거라고 가정하지 않는다. 위원 결과에서 반영 여부를 확인한다.
- 지시를 처음부터 완결되게 쓴다. 사용자가 연달아 지시를 추가하는 중이면 배정을 잠깐 미룬다([사용자 실시간 테스트 중 수정 모으기](common/council/council-live-testing-batch)).
- 긴 실행(측정·배치)은 구현과 실행을 나눠 배정한다.
- 정지한 위원이 띄운 스크립트는 [위원 정지 후 남은 생성 스크립트 정리](common/council-members/council-stop-member-orphan-process).
