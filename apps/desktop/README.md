# GenCouncil Desktop (Tauri 트레이 앱)

트레이에 상주하면서 로컬 웹 서버(`gencouncil web`)를 띄우고, 그 UI를 네이티브 창으로 보여 주는 얇은 래퍼. **빌드하려면 Rust 툴체인이 필요하다** (이 저장소를 만든 환경에는 없어서 스캐폴드만 있고 빌드는 검증하지 않았다).

Rust 없이 바로 쓸 수 있는 대안: `gencouncil desktop` (Edge/Chrome 앱 모드 창) + `gencouncil service install` (로그온 시 서버 자동 시작).

## 빌드

1. Rust 설치: https://rustup.rs (Windows는 MSVC 빌드 도구 포함)
2. 이 폴더에서:

```bash
npm install -D @tauri-apps/cli@^2
```

```bash
npx tauri dev        # 개발 실행
```

```bash
npx tauri build      # 설치 파일 생성 (src-tauri/target/release/bundle)
```

## 동작

- 시작 시 `~/.gencouncil/server.json`의 포트·토큰을 읽는다. 서버가 안 떠 있으면 `node <cli.js> web`을 자식 프로세스로 띄운다 (`GENCOUNCIL_CLI` 환경변수 또는 `tauri.conf.json`의 `cliPath`로 경로 지정).
- 메인 창은 `http://localhost:<port>/auth?token=<token>`을 열어 쿠키를 받고 UI로 이동한다.
- 트레이 메뉴: 열기 / 서버 재시작 / 종료. 창을 닫아도 트레이에 남는다.

구조:

```
apps/desktop/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    build.rs
    capabilities/default.json
    src/main.rs
```
