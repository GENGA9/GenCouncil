---
title: OpenCode CLI(@opencode/cli V2) 설치·EXAONE 공급자 설정·비대화형 실행·429 무한 재시도 정체 (Windows)
summary: Windows에 OpenCode CLI를 설치하고 EXAONE(OpenAI 호환 API, k-exaone_v2.5)을 공급자로 설정해 opencode run으로 비대화형 작업을 돌리려면 어떤 패키지(V1 opencode-ai와 V2 @opencode/cli 차이)와 설정 키·명령을 쓰고, EXAONE 429로 opencode가 출력 없이 멈추거나 PowerShell에서 실행·JSON 파싱이 실패할 때 어떻게 하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
OpenCode CLI는 npm에 `opencode-ai`(V1, 1.19.x)와 `@opencode/cli`(V2, 2.x) 두 패키지가 있고 설정 스키마가 다르다. 공식 문서(opencode.ai/docs, docs.exaone.ai/ko/docs/agent-start)는 V2를 안내한다. 여기서는 V2로 EXAONE을 공급자로 붙이는 법과 스크립트에서 돌릴 때의 함정을 적는다.

## 언제 쓰나
- Windows에서 OpenCode로 EXAONE(K-EXAONE) 모델을 에이전트로 돌릴 때
- 스크립트에서 OpenCode를 비대화형으로 실행하고 결과·토큰 사용량을 JSON으로 받을 때
- opencode run이 아무 출력 없이 멈춰 있을 때(EXAONE 429)

## 방법
### 설치
- `npm install -g @opencode/cli` → `opencode --version`(v2.2.7 확인). postinstall 차단 경고는 무시해도 된다.

### V2 설정 키 (V1과 다름)
- V2: `providers`(+`package`, `settings`), `permissions`(배열), `mcp.servers.<이름>`.
- V1의 `provider`/`permission`/`bash` 키는 V2에서 쓰지 않는다.

### EXAONE 공급자 설정
- 전역 설정 파일: `%USERPROFILE%\.config\opencode\opencode.json`.
- `providers.exaone`:
```json
{
  "package": "@opencode/ai/providers/openai-compatible",
  "settings": { "baseURL": "https://api.exaone.ai/v1", "apiKey": "{env:EXAONE_API_KEY}" },
  "models": {
    "k-exaone_v2.5": {
      "capabilities": { "tools": true, "reasoning": { "supported": true } },
      "compatibility": { "reasoningField": "reasoning_content" },
      "body": { "reasoning_effort": "medium" }
    }
  }
}
```
- 키는 사용자 환경변수 `EXAONE_API_KEY`에 둔다(새 셸에서 적용 — [Windows 환경변수 함정](common/windows/windows-environment-variables)). 설정 파일에 키를 직접 쓰지 않는다.
- 확인: `opencode models`에 `exaone/k-exaone_v2.5`가 보이면 성공.

### 비대화형 실행
- `opencode run --standalone --auto --format json --model exaone/k-exaone_v2.5 "프롬프트"`
  - cwd가 작업 폴더다.
  - `--auto`: 거부되지 않은 권한을 자동 승인.
  - `--standalone`: 환경변수를 쓰는 전용 서버로 실행.
- 이어 하기: `-c`(마지막 세션) 또는 `-s <ID>`.
- JSON 이벤트는 step_start/text/step_finish이고, 토큰 사용량은 `step_finish.part.tokens`에 있다.

### 스크립트(PowerShell 드라이버)에서 돌릴 때
- `Start-Process`로 opencode를 직접 실행하면 실패한다(opencode는 `.cmd`다). PowerShell에서 `opencode run ... $task`를 직접 호출하거나 `cmd /c`로 실행한다.
- JSON 출력 첫 줄에 BOM이 붙는다 → 파싱 전에 BOM을 제거한다.
- EXAONE이 `too many concurrent requests(600)` 429를 주면 opencode가 무한 재시도하며 stdout에 이벤트가 하나도 안 나온 채 멈춘다 → 드라이버에 '진행 없음' 타임아웃(일정 시간 새 이벤트가 없으면 종료)을 둔다.

## 주의할 점
- 블로그·예전 글의 V1(`opencode-ai`) 설정 예시를 V2에 그대로 넣으면 키가 맞지 않는다.
- EXAONE API 사용 한도는 구현 전에 확인한다([새 외부 LLM·무료 API 한도](common/ai-agents/external-api-rate-limits)).
