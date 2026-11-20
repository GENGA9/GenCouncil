---
title: Python 표준 라이브러리만으로 로컬 웹 앱 서버: 업로드·keep-alive 오류 응답·CSRF·테스트
summary: fastapi 없이 Python 3.13+ http.server로 로컬 웹 앱을 만들 때 cgi 없이 업로드를 어떻게 받고, Windows에서 거절 응답이 WinError 10053으로 끊기는 것과 CSRF·DNS 리바인딩을 어떻게 막으며, 어떻게 테스트하나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
Python 3.13부터 `cgi`가 제거돼 표준 라이브러리로는 multipart를 풀 수 없다. 업로드는 raw 바이트 POST로 받는다.
`ThreadingHTTPServer`+HTTP/1.1에서는 오류 응답 때 연결을 닫고 남은 본문을 조심해서 비워야 클라이언트가 오류 JSON을 읽는다.

## 언제 쓰나
- 의존성 없이 로컬(127.0.0.1) 웹 도구·앱 서버를 만들 때

## 방법
### 업로드
- raw 바이트 POST(`application/octet-stream`, `?name=`) → Content-Length만큼 읽고 파일명 정리·매직바이트 검사.
- `<video>` 재생에는 Range(206) 응답이 필요하다.

### 오류 응답과 keep-alive (Windows WinError 10053)
- POST를 본문 읽기 전에 거절하고 닫으면 클라이언트가 간헐적으로 WinError 10053을 받아 오류 JSON을 못 읽는다.
- 오류 응답 때 `self.close_connection = True`(남은 본문이 다음 요청을 깨뜨림).
- 거절 응답은 Content-Length가 하나·숫자·작은 상한(예: 8192) 이내이고 Transfer-Encoding이 없을 때만 짧은 timeout(0.2초)으로 남은 본문을 비운 뒤 응답·close한다. 읽음 플래그로 이중 읽기를 막고, 무제한 drain은 하지 않는다.
- 브라우저 종료로 나는 ConnectionResetError/BrokenPipeError는 Handler.handle에서 연결 종료로 처리한다.

### CSRF·DNS 리바인딩
- POST는 Content-Type json·octet-stream만 받는다.
- Host는 127.0.0.1/localhost만 받는다.

### 테스트
- 경로 탈출 테스트는 `http.client`로 원시 경로(`..%5c`, `%2e%2e`)를 보낸다.
- 서버는 포트 0으로 띄운다.
- 외부 CLI는 환경변수로 가짜 스크립트로 교체하고, 호출 기록은 호출마다 파일 하나로 남긴다(병렬 이어쓰기는 줄이 섞임).

## 주의할 점
- FastAPI를 쓸 수 있으면 [FastAPI·Starlette 함정](common/python/fastapi-starlette-pitfalls)도 본다.
