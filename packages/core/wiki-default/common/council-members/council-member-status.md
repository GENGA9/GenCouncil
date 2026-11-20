---
title: 위원 상태가 이상할 때: failed인데 정상·running 남음·중단 직후 인계 거절(stopped 확인)·핸드오버 거절
summary: 위원이 failed(other)로 끝났는데 커밋이 있거나, 끝났는데 running으로 남거나, 정정 지시를 위해 위원을 멈춘 직후 인계가 running 판정으로 거절되거나, 핸드오버가 'no usable claude account'로 거절될 때 의장은 무엇을 확인하고 언제 인계 완료를 기록하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원의 status·이벤트가 실제 작업 결과와 어긋나는 경우가 있다. 상태 문구만 보고 재배정하지 말고 council_member로 커밋·RESULT·lastText를 먼저 확인한다.
핸드오버는 계정·횟수 제한으로 거절될 수 있어, account·model 명시 → 다른 provider → 새 council_assign 순으로 넘어간다. 인계 완료는 성공 응답을 확인한 뒤에만 기록한다.

## 언제 쓰나
- 위원이 failed인데 실패 원인이 완료 문장일 때
- 위원이 일을 끝냈는데 status running에 toolCalls가 멈춰 있을 때
- 사용자 정정을 반영하려고 위원을 멈추고 바로 인계할 때
- council_handover가 거절되거나, 인계 위원이 0 tool calls로 바로 죽을 때

## 방법
### failed(other)인데 커밋이 정상
- 증상: 일을 다 끝내고 커밋했는데 failed, 원인(other)이 마지막 출력 한 줄("git commit 완료")로 찍히고 자동 검증도 안 붙는다.
- 실패 이벤트는 "실패 원인" 문구부터 읽는다. 완료 문장이면 council_member로 commits·RESULT·diff를 확인하고, 완료 조건이 맞으면 의장이 diff 검토 후 머지한다.

### 끝났는데 running으로 남음
- 주로 핸드오버 위원에게 생긴다. council_member의 lastText(완료 문장)·toolCalls 정지와 커밋을 확인 → council_stop_member → council_merge. 정지된 위원도 머지된다.

### 중단 직후 인계: stopped 확인 → 인계 → 성공 응답 확인 → 체크포인트
- 증상: 실행 중 사용자 정정을 반영하려고 위원을 멈춘 직후 인계를 요청하면 아직 running으로 판정돼 거절될 수 있다. 계정 표시가 ok여도 거절될 수 있다. 성공을 가정하고 쓴 체크포인트는 틀린 인계 정보를 남긴다.
- 1. 중단 요청 접수와 실제 종료를 구분한다. council_member/council_state에서 stopped를 확인한 뒤 인계한다.
- 2. 인계 reason과 작업 설명에 최신 정정이 원 지시보다 우선함과 원래 완료 조건을 같이 쓴다.
- 3. 같은 worktree로 인계를 시도하고, 그 provider를 쓸 수 없으면 허용된 다른 provider로 이어받는다. 사용 불가 원인을 임의로 quota(한도 소진)로 단정하지 않는다.
- 4. council_handover 성공 응답에 나온 후속 member_id와 보존된 branch/worktree를 확인한 뒤에만 체크포인트에 인계 완료를 쓴다. 실패 응답은 실패로 기록하고, 뒤에 성공하면 고쳐 쓴다.
- 5. 뒤늦게 오는 이전 위원 종료 이벤트는 handoverTo와 대조해 중복 재배정하지 않는다.
- 정정 때문에 멈춘 실행(결과·커밋 없음)은 그 모델의 실패나 성향 근거로 쓰지 않는다.

### 핸드오버 'no usable claude account' 거절
- 증상: council_handover(provider: claude)가 "no usable claude account (claude:ok)"로 거절된다(동시 한도, 또는 그 provider 계정이 하나뿐이면 ok여도 직전 계정을 빼고 고르는 듯). 개인 한도 소진 위원은 자동 인계되지 않는다.
- account·model을 명시해 다시 부른다: `council_handover(member_id, account:"claude", model:"sonnet", reason)`. 같은 worktree에서 이어 가며, reason에 바뀐 지시를 다 쓰면 인계 위원이 그대로 따른다.
- 계속 거절되면 같은 지시로 provider gpt/gemini 핸드오버(충돌 해결도 같은 방식).
- 끝났거나 정지한 위원에게 수정 지시: `council_verify(member_id, model, reason)`(같은 worktree·branch, model을 한 단계 올릴 수 있다).

### 인계가 안 될 때: 새 council_assign
- 앱 재시작 후 자동 인계·"이어서 하기" 위원이 0 tool calls로 exit 1을 반복하면(logTail에 spawn 줄만) 같은 provider로 다시 시도하지 않는다.
- 핸드오버는 작업당 2번까지("already handed over 2 times"), failed 위원은 council_verify도 거절 → 다른 provider로 새 council_assign.
- 새 지시 첫 줄: "앞 worktree 브랜치를 git merge, 미커밋 파일 복사, STATE.md·TASK.md·HANDOVER.md·.council/shots 먼저 읽기" + "결과 파일이 이미 있는지 먼저 확인, 없을 때만 다시 생성". 앞 worktree 경로는 읽기 전용 참고로 적는다.

## 주의할 점
- 같은 '이어가지 못한 위원' 이벤트가 반복되면 살아 있는 위원의 council_member(toolCalls 증가)만 확인하고 재배정하지 않는다.
- 같은 위원을 두 번 검증하면 'already being checked by …'로 거절되니 마지막 검증 위원 id를 넘긴다. 머지는 원래 위원(branch 소유자) id로.
- 위원을 멈출 때 외부(ComfyUI 큐 등)에 제출한 작업이 있으면 새 지시에 자기 prompt_id만 /queue delete·/interrupt 하는 절차를 넣는다. 남은 스크립트는 [위원 정지 후 남은 생성 스크립트 정리](common/council-members/council-stop-member-orphan-process).
- 실행 중인 위원에게 지시를 바꾸는 법은 [실행 중인 위원 지시 바꾸기](common/council/council-change-running-instruction).
