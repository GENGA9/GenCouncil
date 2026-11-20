---
title: .git이 수십 GB로 커졌을 때 진단·정리
summary: .git이 브랜치 히스토리보다 훨씬 클 때 도달 불가 객체를 어떻게 찾고 히스토리 재작성 없이 줄이나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
.git이 브랜치 히스토리보다 훨씬 크면(예: 17GB vs 1.2GB) 대개 도달 불가 객체와 체크포인트 ref가 원인이다. 자동 정비 `repack --geometric=2`는 큰 팩을 다시 쓰지 않고, 기본 gc는 2주 안의 도달 불가 객체를 지우지 않는다.
`git stash -u`·Codex 체크포인트(`refs/codex/turn-diffs/checkpoints/...`)는 무시 규칙 없는 미추적 큰 폴더까지 객체로 만든다. filter-repo 없이 정리할 수 있다(17→1.3GB).

## 언제 쓰나
- 저장소 .git 크기가 비정상적으로 클 때, gc 요청을 받았을 때
- gc 요청을 받으면 먼저 docs의 정리 계획 문서(목표 크기·최종 명령)가 있는지 찾는다

## 방법
### 진단
- 전체 객체: `git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname) %(objectsize) %(objectsize:disk)'`
- 도달 가능 객체: `git rev-list --objects --all --reflog --indexed-objects`
- 두 집합의 차 = 도달 불가 객체
- ref별 무게는 `--branches` 집합과 직접 차집합을 낸다(`--not --branches`는 과대 계산)
- 뿌리 트리를 `git ls-tree -r`로 펼쳐 경로를 확인하고, 원본이 필요하면 `git archive <트리sha> <경로>`로 꺼낸다

### 정리 (모든 세션을 멈춘 뒤)
1. `git stash list` — 있으면 bundle로 백업(reflog expire가 stash를 지운다)
2. 체크포인트 ref 삭제: `git update-ref -d <ref>`
3. `git reflog expire --expire=now --expire-unreachable=now --all`
4. `git gc --prune=now`
5. `git worktree prune`
6. `git fsck --connectivity-only`

## 주의할 점
- 큰 산출물 폴더는 .gitignore에 넣고, 가끔 수동 gc
- `git status`는 `GIT_OPTIONAL_LOCKS=0`으로 돌린다
- 정리 중 다른 세션이 git을 쓰면 안 된다
