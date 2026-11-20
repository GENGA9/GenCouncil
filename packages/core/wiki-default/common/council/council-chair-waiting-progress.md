---
title: 의장이 긴 위원 작업을 기다리고 진행을 알릴 때: council_wait 대신 이벤트·위원 보고 로그
summary: council_wait가 300초 무응답으로 끊기거나, 긴 위원 작업의 진행을 사용자에게 알려야 할 때 의장은 무엇을 기다리고 어떻게 진행을 확인하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원 이벤트([council event])는 위원이 끝날 때만 온다. council_wait로 오래 붙잡으면 300초 무응답으로 끊기고, 의장 세션에서 CronCreate 주기 확인은 실행되지 않았으며 Monitor는 의장이 쓸 수 없다.
그래서 배정 뒤 턴을 끝내고 이벤트를 기다리며, 진행은 위원이 쓰는 보고 로그를 사용자가 물을 때 읽어 알린다.

## 언제 쓰나
- 위원 작업이 수 분~수 시간 걸릴 때
- council_wait가 "no response or progress for 300s"로 끊겼을 때
- 사용자가 긴 일괄 작업(생성·측정)의 진행을 궁금해할 때

## 방법
### 기다리기
- 배정 뒤 턴을 끝내고 [council event]를 기다린다. 꼭 council_wait를 써야 하면 `timeout_sec` 280 이하.
- council_wait가 끊겨도 위원은 계속 돈다. 재배정하지 말고 council_member(tail)로 상태를 확인한다.
- 이미 끝난 위원이 `finished: []`, `still_running: 0`으로 안 보일 수 있다 → council_member로 상태와 결과를 직접 읽는다.

### 진행 보고: 위원이 쓰는 로그
- 위원 지시에 넣는다: "단위 작업마다 고정 형식 한 줄(시각·결과·소요·설정·진행 a/N·남은 예상)을 `<작업>/report-*.log`에 append".
- 사용자가 진행을 물으면 의장이 그 로그를 tail(읽기 전용)해 새 줄만 보고한다.
- 처음에 사용자에게 "자동 알림은 안 될 수 있으니 물어보면 확인한다"고 알린다.
- 재배정해도 같은 로그를 이어 쓰게 한다. 로그가 위원 worktree 안이면 재배정 때 경로가 바뀌니 체크포인트에 현재 경로를 적는다.

## 주의할 점
- 의장이 일하는 중 온 사용자 메시지는 대기열로 간다. 턴을 오래 붙잡지 않는다.
- 2시간 넘는 작업을 세션과 떼어 띄우는 법은 [Claude Code에서 2시간 넘는 작업](common/ai-agents/claude-code-long-running-jobs), 위원 상태가 이상할 때는 [위원 상태가 이상할 때](common/council-members/council-member-status).
