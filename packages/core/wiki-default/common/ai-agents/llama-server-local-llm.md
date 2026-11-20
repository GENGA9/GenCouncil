---
title: 로컬 LLM(llama-server) 띄우기·VRAM 배치·반복 루프 감지
summary: llama-server로 16GB GPU에 27B GGUF를 어떤 인자로 띄우고, 같은 구절을 반복해 JSON이 깨질 때 어떻게 감지하고 재시도하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
llama.cpp `llama-server`로 로컬 LLM을 돌릴 때의 기동 인자와 반복 루프 대응이다. 16GB GPU에선 `-ngl 99`를 주지 말고 자동 배치에 맡긴다(넘치면 Windows가 공유 메모리로 조용히 스필해 느려질 뿐 크래시가 없다).
Qwen3.5 비사고 모드(temp 0.7/top_p 0.8)는 약 1/20 확률로 같은 구절을 반복해 max_tokens까지 채우고 JSON이 깨진다(50~90초 낭비). 스트리밍으로 받으며 꼬리를 검사해 끊고 다시 요청한다.

## 언제 쓰나
- 16GB GPU에 27B급 GGUF를 띄울 때, 또는 tok/s가 1~7로 느릴 때
- llama-server로 구조화 출력(JSON)을 받는 백엔드를 만들 때

## 방법
### 기동 인자 (RTX 5070 Ti 16GB 실측)
- `-ngl 99`는 자동 배치를 끈다(로그 `common_fit_params: … n_gpu_layers already set by user`).
- 27B IQ3_M+mmproj: `-ngl` 없이 `-c 20480 -ub 512 --cache-type-k q8_0 --cache-type-v q8_0 -fa on --jinja` → 44~46 tok/s. IQ4_XS(14.7GB)는 불가.
- 9B Q6_K: `-c 32768 -ngl 99` 약 89 tok/s.
- Qwen3.8-27B GGUF(IQ3_M+mmproj f16, orcarouter 무검열판 포함): 카드는 최신 llama.cpp(MTP) 필요라고 적혀 있지만 b12110 Windows CUDA가 그대로 로드한다(로그 `blk.64.nextn.* unused tensor … ignoring`은 MTP 헤드만 무시). 같은 인자로 약 44 tok/s, VRAM 최대 15.3GB, 로드 72~96초 → 모델·mmproj 경로만 바꾸면 된다. 프롬프트 재작성 품질은 3.5와 오차 범위.
- 같은 GPU의 ComfyUI가 모델을 쥐고 있으면 급감 → `POST :8188/free {"unload_models":true,"free_memory":true}` 후 로드.

### 반복 루프 감지·재시도
- `stream:true`로 받으며 64자마다 꼬리 검사: 길이 1~400 덩어리가 꼬리에서 `max(4, ceil(300/len))`번 연속이면 루프 → 연결을 끊고 1회 재요청, 또 루프면 오류.
- 정확 반복이 아닌 루프는 `finish_reason=="length"`를 실패로 보고 재시도한다(`max_tokens`는 성공 최대치보다 조금 크게, 약 3000).
- 사고 끄기: `chat_template_kwargs:{"enable_thinking":false}`(--jinja 필요).

## 주의할 점
- tok/s와 nvidia-smi를 같이 본다(스필은 오류 없이 느려지기만 한다).
- 기동 전 포트 점유를 확인한다(남의 서버를 health 응답으로 착각할 수 있다).
