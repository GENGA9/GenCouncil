---
title: gencouncil-media-guard 훅이 새로 추가한 PNG·JPG를 커밋에서 뺄 때: 확인(git ls-files)·디스크 잔존 목록 보고·재번호 때 슬롯 재활용·추적 중인 그림을 다시 그릴 때 삭제 커밋 막기
summary: pre-commit 훅 gencouncil-media-guard가 "큰 미디어 N개는 커밋에서 뺐다"를 출력하며 새로 추가한 64KB 넘는 PNG·JPG를 git add -f 해도 커밋에서 빼면, 무엇이 빠졌는지 어떻게 확인하고 의장·메인 반입 때 놓치지 않게 무엇을 보고하며, 컷 재번호·추가 작업이나 이미 추적 중인 큰 그림을 지우고 다시 그린 작업에서 커밋에 '삭제'만 남아 병합이 그림을 지우지 않게 하려면 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
저장소에 `gencouncil-media-guard.mjs` pre-commit 훅이 설치돼 있으면 `.gitignore`와 무관하게 새로 추가(`--diff-filter=A`)한 64KB 넘는 `.png`/`.jpg`가 `git commit` 때 자동으로 `git rm --cached`되고 `.git/info/exclude`에 추가된다. 이미 추적 중인 파일의 수정(`M`)과 `git mv`는 정상 커밋된다. 훅은 우회하지 않는다.

## 언제 쓰나
- 커밋 때 훅이 `큰 미디어 N개는 커밋에서 뺐다`를 출력할 때
- `git add -f`로 넣은 새 그림이 커밋에 없을 때
- 스토리보드 재번호·컷 추가처럼 그림 파일 경로가 새로 생기는 작업을 커밋할 때
- 이미 추적 중인 큰 그림(예: 컷 PNG)을 지우고 다시 그린 뒤 커밋할 때

## 방법
1. 훅 출력과 `git ls-files <경로>`를 대조해 실제로 추적에서 빠진 신규 미디어 파일 목록을 뽑는다.
2. 빠진 파일은 작업 폴더 디스크에 그대로 둔다(지우지 않는다).
3. `RESULT.md`에 빠진 파일의 디스크 경로 목록을 적어, 의장·메인 반입 때 함께 복사·반영할 수 있게 한다.

### 재번호·컷 추가 작업
- 새 판에 없는 슬롯만 `git rm`한다.
- 재활용하는 슬롯(같은 경로)은 덮어써서 `M` 상태로 커밋되게 둔다.
- 순수 신규 경로 PNG는 커밋에서 빠지므로 디스크 잔존 경로를 `RESULT.md`에 기록한다.

### 추적 중인 큰 그림을 다시 그릴 때: 삭제가 커밋되면 병합이 그림을 지운다
- 생성기가 이미 있는 파일을 건너뛰어 옛 PNG를 지우고 다시 그린 뒤 `git add -A; commit`하면, 새 그림은 신규 추가로 취급돼 훅이 커밋에서 빼고 커밋에는 "삭제"만 남는다. 이 커밋을 병합하면 대상 폴더에서 그림이 지워진다.
- 삭제가 커밋됐으면 `git reset -q <기준커밋> -- <png들>`로 인덱스를 옛 blob으로 되돌린 뒤 다시 커밋한다. 작업 폴더의 새 파일은 그대로이고 상태는 ` M`이 된다. 이후 `git add -A`를 해도 훅이 계속 제외하므로 옛 blob이 유지된다.
- 커밋 전에 `git status`에 `D`가 있으면 같은 reset으로 되살린다.
- 새 그림은 git으로 옮겨지지 않으므로 직접 보관한다: 지우기 전에 옛 그림을 백업 폴더로 복사해 md5를 대조하고, 새 그림은 메인 작업 폴더에 복사한 뒤 RESULT.md에 새 PNG의 md5·경로·복구 방법을 적는다.

## 주의할 점
- `.gitignore`에 없는 파일도 빠진다. `git status`가 깨끗해도 `.git/info/exclude`에 들어가 안 보일 뿐이다.
- 렌더 폴더를 git 밖 공유 폴더로 돌리는 이행은 [render-untrack-source-split](common/git/render-untrack-source-split), 추적 해제 함정은 [git-untrack-exclude-pitfalls](common/git/git-untrack-exclude-pitfalls).
