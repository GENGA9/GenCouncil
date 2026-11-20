---
title: 렌더 폴더를 git 밖(.gencouncil-shared)으로 돌리고 원본만 옮길 때: 폴더 rename 병합 복구(stage 3·파일 분류)·메인 반영 전 백업→merge_base→누락분만 복원
summary: 렌더와 원본이 섞인 폴더에서 원본만 다른 위치로 git mv하고 렌더는 git rm --cached로 공유 폴더(.gencouncil-shared)로 돌릴 때, 병합에서 Git 폴더 rename 추론이 새 렌더까지 원본 폴더로 옮기면 어떻게 복구하고, council_merge_base로 메인 디스크 렌더가 지워지는 것을 어떻게 백업·복원하며, 옮긴 원본의 옛 위치는 왜 복원하면 안 되나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
렌더(생성 결과)와 원본(스크립트·설정·손으로 고친 파일)이 한 폴더에 섞여 있을 때, 원본만 다른 위치로 `git mv`하고 렌더는 `git rm -r --cached`로 추적을 풀어 공유 폴더(.gencouncil-shared)로 돌리는 이행 절차다.
두 군데서 파일이 사라지거나 엉뚱한 데로 간다: 다른 브랜치를 병합할 때 Git의 폴더 rename 추론, 그리고 메인 반영(council_merge_base) 때 추적 해제가 디스크 삭제로 처리되는 것.

## 언제 쓰나
- 렌더 폴더를 git 밖 공유 폴더로 돌리는 안건을 진행할 때
- 원본을 옮긴 브랜치에 옛 구조의 브랜치(새 렌더가 든)를 병합할 때
- 그 안건을 메인에 반영할 때, 반영 뒤 열린 안건을 따라오게 할 때

## 방법
### 병합에서 새 렌더까지 원본 폴더로 옮겨질 때: stage 3·파일 분류로 복구
- 증상: 원본만 새 위치로 옮긴 브랜치에 옛 구조 브랜치를 병합하면, Git이 폴더 단위 rename으로 추론해 새 렌더·편집 프로젝트까지 새 원본 폴더로 옮기고 file location 충돌을 낸다.
- 새 파일은 index에 stage 3만 있는 경우도 있다 → modify/delete만 보면 누락된다.
1. 병합 직후 `git ls-files -u -z`로 파일별 index stage를 저장해 둔다. output 파일 목록·개수도 기록한다.
2. 새 원본 경로에 놓인 파일을 기존 분류 규칙(원본/렌더)으로 다시 판정한다.
   - 실제 원본은 `git add`로 채택한다.
   - 렌더·상대 미디어 링크 프로젝트(.kdenlive 등)는 원래 위치로 옮긴다. 옮기기 전에 목적지에 기존 파일이 없는지, 경로가 작업 폴더 안인지 확인한다.
3. 잘못 옮겨진 경로는 `git rm --cached -- <경로>`로 index에서만 빼고, 공유 경로도 `--cached`로 추적 해제한다.
4. 이동 전후 디스크 파일 개수와 새 렌더의 main blob 해시를 비교한다.
- 파일 삭제나 `git clean`은 쓰지 않는다.

### 메인 반영: 백업 → merge_base → 누락분만 복원
- `git rm -r --cached` 커밋을 council_merge_base하면 메인 디스크에서 그 렌더들이 실제로 지워진다. 원리는 [git 추적 해제·제외 함정](common/git/git-untrack-exclude-pitfalls).
1. 반영 직전 위원이 메인 output 전체를 저장소 밖(`<백업 폴더>/shared-<시각>`)에 `robocopy /E`로 복사한다(`/MIR` 금지). 원본·백업 SHA256 매니페스트를 대조한다(23GB 약 7분).
2. 사용자가 "메인에 반영해"라고 하면 council_merge_base.
3. 위원(메인 output 쓰기 예외를 사용자에게 승인받음)이 백업 매니페스트 중 "메인에 없고, 옮긴 원본의 옛 경로가 아닌" 파일만 덮어쓰기 없이 복사한다.
4. 전체 재해시 대조: 없는 것 = 옛 경로 목록과 정확히 일치, 해시가 다른 것 = 반영 커밋 diff 목록 안.
5. 메인 `git status`가 깨끗하고, 공유 경로마다 `git ls-files` 결과가 0인지 확인한다.

### 반영 뒤 열린 안건 따라오게 하기
- 열린 안건은 반영 후 `git merge main` + 이행 스크립트 재실행으로 새로 들어온 원본·렌더를 같은 규칙으로 정리한다.
- 받아오지 않은 브랜치를 그대로 메인에 합치면 렌더가 다시 추적된다.

## 주의할 점
- 옮긴 원본의 옛 경로는 복원하지 않는다. 백업을 통째로 되돌리면 옛 위치에 옛 원본 사본이 되살아난다. 경로 헬퍼가 "렌더 쪽 기존 파일 우선"으로 읽는 구조면 옛 사본이 새 위치의 수정을 가린다.
- 원본 이동과 렌더 추적 해제만으로 병합하면 다른 checkout의 디스크 파일은 지워질 수 있다. 그 checkout도 반영 전에 백업하고, 커밋돼 있던 파일은 `git restore --source=<이전커밋> --worktree`로 되살린다.
- merge_base 절차 일반은 [council_merge·council_finish·council_merge_base 운영](common/council-merge/council-merge-finish).
