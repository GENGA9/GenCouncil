---
title: 에이전트 간 JSON 파일 버스 쓰기 (Windows): Node로 UTF-8 원자적 쓰기
summary: 여러 에이전트가 폴링하는 requests/verdicts 같은 JSON 파일을 Windows에서 쓸 때 인코딩 깨짐과 쓰는 도중 읽기를 어떻게 막나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
PowerShell `Set-Content`·`>`로 JSON을 쓰면 UTF-16 LE(BOM)나 CP949로 저장돼 다른 에이전트(Node/Python) 파서가 `Unexpected token`·한글 깨짐을 낸다. 쓰는 도중 읽으면 빈·미완성 JSON이 된다. Node로 UTF-8 임시 파일에 쓰고 rename으로 교체한다.

## 언제 쓰나
- 여러 에이전트·프로세스가 폴링하는 파일 버스(requests/verdicts 등)를 만들거나 쓸 때

## 방법
- `fs.writeFileSync(tmp, JSON.stringify(data,null,2), 'utf8')` 후 `fs.renameSync(tmp, target)`로 원자적으로 교체한다.
- 셸 인라인 문자열 대신 작은 helper js를 거쳐 따옴표·이스케이프 문제를 피한다.

## 주의할 점
- 파일 버스 전부에 적용한다(한 곳만 PowerShell로 쓰면 그 파일에서 깨진다).
- PowerShell 파이프의 한글 손실은 [Windows에서 Python 한글이 깨질 때](common/windows/windows-python-korean-encoding).
