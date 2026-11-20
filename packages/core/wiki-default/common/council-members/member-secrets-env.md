---
title: 위원이 .env·비밀 파일을 다룰 때
summary: 위원에게 .env 키 확인·추가·실키 검증을 맡길 때 키 값이 출력되거나 백업 파일이 커밋되지 않게 하려면?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원이 `grep KEY .env | sed …`로 가리려다 패턴이 안 맞으면 키가 출력·기록되고, 그러면 키를 바꿔야 한다.
`.env.bak-*` 백업 파일은 .gitignore의 `.env`에 걸리지 않아 커밋될 수 있다.

## 언제 쓰나
- 위원이 .env·API 키를 확인하거나 추가하거나 백업할 가능성이 있는 작업

## 방법
- ".env·키 파일 출력 금지, 존재는 참/거짓만"은 이제 프로그램이 자동으로 한다(위원 기본 규칙). 지시에 따로 넣지 않는다.
- 위원이 지킬 방법: 존재는 설정 객체(pydantic Settings 등)로 읽어 `bool(value)`만 본다. 수정은 키 이름만 읽고 줄 추가만 한다.
- 백업을 만들면 그 패턴을 `.git/info/exclude`에 넣고, 백업을 지웠는지 보고하게 한다.
- 실키로 검증해야 하면 지시에 넣는다: "키는 env로만, 출력은 앞 5글자"(패킷 .council/TASK.md에 남은 키도 가린다).
- 배포 전에 `git diff --stat origin/main main`에 .env나 백업 파일이 없는지 확인한다(council_merge 결과의 warnings에도 `.env*`·`.bak`이 뜬다).

## 주의할 점
- 키가 노출되면 RESULT.md에 적고, 사용자에게 위험도와 함께 키 교체를 권한다.
