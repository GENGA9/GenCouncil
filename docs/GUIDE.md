# GenCouncil 상세 안내

> 처음 보는 분은 [README](../README.md)부터 읽으세요. 이 문서는 기능별 동작·명령·설정을 개발 단계 순서로 모은 상세 안내입니다.

여러 AI(클로드 · 제미나이 · GPT, 다중 계정)를 "제작위원회"로 묶어 의장이 업무를 분장·취합하고,
내 PC 전체의 공유 기억(Space)을 축적하며, 모바일에서도 작업을 이어가는 로컬 오케스트레이션 앱.
전체 설계는 [docs/ARCHITECTURE.md](ARCHITECTURE.md).

## 현재 상태: 5단계 + 위원 한도·GPT·폴더 모드

## 5단계: 상주 · 알림 · 회고 · 데스크탑

### 회고 자동화

안건을 종료할 때 의장이 먼저 **회고 턴**을 돈다: 잘 된 분장과 실패 원인을 정리하고, 재사용 가치가 있는 해결책·도구 위치·규약을 `memory_write`로 공유 기억에 넣고, 위원으로 쓴 각 모델의 성향을 `persona` 기억에 남기고, 남은 제안을 승인/거절한 뒤 `state.md`에 "회고 완료"를 적는다. 웹의 "안건 종료"가 회고 여부를 묻고, "회고" 버튼으로 종료 없이 따로 돌릴 수도 있다. CLI는 `council finish --retro`.

### Telegram

폰의 Telegram으로 의장과 대화하고, 원할 때 의장에게 결과를 받는다. @BotFather로 봇을 만들고 봇에 메시지를 한 번 보낸 뒤:

```bash
gencouncil web telegram --token <봇 토큰> --chat <내 chat id> --agenda rf-project-제작위원회/밸런스-안건
```

(chat id는 `https://api.telegram.org/bot<토큰>/getUpdates`의 `message.chat.id`.) `gencouncil web`을 다시 띄우면 봇이 연결된다. **안건별 자동 전송은 기본 켜짐이다.** 텔레그램이 연결돼 있으면 새 안건의 의장 답변·위원 완료·시안·안건 종료 알림과 "결정 대기" 질문(선택 버튼 포함)이 모두 자동으로 온다. 끄면 "결정 대기" 질문만 온다(질문은 꺼도 항상 온다). 꺼진 안건에서 텔레그램으로 받고 싶을 때는 의장에게 "텔레그램으로 보내 줘"(예: "이 시안 텔레그램으로 보내 줘", "방금 질문 텔레그램으로도 물어봐")라고 하면 의장이 `council_telegram` 도구로 글·파일(사진은 사진으로, PDF 등은 문서로, 50MB 초과는 이름만)·질문 선택 버튼을 보낸다. 그 밖에는 보내지 않고, 텔레그램에서 쓴 글에 답할 때도 "텔레그램으로 답해 줘"라고 해야 한다. **안건별 자동 전송 버튼:** 안건 화면 위쪽("안건 종료" 옆)에 텔레그램 아이콘(종이비행기) 버튼이 있다. 텔레그램이 연결돼 있으면 켜짐(파란색, 기본)으로 그 안건의 모든 알림(의장 답변, 위원 완료/실패, 시안 사진·파일, 릴레이 대기, 의장 계정 전환, 안건 종료 메시지)이 텔레그램으로 자동 전송되고, 눌러 끄면(회색) "결정 대기" 질문만 온다. 텔레그램이 연결되지 않았으면 꺼짐 모양으로 비활성 표시된다("텔레그램이 연결되어 있지 않습니다"). 설정은 안건의 `agenda.json`(`telegramAuto`)에 저장되고 서버 재시작이 필요 없다: 값이 없으면 켜짐, `false`일 때만 꺼짐. 텔레그램에서도 그 안건 토픽(DM이면 `/agenda`로 고른 안건)에서 `/auto on`, `/auto off`, `/auto`(상태)로 같은 설정을 바꾼다. 서버 전체 `gencouncil web telegram --auto on`은 "안건 설정보다 우선하는 강제 켜짐"이다(모든 안건이 켜짐, 버튼 잠김). 없애려면 `--auto off`(서버 재시작 필요) — 그러면 안건별 설정(기본 켜짐)으로 돌아간다. 기존 설정에 `--auto`가 없어도 안건은 기본 켜짐이다. 받는 것: `/list` `/agenda <project/slug>` `/status` `/auto`, 그 외 텍스트는 그 안건의 의장에게 `[텔레그램] ` 표시를 붙여 전달된다(`/status`·`/list` 결과와 "의장에게 전달했습니다" 같은 접수 답은 항상 온다). 설정된 chat id 외의 메시지는 무시한다. 사진·영상·파일을 첨부하고 캡션으로 지시할 수 있다(20MB 이하, 연달아 보낸 것은 묶어서 전달: 마지막 메시지 뒤 4초 안에 온 글·첨부를 한 번에 의장에게 보내고, 의장이 처리 중이면 끝날 때까지 최대 30분 기다렸다 전달한다). 의장이 질문을 선택 버튼과 함께 보낸 경우(`ask`) 버튼을 눌러 답할 수 있다. 끄려면 `gencouncil web telegram --off`.

#### 안건별 포럼 토픽

그룹의 토픽(포럼) 기능을 쓰면 안건마다 토픽이 하나씩 생겨, 그 안건의 알림은 그 토픽으로 오고 토픽에 쓴 글·누른 버튼은 그 안건의 의장에게만 간다. 포럼을 연결하면 안건 알림은 개인 대화로 가지 않는다(개인 대화의 `/agenda`·`/list` 등은 그대로 동작).

1. 텔레그램에서 그룹을 만들고 그룹 설정에서 **토픽**을 켠다(슈퍼그룹이 된다).
2. 봇을 그룹에 추가하고 **관리자**로 올리며 **토픽 관리** 권한을 준다.
3. 그룹에서 `/forum` 을 보낸다(봇 주인만 가능). "이 그룹을 GenCouncil 포럼으로 연결했습니다"라고 답하면 끝이며 서버 재시작은 필요 없다. 터미널에서는 `gencouncil web telegram --forum <그룹 chat id>` (해제는 `--forum off`).

토픽은 안건의 첫 전송 때 안건 제목으로 자동 생성되고 `server.json`의 `telegram.topics`에 저장된다. 사람이 토픽을 지우면 다음 전송에 다시 만들고, 안건이 종료되면 토픽을 닫는다(종료 메시지는 그 안건의 자동 전송이 켜져 있을 때만). 토픽 밖(일반)에서는 `/list` `/help` `/forum` `/status`만 받고 일반 글은 "안건 토픽 안에 쓰세요"라고 안내한다. 그룹에서는 주인(`--chat`의 사용자) 외의 글·버튼을 무시한다.

### 상주 (Windows 로그온 작업)

```bash
gencouncil service install     # 로그온 시 숨겨진 창으로 gencouncil web 실행 (관리자 권한 불필요)
```

```bash
gencouncil service start | stop | status | logs
```

`~/.gencouncil/service/`에 런처(.cmd/.vbs)와 `web.log`가 생긴다. 제거는 `service uninstall`. macOS/Linux는 LaunchAgent/systemd --user로 `gencouncil web`을 띄우면 된다.

### 데스크탑

```bash
gencouncil desktop             # 서버가 없으면 띄우고, Chrome 앱 모드 창으로 콘솔을 연다 (Rust 불필요)
```

Chrome 앱 창은 전용 프로필(첫 실행 생략)을 써서 토큰 쿠키가 일반 브라우징과 섞이지 않는다. Chrome이 없으면 Edge 기본 프로필로 연다(Edge 새 프로필은 앱 모드에서 첫 실행 마법사에 막혀 빈 창이 된다). 트레이 상주형 네이티브 앱은 [apps/desktop](../apps/desktop/README.md)에 Tauri 2 스캐폴드(트레이 메뉴, 서버 자식 프로세스, 창 닫아도 상주)가 있다. 이 환경에 Rust가 없어 빌드는 검증하지 못했다.

## 패키지

| 패키지 | 역할 |
|--------|------|
| `packages/core` | 기억 저장소(markdown + git), 한/영 검색 색인, INDEX.md 생성 |
| `packages/mcp` | 기억 MCP 서버(stdio) + 클로드/제미나이 등록기 |
| `packages/council` | 프로젝트·안건·계정 레지스트리, git worktree 통합, 위원 드라이버(claude/gemini CLI, relay), 한도 분류·핸드오버, 의장 세션, 의장용 MCP, `AgendaRuntime`(의장 턴 + 위원 이벤트 전달), 터미널 REPL |
| `packages/server` | 웹 서버: REST + WebSocket, 토큰 인증, 정적 UI, 안건별 의장 MCP 경로 `/mcp/<project>/<agenda>`, Telegram 브리지 |
| `apps/web` | React PWA (레퍼런스의 3단 레이아웃, 폰에서는 탭 3개) |
| `apps/desktop` | Tauri 2 트레이 앱 스캐폴드 (Rust 필요, 미검증) |
| `packages/cli` | `gencouncil` 명령 전체 (memory · project · agenda · council · account · web · service · desktop) |

## 제작위원회 만들기

- **이름**: 프로젝트 이름만 적으면 " 제작위원회"가 자동으로 붙는다 (`RF PROJECT` → `RF PROJECT 제작위원회`).
- **폴더**: git 저장소가 아니어도 된다. "폴더 선택"으로 PC의 폴더를 고른다.
  - git 저장소(최상위, 커밋 있음)면 그 저장소에서 바로 worktree로 작업한다.
  - 그 밖의 폴더는 그 폴더 안에 **로컬 git**을 만든다(원격 없음, 어디에도 올라가지 않음). 사본은 만들지 않고 그 폴더에서 바로 작업한다.
  - 파이썬 가상환경(`pyvenv.cfg`가 있는 폴더), `node_modules`·캐시 폴더, 실행 파일·라이브러리·로그(`.dll` `.pyd` `.pyc` `.exe` `.log` …), 64KB가 넘는 이미지·영상·오디오·압축·모델 파일, 5MB가 넘는 파일은 `.git/info/exclude`로 git에서 뺀다. 폴더 안에 따로 git이 있는 하위 폴더도 뺀다(그 폴더는 별도 제작위원회로 등록하면 된다). 빠진 것은 폴더에 그대로 남고 GenCouncil이 건드리지 않는다. 위원 작업 폴더에도 들어가지 않아서, 위원은 필요하면 원본 경로에서 읽기만 한다.
  - 사용자가 폴더를 직접 고친 내용은 안건을 열 때와 종료할 때 "gencouncil: 사용자 변경 반영"으로 자동 커밋된다. 안건 결과는 종료 때 이 폴더에 바로 합쳐진다.
  - 만들 때 무엇이 git에 들어가고 무엇이 빠졌는지 요약을 보여 준다.
- **의장**: 기본 Opus. 판단이 많고 토큰은 적게 쓰는 역할이라서다. 모델과 추론 수준은 프로젝트 설정(⚙)이나 의장 헤더에서 바꾼다.
- **GPT·제미나이 의장**: 의장 헤더의 계정 드롭다운에서 GPT(Codex)나 제미나이(Antigravity) 계정을 고르면 그 AI가 의장을 맡는다. 모델 목록도 그 AI 것으로 바뀌고(기본 gpt-6.2-sol / gemini-4-neon), 세션은 새로 시작한다(state.md 유지). 두 CLI에는 시스템 프롬프트 옵션이 없어 새 세션의 첫 메시지에 의장 지침 전체를, 이후 턴에는 목표·한도·state.md만 붙인다. Codex 의장은 읽기 전용 샌드박스(직접 수정 허용 시 작업 폴더 쓰기)에서 돈다. Antigravity는 MCP를 전역 설정에서만 읽으므로 처음 쓸 때 `~/.gemini/config/mcp_config.json`에 `gencouncil_council`(안건 연결 다리)·`gencouncil`(공유 기억)을 등록하고 `~/.gemini/antigravity-cli/settings.json`에서 두 서버의 도구를 허용한다. 다리는 agy 프로세스 환경변수로 어느 안건인지 알아내므로, 위원이나 직접 띄운 agy에서는 도구가 비어 있다. 위원 권한을 대신 승인하는 검토는 의장이 GPT·제미나이여도 클로드(Opus)가 한다.

## 위원 자율성

위원이 명령 실행처럼 권한이 필요한 일을 할 때 누가 허락하는지 정한다. 프로젝트 설정(⚙)이나 의장 패널 상단의 "위원:" 드롭다운에서 바꾸며, 다음에 시작하는 위원부터 적용된다.

| 값 | 동작 |
|----|------|
| full (권한 확인 없음) | 모든 도구를 묻지 않고 실행 |
| chair (의장이 대신 승인) | 파일 편집은 자동, 그 밖의 요청은 의장이 판단 |
| edits (편집만 자동) | 파일 편집만 자동, 나머지는 거절 |

**의장이 대신 승인** 모드에서 클로드 위원은 권한 요청을 GenCouncil로 보낸다(`--permission-prompt-tool`). 읽기·빌드·테스트 명령(`git status`, `npm test`, `pytest` …)은 바로 허가하고, `git push`·브랜치 이동·광역 삭제·시스템 변경·외부로 파이프 실행은 바로 거절한다. 나머지는 의장 모델(의장 계정, 추론 low)에게 작업 내용과 함께 한 번 물어 허가·거절과 이유를 받는다. 같은 요청은 다시 묻지 않는다. 결정은 의장 채팅에 "의장 승인/거절 …" 줄로 보이고 위원 로그에도 남는다. GPT 위원은 작업 폴더로 제한된 샌드박스에서, 제미나이 CLI 위원은 편집 자동 모드로 돌아간다(두 CLI는 외부 승인 연결을 지원하지 않는다).

## 공유 기억 처리 (Fable)

위원과 의장은 기억을 **제안**만 한다. 제안의 승인·수정·병합·거절은 공유 기억 화면의 **"Fable로 제안 처리"** 버튼이 맡는다. Fable(추론 high)이 제안마다 기존 기억과 겹치는지 찾아보고, 쓸 만한 것은 제목·본문·태그를 다듬어 승인하고, 겹치는 것은 기존 기억에 보강한 뒤 중복으로 거절하고, 일회성·부정확한 것은 이유와 함께 거절한다. 처리 결과는 버튼 아래에 남는다. CLI는 `gencouncil curate`, 기록은 `~/.gencouncil/space/curator/curator.log`.

## 위원 한도와 모델 선택

사용자는 위원 종류별 **동시 최대 인원, 최대 모델, 최대 추론 수준**만 정한다. 프로젝트를 만들 때 또는 프로젝트 이름 옆 ⚙에서 바꾼다.

| 종류 | 실행 | 모델 단계 (낮음 → 높음) | 추론 |
|------|------|------------------------|------|
| 클로드 | Claude Code CLI | haiku · sonnet · opus · fable | low ~ max |
| 제미나이 CLI | Antigravity CLI (`agy`) | gemini-3.8-flash · gemini-4-hydrogen · gemini-4-neon (기본, Opus급) · gemini-4-argon (최상위) | low ~ high (Hydrogen·Neon은 xhigh 지원) |
| GPT | Codex CLI | gpt-6-luna · gpt-6.1-terra · gpt-6.2-sol (주력) · gpt-6.2-astra (최상위) | low ~ max |
| 웹 제미나이 / AI Studio / ChatGPT 웹 | 릴레이 (사람이 전달) | 웹에서 고름 | - |

**제미나이 CLI는 기본으로 꺼져 있다.** Google [Antigravity 추가 약관](https://antigravity.google/terms) 6조는 제3자 소프트웨어로 서비스에 접근하는 것을 위반(계정 정지·해지 사유)으로 보고, [Antigravity FAQ](https://antigravity.google/docs/faq)는 `agy`를 제3자 코딩 에이전트·앱 안에 감싸 쓰는 것을 개인 요금제에서 지원하지 않는다고 적고 있다. GenCouncil은 제미나이 위원·의장·사용량 확인에 `agy`를 자동으로 실행하므로, 꺼져 있는 동안은 `agy`를 한 번도 실행하지 않는다(제미나이 위원·의장을 만들 수 없고, 프로젝트 한도와 상관없이 0명으로 친다). 쓰려면 계정 화면(작업실, 또는 시각화의 설정 › 계정·공간)에서 "위험 읽고 켜기"를 누르고 위험 고지를 읽은 뒤 "제 판단으로 켭니다"에 체크해야 켜진다. 설정은 `~/.gencouncil/providers.json`에 공간 전체로 저장되고 바로 적용된다. 위험 없이 제미나이를 쓰려면 꺼 둔 채 릴레이(웹 제미나이·AI Studio)를 쓴다.

의장은 이 한도 안에서 작업마다 provider·model·effort·advisor를 직접 고른다. 원칙은 "실행은 싸게, 판단은 비싸게"다. 쉬운 작업은 하위 모델, 일반 코딩은 주력 모델, 어려운 설계만 상위 모델을 쓴다. 여러 단계에 걸친 긴 클로드 작업에는 sonnet + advisor opus를 붙여 계획 확정 전·같은 오류 2회·완료 선언 전에만 opus에 상담하게 한다. 클로드 위원에게는 읽기 전용 Haiku 탐색기(search/grep/docs)가 자동으로 붙는다. 한도를 넘는 배정은 서버가 거절하고 허용 목록을 의장에게 돌려준다. 동시 인원이 차면 의장은 다른 종류를 쓰거나 하나가 끝나길 기다린다.

CLI: `gencouncil project set <project> --limit claude=3,opus,high --limit gpt=2,gpt-6.2-sol,high --limit gemini-web=1`, 확인은 `gencouncil project limits <project>`.

추론 수준은 세 provider 모두 작업 유형에서 시작한다: 좁고 기계적인 일(`mechanical`)은 low, 범위가 분명한 일반 작업(`routine`)은 medium, 여러 모듈에 걸친 변경·원인 모를 버그·설계(`complex`)는 high. xhigh는 high로 실패한 작업을 다시 맡길 때만, max는 사용자가 직접 요청했을 때만 쓴다. 의장은 배정할 때 이 유형(`kind`)을 적고, 서버는 끝난 위원의 결과를 모델 × 추론 × 유형별로 모아(완주, 한도로 끊김, 인계·실패·중단, tool call, 소요 시간) 의장 지침과 `council_limits`, `gencouncil project limits`에 보여 준다. 인계할 때는 사유(한도·로그인·재시작·수동)가 기록되어, 재시작으로 이어 간 작업은 실패로 세지 않는다.

위원 카드와 작업 칩에는 `claude-1` 같은 id 대신 **실제로 실행된 모델명**(Sonnet 5.5, GPT-6.1 Sol, Gemini 2.5 Pro …)과 추론 수준·advisor가 표시된다.

색: 클로드 주황 `#d97757`, 제미나이 구글 블루 `#4285f4`, GPT 그린 `#10a37f`, 그 외 릴레이 보라. 릴레이 위원은 라벨(제미나이/agy/aistudio → 블루, gpt/chatgpt → 그린)로 판별한다. 실행 중에는 레퍼런스의 회전 2×2 스피너가 그 색으로 돈다.

## 4단계: 핸드오버 · 계정 레지스트리 · 릴레이 위원

### 계정 레지스트리와 다중 로그인 미리 해 두기

웹의 "계정" 화면에서 종류(클로드, GPT, 제미나이 CLI, 웹 제미나이, AI Studio, ChatGPT 웹)와 ID만 넣고 "추가하고 로그인"을 누르면 이 PC에 로그인 창이 열린다. 한 번 로그인하면 그 계정 전용 폴더에 저장되어 다시 할 필요가 없다. 폴더를 비우면 `~/.gencouncil/accounts/<ID>`를 쓴다.

- CLI 계정: 콘솔 창이 열린다. 클로드는 `/login`, GPT는 `codex login`이 자동 실행되어 브라우저로 로그인, 제미나이는 첫 실행 안내를 따른다.
- 웹 계정: 그 계정 전용 Chrome 프로필로 사이트가 열린다. 구글/ChatGPT에 로그인하고 창을 닫으면 된다. 같은 종류의 웹 계정이 여럿이면 릴레이 위원마다 가장 오래 안 쓴 계정을 고른다. 릴레이 창의 "복사하고 사이트 열기"가 그 프로필로 사이트를 연다.

`~/.gencouncil/accounts.json`. 기본 로그인은 `claude`, `gemini`라는 이름으로 항상 존재한다. 계정을 더 쓰려면:

```bash
gencouncil account add claude-b --provider claude --config-dir C:\Users\me\.claude-b --note "회사 계정"
```

```bash
gencouncil account login claude-b      # 그 계정 폴더로 클로드 코드를 열어 준다. /login 후 /exit
```

```bash
gencouncil account list                # 상태: ok / exhausted(리셋 시각) / auth(로그인 필요)
```

클로드는 `CLAUDE_CONFIG_DIR`, 제미나이는 `HOME`을 그 폴더로 바꿔 띄우므로 로그인이 계정별로 분리된다. 위원·의장은 등록된 계정 중 **사용 가능한 것을 우선순위대로 자동 선택**한다. 한도 오류가 나면 그 계정은 `exhausted`가 되고(오류 문구의 리셋 시각을 읽고, 없으면 클로드 5시간 / 제미나이 1시간), 시각이 지나면 자동 복구된다. 웹 UI의 "계정" 화면에서 상태 확인·수동 복구·추가를 할 수 있다.

### 핸드오버

- **위원**: 패킷 규칙에 따라 단계마다 `.council/STATE.md`를 갱신한다. 위원 프로세스가 한도(quota)나 로그인(auth) 오류로 죽으면 서버가 원인을 분류해 계정을 표시하고, **같은 worktree·같은 브랜치**에서 다른 계정(없으면 `members.fallbackProvider`)의 새 위원을 띄운다. 미커밋 변경은 먼저 자동 커밋되고, 새 위원은 원래 패킷 + STATE.md + 커밋 로그 + diffstat이 담긴 인계 패킷(`.council/HANDOVER.md`)을 받는다. 작업당 최대 `members.maxHandovers`(기본 2)회. 의장에게는 "→ 핸드오버됨 X" 이벤트가 가서 재배정하지 않는다.
- 수동 인계: 멈추거나 애매하게 실패한 위원을 이어서 시키려면 위원 카드의 "이어받기", 의장 도구 `council_handover`, 또는 CLI.

```bash
gencouncil council handover <project> <agenda> claude-1 [--provider gemini] [--account claude-b]
```

- **의장**: 의장 턴이 한도/로그인 오류로 실패하면 같은 종류(claude·gpt·gemini)의 다른 계정으로 바꾸고 `state.md`를 바탕으로 새 세션을 시작한다(최대 3회). 쓸 수 있는 계정이 없으면 그 사실을 채팅에 알린다. 의장 헤더의 계정 드롭다운으로 수동 전환도 된다(세션은 새로 시작, state.md 유지).

### 릴레이 위원

웹 제미나이, AI Studio, Antigravity, ChatGPT처럼 CLI가 없는 AI를 쓰는 방법. 의장이 `provider: relay`로 배정하면서 필요한 파일을 `files`에 넣으면 패킷에 파일 내용이 포함된다. 오른쪽 카드의 "패킷 · 답변"에서 ① 패킷 전체 복사 → 웹 AI에 붙여넣기 ② AI 답변 전체를 붙여넣고 "적용하고 완료". 답변의 `=== FILE: 경로 ===` 블록은 worktree에 저장·커밋되고 `=== RESULT ===` 블록은 결과 보고가 된다. 그 뒤는 일반 위원과 똑같이 의장이 검토·머지한다. 폰의 PWA에서도 같은 흐름으로 처리할 수 있다. CLI:

```bash
gencouncil council relay packet <project> <agenda> relay-1 > packet.txt
```

```bash
gencouncil council relay submit <project> <agenda> relay-1 --file answer.txt
```

Antigravity처럼 폴더를 직접 편집하는 도구는 위원 worktree(`.worktrees/<안건>/relay-N`)를 열어 작업하게 한 뒤 RESULT 블록만 붙여넣으면 된다(미커밋 변경을 서버가 커밋한다).

## 3단계: 웹 UI + 모바일

```bash
gencouncil web            # http://localhost:7700 (기본: 모든 인터페이스에 바인딩, 토큰 필요)
```

```bash
gencouncil web token      # 접속 토큰 (처음 실행 때 ~/.gencouncil/server.json 에 생성, --reset 으로 재발급)
```

화면 구성 (레퍼런스 그대로)

- 좌: SPACE → 제작위원회 → 안건 트리, 실행 중 위원 수·작업 진행도 배지, 공유 기억(승인 대기 제안 수), 현재 안건 고정, 서버/Tailscale 주소.
- 중: 의장 헤더(모델·추론 수준 드롭다운 = 즉시 저장, 다음 턴부터 적용), 목표 박스(목표별 작업 칩: 대기/진행/검토/완료/막힘 ← 담당 위원), 의장 채팅(도구 호출은 회색 한 줄, 위원 이벤트는 노란 테두리), "의장 상태" 토글로 state.md, 세션 초기화, 안건 종료.
- 우: 위원 카드. 실행 중은 펼쳐져 최근 20분 활동 스파크라인·도구 호출 수·마지막 말·로그/중지 버튼, 끝난 위원은 접힌 줄(▽)로 결과·diffstat·머지 버튼.
- 폰(900px 이하): [안건] [의장] [위원] 탭.

### 시각화 모드

위 화면이 **작업실** 모드다. 왼쪽 위의 `✦ 시각화 | ▤ 작업실` 스위치(폰은 탭 줄의 ✦)로 **시각화** 모드를 고르면, 열려 있는 안건이 지금 어떻게 돌아가는지를 밤하늘 위의 그림으로 보면서 같은 일을 할 수 있다. 고른 모드는 브라우저에 기억된다.

그림

- 가운데: 의장. 둘레의 고리는 과제 하나가 호 하나다(회색 대기, 맡은 회사 색 진행, 흰색 검토, 금색 결정됨). 의장이 생각하는 동안 코로나가 커진다.
- 삼각형의 세 꼭짓점: Claude · GPT · Gemini. 회사마다 고리 위에 모델 사다리가 낮은 단부터 새겨져 있고, 프로젝트 한도를 넘는 단은 비어 있다. 지금 일하는 위원은 자기 모델의 단에서 바깥으로 뻗어 나와 이름·추론 수준, 맡은 과제, 진행 상황 한 줄(도구 호출 수 · 몇 분째)을 달고 있다(원 안의 점 개수 = 추론 수준). 한 회사에서 여럿이 나가 있으면 의장 반대쪽 호를 따라 넓게 퍼지고, 붐비면 한 명 걸러 더 멀리 선다(단으로 이어지는 선이 길어진다). 이름표는 회사·의장·다른 위원·다른 이름표를 가장 덜 가리는 자리를 고른다. 끝난 위원은 회사 곁에 작고 어두운 노드로 남는다.
- 오가는 것: 의장이 위원을 보내면 `지시` 꾸러미가 의장 → 회사 → 그 모델의 단으로 선을 타고 간다. 그동안 그 회사의 원반(회사 이름과 모델 사다리)이 한 바퀴 돌고, 고른 모델이 설 자리에는 밖에서 안을 가리키는 화살표와 선이 켜진다. 원반이 멈춰 고른 모델이 그 선에 맞으면 이름이 환하게 빛나고, 거기서 새 가지(워커)가 자라 나온다. 한 회사에 지시가 잇달아 가면 한 번 도는 동안 고른 모델이 모두 켜진다. 위원이 한 줄 남길 때마다 작은 빛이, 끝나면 `보고` 꾸러미가 같은 길을 거슬러 의장에게 간다. 내가 보낸 말은 `요청`으로 그림 가장자리에서 의장에게, 의장의 답은 `응답`으로 되돌아온다.
- 폰(세로 화면): 같은 삼각형을 바짝 모아 그린다. GPT와 Gemini는 의장 바로 옆 아래, Claude는 의장 바로 위에 서고, 의장의 말은 그림 속 말풍선이 아니라 입력창 바로 위에 고정된 패널(입력창과 같은 폭, 세 줄 높이)에 뜬다. 의장이 질문하면 그 자리에 선택지가 달린 질문 카드가 온다. 그림의 높이는 지금 그려진 것(회사, 끝난 위원, 일하는 위원과 이름표)에 맞춰 정해진다: 안건 카드와 그림 사이의 여백이 그림과 의장 패널 사이의 여백과 같아지는 자리다. 세 줄 이름표를 둘 자리가 없는 위원은 이름 한 줄만 단다. Claude 위에 일하는 위원이 없으면 그만큼 위로 올라가고, 위원이 생기거나 사라져 높이가 바뀔 때는 그림 전체가 미끄러지듯 옮겨 간다. 화면이 짧아 여백이 없으면 카드 바로 아래에 붙는다.
- 의장 교체: 같은 안건에서 의장의 모델이나 회사가 바뀌면, 이전 의장의 빛이 원판으로 빨려 들며 이름이 사라지고, 새 의장이 흰 섬광과 함께 나타난다. 하늘 전체로 고리가 퍼지고 세 회사로 가는 선마다 빛이 내달려 회사들이 물결로 답한다. 위원이 배정될 때보다 훨씬 큰 연출이다. 열려 있던 의장 카드는 닫힌다.
- 아래: 지금 단계를 밝힌 `배분 → 작업 → 검토 → 결정` 띠.

말하고 듣기

- 말은 말한 쪽 옆에 뜬다. 의장의 답과 질문은 의장 옆 말풍선으로(새 말이 오기 전까지 흐리게 남는다. 폰에서는 입력창 위 고정 패널), 위원이 남긴 한 줄·도구 호출·결과 보고는 그 위원 옆 말풍선으로 몇 초 떴다 사라진다. 말풍선은 동시에 다섯 개(폰은 두 개)까지만 뜨고, 새 말이 오면 가장 오래된 것이 자리를 비킨다.
- 끝난 위원은 사라지지 않고 회사 곁(의장 쪽 양옆)에 작고 어두운 노드로 남는다. 안의 글자는 모델 단의 첫 글자, 금색 테두리는 머지됨, 붉은 테두리는 실패.
- 입력창은 그림 아래에 떠 있다: 의장에게 말하기, 파일 첨부, 의장 질문의 선택지 버튼, 안건 종료 승인, 끊긴 작업 이어서 하기, 대기 메시지 취소.
- 왼쪽 위 카드에 지금 프로젝트와 안건. 누르면 안건을 바꾸거나 새로 만들고, 프로젝트 설정·가이드라인, Gen Wiki·기억·계정·설정을 열 수 있다.
- 지나간 말을 다시 보려면 입력창의 `☰`(또는 의장 말풍선)로 **기록**을 연다: 의장과의 대화, 의장의 도구 호출, 위원의 투입·진행·보고가 순서대로 쌓여 있다(오른쪽 패널, 폰은 아래 시트).

위키와 설정

- 모드 스위치 옆의 `❖ 위키` · `⚙ 설정`을 누르면 그림 위로 패널이 열린다(그림은 뒤에서 계속 움직인다). 탭은 넷: **위키**(Gen Wiki: 검색, 읽기, 편집, 제안 처리, 전체 점검), **기억**(공유 기억 검색, 제안 승인·거절, 정리), **계정**(로그인, 복구, 추가), **설정**. 작업실의 같은 화면과 하는 일이 같다. 닫기는 ✕, 바깥, Esc.
- 설정 탭의 **공간**: 회사별 남은 사용량(새로 확인, 세부 한도), 위키·기억·계정 바로가기, 연결 상태, 작업실로 가기와 작업실 테마.
- 설정 탭의 **제작위원회**(프로젝트마다): 의장·위원 한도(이름, 작업 폴더, 의장 모델·추론, 직접 수정, 위원 자율성, 위원 한도), 가이드라인 편집, 안건 목록(열기, 새 안건, 보관된 안건). 그림 속 카드의 "한도 · 설정"과 "가이드라인"도 여기로 온다.
- 폰에서는 패널이 화면 전체를 덮는다. 위키는 목록 → 페이지 순서로 넘어가고 `‹ 목록`으로 돌아온다.
- 시각화 모드에서 뜨는 창(위원 로그·diff, 패킷, 이어받기, 제작위원회 추가)도 같은 밤하늘 색으로 나온다.

누르면 열리는 카드

- 의장: 멈추기(작업 중일 때), 의장을 맡을 회사(Claude · GPT · Gemini 중 계정이 있는 곳. 회사를 누르면 그 회사의 모델이 나오고, 모델을 고르면 그때 의장이 바뀐다), 모델·추론 수준·계정·위원 권한, 텔레그램 자동 전송, 의장 상태(state.md), 세션 초기화, 회고, 메인 반영, 안건 종료, 삭제, 과제 목록.
- 회사: 모델 사다리와 각 단의 쓰임, 남은 사용량, 끝난 위원 목록(로그·diff, 머지, 이어받기), 한도·설정.
- 일하는 위원: 과제·추론 수준·도구 호출 수·마지막 말, 로그 보기, 중지(릴레이 위원은 패킷·답변).
- 끝난 위원: 결과 요약·미완료·오류, 로그·diff, 머지, 이어받기.

서버 없이 그림만 보려면 개발 서버에서 `/vision-demo.html`을 연다(`?empty` 안건 고르기 전, `?ask` 의장 질문, `?quiet` 자동 재생 끔, `?idle` 일하는 위원 없음, `?film` 짧은 홍보 장면: 의장 카드에서 Claude와 Opus 선택 → 의장 교체 → 지시 입력 → 다섯 모델 배분). 위키·기억·계정·설정 패널도 예시 자료로 열린다.

### 폰에서 쓰기 (Tailscale)

1. PC와 폰에 Tailscale을 설치해 같은 tailnet에 넣는다.
2. PC에서 `gencouncil web`. 시작 로그에 `http://<pc>.<tailnet>.ts.net:7700` 주소가 뜬다. 폰 브라우저에서 열고 토큰을 입력하면 바로 쓸 수 있다.
3. 홈 화면에 **PWA로 설치**하려면 HTTPS가 필요하다. PC에서 한 번만:

```bash
tailscale serve --bg 7700
```

   그러면 `https://<pc>.<tailnet>.ts.net` 로 접속되고(인증서는 Tailscale이 발급), 브라우저 메뉴의 "홈 화면에 추가"가 독립 앱으로 설치된다. 서비스워커는 앱 셸만 캐시하고 API/WS는 캐시하지 않는다.

보안: API·WebSocket·MCP 경로는 모두 토큰이 있어야 한다(쿠키 또는 `Authorization: Bearer`). 정적 UI만 토큰 없이 내려간다. 집 Wi-Fi에 노출하고 싶지 않으면 `gencouncil web --host 127.0.0.1` 로 띄우고 `tailscale serve`로만 내보낸다.

### 개발

```bash
npm run dev --workspace @gencouncil/web   # Vite 개발 서버(5173) → 7700으로 프록시
```

`npm run build`가 TypeScript 패키지와 웹 번들을 모두 빌드한다. 서버는 `apps/web/dist`를 그대로 서빙한다.

## 2단계: 제작위원회 돌리기

### 개념

```
프로젝트(제작위원회)  = git 저장소 1개 + guidelines.md + 의장 설정
 └ 안건               = 목표 목록 + 통합 브랜치 agenda/<slug>
    ├ 작업 T1, T2 …   = 의장이 쪼갠 단위
    └ 위원 claude-1 … = 작업 1개를 맡아 독립 worktree/브랜치 member/<slug>/<id> 에서 자율 실행
```

- **의장**은 `claude -p`(헤드리스 클로드 코드, 기존 로그인 사용)로 돌아가며 `--resume`으로 대화가 이어진다. 편집 도구가 없고 읽기 + 의장 도구(council_*) + 기억 도구(memory_*)만 쓴다.
- **위원**도 헤드리스 CLI다. 클로드는 `claude -p --dangerously-skip-permissions`, 제미나이는 `gemini -p --approval-mode yolo`(프로젝트 `members.autonomy`가 `edits`면 편집만 자동 승인). 작업 패킷(`.council/TASK.md`)을 stdin으로 받고, 끝나면 커밋 + `.council/RESULT.md`를 쓴다. 서버가 RESULT.md를 파싱해 결과·미완료·기억 제안을 기록한다.
- **머지는 의장만** 한다. 위원 브랜치 → 통합 worktree(`.worktrees/<slug>/_integration`, 안건 브랜치) → `council finish`로 베이스 브랜치. 충돌이 나면 머지를 되돌리고 충돌 파일을 보고한다.
- 의장은 분장·배정·머지마다 `chair/state.md`에 상태를 남긴다. 이것이 4단계 핸드오버(의장 교체)의 근거다. `/reset`으로 세션을 끊어도 state.md는 이어진다.

### 사용

```bash
gencouncil project add "RF PROJECT 제작위원회" --repo D:\PROJECT\RF --chair-model claude-opus-5-5 --chair-effort high
```

```bash
gencouncil agenda add rf-project-제작위원회 "밸런스 안건" --goal "목표 1" --goal "목표 2"
```

```bash
gencouncil council chat rf-project-제작위원회 밸런스-안건
```

채팅에서 그냥 말하면 의장에게 전달된다. 위원이 끝나면 `[council event]`가 자동으로 의장에게 들어가고 의장이 검토·머지한다. REPL 명령: `/status` `/tasks` `/members` `/log <id>` `/merge <id>` `/stop <id>` `/reset` `/quit`. 채팅을 닫으면 실행 중인 위원은 중지된다.

```bash
gencouncil council finish rf-project-제작위원회 밸런스-안건     # 안건 브랜치를 베이스에 머지, worktree 정리
```

의장 없이 위원 하나만 직접 돌려 보려면:

```bash
gencouncil council run <project> <agenda> --task "제목" --instructions "무엇을/어디에/완료 조건" --provider claude
```

가이드라인(AI 성향·분장 규칙)은 `gencouncil project guidelines <project>`가 알려 주는 파일을 편집한다. 의장 프롬프트에 매 턴 들어간다.

다중 계정: `gencouncil account add claude-b --provider claude --config-dir ~/.claude-b` 후 배정 시 `account: claude-b`. 클로드는 `CLAUDE_CONFIG_DIR`, 제미나이는 HOME을 바꿔 띄운다.

런타임 데이터는 `~/.gencouncil/projects/<project>/agendas/<slug>/`(agenda.json, tasks.json, members.json, members/*.log, chair/state.md, chair/session.json, transcript.jsonl)에 쌓인다.

### 주의

- `autonomy: full`(기본)은 위원이 권한 확인 없이 명령을 실행한다. worktree로 격리되지만 저장소 밖을 건드릴 수 있는 명령까지 막지는 않는다. 신뢰할 수 없는 작업은 `--autonomy edits`로.
- 제미나이 위원은 로그인 전이라 실제 실행은 아직 검증하지 못했다. 또 Gemini CLI는 신뢰하지 않은 폴더에서 MCP와 프로젝트 설정을 끈다(그래서 패킷은 stdin으로 주고, 기억 제안은 RESULT.md로도 받는다).
- 바이너리 파일은 한 위원에게만 배정하도록 가이드라인 기본 템플릿에 적혀 있다.

## 1단계: Space 공유 기억

기억은 코드와 분리된 `~/.gencouncil/space/memory/`에 산다(`GENCOUNCIL_HOME`으로 변경 가능).

```
~/.gencouncil/space/            git 저장소
  memory/
    INDEX.md                    자동 생성 색인 (위원 프롬프트에 주입)
    solutions/ tools/ conventions/ accounts/ personas/
    proposals/                  위원이 제안한 것. 승인되면 위 폴더로 이동
  wiki/                         Gen Wiki (common/ · models/ · projects/<프로젝트>/)
```

### 기본 위키

처음 설치한 GenCouncil의 빈 위키는 저장소의 `packages/core/wiki-default/` 페이지 91개로 시작한다(서버나 MCP 서버가 처음 뜰 때 한 번 복사, 페이지가 하나라도 있는 위키는 건드리지 않는다). 내용은 의장·위원 운영(`common/council*`), CLI와 에이전트(`common/ai-agents`), 모델별 성향(`models/`), git·Windows·웹·Python 함정이다. 프로젝트 전용 페이지(`projects/`)와 개인 작업에서 쌓인 페이지는 들어 있지 않다. `packages/core/test/wikidefault.mjs`가 기본 위키에 개인 경로·주소·프로젝트 이름·기억 id·키가 섞이지 않았는지, 링크가 모두 살아 있는지 검사한다.

## 설치

```bash
npm install && npm run build
```

```bash
npm link --workspace @gencouncil/mcp   # 전역 `gencouncil` 명령
```

```bash
gencouncil init                        # 기억 폴더 + 시드 2개
```

```bash
gencouncil install all                 # 클로드 코드 + 제미나이 CLI 등록, CLAUDE.md/GEMINI.md에 사용 규칙 추가
```

`install`이 하는 일

- 클로드 코드: `claude mcp add --scope user gencouncil …` (user 스코프, 모든 프로젝트에서 보임)
- 제미나이 CLI: `~/.gemini/settings.json`의 `mcpServers.gencouncil`
- Antigravity: `gencouncil install antigravity` → `~/.gemini/antigravity/mcp_config.json` (IDE 재시작 후 반영)
- 각 도구의 전역 지시 파일에 `<!-- gencouncil:start/end -->` 블록으로 사용 규칙을 넣는다. `--no-rules`로 생략.

제미나이 CLI는 **신뢰하지 않은 폴더에서는 MCP 서버를 끈다.** 처음 `gemini`를 실행할 때 폴더를 신뢰하거나,
`gemini mcp list`에서 Disabled로 나오면 그 폴더에서 `/permissions`(또는 신뢰 프롬프트)로 허용한다.

다른 계정의 클로드 코드에 붙이려면 그 계정의 설정 디렉토리로 실행한다.

```bash
CLAUDE_CONFIG_DIR=~/.claude-b gencouncil install claude
```

## MCP 도구

| 도구 | 누가 | 설명 |
|------|------|------|
| `memory_index` | 모두 | 검증된 기억의 한 줄 색인 |
| `memory_search` | 모두 | 한/영 전문 검색 (`type`, `project`, `include_proposed`) |
| `memory_read` / `memory_list` | 모두 | 항목 읽기 / 목록 |
| `memory_propose` | 모두 | 제안 (proposals/ 에 저장) |
| `memory_write` / `memory_update` | owner, chair | 바로 검증된 기억으로 저장 / 수정(`append` 권장) |
| `memory_approve` / `memory_reject` | owner, chair | 제안 승인 / 거절 |

역할은 서버 환경변수 `GENCOUNCIL_ROLE`(owner | chair | member)로 정한다. `install`은 내 도구에 owner를 준다.
2단계에서 의장이 띄우는 위원은 member로 띄워 제안만 하게 할 계획이다.
`GENCOUNCIL_AGENT`는 항목의 `source`에 기록된다(claude-code, gemini-cli …).

## CLI

```bash
gencouncil search "ffmpeg 경로"
```

```bash
gencouncil add --type solution --title "ffmpeg가 PATH에 없을 때 실행 경로" --tags ffmpeg,windows --body-file note.md
```

```bash
gencouncil proposals
```

```bash
gencouncil approve <id>
```

그 밖에 `status`, `index`, `read`, `list`, `update`, `reject`, `remove`, `server-path`. `gencouncil help` 참고.

## 기억 파일 형식

```markdown
---
id: sol-20261022-ffmpeg가-path에-없을-때-실행-경로
title: ffmpeg가 PATH에 없을 때 실행 경로
type: solution            # solution | tool | convention | account | persona
tags: [ffmpeg, windows]
project: RF               # 비우면 Space 전체
status: verified          # verified | proposed | rejected
source: claude-code
created: 2026-10-22T05:00:00.000Z
updated: 2026-10-22T05:00:00.000Z
---

## 문제
## 해결
## 적용 방법
```

직접 편집해도 된다. 서버가 변경을 감지해 다시 읽고, 쓰기마다 git 커밋이 남는다.

## 로그

안건별 기록은 `~/.gencouncil/projects/<프로젝트>/agendas/<안건>/` 아래에 남는다.

| 파일 | 내용 |
|------|------|
| `members/<id>.log` | 위원 CLI의 stdout/stderr 원문, 시작 계정·브랜치, 종료 코드 |
| `chair/chair.log` | 의장 매 턴의 계정·모델·advisor·재개 세션, 프롬프트, stream-json·stderr 원문, 종료 코드, 계정 전환 |
| `transcript.jsonl` | 의장과의 대화 (내 메시지, 최종 답변, 오류, 비용) |
| `members.json` | 위원 상태, 커밋, 실패 분류와 리셋 시각, 인계 관계 |
| `chair/state.md` | 의장 체크포인트 |
| `archive/<worktree>/` | 안건 종료·정리 때 worktree를 지우기 전에 복사한 `.council/*.md` (TASK, RESULT, STATE, HANDOVER) |

계정 오류는 `~/.gencouncil/accounts.json`, 상주 서버 로그는 `~/.gencouncil/service/web.log`에 있다. 한도 오류 감지가 틀리면 `chair.log`나 위원 `.log`의 stderr 줄을 보고 `packages/council/src/quota.ts`의 패턴을 보강한다. 로그 정리(로테이션)는 아직 없다.

## 테스트

```bash
npm test
```

임시 `GENCOUNCIL_HOME`에서 기억 저장소 왕복, MCP stdio 세션(member / owner 역할 게이트), LLM 없이 안건·worktree·패킷·머지/충돌·finish 흐름, 한도 분류·계정 레지스트리·릴레이 왕복·가짜 드라이버로 한도 오류 → 자동 핸드오버, 웹 서버(인증, 프로젝트/안건 API, 런타임 열기, MCP 엔드포인트, WebSocket), 그리고 가짜 Telegram API로 알림 포맷·명령·의장 전달을 검사한다. 실제 의장·위원 실행은 계정을 쓰므로 자동 테스트에 넣지 않았다.

## 남은 일

- Tauri 트레이 앱 빌드 검증 (Rust 설치 후 `apps/desktop`)
- 제미나이 CLI 로그인 후 제미나이 위원 실제 실행 검증
- Telegram 봇 실제 연결 검증 (봇 토큰 필요)
