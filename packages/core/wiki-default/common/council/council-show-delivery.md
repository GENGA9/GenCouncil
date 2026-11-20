---
title: council_show로 결과 보내기: 허용 형식·소리 후보는 검은 화면 mp4(mp3·html 재생 안 됨)·Artifact 대체(HTML·PDF)·.ply 같은 파일 감싸기
summary: council_show·텔레그램이 받지 않는 형식(.ply·.mp3 등)이나 소리 후보(목소리·BGM·효과음)를 사용자에게 들려줘야 할 때, "아티팩트로 게시해 줘" 요청을 받았을 때 결과를 어떻게 만들어 보내나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
council_show는 결과 파일을 채팅·텔레그램으로 보낸다. 받는 형식과 위치가 정해져 있고, council 의장·claude CLI 위원에게는 claude.ai Artifact 게시 도구가 없다.
그래서 허용 밖 파일은 단일 HTML로 감싸고, 소리는 검은 화면 mp4로 만들고, Artifact 요청은 단독 HTML·PDF로 대신한다.

## 언제 쓰나
- 사용자에게 보여 줄 파일이 png·jpg 등 허용 형식이 아닐 때(.ply 3D 스플랫 등)
- 목소리·BGM·효과음 후보를 사용자에게 들려줄 때
- "아티팩트로 게시해 줘" 요청을 받았을 때

## 방법
### 허용 형식·위치
- 형식: png·jpg·gif·webp·svg·html·pdf·mp4·webm·txt·md.
- 위치: 허용 폴더(위원 worktree·프로젝트) 안. 보낼 파일은 worktree `.council/shots/`에 둔다(커밋 안 함).

### 소리 후보: 검은 화면 mp4로
- council_show는 `.mp3`를 형식 거절한다. 오디오 태그가 든 preview.html은 보여 주긴 해도 사용자 화면(채팅·텔레그램)에서 소리가 안 난다("안 들리네").
- 소리 후보는 처음부터 mp4로 만든다: 1280x720 검은 화면 + drawtext 제목(malgun.ttf) + H.264 yuv420p + AAC 192k, 앞뒤 0.5초 무음.
- 후보별 mp4와, 후보를 이어 붙인 비교 mp4(사이 1초 무음)를 함께 council_show한다.
- drawtext 폰트 경로는 `fontfile='C\:/Windows/Fonts/malgun.ttf'`, 한글 제목은 `textfile=`로 넣는다.
- 목소리·BGM·효과음 후보 작업을 배정할 때 완료 조건에 "후보마다 mp4(제목 카드)와 비교 mp4"를 넣는다. html 미리듣기는 로컬 브라우저용 보조로만.

### 허용 밖 파일(.ply 등): gzip+base64 단일 HTML
- 원본을 gzip+base64로 품은 단일 HTML을 만든다: 다운로드 버튼(`DecompressionStream('gzip')` → Blob, 원래 파일명) + 뷰어.
- 3DGS .ply 뷰어: `@mkkellogg/gaussian-splats-3d` 0.4.7 + three 0.160.1(jsdelivr importmap), `addSplatScene(blobUrl,{format:SceneFormat.Ply})`, `sharedMemoryForWorkers:false`·`gpuAcceleratedSort:false`(file://에서 동작). idol 출력은 `cameraUp [0,-1,0]`.
- 검증: HTML에서 디코드한 파일의 sha256을 원본과 대조한다. headless 캡처는 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.
- 아이폰 텔레그램 인앱 브라우저에선 안 열린다 → PC 브라우저로 열라고 안내하고, 회전 미리보기는 mp4/gif 턴테이블을 따로 보낸다.

### "Artifact로 게시" 요청: 단독 HTML + PDF
- 위원 지시 1단계를 "Artifact 도구 확인, 없으면 HTML·PDF 대체물"로 둔다.
- md를 외부 의존 없는 단독 HTML(인라인 CSS, 모바일 폭, 시스템 글꼴, 표 가로 스크롤)로 바꾸고 Chrome headless `--print-to-pdf`로 PDF도 만든다. 결과는 `.council/shots/`.
- 의장이 council_show로 PDF를 보내면 채팅·텔레그램으로 간다.
- Artifact 주소가 꼭 필요하면 사용자가 Claude 앱 대화에서 게시한다.

## 주의할 점
- council_show의 "shown"은 텔레그램 도착 보장이 아니다. 텔레그램이 연결 안 돼 있으면 사용자에게 연결을 부탁하고 다시 보낸다.
