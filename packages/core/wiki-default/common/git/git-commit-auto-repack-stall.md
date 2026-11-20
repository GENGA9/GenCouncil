---
title: git commit이 몇 분씩 멈출 때: 자동 maintenance·repack 끄기
summary: 큰 저장소에서 git commit이 시간 초과로 안 끝날 때 무엇이 붙잡고 있고, 이중 커밋 없이 어떻게 피하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
큰 저장소에서 `git commit`이 안 끝나 보여도 커밋은 이미 들어가 있는 경우가 많다. 뒤따르는 `git maintenance run --auto` → `git repack --geometric=2`가 2~3분 commit을 붙잡는다(Windows는 --detach여도 기다린다).

## 언제 쓰나
- 위원·스크립트의 `git commit`이 시간 초과로 끝났을 때
- 큰 메인 폴더에서 커밋이 몇 분씩 걸릴 때

## 방법
- 먼저 `git log -1`로 커밋이 들어갔는지 확인한다. 재실행하면 이중 커밋 위험이 있다.
- `git repack`·`git pack-objects` 프로세스가 있으면 기다린다. repack은 강제로 끊지 않는다.
- 이번 커밋만 자동 정리를 끈다(저장소 설정은 그대로): `git -c gc.auto=0 -c maintenance.auto=false commit ...`

## 주의할 점
- .git 자체가 너무 커졌다면 [.git이 수십 GB로 커졌을 때 진단·정리](common/git/git-repo-size-cleanup).
