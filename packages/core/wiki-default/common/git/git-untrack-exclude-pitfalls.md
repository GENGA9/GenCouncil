---
title: git 추적 해제·제외 함정: rm --cached 머지가 다른 체크아웃 파일을 지움(복구는 restore --worktree)·info/exclude·하위 .gitignore가 새 파일을 조용히 뺌
summary: worktree에서 git rm --cached로 추적 해제한 커밋을 메인에 머지하면 왜 파일이 지워지고 다시 추적시키지 않고 디스크만 어떻게 되살리며, git add -A가 결과 파일(mp4 등)을 오류 없이 빼먹을 때(info/exclude·하위 .gitignore) 어떻게 찾고 막나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
추적 해제와 제외 규칙은 커밋한 worktree 밖에도 영향을 준다. `git rm --cached` 커밋은 다른 체크아웃에 머지될 때 삭제로 처리되고, `.git/info/exclude`는 모든 worktree가 공유한다. 하위 폴더 .gitignore의 넓은 규칙도 산출물을 오류 없이 커밋에서 뺀다.

## 언제 쓰나
- 큰 원본을 `git rm --cached`+.gitignore로 추적만 풀고 메인(merge_base)에 반영하려 할 때
- 추적 해제 머지로 지워진 파일을 디스크에만 되살릴 때
- 거절본 등 파일을 exclude로 숨기려 할 때
- merge 뒤 "그림 없음" 경고나 후속 빌드 실패로 파일이 커밋에서 빠진 게 드러날 때
- 커밋하려던 산출물(mp4 등)이 `git add -A` 뒤에도 빠져 있을 때

## 방법
### 빠진 파일 원인 찾기: git check-ignore -v
- `git check-ignore -v <경로>`로 어느 파일 몇째 줄이 막는지 본다(`.git/info/exclude`인지, 하위 폴더 .gitignore인지).

### git rm --cached 커밋은 다른 체크아웃에서 삭제가 된다
- worktree에서 추적만 해제해도, 그 커밋을 메인 폴더에 merge하면 삭제로 처리되어 메인의 디스크 파일까지 지워진다.
- 메인 반영(merge_base) 전에 `$before = git rev-parse HEAD`로 이전 커밋을 기록하고, 필요한 파일은 저장소 밖에 먼저 복사해 개수·바이트·해시로 검증한다.
- 추적 해제와 원본 이관을 나눴다면 이관 검증이 끝난 뒤 메인 반영을 사용자에게 묻는다.

### 지워진 파일을 디스크에만 되살리기: restore --worktree
- 반영 뒤 커밋돼 있던 파일만 되살릴 때: `git restore --source=$before --worktree -- <경로>`. `--staged`는 붙이지 않는다.
- 되살린 뒤 `git ls-files -- <경로>`로 다시 추적되지 않았는지 확인한다(출력이 없어야 한다).
- 미커밋·미추적·ignored 파일은 이전 커밋에 없으므로 이 방법으로 돌아오지 않는다. 검증한 저장소 밖 백업에서 복원한다.
- 예전 방식(이제 안 됨): `git checkout <이전커밋> -- <경로>` — 인덱스까지 복원해 추적 해제한 파일을 다시 추적·스테이징한다.

### .git/info/exclude의 파일명이 같은 경로 새 파일을 뺀다
- 거절본 파일명을 `.git/info/exclude`(모든 worktree 공용)에 올리면, 같은 경로에 다시 만든 최종본이 `git add -A`에서 조용히 빠진다.
- 확인: `git check-ignore -v <경로>`에 `.git/info/exclude` 줄이 나오면 해당한다.
- 해결: 만든 worktree에서 읽기만 해서 복사 후 `git add -f`.
- 재발 방지: 거절본은 파일명으로 exclude하지 말고 `rejected/` 같은 폴더로 옮긴다.

### 하위 .gitignore의 *.mp4 같은 넓은 규칙이 결과물을 뺀다
- 하위 폴더 .gitignore의 `*.mp4` 같은 규칙이 남길 산출물까지 막는다.
- 그 .gitignore에 `!final/*.mp4`처럼 부정 규칙을 넣는다(슬래시가 있는 규칙은 그 .gitignore 폴더 기준).
- 다시 `git check-ignore -v`로 `!` 규칙이 잡히는지 확인하고, 커밋 뒤 `git ls-files <폴더> | grep -c mp4`로 개수를 센다.
- `git add -f`로 하나씩 넣는 방식은 다음 판에서 또 빠뜨린다.
- 예: `<폴더>/.gitignore`에 `!final/*.mp4`, `!pieces/final/*.mp4`.

## 주의할 점
- exclude의 gencouncil managed 블록과 대량 삭제 커밋은 [사용자 변경 반영 커밋의 대량 삭제 되살리기](common/council-merge/gencouncil-user-change-mass-delete).
- merge_base 절차는 [council_merge·council_finish·council_merge_base 운영](common/council-merge/council-merge-finish).
