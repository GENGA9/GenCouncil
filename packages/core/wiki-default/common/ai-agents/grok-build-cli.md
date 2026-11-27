---
title: Grok Build CLI (grok) 위원·의장 운용
summary: xAI Grok Build CLI(grok)를 GenCouncil 위원·의장으로 헤드리스 실행할 때 어떤 플래그·프로필·MCP 설정을 쓰고 무엇을 조심하나?
updated: 2026-11-26T00:00:00.000Z
by: gencouncil-default
---
Grok Build 1.0.92 기준. 설치 위치는 `%USERPROFILE%\.grok\bin\grok.exe`이고, 오래 떠 있던 프로세스는 PATH에 없을 수 있어 GenCouncil이 이 폴더를 직접 찾는다.

## 언제 쓰나
- 그록 위원(council_assign provider: grok)이나 그록 의장(의장 계정을 grok으로)을 돌릴 때.
- 그록이 이상하게 동작할 때 원인을 찾을 때.

## 방법
- 헤드리스 한 턴: `grok -p --output-format streaming-json --cwd <폴더> --no-alt-screen`. `-p` 뒤에 값이 없으면 프롬프트를 stdin에서 읽는다. 이어 가기는 `--resume <sessionId>`(세션 id는 마지막 `end` 이벤트에 있다).
- 모델: `--model grok-4.7`(기본) / `grok-4.7-build-fast` / `grok-4.6` / `grok-4.5`. 실제로 돈 모델 이름은 `end` 이벤트의 `modelUsage` 키(`grok-4.7-build`)다.
- 추론: `--reasoning-effort low|medium|high|xhigh`. max는 없고 grok-4.5는 high까지다.
- 로그인: `GROK_HOME`이 계정 폴더다(기본 `~/.grok`). `grok login --oauth`로 브라우저 로그인. 토큰이 7일 정도면 만료되니 '로그인 필요' 실패는 다시 로그인하면 된다.
- **빈 프로필로 돌린다**: grok은 사용자 프로필의 Claude Code 스킬·플러그인·훅·MCP를 그대로 불러온다(Claude 훅이 답을 막은 적이 있다). 그래서 `USERPROFILE`·`HOME`을 빈 폴더로 바꾸고 `.gitconfig`만 복사해 둔다.
- **MCP**: 빈 프로필의 `<프로필>/.cursor/mcp.json`(Cursor 형식 `{"mcpServers":{...}}`)을 읽는다. HTTP 서버의 토큰은 `"Authorization": "Bearer ${env:GENCOUNCIL_COUNCIL_TOKEN}"`처럼 환경 변수로 넘겨 파일에 남기지 않는다. stdio 서버(기억 서버)에는 실제 홈(`USERPROFILE`/`HOME`/`GENCOUNCIL_HOME`)을 env로 돌려줘야 공간을 찾는다. 확인은 `grok inspect --json`.
- **MCP 도구는 목록에 바로 보이지 않는다**: `search_tool`로 찾고 `use_tool`로 부르며 이름은 `<서버>__<도구>`(예: `council__council_assign`, `gencouncil__memory_search`). 위원·의장 지시에 이 문장을 넣어 둔다.
- 권한: 헤드리스 `--permission-mode acceptEdits`는 편집도 거절한다. `--always-approve`로 돌리고, 쓰면 안 되는 도구는 `--disallowed-tools`(쉼표 목록: `run_terminal_command,search_replace,write,spawn_subagent,workflow,monitor,image_gen` 등)로 뺀다. `--tools ""`는 오류다.

## 주의할 점
- `grok usage`(사용량)는 헤드리스에서 "Run /usage inside grok instead" 오류를 내고 `-p "/usage"`는 일반 질문으로 처리된다. 대신 `/usage` 창이 읽는 결제 서버를 직접 부른다: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, 헤더 `Authorization: Bearer <GROK_HOME/auth.json의 key>`. 응답 `config.creditUsagePercent`가 주간 사용률, `config.currentPeriod.end`가 초기화 시각이다(5시간 창은 없다). `X-XAI-Token-Auth` 헤더를 같이 보내면 401이 난다. 토큰(`expires_at`)이 만료됐으면 `grok models`를 한 번 돌리면 갱신된다.
- 없는 세션을 이어 가면 원격에서 찾다가 "No saved copy of session … was found"로 끝난다. 새 세션으로 다시 시작한다.
- stream의 `*_update` 이벤트는 같은 도구 호출의 진행 상황이라 세지 않는다. `available_commands`·`usage`·`thought`도 무시한다.
- 그록 자체 기억(`--no-memory`로 끔)·하위 에이전트(`--no-subagents`)는 GenCouncil 기억·위원 구조와 겹치므로 의장에게는 끈다.
