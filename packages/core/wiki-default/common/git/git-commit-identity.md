---
title: git commit이 'Author identity unknown'으로 실패할 때: 명령에만 -c user.name/user.email
summary: 새 임시 저장소나 worktree에서 git commit이 "Author identity unknown"·"unable to auto-detect email address"로 실패할 때 전역 설정을 바꾸지 않고 어떻게 커밋하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
전역 `user.name`/`user.email`이 설정되지 않은 환경에서는 새로 만든 임시 저장소나 worktree에서 `git commit`이 실패한다. 전역·저장소 설정을 바꾸지 않고 그 커밋 명령에만 작성자를 준다.

## 언제 쓰나
- `git commit`이 `Author identity unknown` / `unable to auto-detect email address`로 실패할 때(임시 저장소·worktree·Git Bash)

## 방법
- `git -c user.name=<이름> -c user.email=<이메일> commit -m "..."`
- 설정을 저장소에 남기지 않으려면 `git config`를 쓰지 않는다.

## 주의할 점
- 전역 설정은 바꾸지 않는다.
- 사용자 이메일은 작성자 표기용으로만 쓴다.
- council_merge는 작성자 정보가 없으면 `GenCouncil <gencouncil@local>`로 커밋한다.
