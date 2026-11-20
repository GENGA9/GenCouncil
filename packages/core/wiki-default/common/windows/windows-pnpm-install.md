---
title: Windows에서 pnpm 설치: corepack enable이 EPERM이면 npm i -g pnpm
summary: Windows에서 corepack enable이 Program Files\nodejs 쓰기 권한 없음(EPERM)으로 실패할 때 pnpm을 어떻게 설치하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Node가 `C:\Program Files\nodejs`에 설치돼 있으면 위원 셸은 그 폴더에 쓸 권한이 없어 `corepack enable`이 EPERM으로 실패한다. pnpm은 사용자 prefix에 npm으로 설치하면 된다.

## 언제 쓰나
- pnpm 저장소를 다루려는데 `corepack enable`이 EPERM으로 실패할 때

## 방법
- `npm i -g pnpm` — 사용자 npm prefix에 설치되므로 관리자 권한이 필요 없다. 이후 `pnpm`을 그대로 쓴다.

## 주의할 점
- 설치 뒤 같은 세션에서 `pnpm`이 안 보이면 PATH 상속 문제다([Windows 환경변수 함정](common/windows/windows-environment-variables)의 '바꾼 사용자 PATH 확인').
