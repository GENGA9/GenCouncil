---
title: council_merge·council_finish·council_merge_base 운영: 머지 전 확인·사용자 선택 대기 후보 보존·충돌·미머지 거절·메인 반영
summary: 의장이 위원 결과를 council_merge하고 council_finish·council_merge_base로 닫을 때 머지 전 무엇을 보고(사용자가 고를 후보 음성·그림이 worktree에만 있으면 머지로 사라짐), 충돌·"머지하지 않은 위원 결과"·"메인 반영을 요청하지 않았다"·"uncommitted changes"·"merge conflict in main checkout" 거절을 어떻게 풀며, 메인에 빈 폴더는 어떻게 만드나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원 결과는 council_merge로 안건(통합) 브랜치 `agenda/<안건>`에 들어가고, council_finish 승인이나 council_merge_base 때 메인 폴더에 반영된다. 의장은 파일을 직접 고칠 수 없으므로 충돌·정리는 다음 위원에게 맡긴다.

## 언제 쓰나
- 위원 완료 이벤트를 받고 council_merge하기 전
- 위원이 사용자 선택용 후보(음성·그림·영상)를 만들었고 사용자가 아직 고르지 않았을 때
- council_merge가 충돌로 멈췄을 때
- council_finish가 "머지하지 않은 위원 결과: A"로, council_merge_base가 "사용자가 메인 반영을 요청하지 않았다"·"main checkout has uncommitted changes"·"merge conflict in main checkout: <파일>"로 거절할 때
- 사용자가 저장소 루트에 빈 폴더를 요청할 때

## 방법
### 머지 전 확인
- 순서: 완료 이벤트 → council_show(시안) → council_member(diff) → council_merge.
- 임시·비밀·대용량 파일 점검은 이제 프로그램이 자동으로 한다: council_merge 결과의 warnings(tmp/·.env*·.bak·.log·node_modules·50MB 넘는 파일)를 본다. "중간 파일은 .council/ 아래, tmp/ 커밋 금지"도 위원 기본 규칙이다.
- 경로를 직접 보려면 `git diff agenda...member --stat --ignore-cr-at-eol`.
- 임시 파일이 이미 들어갔으면 다음 위원 첫 커밋으로 `git rm` + .gitignore 추가. 메인 반영 전에 발견하면 이력만 남고 피해는 없다.

### 사용자가 고를 후보는 공유 폴더에: 머지하면 worktree와 함께 사라짐
- 위원이 후보(ElevenLabs 음성 c1~c3, 비교 mp4, 그림 시안 등)를 worktree의 `.council/shots`나 작업 폴더에만 두고 커밋하지 않으면, council_merge로 worktree가 정리될 때 후보 파일이 사라진다. 사용자가 "후보1"을 고른 뒤에 확정할 원본이 없어 다시 만들어야 한다. ElevenLabs처럼 같은 소리를 다시 낼 수 없는 생성기는 되살릴 수 없다.
- 배정 때: 지시서에 저장 경로를 직접 적는다. "후보는 공유 폴더 <경로>에 저장, worktree에만 두지 말 것". 공유 폴더는 git 밖 `.gencouncil-shared`에 등록된 곳(예: `output/<작품>/audio`, `video`, `post`)이다. 경로 예: `audio/elevenlabs/<작업>/cand-<판>-<줄id>/c1.wav`.
- 머지 전: RESULT.md에 적힌 후보 경로가 공유 폴더인지 확인한다. worktree에만 있으면 공유 폴더로 옮긴 뒤 머지하거나, 사용자 선택이 끝날 때까지 머지(=worktree 정리)를 미룬다.

### council_merge 충돌: 다음 위원이 merge로 해결
- 같은 파일을 여러 위원이 차례로 고치면(한 명은 그림, 한 명은 글자) council_merge가 충돌로 중단된다.
- 다음 위원 지시 맨 앞에 "0. `git merge member/<안건>/<충돌 위원>`, 양쪽 의도를 살려 해결, merge 커밋, tsc·test"를 넣고 본 작업을 잇는다. 그 위원을 머지하면 충돌 브랜치도 함께 들어간다.
- 충돌 해결을 다른 위원에게 넘겼다면 의장 checkpoint에 "A는 B 브랜치로 병합됨"을 적어 둔다(안건을 닫을 때 아래 미머지 거절이 난다).
- 단순 충돌 정리만이면 sonnet medium 짧은 작업으로 "앞 위원 브랜치 merge 후 고침"을 맡기고 정리한 위원만 머지한다.
- 예방: 같은 파일을 만질 후속 작업은 add_task로 등록해 앞 위원 머지 직후 배정한다.
- 병렬 위원 충돌 전반은 [병렬 위원 작업을 합칠 때](common/council-merge/council-parallel-merge), 한 줄 JSON·생성물 충돌은 [한 줄 JSON·생성물 파일의 병합 충돌](common/git/git-merge-special-files).

### council_finish "머지하지 않은 위원 결과" 거절
- B가 A 브랜치를 merge해 B만 머지한 경우 서버는 A를 아직 '머지 안 함'으로 본다. 통합 worktree에서 `git merge-base --is-ancestor member/<안건>/<A> HEAD && echo merged-already`(또는 `… agenda/<안건> && echo included`)로 포함을 확인 → `council_finish(include_unmerged:true, reason "B 경유로 포함")`. 실제로 버려지는 것은 없다.
- 핸드오버·검증으로 같은 브랜치를 쓴 위원이 여럿이면(A→B→C) 마지막 위원을 머지한 뒤 나머지 id도 council_merge로 한 번씩 부른다("Already up to date"로 상태만 정리되고 finish가 통과).
- 버려진 위원 브랜치(재시작 후 실패한 자동 인계 등)는 `council_finish(include_unmerged:true)`.
- 이미 머지한 결과를 버리고 닫으려면 [이미 머지한 위원 결과를 버리고 안건 닫기](common/council-merge/council-finish-discard).

### council_merge_base "사용자가 메인 반영을 요청하지 않았다" 거절
- merge_base는 사용자의 '최신 메시지'가 반영 요청이어야 한다. 사용자가 "끝나면 메인에 합치고 라이브·원격 백업까지"라고 미리 지시해도, 그 사이 위원 완료 이벤트가 오거나 긴 작업 뒤에는 이렇게 거절될 수 있다(라이브만 먼저 끝나 메인·원격 백업이 뒤처진다).
- 거절되면 council_ask_user로 한 번 묻고, 사용자가 "메인에 반영해"라고 답한 턴에 다시 호출한다. 우회하지 않는다.
- 일괄 반영 작업은 시작할 때 "끝부분에 사용자 응답이 한 번 필요하다"고 미리 알린다. 원격 push는 merge_base 뒤 위원에게 맡긴다.

### council_merge_base "merge conflict in main checkout: <파일>": 다른 안건이 main에 먼저 들어갔을 때
- 확인: `git log --oneline agenda/<안건>..main`, `git diff <마지막 반영 커밋> main -- <파일>`로 상대 변경을 본다.
- 위원(sonnet medium, 여러 파일이면 opus)에게: "내 브랜치에서 로컬 main을 git merge, 양쪽 기능 유지(한쪽 로직이 공용 훅으로 옮겨졌으면 상대 변경을 훅 쪽으로 이식). main 체크아웃·수정·푸시·rebase 금지" → council_merge → 사용자 "메인에 반영해"를 다시 받고 merge_base 재실행.
- 두 안건이 서로 다른 범위를 고쳤는데 공용 생성 산출물(json·리포트 html·로그)이 충돌하면 원칙을 준다: 우리 범위 키는 안건 값, 상대 범위 키는 main 값(json은 키 단위), 로그는 양쪽 줄 시간순, 생성 산출물은 병합 후 생성기로 재생성해 각 범위가 원 출처와 같은지 diff. 상대 범위를 되돌리는 도구는 쓰지 말라고 명시한다.
- 검증: `git merge-tree --write-tree main HEAD` 충돌 0 → merge_base 재시도. 머지 뒤 의장이 통합 worktree에서 `npx tsc --noEmit` 확인. 위원 tool call 수가 적으면 테스트를 실제로 돌렸는지 의심한다.
- 반영이 늦을수록 충돌이 커지니 큰 작업이 끝날 때마다 council_ask_user로 반영 여부를 묻는다.

### council_merge_base "main checkout has uncommitted changes" 거절
- 메인 폴더에 여러 세션 작업과 안건과 겹치는 옛 실험이 섞여 있을 때 난다.
- 읽기 전용 위원이 조사: 파일별 변경·수정 시각 군집으로 작업 묶음을 구분하고, 안건과 겹치는 줄 표를 만든다(`git diff HEAD...agenda`; 메인 브랜치 이름이 옛것일 수 있다).
- 사용자 결정 뒤 메인 폴더에서: 시작 상태 저장 → 버릴 실험은 패치로 보관 후 그 hunk만 되돌림 → 살릴 기능은 기능별 커밋(섞인 파일은 패치를 나눠 `git apply --cached`) → tsc·test. stash·reset --hard 금지.
- 같은 위원 worktree(안건 기준)에서 `git merge <base 브랜치>`로 충돌 해결·테스트 → 의장이 안건에 머지 → merge_base가 충돌 없이 끝난다.
- 라이브·패키지를 안건 브랜치로 만들었다면 메인 미커밋 기능이 빠져 있다 → 반영 후 재빌드·패키징 여부를 사용자에게 묻는다.

### 메인 폴더에 빈 폴더 만들기: .gitkeep 커밋
- git은 빈 폴더를 기록하지 않고, 위원은 worktree 안에서만 일한다.
- 배정 전 `ls <메인 폴더>`로 같은 이름이 있는지 확인한다(큰 루트 Glob은 시간 초과).
- haiku(effort low) 위원에게: "worktree 루트에 X/.gitkeep 생성 → 그 파일만 add → 커밋". 금지: 메인 폴더 직접 수정, `git add -A`. 완료 조건 `git ls-tree --name-only -r HEAD X`.
- 보고에 "머지 후에도 메인 폴더엔 아직 없고, council_finish 승인이나 council_merge_base 때 생긴다"고 쓴다.

## 주의할 점
- 안건을 닫으면 위원 worktree가 지워져 그 안의 git 밖 캐시(작업 폴더·생성 wav 등)도 사라진다. 다음 작업이 그 캐시를 읽으면 닫기 전에 사용자에게 메인 폴더(무시 경로)로 옮길지 묻는다.
- 메인 폴더의 git 밖 파일을 고치는 일은 [메인 폴더의 git 밖 산출물을 위원이 고칠 때](common/council-merge/council-main-untracked-edit).
- "gencouncil: 사용자 변경 반영" 커밋이 추적 파일을 대량 삭제한 경우는 [사용자 변경 반영 커밋의 대량 삭제 되살리기](common/council-merge/gencouncil-user-change-mass-delete).
- 추적 해제(`git rm --cached`) 커밋을 메인에 반영하면 메인 디스크 파일이 지워진다 → [git 추적 해제·제외 함정](common/git/git-untrack-exclude-pitfalls).
- 머지·finish는 로컬만 바꾼다. push는 따로 맡긴다.
