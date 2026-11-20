---
title: worktree에 junction 걸기: node_modules·공유 렌더 폴더(git merge main 뒤 사라짐)·링크 안에서 ../ 금지(원본에 써짐)·PowerShell로 만들고 링크만 지우기·npm workspaces 내부 패키지
summary: Windows 위원 worktree에 node_modules나 git 밖 공유 렌더 폴더(.gencouncil-shared)를 junction으로 걸 때 어떻게 만들고 지우며, git merge main 뒤 공유 폴더 junction이 사라졌을 때 어떻게 다시 걸고, 공유 링크 폴더(_shared·output/*/video 등) 안에서 ../ 상대경로로 worktree를 가리켰다가 원본 폴더에 파일이 생기는 것을 어떻게 막으며, npm workspaces 저장소에서 빌드가 메인의 낡은 내부 패키지를 쓰는 것을 어떻게 막나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원 worktree엔 node_modules·git 밖 공유 폴더가 없어 메인 체크아웃이나 공유 실제 폴더를 junction으로 빌려 쓴다. junction은 PowerShell로 만들고, 지울 때는 링크만 지운다(재귀 삭제는 대상 내용을 비운다).
공유 링크 폴더 안에서는 `..`가 링크가 풀린 실제 경로(원본 저장소) 기준으로 올라가므로 출력 경로는 worktree 절대경로로 준다.
npm workspaces 저장소는 통째 junction을 걸면 `@scope/*` 내부 패키지가 메인 dist를 가리키니, 항목별 junction으로 내부 패키지만 이 worktree로 돌린다.

## 언제 쓰나
- worktree에서 npm install 없이 빌드·테스트를 돌릴 때
- 위원 worktree에서 `git merge main` 뒤 공유 렌더 폴더(예: `output/<작품>/{video,post,audio}`)가 없어졌을 때
- worktree의 `_shared/`·`output/<작품>/video|post|audio` 같은 공유 링크 폴더 안으로 cd해 작업할 때
- Bash 도구의 `cmd /c mklink /J`로 링크가 안 생기거나 엉뚱한 대상으로 생기거나 `cmd /c rmdir`로 못 지울 때(백슬래시 이중 표기·한글 경로·변수 미전개)
- worktree에서 `tsc -b`가 "Property ... does not exist"(TS2339) 같은 엉뚱한 타입 오류를 내거나 테스트가 옛 코드를 돌 때

## 방법
### 일반 저장소: node_modules 통째 junction
- 만들기: `New-Item -ItemType Junction -Path "node_modules" -Target "<메인 체크아웃>/node_modules"`
- 확인: `(Get-Item node_modules).LinkType`이 Junction이고 대상 내용이 보이면 된다.
- 지우기: `[System.IO.Directory]::Delete((Join-Path (Get-Location) "node_modules"), $false)`. 대상 내용은 남는다.

### git merge main 뒤 공유 렌더 폴더 junction 다시 걸기
- main이 렌더 폴더(video/post/audio)를 git 추적에서 뺀 커밋을 위원 worktree에 `git merge main`하면 worktree의 그 폴더가 지워지고, 공유 폴더로 가는 junction도 다시 안 생긴다(다른 공유 폴더는 junction으로 남아 있을 수 있다).
- 그러면 스크립트가 렌더 경로를 worktree 안에 새 실제 폴더로 만들거나 읽기에 실패한다.
1. 병합 뒤 `ls output/<작품>/video`로 확인한다. 링크 대상은 `Get-ChildItem output\<작품> | Where-Object LinkType`.
2. 없으면 PowerShell로 건다: `New-Item -ItemType Junction -Path output\<작품>\video -Target <원본 저장소 경로>\output\<작품>\video`(post·audio도 같게).
3. git status는 깨끗하게 유지된다.
- Git Bash에서 `cmd //c "mklink /J ... $d"`는 `$d`가 안 풀려 잘못된 대상으로 링크가 만들어진다. 쓰지 않는다.
- 공유 폴더 규칙은 [렌더 폴더 git 밖 이행](common/git/render-untrack-source-split).

### 공유 링크 폴더 안에서 ../ 상대경로 금지
- worktree의 `_shared/`, `output/<작품>/video|post|audio` 등(.gencouncil-shared에 등록된 폴더)은 원본 저장소(예: `<원본 저장소 경로>/...`)로 가는 링크다.
- 그 안으로 cd한 뒤 `../../../.council/tmp/x.png`처럼 상대경로로 worktree의 .council을 가리키면, 링크가 풀린 실제 경로 기준으로 올라가 원본 폴더(`<원본 저장소 경로>/.council/...`)에 파일이 생긴다(원본 폴더 쓰기 금지 위반).
- 출력 경로는 항상 worktree 절대경로로 준다: worktree 루트에서 `W=$(pwd -W)`를 잡아 두고 `"$W/.council/tmp/..."`. Python 스크립트에도 출력 경로를 절대경로 인자로 넘긴다.
- 실수로 만들었으면 그 파일만(mtime으로 내가 만든 것인지 확인) 지우고 빈 폴더만 rmdir한다.

### npm workspaces(모노레포): 항목별 junction
- worktree엔 node_modules가 없어 상위(메인 체크아웃) node_modules/@scope/* 링크를 따라 메인 dist를 import한다.
- worktree에 실제 node_modules 폴더를 만들고, 메인의 각 항목(@scope 제외)은 `New-Item -ItemType Junction`으로 건다. `node_modules/@scope/<pkg>`만 이 worktree의 packages/*(apps/*)로 junction한다. 파일 항목(.package-lock.json)은 건너뛴다.
- 끝나면 링크만 `.Delete()`로 지운다.

## 주의할 점
- `Remove-Item -Recurse`는 쓰지 않는다(링크 대상인 메인 node_modules·공유 데이터를 비운다).
- Bash에서 Windows 경로는 슬래시로 쓰거나 PowerShell로 옮긴다.
- 위원 지시에 한 줄 넣고, "tsc가 무관한 타입 오류"면 먼저 이것을 의심한다.
