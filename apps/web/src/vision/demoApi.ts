// Canned answers for the pages the demo opens over the picture (wiki, memory, accounts, settings),
// so /vision-demo.html works with no server. Dev only: nothing in the app imports this.
import type { Account, CurateStatus, MemoryHit, ModelsInfo, UsageSnapshot, WikiPage } from "../types";

const now = new Date().toISOString();

export const DEMO_ACCOUNTS: Account[] = [
  { id: "claude", provider: "claude", status: "ok", lastUsed: now },
  { id: "claude-b", provider: "claude", status: "exhausted", configDir: "~/.gencouncil/accounts/claude-b", resetAt: new Date(Date.now() + 3 * 3600e3).toISOString(), note: "회사 계정" },
  { id: "gpt", provider: "gpt", status: "ok", lastUsed: now },
  { id: "gemini", provider: "gemini", status: "ok" },
  { id: "aistudio-1", provider: "aistudio", status: "ok", configDir: "~/.gencouncil/accounts/aistudio-1", loginOpenedAt: now },
];

const page = (path: string, title: string, summary: string, body: string): WikiPage => ({
  path,
  title,
  summary,
  body,
  updated: now,
  by: "chair",
  sources: [],
  section: path.split("/").slice(0, -1).join("/"),
  chars: body.length,
  history: [{ commit: "a1b2c3d", date: now, subject: `wiki: ${title}` }],
});

const PAGES: WikiPage[] = [
  page("common/git/index", "Git 작업 규칙", "안건 브랜치와 위원 브랜치를 다루는 법", "## 이 폴더\n\n안건·위원 브랜치 규칙을 모았습니다."),
  page(
    "common/git/merge-conflicts",
    "머지 충돌 풀기",
    "위원 결과를 안건 브랜치에 합칠 때 충돌이 나면 의장이 통합 폴더에서 푼다.",
    "## 언제\n\n위원 두 명이 **같은 파일**을 고쳤을 때 난다.\n\n## 순서\n\n1. 통합 작업 폴더에서 `git status`로 충돌 파일을 본다\n2. 두 결과를 모두 읽고 의도를 살려 합친다\n3. 테스트를 돌린 뒤 커밋한다\n\n```bash\ngit status\nnpm test\ngit commit -am \"merge: resolve\"\n```\n\n> 한쪽을 통째로 버리지 않는다. 버려야 하면 이유를 state.md에 적는다.\n\n| 상황 | 할 일 |\n| --- | --- |\n| 같은 줄 수정 | 둘의 의도를 합친다 |\n| 파일 이동 | 이동한 쪽을 따른다 |\n\n관련: [브랜치 이름](common/git/branch-names)",
  ),
  page("common/git/branch-names", "브랜치 이름", "agenda/<프로젝트>/<안건>/<위원>", "## 규칙\n\n- 안건: `agenda/<project>/<slug>`\n- 위원: 안건 브랜치 뒤에 `/<member-id>`"),
  page("models/claude", "Claude 성향", "길고 얽힌 설계·디버깅에 강하다", "## 요약\n\nOpus는 어려운 설계에, Sonnet은 주력 구현에 쓴다."),
  page("models/gpt", "GPT 성향", "좁고 명확한 작업을 빠르게 끝낸다", "## 요약\n\nSol은 주력, Terra는 문서·기계적 작업."),
  page("projects/demo/index", "데모 프로젝트", "결제 시스템 개편", "## 개요\n\n결제 모듈을 새 구조로 옮긴다."),
  page("projects/demo/payments", "결제 모듈 구조", "PaymentGateway 인터페이스와 호출부", "## 구조\n\n`PaymentGateway`를 통해서만 결제사를 부른다."),
];

const hit = (id: string, title: string, type: string, status: string, extra: Partial<MemoryHit> = {}): MemoryHit => ({ id, title, type, status, tags: ["demo"], updated: now, scope: "common", ...extra });
const PROPOSALS: MemoryHit[] = [
  hit("sol-1", "Vite 개발 서버에서 고친 코드가 안 보일 때: 서비스워커 캐시", "solution", "proposed", { source: "claude-3", snippet: "서비스워커를 해제하고 캐시를 지운다…", project: "demo", scope: "project" }),
  hit("con-1", "위원 브랜치는 안건 브랜치에서만 딴다", "convention", "proposed", { source: "chair" }),
  hit("per-1", "Sol은 범위를 좁혀 주면 빠르다", "persona", "proposed", { source: "chair" }),
];
const RECENT: MemoryHit[] = [
  hit("tool-1", "esbuild로 테스트용 번들 만들기", "tool", "verified", { snippet: "apps/web/test/*.mjs 가 쓰는 방법" }),
  hit("acc-1", "Gemini CLI는 이 PC에서 계정 하나만 쓴다", "account", "verified"),
];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function installDemoApi(models: ModelsInfo, usage: UsageSnapshot): void {
  const real = window.fetch.bind(window);
  const idle: CurateStatus = { running: false };
  // Gemini (Antigravity CLI) starts off, as on a fresh install
  let gemini: { enabled: boolean; acceptedAt?: string } = { enabled: false };
  const defaults = Object.fromEntries(models.providers.map((p) => [p.id, { maxMembers: 3, maxModel: p.models[p.models.length - 2]?.id, maxEffort: "high" }]));
  const withDetails: UsageSnapshot = {
    ...usage,
    items: usage.items.map((u) =>
      u.provider === "gemini"
        ? { ...u, details: [{ group: "Gemini 4", label: "Gemini 4 Neon", usedPct: 24 }, { group: "Gemini 4", label: "Gemini 4 Argon", usedPct: 71 }] }
        : { ...u, weekly: u.weekly && { ...u.weekly, resetsAt: new Date(Date.now() + 52 * 3600e3).toISOString() } },
    ),
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return real(input, init);
    const path = url.pathname.slice(5);
    const method = (init?.method ?? "GET").toUpperCase();
    const meta = PAGES.map(({ body: _body, history: _history, ...m }) => m);
    if (path === "wiki" && method === "GET") return json(meta);
    if (path === "wiki/status") return json({ proposals: PROPOSALS.length, unmigrated: 2, pages: PAGES.length, changed: 4, lastReview: now });
    if (path === "wiki/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(PAGES.filter((p) => `${p.title} ${p.summary} ${p.body}`.toLowerCase().includes(q)).map((p) => ({ ...p, score: 1, snippet: p.summary })));
    }
    if (path === "wiki/page" && method === "GET") {
      const p = PAGES.find((x) => x.path === url.searchParams.get("path"));
      return p ? json(p) : json({ error: "없는 페이지입니다" }, 404);
    }
    if (path === "wiki/page" && method === "PUT") return json({ ...PAGES[0], ...(JSON.parse(String(init?.body ?? "{}")) as object) });
    if (path === "memory/curate" || path === "memory/tidy" || path === "memory/reorganize") return json(idle);
    if (path === "memory/proposals") return json(PROPOSALS);
    if (path === "memory/recent") return json(RECENT);
    if (path === "memory/stats") return json({ verified: 14, common: 9, byProject: { demo: 5 } });
    if (path === "memory/search") return json([...PROPOSALS, ...RECENT].filter((h) => h.title.toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase())));
    if (path.startsWith("memory/entry/")) {
      const id = decodeURIComponent(path.split("/")[2] ?? "");
      const h = [...PROPOSALS, ...RECENT].find((x) => x.id === id);
      if (method !== "GET") return json({ ok: true });
      return h ? json({ ...h, body: "## 문제\n\n고친 코드가 화면에 나오지 않는다.\n\n## 해결\n\n서비스워커를 해제하고 캐시를 지운다.\n\n## 적용 방법\n\n개발 서버를 볼 때마다 확인한다." }) : json({ error: "없는 기억입니다" }, 404);
    }
    if (path === "settings/gemini") {
      if (method === "PUT") {
        const b = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean; accept?: boolean };
        if (b.enabled && !b.accept) return json({ error: "위험 고지에 동의해야 합니다." }, 400);
        gemini = b.enabled ? { enabled: true, acceptedAt: new Date().toISOString() } : { ...gemini, enabled: false };
      }
      return json(gemini);
    }
    if (path === "accounts" && method === "GET") return json(DEMO_ACCOUNTS.map((a) => (a.provider === "gemini" && !gemini.enabled ? { ...a, status: "disabled" } : a)));
    if (path === "usage") return json(withDetails);
    if (path === "models") return json({ ...models, efforts: ["low", "medium", "high", "xhigh", "max"], defaults });
    if (/^projects\/[^/]+\/guidelines$/.test(path)) return method === "GET" ? json({ text: "# 업무 분장 가이드라인\n\n- 설계·어려운 디버깅: Opus\n- 주력 구현: Sonnet, Sol\n- 문서·기계적 정리: Terra, Flash\n", path: "D:\\work\\demo\\.gencouncil\\guidelines.md" }) : json({ ok: true });
    if (/^projects\/[^/]+\/settings$/.test(path)) return json({});
    if (path === "fs") return json({ path: "D:\\work", parent: "D:\\", roots: [{ name: "D:", path: "D:\\" }], entries: [{ name: "demo", path: "D:\\work\\demo", git: true }, { name: "other", path: "D:\\work\\other" }] });
    return json({ error: "데모에는 없는 기능입니다" }, 404);
  };
}
