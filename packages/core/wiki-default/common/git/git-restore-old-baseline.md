---
title: 같은 worktree에서 옛 커밋 코드로 기준판 만들기(git restore --source): 리팩터 출력 동일성 확인, 대용량 복제 없이
summary: 생성기를 리팩터한 뒤 출력이 옛 커밋과 같은지 보려고 옛 코드로 기준판을 만들 때, 출력이 파일 존재(그림·영상 유무)에 따라 바뀌거나 저장소가 수 GB라 다른 폴더·새 worktree를 못 쓰면 같은 worktree에서 어떻게 잠시 되돌리고 깨끗이 복구하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
출력이 파일 존재 확인에 따라 바뀌면 git archive·새 worktree에서 만든 기준판은 믿을 수 없고, 이미지로 수 GB인 저장소는 복제도 비싸다. 같은 worktree에서 코드만 옛 커밋으로 잠시 되돌려 옛 체인을 돌리고, 결과를 커밋 안 하는 폴더에 복사한 뒤 HEAD로 되돌린다.

## 언제 쓰나
- 생성기·빌드 스크립트를 리팩터한 뒤 "출력이 옛 커밋과 같은가"를 증명할 때

## 방법
1. 작업 트리를 깨끗하게(커밋) 한 뒤: `git restore --source=<옛커밋> --worktree -- <프로젝트폴더> <스킬폴더>`
   - pathspec 안에서 옛 커밋에 없는 파일(그 뒤 추가된 파일)은 지워진다(status에 D).
2. 옛 체인을 실행하고 결과를 `.council/base/`(커밋 안 하는 폴더)로 복사한다.
3. 복구: `git restore --source=HEAD --worktree --staged -- <같은 경로들>`
   - 옛 커밋에만 있던 파일(그 뒤 옮기거나 지운 파일)은 untracked로 남는다 → `git status --untracked-files=all`로 보고 직접 rm. 생성 중 새로 생긴 캐시(썸네일 등)는 `git clean -fd -- <폴더>`.
4. `git status`가 비었는지 확인한다.
5. 비교는 줄 끝을 무시한다: `tr -d '\r' < a | cmp - <(tr -d '\r' < b)` (core.autocrlf=true면 꺼낸 파일은 CRLF, 생성기 출력은 LF).

## 주의할 점
- 복구 전에 커밋 안 한 코드 수정이 없게 한다.
- 같은 이유로 생성물만 되돌릴 때 `git checkout -- <상위 폴더>`를 쓰면 커밋 안 한 코드 수정까지 사라진다 → 되돌릴 생성물 경로만 정확히 준다.
- 줄끝 일반은 [core.autocrlf 저장소에서 파일 sha 테스트](common/git/git-autocrlf-file-hash).
