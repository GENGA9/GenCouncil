# GenCouncil Desktop (Tauri 트레이 앱)

로컬 웹 콘솔을 자기 창으로 띄우는 얇은 Windows 앱. 트레이에 상주하고, 창을 닫아도 트레이에 남는다. 휴대폰은 지금처럼 브라우저(PWA)로 쓴다.

## 동작

- 서버는 앱이 아니라 로그온 작업 `GenCouncilWeb`(`gencouncil service install`)이 돌린다. 앱은 포트에 아무것도 없을 때만 `gencouncil service start`로 그 작업을 켜고(작업이 없으면 `gencouncil web`을 숨겨서 띄움), **앱을 종료해도 서버는 계속 돈다**.
- 시작하면 로딩 화면(`splash/`)을 보여 주고, 서버가 뜨면 `~/.gencouncil/server.json`의 포트·토큰으로 `http://localhost:<port>/auth?token=…`을 열어 쿠키를 받고 콘솔로 넘어간다.
- 트레이: 왼쪽 클릭 = 창 열기. 오른쪽 메뉴 = 열기 / 새로고침 / 닫으면 플로팅 의장 띄우기(체크) / 서버 재시작(확인 창) / 종료.
- 두 번 실행하면 새로 뜨지 않고 기존 창을 앞으로 가져온다.
- 플로팅 의장: 창을 닫아(X) 트레이로 보내면, 의장 반신이 바탕화면 오른쪽 아래에 투명·항상 위 창(`/?float=1`, 300×420)으로 뜬다(포커스는 가져가지 않음). 최소화는 그냥 최소화다. 콘솔이 어느 화면이었든 뜨며, 말풍선에 의장의 최근 답·결정 대기 질문·위원 보고, 💬로 여는 입력창으로 바로 지시. 아바타 화면의 짧은 이벤트 대사(지시 받음·안건 종료 등)는 메인 콘솔이 아바타 화면일 때만 함께 나온다. 의장을 끌면 창이 움직이고(위치와 설정은 `%APPDATA%\dev.gencouncil.desktop\float.json`에 기억), 더블클릭하거나 ⤢를 누르면 메인 창이 돌아오고 플로팅은 숨는다(트레이 클릭·'열기'도 같음).
  - 켜고 끄기: 트레이 메뉴 '닫으면 플로팅 의장 띄우기'(기본 켜짐, 재시작 후에도 유지). 트레이에 들어가 있는 동안 켜면 바로 뜨고 끄면 바로 숨는다.
  - 플로팅 의장 우클릭 메뉴: 메인 열기 / 잠시 숨기기(이번만, 다음에 닫으면 다시 뜸. ✕ 버튼과 같음) / 플로팅 끄기(설정까지 끔 = 트레이 체크 해제). 입력칸 안의 우클릭은 브라우저 편집 메뉴 그대로.
  - 콘솔 페이지는 `desktop_mode` 명령으로 떴음을 알리고(이때 플로팅 창을 숨긴 채 미리 로드), 원격(localhost) 페이지가 부를 수 있는 명령은 `capabilities/console.json`·`float.json`에 적힌 것뿐이다.
- CLI 경로는 빌드할 때 이 저장소의 `packages/cli/dist/cli.js`로 박힌다. 바꾸려면 `GENCOUNCIL_CLI` 환경변수.

## 빌드

필요한 것: Rust(rustup, MSVC), Visual Studio Build Tools(C++), Node. 이 폴더에서:

```bash
npx tauri dev        # 개발 실행
```

```bash
npx tauri build      # 설치 파일: src-tauri/target/release/bundle/nsis/GenCouncil_<ver>_x64-setup.exe
```

설치 파일은 사용자 폴더에 설치(관리자 권한 불필요)하고 시작 메뉴 바로가기를 만든다. 아이콘은 `npx tauri icon ../web/public/icons/icon-512.png -o src-tauri/icons`로 다시 만든다.
