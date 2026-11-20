---
title: 이미 머지한 위원 결과를 버리고 안건 닫기: 삭제 커밋 먼저
summary: 이미 council_merge한 결과를 베이스에 넣지 않고 안건을 닫으려면 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
council_finish는 안건 브랜치를 베이스에 머지하므로 이미 council_merge한 파일이 그대로 들어간다. `include_unmerged:true`는 머지하지 않은 위원 결과만 버린다.
그래서 먼저 삭제 커밋으로 안건 브랜치를 베이스와 같게 만든 뒤 닫는다.

## 언제 쓰나
- 위원 결과를 이미 통합 브랜치에 머지했는데 사용자가 결과를 버리기로 했을 때

## 방법
1. haiku(low) 위원에게 `git rm -r <경로>` 삭제 커밋을 맡기고 council_merge.
2. `git diff --stat main...agenda/<안건>`이 비어 있는지 확인.
3. `council_finish(include_unmerged:true)`.

## 주의할 점
- 의장은 편집 도구가 없어 이 방법이 가장 짧다.
