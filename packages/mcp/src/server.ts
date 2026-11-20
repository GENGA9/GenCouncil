#!/usr/bin/env node
/**
 * GenCouncil MCP server (stdio).
 *
 * Env:
 *   GENCOUNCIL_HOME   data root (default ~/.gencouncil)
 *   GENCOUNCIL_ROLE   owner | chair | member   (default member)
 *                     owner/chair may write/approve directly; member can only propose.
 *   GENCOUNCIL_AGENT  label recorded as `source` on entries (e.g. claude-code, gemini-cli)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENTRY_TYPES, LONG_PAGE, MemoryStore, WikiStore, normalizeWikiPath, pageOutline, pageSection, type EntryType, entryScope } from "@gencouncil/core";

type Role = "owner" | "chair" | "member";

/** per-process counters for one curator run (one MCP server process per run) */
const session = { writes: 0, retires: 0, prunes: 0, wikiRemoves: 0 };

function role(): Role {
  const r = (process.env.GENCOUNCIL_ROLE ?? "member").toLowerCase();
  return r === "owner" || r === "chair" ? r : "member";
}

function agent(): string {
  return process.env.GENCOUNCIL_AGENT ?? `${role()}@unknown`;
}

const canWrite = () => role() !== "member";

const typeSchema = z.enum(ENTRY_TYPES);

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function json(v: unknown) {
  return text(JSON.stringify(v, null, 2));
}

export async function createServer(store: MemoryStore, wiki: WikiStore = new WikiStore()): Promise<McpServer> {
  const server = new McpServer({ name: "gencouncil", version: "0.1.0" });

  server.registerResource(
    "memory-index",
    "gencouncil://memory/index",
    {
      title: "Space Memory Index",
      description: "Compact index of all verified shared-memory entries.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: store.renderIndex() }] }),
  );

  server.registerTool(
    "memory_index",
    {
      title: "Memory index",
      description:
        "Return the compact index (id + title + tags) of all verified Space memory entries. " +
        "Call this once at the start of a task to see what is already known.",
      inputSchema: { project: z.string().optional().describe("Show only this project's own entries after the common ones (default: your project)") },
    },
    async ({ project }) => text(store.renderIndex({ project: project ?? (process.env.GENCOUNCIL_PROJECT || undefined) })),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Full-text search over Space memory (solutions, tool locations, conventions, account notes, AI personas). " +
        "Korean and English both work. Use this BEFORE solving a problem from scratch.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords or a short sentence describing the problem"),
        type: typeSchema.optional().describe("Restrict to one entry type"),
        project: z.string().optional().describe("Restrict to entries tagged with this project"),
        scope: z.enum(["common", "project"]).optional().describe("common = reusable everywhere, project = project-only facts"),
        limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 10)"),
        include_proposed: z
          .boolean()
          .optional()
          .describe("Also search entries that are proposed but not yet approved"),
      },
    },
    async ({ query, type, project, scope, limit, include_proposed }) => {
      const hits = store.search(query, {
        type: type as EntryType | undefined,
        project,
        scope,
        limit,
        status: include_proposed ? "any" : "verified",
      });
      if (hits.length === 0) return text(`No memory entries match "${query}".`);
      return json(hits);
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read memory entry",
      description: "Read one memory entry in full (frontmatter + markdown body) by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const e = store.get(id);
      if (!e) return err(`not found: ${id}`);
      return json({ ...e.meta, body: e.body, file: e.file });
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memory entries",
      description: "List entries by type / status / project, newest first.",
      inputSchema: {
        type: typeSchema.optional(),
        status: z.enum(["verified", "proposed", "rejected", "any"]).optional().describe("default: any"),
        project: z.string().optional(),
        scope: z.enum(["common", "project"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ type, status, project, scope, limit }) =>
      json(
        store
          .list({ type: type as EntryType | undefined, status, project, scope, limit })
          .map((m) => ({
            id: m.id,
            title: m.title,
            type: m.type,
            status: m.status,
            tags: m.tags,
            project: m.project,
            scope: entryScope(m),
            source: m.source,
            updated: m.updated,
          })),
      ),
  );

  const newEntryShape = {
    title: z.string().min(3).describe("One-line summary. Write it as the thing you would search for later."),
    type: typeSchema.describe("solution | tool | convention | account | persona"),
    body: z
      .string()
      .min(10)
      .describe(
        "Markdown. For a solution use sections: ## 문제 / ## 해결 / ## 적용 방법 (commands, paths, gotchas).",
      ),
    tags: z.array(z.string()).optional().describe("Lowercase keywords: tool names, error names, domains"),
    project: z.string().optional().describe("Project key (repo folder name) this came from"),
    scope: z
      .enum(["common", "project"])
      .optional()
      .describe(
        "common: any project can reuse it (how to use a shared tool, a procedure for an outside service, environment quirks, model behaviour). " +
          "project: only true for this project's code/data/domain. Default: project when project is set.",
      ),
  };

  server.registerTool(
    "memory_propose",
    {
      title: "Propose memory entry",
      description:
        "Propose a new reusable memory (lands in proposals/ until the owner or chair approves). " +
        "Use when you solved something non-obvious that will come up again, found where a tool lives, or learned a convention. " +
        "Not for the fix of one specific bug or the result of this task: those are in the code and git history.",
      inputSchema: newEntryShape,
    },
    async (input) => {
      const e = store.propose({ ...input, source: agent() });
      return text(`proposed ${e.meta.id} -> ${e.file}`);
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "Write memory entry (owner/chair)",
      description:
        "Directly add a verified memory entry. Only allowed when GENCOUNCIL_ROLE is owner or chair; " +
        "members get an error and should use memory_propose instead.",
      inputSchema: newEntryShape,
    },
    async (input) => {
      if (!canWrite()) return err(`role ${role()} cannot write directly; use memory_propose`);
      const e = store.write({ ...input, source: agent() });
      session.writes++;
      return text(`written ${e.meta.id} -> ${e.file}`);
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update memory entry (owner/chair)",
      description:
        "Edit an existing entry. Prefer `append` to add new findings under a dated heading; " +
        "use `body` only to rewrite. owner/chair only.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        body: z.string().optional().describe("Replace the whole body"),
        append: z.string().optional().describe("Append under '## 추가 (date)'"),
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
        scope: z.enum(["common", "project"]).optional(),
      },
    },
    async ({ id, ...patch }) => {
      if (!canWrite()) return err(`role ${role()} cannot update; use memory_propose with a new entry`);
      try {
        const e = store.update(id, patch);
        return text(`updated ${e.meta.id}`);
      } catch (ex) {
        return err(String((ex as Error).message));
      }
    },
  );

  server.registerTool(
    "memory_approve",
    {
      title: "Approve proposal (owner/chair)",
      description: "Move a proposed entry into the verified memory. owner/chair only.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      if (!canWrite()) return err(`role ${role()} cannot approve`);
      try {
        const e = store.approve(id, { source: agent() });
        return text(`approved ${e.meta.id} -> ${e.file}`);
      } catch (ex) {
        return err(String((ex as Error).message));
      }
    },
  );

  server.registerTool(
    "memory_reject",
    {
      title: "Reject proposal (owner/chair)",
      description: "Mark a proposed entry as rejected (kept in proposals/ for the record). owner/chair only.",
      inputSchema: { id: z.string().min(1), reason: z.string().optional() },
    },
    async ({ id, reason }) => {
      if (!canWrite()) return err(`role ${role()} cannot reject`);
      try {
        const e = store.reject(id, reason);
        return text(`rejected ${e.meta.id}`);
      } catch (ex) {
        return err(String((ex as Error).message));
      }
    },
  );

  server.registerTool(
    "memory_retire",
    {
      title: "Retire a verified entry (owner)",
      description:
        "Take a verified entry out of use because it was merged into another entry (merged_into), is outdated/wrong, " +
        "is a one-off record (reason starts with 일회성), or is an old solution replaced by a newer entry (reason starts with 대체됨, merged_into the newer entry). It is kept with the rejected records and memory_approve restores it. owner/chair only.",
      inputSchema: { id: z.string().min(1), reason: z.string().min(3), merged_into: z.string().optional() },
    },
    async ({ id, reason, merged_into }) => {
      if (!canWrite()) return err(`role ${role()} cannot retire`);
      // a split retires the bundle only after writing its parts: no knowledge leaves, so it is not budgeted
      const isSplit = /^분할/.test(reason.trim()) && !merged_into && session.writes >= 2;
      const budget = Number(process.env.GENCOUNCIL_RETIRE_BUDGET ?? "");
      // one-off records, and old solutions folded into the entry that replaced them, are cut on their
      // own larger budget, so merges of live knowledge stay capped
      const pruneBudget = Number(process.env.GENCOUNCIL_PRUNE_BUDGET ?? "");
      const r = reason.trim();
      const isPrune =
        ((/^일회성/.test(r) && !merged_into) || (/^대체됨/.test(r) && !!merged_into)) && Number.isFinite(pruneBudget) && pruneBudget > 0;
      if (isPrune && session.prunes >= pruneBudget)
        return err(`이번 정리에서 일회성·대체된 항목 정리는 ${pruneBudget}개까지만 된다. 나머지는 다음 정리에 맡긴다.`);
      if (!isSplit && !isPrune && Number.isFinite(budget) && budget > 0 && session.retires >= budget)
        return err(`이번 정리에서 합치기·삭제는 ${budget}개까지만 된다(이미 ${session.retires}개). 더 합치지 말고 나누기·줄이기만 한다.`);
      try {
        const e = store.retire(id, reason, merged_into);
        if (isSplit) session.writes -= 2;
        else if (isPrune) session.prunes++;
        else session.retires++;
        return text(`retired ${e.meta.id}${merged_into ? ` (merged into ${merged_into})` : ""}`);
      } catch (ex) {
        return err(String((ex as Error).message));
      }
    },
  );

  if (canWrite()) {
    server.registerTool(
      "memory_to_wiki",
      {
        title: "Mark a memory entry as moved into the wiki (owner)",
        description:
          "공유 기억 항목(제안 또는 승인된 항목)의 내용을 위키 페이지에 옮긴 뒤 부른다. 그 페이지가 있고 페이지의 sources에 이 id가 들어 있어야 한다(wiki_write의 sources). " +
          "항목은 '위키 등록: <path>' 기록과 함께 보관함으로 간다(memory_approve로 되살릴 수 있다). 정리 한도에 세지 않는다.",
        inputSchema: { id: z.string().min(1), path: z.string().min(1).describe("내용을 옮긴 위키 페이지 경로") },
      },
      async ({ id, path: p }) => {
        try {
          const page = wiki.read(p);
          if (!page) return err(`위키 페이지가 없다: ${p}. 먼저 wiki_write로 내용을 옮긴다.`);
          if (!page.sources.includes(id)) return err(`${page.path}의 sources에 ${id}가 없다. wiki_write(sources에 이 id 포함)로 페이지를 저장한 뒤 다시 부른다.`);
          const e = store.get(id);
          if (!e) return err(`기억 항목이 없다: ${id}`);
          const reason = `위키 등록: ${page.path}`;
          if (e.meta.status === "proposed") store.reject(id, reason);
          else if (e.meta.status === "verified") store.retire(id, reason);
          else return text(`${id}는 이미 정리된 항목이다 (${e.meta.status})`);
          return text(`${id} → ${page.path}`);
        } catch (ex) {
          return err(String((ex as Error).message));
        }
      },
    );
  }

  // ---------- Gen Wiki ----------
  const wikiProject = () => process.env.GENCOUNCIL_PROJECT || undefined;

  server.registerTool(
    "wiki_toc",
    {
      title: "Gen Wiki contents (one level)",
      description:
        "Gen Wiki를 한 단계씩 내려가며 본다. path 없이 부르면 맨 위(common/, models/, 이 프로젝트의 projects/<프로젝트>/), " +
        "폴더 경로를 주면 그 폴더의 하위 폴더(쪽수)와 페이지(제목·한 줄 요약)만 보여 준다. 필요한 갈래만 따라 내려가고, 찾을 말이 분명하면 wiki_search가 더 빠르다.",
      inputSchema: {
        path: z.string().optional().describe("볼 폴더 (예: common, common/comfyui, projects/h3_studio). 없으면 맨 위"),
        project: z.string().optional().describe("이 프로젝트의 페이지를 함께 보여 준다 (기본: 내 프로젝트)"),
      },
    },
    async ({ path: folder, project }) => text(wiki.renderChildren(folder ?? "", { project: project ?? wikiProject() })),
  );

  server.registerTool(
    "wiki_search",
    {
      title: "Search Gen Wiki",
      description: "Gen Wiki 전문 검색 (한국어·영어). 결과의 path를 wiki_read로 연다.",
      inputSchema: {
        query: z.string().min(1),
        project: z.string().optional().describe("이 프로젝트 페이지까지 찾는다 (기본: 내 프로젝트; 다른 프로젝트 페이지는 제외)"),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    async ({ query, project, limit }) => {
      const hits = wiki.search(query, { project: project ?? wikiProject(), limit });
      return hits.length ? json(hits) : text(`위키에 "${query}"에 맞는 페이지가 없다.`);
    },
  );

  server.registerTool(
    "wiki_read",
    {
      title: "Read Gen Wiki page",
      description:
        `위키 페이지를 읽는다. 짧은 페이지(${LONG_PAGE}자 이하)는 통째로, 긴 페이지는 먼저 목차(## 절 제목과 글자 수)만 준다. ` +
        "그다음 필요한 절만 section으로 읽는다(예: section: \"방법\"). 통째로 꼭 필요하면 full: true. path 예: common/comfyui, projects/h3_studio/video-jobs",
      inputSchema: {
        path: z.string().min(1),
        section: z.string().optional().describe("읽을 ## 절 제목(앞부분만 맞아도 된다)"),
        full: z.boolean().optional().describe("긴 페이지도 통째로 읽기"),
      },
    },
    async ({ path: p, section, full }) => {
      try {
        const page = wiki.read(p);
        if (!page) return err(`페이지가 없다: ${p}. wiki_toc나 wiki_search로 경로를 확인한다.`);
        const head = `# ${page.title}\n(path: ${page.path} · 수정 ${page.updated} · ${page.by}${page.sources.length ? ` · 출처 ${page.sources.length}개` : ""})\n${page.summary ? `> ${page.summary}\n` : ""}`;
        if (section) {
          const s = pageSection(page.body, section);
          if (s) return text(`${head}\n${s}`);
          return err(`'${section}' 절이 없다. 절 목록: ${pageOutline(page.body).map((o) => o.heading).join(" / ") || "(절 없음)"}`);
        }
        // editors rewrite whole pages, so they always get the full text
        if (full || canWrite() || page.body.length <= LONG_PAGE) return text(`${head}\n${page.body}`);
        const outline = pageOutline(page.body);
        if (!outline.length) return text(`${head}\n${page.body}`);
        // the overview before the first "## " heading (empty when the page starts with one)
        const firstHeading = page.body.search(/^##\s/m);
        const intro = (firstHeading < 0 ? "" : page.body.slice(0, firstHeading)).trim().slice(0, 600);
        return text(
          `${head}\n${intro ? intro + "\n\n" : ""}이 페이지는 ${page.body.length}자로 길어 목차만 보인다. 필요한 절을 wiki_read(path, section)로 읽는다:\n` +
            outline.map((o) => `- ${o.heading} (${o.chars}자)`).join("\n"),
        );
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "wiki_propose",
    {
      title: "Propose a Gen Wiki edit",
      description:
        "위키 페이지 수정(또는 새 페이지)을 제안한다. 작업하다 위키에 적힌 절차가 틀렸거나 바뀐 것을 알게 되면 부른다. " +
        "제안은 관리자가 '제안 처리' 때 그 페이지에 반영한다. 고칠 페이지를 먼저 wiki_read로 읽고, body에는 바뀐 부분만 '무엇이 틀렸나 / 이제 맞는 방법(명령·경로·값 그대로)'으로 쓴다. " +
        "한 번 쓰고 버릴 작업 기록, 비밀값은 넣지 않는다.",
      inputSchema: {
        path: z.string().min(1).describe("고칠 위키 페이지 경로(없는 페이지면 새로 만들 경로): common/<페이지> | models/<페이지> | projects/<프로젝트>/<페이지>"),
        change: z.string().min(5).describe("무엇이 바뀌었나 한 줄 (제안 제목이 된다)"),
        body: z.string().min(10).describe("바뀐 내용: 무엇이 틀렸나 / 이제 맞는 방법"),
      },
    },
    async ({ path: p, change, body }) => {
      let norm: string;
      try {
        norm = normalizeWikiPath(p);
      } catch (e) {
        return err((e as Error).message);
      }
      const parts = norm.split("/");
      const e = store.propose({
        type: parts[0] === "models" ? "persona" : "solution",
        title: `위키 수정: ${norm} — ${change.trim()}`.slice(0, 120),
        body,
        tags: [`wiki:${norm}`],
        ...(parts[0] === "projects" ? { project: parts[1], scope: "project" as const } : { scope: "common" as const }),
        source: agent(),
      });
      return text(`proposed ${e.meta.id} (위키 ${norm} 수정 제안). 다음 제안 처리 때 반영된다.`);
    },
  );

  if (canWrite()) {
    server.registerTool(
      "wiki_write",
      {
        title: "Write Gen Wiki page (owner)",
        description:
          "위키 편집자(제안 처리·전체 점검) 전용. 위키 페이지를 만들거나 통째로 바꾼다(고칠 때는 먼저 wiki_read로 읽고 전체 본문을 다시 보낸다). " +
          "한 페이지 = 한 주제. 다른 사람이 처음 읽어도 따라 할 수 있게 '언제 쓰나 / 방법 / 주의할 점' 순서로 쓴다. " +
          "한 번 쓰고 버릴 작업 기록, 비밀값(키·토큰·비밀번호)은 넣지 않는다. 모든 수정은 git에 기록된다.",
        inputSchema: {
          path: z.string().min(1).describe("common/<페이지> | models/<페이지> | projects/<프로젝트>/<페이지> (영문 소문자·한글·숫자·-_ )"),
          title: z.string().min(2),
          summary: z.string().min(5).describe("이 페이지가 답하는 질문 한 줄"),
          body: z.string().min(10).describe("마크다운 본문 (제목 줄 없이)"),
          sources: z.array(z.string()).optional().describe("이 페이지로 옮긴 공용 기억 id"),
          reason: z.string().optional().describe("무엇을 바꿨는지 한 줄 (git 기록)"),
        },
      },
      async ({ path: p, title, summary, body, sources, reason }) => {
        try {
          const page = await wiki.write(p, { title, summary, body, sources }, agent(), reason);
          return text(`saved ${page.path} (${page.chars}자)`);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    );
  }

  if (canWrite()) {
    server.registerTool(
      "wiki_remove",
      {
        title: "Remove Gen Wiki page",
        description: "위키 페이지를 지운다. 다른 페이지로 합쳤으면 reason을 \"통합: <남긴 경로>\", 이제 필요 없는 페이지면 \"정리: <이유>\"로 쓴다. git 기록에는 남는다.",
        inputSchema: { path: z.string().min(1), reason: z.string().min(3) },
      },
      async ({ path: p, reason }) => {
        // cleanup deletions are capped per run; a merge ("통합:") keeps its content in another page and is not counted
        const budget = Number(process.env.GENCOUNCIL_WIKI_REMOVE_BUDGET ?? "");
        const isMerge = /^통합/.test(reason.trim());
        if (!isMerge && Number.isFinite(budget) && budget > 0 && session.wikiRemoves >= budget)
          return err(`이번 점검에서 정리 삭제는 ${budget}개까지만 된다. 나머지는 다음 점검에 맡긴다.`);
        try {
          const removed = await wiki.remove(p, agent(), reason);
          if (removed && !isMerge) session.wikiRemoves++;
          return removed ? text(`removed ${p}`) : err(`페이지가 없다: ${p}`);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    );
  }

  return server;
}

export async function serveStdio(): Promise<void> {
  const store = new MemoryStore({ watch: true });
  await store.init();
  const wiki = new WikiStore();
  await wiki.init({ seed: true });
  const server = await createServer(store, wiki);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; log to stderr only
  console.error(`[gencouncil] mcp ready: ${store.size()} entries, role=${role()}, agent=${agent()}, dir=${store.dir}`);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  serveStdio().catch((e) => {
    console.error("[gencouncil] fatal:", e);
    process.exit(1);
  });
}
