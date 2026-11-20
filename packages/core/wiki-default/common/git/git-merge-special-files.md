---
title: 한 줄 JSON·생성물 파일의 병합 충돌: 키별 3-way·git merge-file
summary: 한 줄짜리 locales JSON이 병렬 수정마다 충돌하거나, 커밋된 생성물(md·html)이 원본과 어긋나 재생성 diff가 커질 때 어떻게 바뀐 부분만 합치나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
줄 단위 git 병합이 맞지 않는 파일이 있다. 한 줄짜리 JSON은 키 하나만 바뀌어도 줄 전체가 충돌하고, 이미 원본과 어긋난(stale) 생성물은 생성기를 다시 돌리면 손대지 않은 부분까지 diff가 생긴다.
둘 다 base/ours/theirs를 직접 만들어 바뀐 부분만 합친다.

## 언제 쓰나
- 병렬 위원이 고친 한 줄 다국어 JSON(locales/*.json)이 충돌할 때
- 커밋된 생성물(md·html)이 입력 json과 이미 어긋나 있는데 입력 일부를 바꿔 다시 만들어야 할 때

## 방법
### 한 줄 locales JSON: 키별 3-way 병합
- 해결 위원에게 `git merge agenda/<안건>`(또는 `member/<안건>/<충돌 위원>`)을 허용하고([위원 지시에 넣을 공통 조건](common/council-members/council-member-instructions)), node 스크립트(utf-8)로 base/ours/theirs를 키별 3-way 병합한다: 키는 합집합, 한쪽만 바꾼 키는 그쪽 값.
- 형식(한 줄·끝 줄바꿈)을 유지하고 JSON.parse로 확인한다.
- 다음 위원(예: 릴리스) 지시 0번에 "merge 후 키별 병합"을 넣으면 따로 배정하지 않고 흡수된다.

### 어긋난 생성물: 두 번 생성 + git merge-file
- 옛 입력(통합 HEAD의 json)으로 render → base, 새 입력으로 render → theirs.
- `git merge-file -p <커밋된 파일(LF)> base theirs`로 바뀐 부분만 커밋된 파일에 적용한다.
- 한 줄 내장 JSON(`<script>` 안의 데이터 등)은 merge-file로 충돌한다 → 커밋본 JSON에서 바뀐 항목만 교체하고 `JSON.stringify(o).replace(/</g,'<')`로 직렬화한 뒤 라운드트립 일치를 확인한다.

## 주의할 점
- PowerShell로 쓰지 않는다(한글·한자가 깨진다). 변환은 node로.
- Git Bash의 `/tmp`는 Windows py가 못 읽을 때가 있다.
- 병렬 위원 충돌 전반은 [병렬 위원 작업을 합칠 때](common/council-merge/council-parallel-merge).
