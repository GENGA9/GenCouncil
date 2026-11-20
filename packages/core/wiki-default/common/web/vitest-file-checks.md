---
title: vitest에서 파일 존재·내용 확인: import.meta.glob·?raw·CSS 빈 문자열
summary: @types/node 없는 vitest 프로젝트에서 그림 파일이 있는지, 소스·CSS 파일 내용이 무엇인지 테스트로 어떻게 확인하나(CSS ?raw가 빈 문자열일 때)?
updated: 2026-11-20T00:00:00.000Z
by: gencouncil-default
---
vitest 테스트에선 그림이 로딩되지 않아 아이콘 함수가 대체 모양을 내고, `node:fs` import는 @types/node가 없으면 tsc가 실패한다. 파일 존재는 `import.meta.glob`, 소스 내용은 `?raw`로 확인한다. 단 CSS는 `?raw`·`?inline`이 빈 문자열이 된다.

## 언제 쓰나
- 그림(PNG) 파일이 번들에 있는지 테스트로 확인할 때
- 소스의 경로 문자열·CSS 규칙을 테스트로 검사할 때

## 방법
### 그림 파일 존재
- `import.meta.glob('/art*/ui/x.png', { eager: true, query: '?url', import: 'default' })`

### 소스 파일 원문
- `import src from '../src/x.ts?raw'`로 소스의 경로 문자열을 검사한다(`.ts`의 `?raw`는 정상).

### CSS 파일 원문: ?raw·?inline은 ""
- vitest는 `css.include`에 없는 CSS를 비워 넘긴다 → `expected '' to match` 오류가 보이면 이 문제다.
- 한 파일이면: `(globalThis as any).process.getBuiltinModule('node:fs').readFileSync('src/styles/x.css','utf8')`(Node 22.3+, 타입 오류 없음).
- 여럿이면 vitest 설정 `css: { include: [...] }`(프로젝트 전체에 영향, 따로 검토).

## 주의할 점
- 다른 위원이 그림을 만드는 중이면 그림 유무를 단정하는 테스트를 쓰지 않는다([병렬 위원 작업을 합칠 때](common/council-merge/council-parallel-merge)).
- Vite 자체 함정은 [Vite 함정](common/web/vite-pitfalls).
