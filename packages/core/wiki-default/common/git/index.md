---
title: git·백업
summary: 줄끝·병합 충돌, 합본 생성물 충돌 없애기, 추적 해제·렌더 폴더 git 밖 이행, media-guard가 뺀 새 그림, 저장소 크기, 중간 산출물 대량 정리, 멈춘 커밋·작성자 없음 커밋 실패, 옛 커밋 기준판
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
줄끝·병합 충돌, 합본 생성물 충돌 없애기, 추적 해제·렌더 폴더 git 밖 이행, media-guard가 뺀 새 그림, 저장소 크기, 중간 산출물 대량 정리, 멈춘 커밋·작성자 없음 커밋 실패, 옛 커밋 기준판.

## 페이지
- [git-autocrlf-file-hash](common/git/git-autocrlf-file-hash)
- [git-bulk-cleanup-keep-check](common/git/git-bulk-cleanup-keep-check) — 작업 끝낸 뒤 중간 산출물 대량 git rm: 남길 것 기계적으로 고르기·거꾸로 검사
- [git-commit-auto-repack-stall](common/git/git-commit-auto-repack-stall)
- [git-commit-identity](common/git/git-commit-identity) — 'Author identity unknown' 커밋 실패: 명령에만 -c user.name/user.email
- [git-merge-special-files](common/git/git-merge-special-files)
- [git-repo-size-cleanup](common/git/git-repo-size-cleanup)
- [git-restore-old-baseline](common/git/git-restore-old-baseline) — 같은 worktree에서 git restore --source로 옛 코드 기준판 만들고 깨끗이 복구(리팩터 출력 동일성)
- [git-untrack-exclude-pitfalls](common/git/git-untrack-exclude-pitfalls)
- [media-guard-new-media](common/git/media-guard-new-media) — gencouncil-media-guard 훅이 새 PNG·JPG(64KB 초과)를 커밋에서 뺄 때: git ls-files 확인·RESULT.md에 디스크 잔존 목록
- [render-untrack-source-split](common/git/render-untrack-source-split) — 렌더 폴더를 .gencouncil-shared로 돌리고 원본만 옮길 때: rename 병합 복구·메인 반영 백업·누락분 복원
- [split-combined-generated-files](common/git/split-combined-generated-files) — 단위별 병렬 브랜치가 합본 생성물에서 매번 충돌할 때: 단위별 정본으로 나누고 합본은 gitignore + build-all
