---
title: 코덱스(GPT) 주간 사용량 직접 확인: ~/.codex/sessions rollout jsonl의 rate_limits.used_percent
summary: 코덱스 $imagegen 등으로 일할 때 "GPT 주간 N% 남음" 예산을 지키려면 사용량을 화면 없이 어디서 읽고, 리셋 시각과 장당 소모는 어떻게 가늠하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
코덱스 사용량을 볼 화면·명령은 없지만, `codex exec`를 돌릴 때마다 생기는 세션 로그에 주간 사용률이 들어 있다. 위원이 그림 생성 도중 예산을 직접 확인할 때 쓴다.

## 언제 쓰나
- 코덱스 $imagegen으로 그림을 여러 장 그리면서 "GPT 주간 N%까지만" 같은 예산을 지켜야 할 때
- 예산 계획을 세우거나 다시 잡을 때

## 방법
- 로그 위치: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. token_count 이벤트에 `"rate_limits":{"primary":{"used_percent":81.0,"window_minutes":10080,"resets_at":<unix>}}`가 있다(window 10080분 = 주간).
- 리셋 시각: `date -d @<resets_at 값>`.
- 오늘 최근 세션 몇 개의 값 보기:
```bash
for f in $(ls -t ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl | head -6); do echo "$(basename $f) $(grep -o '"used_percent":[0-9.]*' "$f" | tail -1)"; done
```

## 주의할 점
- 가장 최근 파일은 아직 값이 없을 수 있다(진행 중) → 값이 있는 최근 몇 개를 본다.
- 값은 세션 시작 시점이라 그림 한 장만큼 늦게 반영된다.
- 장당 소모는 처음 몇 장 그린 뒤 이 값으로 다시 잡는다. 실측 예(prolite 플랜, 16:9 그림 약 26장 + 거절 1회): 주간 81% → 84%, 장당 약 0.12%(이전 추정 0.35%보다 훨씬 쌌다).
