---
title: 위원 정지 후 남은 생성 스크립트 정리·사용자 중지 lock·로컬 GPU drain(/free 검증)
summary: council_stop_member로 위원을 멈춘 뒤에도 돌고 있는 일괄 생성 스크립트(부모 driver 포함)를 어떻게 찾고 멈추며, 사용자 지시로 멈춘 작업의 lock을 stale PID라고 지우거나 재개하면 안 되는 이유는 무엇이고, 로컬 GPU를 다른 앱에 돌려줄 때 ComfyUI 현재 잡 결과를 회수한 뒤 /free와 실제 VRAM 반환을 어떻게 확인하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
위원이 긴 일괄 생성을 세션과 떨어진 스크립트로 띄우면 council_stop_member 뒤에도 계속 돌아간다. 예: `py gen.py`, CIM `Win32_Process Create`로 띄운 구동기. 이런 스크립트는 그림을 계속 만들고 ComfyUI 큐에도 계속 넣는다.
그걸 모르고 새 위원을 띄우면 같은 일이 두 번 제출되거나 결과가 남의 worktree에 쓰인다. 사용자가 일부러 멈춘 작업은 프로세스가 없어도 다시 시작하지 않는다.

## 언제 쓰나
- 긴 일괄 생성(ComfyUI·RunPod 등)을 하던 위원을 멈추거나 다른 위원에게 넘길 때
- 이전 위원의 프로세스가 없고 lock·PID만 남아 있을 때
- 로컬 GPU를 게임·다른 앱에 돌려주려고 생성을 drain할 때

## 방법
### 남은 스크립트 찾아 멈추기
- 정지 직후 출력 폴더의 파일 수와 수정 시각을 확인한다. 계속 늘면 위원에게 맡긴다: "그 스크립트의 python만 종료 + 그 스크립트가 넣은 pending만 /queue delete. 서버·running·남의 요청은 건드리지 않음".
- 이어받은 위원은 시작하자마자 이전 위원의 프로세스를 확인한다:
  `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'run_pod|generate\.mjs' } | select ProcessId,Name,CommandLine`
  의장 지시가 있으면 `Stop-Process -Id <pid> -Force`로 끈다(python·node·cmd 래퍼).
- 제출기를 `subprocess.run` 등으로 관리하는 부모 driver가 있으면 부모 명령줄과 자식 PID를 먼저 확인하고, 부모 driver를 먼저 멈춘 뒤 그 제출기만 멈춘다(부모가 다시 띄우지 못하게). 실행 중 Python은 소스 파일을 고쳐도 drain 지시를 반영하지 않는다.
- 명령줄에 상대 경로만 있으면 스크립트 이름과 출력 파일 증가로 대상을 확인한다.
- 긴 일괄 작업 지시에는 미리 넣는다: "PID를 STATE.md에 기록, 정지 신호 파일(예: _work/STOP)이 있으면 다음 제출 전에 멈추는 루프".
- 정지한 위원이 ComfyUI 큐에 남긴 작업은 다음 위원에게 "이 작업 prefix의 pending만 /queue delete"로 정리를 허용한다.

### running 작업 결과 회수
- 서버에서 running인 작업은 그대로 두고, 원 endpoint·promptId로 `/history/<promptId>`에서 결과를 받는다. 원 claim·promptId·결과는 보존한다.
- 기존 프로젝트의 검증·fingerprint·완료 마커 형식을 재사용할 때는 회수용 HTTP 어댑터에서 `POST /prompt`와 upload를 막아 재제출 경로를 없앤다. timeout이나 응답 유실에도 claim은 유지한다.

### 사용자 중지 lock: stale PID여도 지우지 않는다
- 이전 위원의 프로세스가 없고 PID가 stale이라는 사실만으로 재개 권한이 생기지 않는다.
- 재개·lock 삭제 전에 작업 패킷, STATE/RESULT, 공유 중지 안내, 제어 기록의 시각·정책을 대조한다.
- 사용자 지시로 멈춘 lock은 PID가 없거나 작업이 끝났어도 명시적인 새 사용자 허가 전에는 지우지 않는다. 독점 worker lock을 쓰는 runner라면 정지 후 남은 lock을 의도적인 재시작 장벽으로 둔다.
- runner가 `lock.open('x')`를 쓰면 lock 안 PID가 살았는지와 상관없이 파일이 있다는 것 자체가 차단 장치다.
- 재개 금지 안내를 공유 번들에 기록한다.
- "로컬 GPU 사용 금지"면 생성뿐 아니라 GPU 인코딩·분석도 금지다.

### 로컬 GPU drain: 빈 큐에서만 /free, 실제 반환은 따로 확인
1. 위 순서로 제출기를 멈추고 running 결과·완료 마커를 보존한다.
2. `GET http://127.0.0.1:8188/queue`의 `queue_running`과 `queue_pending`이 모두 비었을 때만 `POST http://127.0.0.1:8188/free`에 JSON `{"unload_models":true,"free_memory":true}`를 보낸다. 설치된 ComfyUI가 이 API를 지원하는지 server.py/main.py에서 먼저 확인한다.
3. `/free`의 HTTP 200은 플래그 접수일 뿐 해제 완료가 아니다. 보내기 전후로 `/system_stats`와 `nvidia-smi --query-gpu=timestamp,name,memory.used,memory.free,memory.total,utilization.gpu --format=csv`를 대조해 실제 VRAM 반환을 기록한다.
4. WDDM에서는 프로세스별 used_gpu_memory가 N/A일 수 있으니 장치 전체 통계와 ComfyUI 통계를 함께 쓴다.

## 주의할 점
- 이전 위원이 남긴 subst 드라이브는 쓰지 않는다.
- 명령줄 패턴으로 한꺼번에 종료하면 남의 프로세스까지 죽일 수 있다. 자기 PID만 끈다.
- GPU 전체 사용량을 이유로 ComfyUI 서버·게임·다른 앱·다른 큐·포드를 종료하지 않는다.
- lock 제거·자동 재개는 사용자 지시 범위를 확인한 뒤에만 한다.
- RunPod 프록시는 파이썬 urllib 기본 User-Agent에 403을 낸다. UA를 지정한다.
