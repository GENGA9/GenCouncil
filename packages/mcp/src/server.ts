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
import { ENTRY_TYPES, MemoryStore, type EntryType } from "@gencouncil/core";

type Role = "owner" | "chair" | "member";

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

export async function createServer(store: MemoryStore): Promise<McpServer> {
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
      inputSchema: {},
    },
    async () => text(store.renderIndex()),
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
        limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 10)"),
        include_proposed: z
          .boolean()
          .optional()
          .describe("Also search entries that are proposed but not yet approved"),
      },
    },
    async ({ query, type, project, limit, include_proposed }) => {
      const hits = store.search(query, {
        type: type as EntryType | undefined,
        project,
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
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ type, status, project, limit }) =>
      json(
        store
          .list({ type: type as EntryType | undefined, status, project, limit })
          .map(({ id, title, type, status, tags, project, source, updated }) => ({
            id,
            title,
            type,
            status,
            tags,
            project,
            source,
            updated,
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
    project: z.string().optional().describe("Project name if it only applies to one project"),
  };

  server.registerTool(
    "memory_propose",
    {
      title: "Propose memory entry",
      description:
        "Propose a new reusable memory (lands in proposals/ until the owner or chair approves). " +
        "Use when you solved something non-obvious, found where a tool lives, or learned a convention.",
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

  return server;
}

export async function serveStdio(): Promise<void> {
  const store = new MemoryStore({ watch: true });
  await store.init();
  const server = await createServer(store);
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
