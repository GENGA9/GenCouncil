---
title: 위원이 매번 기억해야 할 저장소 규칙: 루트 AGENTS.md·CLAUDE.md·GEMINI.md에 같은 내용으로
summary: 산출물 저장 위치 같은 저장소 규칙을 Claude·Codex·Gemini CLI 위원 모두가 매번 지시 없이 지키게 하려면 어떤 파일에 어떻게 적고 고치나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원은 worktree마다 새로 떠서, 위키나 지시문에만 있는 저장소 규칙(예: 산출물 저장 위치)을 잊고 제각각(`_shared/<안건>/<위원>/` 등) 저장해 결과물이 흩어진다. 각 CLI가 시작 때 자동으로 읽는 루트 파일에 같은 규칙을 두면 모든 provider 위원에게 전달된다.

## 언제 쓰나
- 위원이 반복해서 어기는 저장소 규칙을 매 지시에 넣지 않고 고정하고 싶을 때
- 그 규칙을 고칠 때

## 방법
- 저장소 루트에 같은 내용으로 세 파일을 커밋한다:
  - `AGENTS.md`(Codex, 정본)
  - `CLAUDE.md`(Claude Code)
  - `GEMINI.md`(Gemini CLI)
- Windows라 심볼릭 링크 대신 복사하고 `diff`로 세 파일이 같은지 확인한다.
- 짧게(40줄 이내) 핵심만: 산출물 폴더 구조, 두지 말 곳, 공유 폴더(git 밖) 여부, 자세한 위키 경로.
- 고칠 때는 세 파일을 함께 고친다.

## 주의할 점
- 위원에게 위키 도구가 없을 수 있으니 루트 파일에 위키 경로만 적지 말고 핵심 규칙 문장을 직접 적는다([위원 지시에 넣을 공통 조건](common/council-members/council-member-instructions)).
- 내용이 정해진 이런 문서 작업은 [claude sonnet](models/claude-sonnet) medium으로 충분하다.
