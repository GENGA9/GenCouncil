---
title: "gencouncil: 사용자 변경 반영" 커밋이 추적 파일을 대량 삭제했을 때 되살리기
summary: main의 "gencouncil: 사용자 변경 반영" 커밋이 추적 중인 파일 수백 개를 삭제로 기록해 통합 브랜치 반영 때 수정/삭제 충돌이 나면 어떻게 목록을 뽑아 되살리고 재발을 막나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
main의 "gencouncil: 사용자 변경 반영" 커밋이 추적 중인 미디어 수백 개를 D(삭제)로 기록한 일이 있다(디스크엔 파일이 남아 있었다). 삭제된 경로는 모두 메인 `.git/info/exclude`의 gencouncil managed 블록에 들어 있었다(원인은 추정).
통합 브랜치를 main에 맞출 때 수정/삭제 충돌이 나므로, 삭제 목록을 뽑아 통합 브랜치 쪽 내용으로 되살린다.

## 언제 쓰나
- main에 "gencouncil: 사용자 변경 반영" 커밋이 생긴 뒤 통합 브랜치 반영에서 수정/삭제 충돌이 대량으로 날 때
- `git show --name-status`에 D가 수백 줄일 때

## 방법
1. 통합 브랜치에서 `git merge main --no-commit`.
2. 삭제 목록: `git -c core.quotepath=off show --name-status --format= <커밋> | grep '^D' | cut -f2-` → `tr '\n' '\0'`로 NUL 구분 파일로 만든다.
3. 브랜치가 일부러 지우거나 옮긴 경로(`git log <브랜치> --diff-filter=DR -- 경로`)는 목록에서 뺀다.
4. `git restore --source=<통합브랜치> --staged --worktree --pathspec-from-file=목록 --pathspec-file-nul`.
5. 검증: `git merge-tree --write-tree main HEAD`가 트리 해시만 내면 충돌 0.

## 주의할 점
- exclude 블록에 추적 경로가 남아 있으면 재발한다 → 의장·사용자가 블록에서 그 경로를 뺀다.
- 머지 운영 전반은 [council_merge·council_finish·council_merge_base 운영](common/council-merge/council-merge-finish).
