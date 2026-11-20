---
title: FastAPI·Starlette 함정: FileResponse 304(ETag) 직접 처리·Form 기본값 생략 감지
summary: FastAPI FileResponse가 If-None-Match에 304를 주지 않을 때 어떻게 직접 처리하고 캐시 헤더를 정하며, 기본값 있는 Form 필드를 클라이언트가 보냈는지 어떻게 아나?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
FastAPI(Starlette)에서 문서만 보고 기대한 동작과 실제가 다른 두 가지다. `FileResponse`는 ETag/Last-Modified를 보내지만 조건부 요청에 304를 주지 않고(StaticFiles만 처리), 기본값 있는 Form 필드는 클라이언트가 보냈는지 구분할 수 없다.

## 언제 쓰나
- 인증이 필요한 파일(이미지·영상)을 FileResponse로 주면서 브라우저 캐시를 살리고 싶을 때
- Form 필드의 "생략"과 "기본값과 같은 값 전송"을 구분해야 할 때

## 방법
### FileResponse 304 직접 처리
- starlette 0.46은 헤더를 전송 시점에 채운다 → 생성 직후 `headers["etag"]`가 비어 있어 거기서 읽을 수 없다.
- `path.stat()`로 직접 계산: etag `'"'+md5(f"{st_mtime}-{st_size}")+'"'`, Last-Modified `formatdate(st_mtime, usegmt=True)`.
- If-None-Match를 우선 비교(W/ 접두·콤마 목록·`*` 처리), 없으면 If-Modified-Since 비교 → 일치하면 `Response(status_code=304, headers=같은 헤더)`, 아니면 `FileResponse(path, headers=..., stat_result=stat)`.
- 캐시 헤더: 인증 파일은 `private, max-age=…, immutable`만(public/s-maxage 금지), 오류 응답은 `no-store`.
- Next 프록시를 거치면 조건 헤더를 백엔드로 전달하고, 304는 `new Response(null,{status:304})`로 돌려준다([서버 토큰을 붙이는 Next 프록시](common/web/nextjs-proxy-auth)).
- 확인: fetch는 304를 200으로 숨긴다 → CDP `encodedDataLength`(약 300 B)나 서버 로그로 본다([Chrome CDP로 브라우저 상태 검사](common/web/chrome-cdp-checks)).

### Form 기본값 필드를 보냈는지 감지
- 기본값 있는 Form 필드(예: `aspect_ratio="1:1"`)는 클라이언트가 보냈는지 알 수 없다.
- 같은 alias로 `Form(alias="aspect_ratio")=None` 필드를 하나 더 선언하지 않는다. 두 필드가 기본값을 공유해 오동작한다.
- 핸들러에서 `(await request.form()).keys()`로 실제 전송 여부를 판정한다.

## 주의할 점
- 304 응답에도 200과 같은 ETag·Cache-Control 헤더를 넣는다.
