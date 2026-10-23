/**
 * Chair-facing MCP server (tools prefixed council_*), hosted over Streamable HTTP
 * by the council process so the headless `claude -p` chair can call back into it.
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { permissionToolResult } from "./approval.js";
import type { Council } from "./council.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function json(v: unknown) {
  return text(JSON.stringify(v, null, 2));
}
function err(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

async function guard<T>(fn: () => Promise<T> | T) {
  try {
    return json(await fn());
  } catch (e) {
    return err((e as Error).message);
  }
}

export function createCouncilMcp(council: Council): McpServer {
  const server = new McpServer({ name: "council", version: "0.1.0" });

  server.registerTool(
    "council_state",
    {
      title: "Council state",
      description: "Goals, tasks, members (status/branch/result summary), integration worktree, and the chair's saved state.md.",
      inputSchema: {},
    },
    async () => guard(() => council.state()),
  );

  server.registerTool(
    "council_set_agenda",
    {
      title: "Set agenda title and goals",
      description:
        "Name the agenda (short Korean title, a few words) and set its goals (outcomes, one line each) from what the user asked. " +
        "Use it on the first request of a new agenda and whenever the user adds or changes what they want. Goals replace the previous list.",
      inputSchema: {
        title: z.string().min(1).max(60).optional(),
        goals: z.array(z.string().min(1)).optional().describe("full goal list, in order"),
      },
    },
    async (i) => guard(() => council.setAgenda(i)),
  );

  server.registerTool(
    "council_guidelines",
    { title: "Project guidelines", description: "The project's work-assignment guidelines (AI tendencies, rules).", inputSchema: {} },
    async () => text(council.registry.guidelines(council.project) || "(no guidelines)"),
  );

  server.registerTool(
    "council_add_task",
    {
      title: "Add task",
      description: "Create a task under the agenda. Keep tasks file-disjoint so members can run in parallel.",
      inputSchema: {
        title: z.string().min(2),
        description: z.string().optional().describe("What/where/done-when; this is shown to the member"),
        goal: z.number().int().min(1).optional().describe("1-based index of the goal this task serves"),
      },
    },
    async (i) => guard(() => council.addTask(i)),
  );

  server.registerTool(
    "council_update_task",
    {
      title: "Update task",
      description: "Change a task's status (todo|doing|review|done|blocked) or note.",
      inputSchema: {
        task_id: z.string(),
        status: z.enum(["todo", "doing", "review", "done", "blocked"]).optional(),
        note: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ task_id, ...patch }) => guard(() => council.updateTask(task_id, patch)),
  );

  server.registerTool(
    "council_assign",
    {
      title: "Assign task to a new member",
      description:
        "Spawn an autonomous member (claude, gemini or gpt CLI) in its own git worktree/branch to do one task, " +
        "or create a relay member (provider 'relay': a human copies the packet into a web AI such as web Gemini / AI Studio / Antigravity and pastes the answer back; " +
        "the web AI cannot see the repo, so list the files it needs in `files`). " +
        "Returns immediately; you will be notified with a [council event] message when it finishes " +
        "(or call council_wait). Write instructions as a complete brief: what, which files, done-when, don'ts. " +
        "The account is chosen automatically from usable accounts; a member that dies of a quota/auth error is handed over automatically. " +
        "Pick provider/model/effort/advisor yourself within the user's limits (see the limits table in your instructions or council_limits); " +
        "the call is rejected with the allowed values if you exceed them.",
      inputSchema: {
        task_id: z.string(),
        provider: z.enum(["claude", "gemini", "gpt", "relay"]).optional().describe("default: project.members.defaultProvider"),
        model: z.string().optional().describe("e.g. haiku | sonnet | opus | fable, gemini-3.8-flash | gemini-4-argon, gpt-6-luna | gpt-6.1-sol | gpt-6-astra. default: the workhorse model within the limit"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("claude/gpt only. default medium (clamped to the limit)"),
        advisor: z.string().optional().describe("claude only: stronger model consulted before locking a plan, after a repeated error and before declaring done, e.g. opus. omit for short tasks"),
        account: z.string().optional().describe("preferred account id (see council_accounts)"),
        site: z.enum(["gemini-web", "aistudio", "chatgpt"]).optional().describe("relay only: which web AI; opens the user's pre-logged-in profile and counts toward that site's limit"),
        label: z.string().optional().describe("relay only: display label, e.g. 제미나이(agy)"),
        files: z.array(z.string()).optional().describe("relay only: repo-relative files/dirs to bundle into the packet"),
        verify: z.boolean().optional().describe("gemini flash only: false skips the automatic Claude check (use for doc-only or trivial work)"),
        instructions: z.string().min(20),
      },
    },
    async ({ task_id, ...rest }) =>
      guard(async () => {
        const m = await council.assign({ taskId: task_id, ...rest });
        return { member_id: m.id, provider: m.provider, model: m.model, effort: m.effort, advisor: m.advisor, site: m.site, account: m.account, branch: m.branch, worktree: m.worktree, status: m.status };
      }),
  );

  server.registerTool(
    "council_handover",
    {
      title: "Hand a member's work over to a new member",
      description:
        "Continue a failed/stopped member's task in the SAME worktree and branch with a new process (another account, provider or model). " +
        "Quota/auth failures are handed over automatically; use this for manual cases (e.g. a relay member you want a CLI member to finish, or a stuck member you stopped).",
      inputSchema: {
        member_id: z.string(),
        provider: z.enum(["claude", "gemini", "gpt"]).optional(),
        model: z.string().optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        account: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ member_id, ...rest }) =>
      guard(async () => {
        const m = await council.handover(member_id, rest);
        return { member_id: m.id, provider: m.provider, account: m.account, handover_from: m.handoverFrom, branch: m.branch };
      }),
  );

  server.registerTool(
    "council_relay_packet",
    {
      title: "Relay packet text",
      description: "Return the packet a human must paste into the web AI for a relay member. Usually the user copies it from the UI; use this to check its contents.",
      inputSchema: { member_id: z.string() },
    },
    async ({ member_id }) => {
      try {
        return text(council.relayPacket(member_id));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "council_limits",
    {
      title: "Member limits",
      description: "The user's limits per provider (max simultaneous members, max model, max effort) and how many are working now.",
      inputSchema: {},
    },
    async () => text(council.limitsMarkdown()),
  );

  server.registerTool(
    "council_accounts",
    {
      title: "Account registry",
      description: "Which logins exist per provider and whether they are usable now (ok / exhausted with reset time / auth needed).",
      inputSchema: {},
    },
    async () => guard(() => council.accounts.list()),
  );

  server.registerTool(
    "council_member",
    {
      title: "Inspect member",
      description: "Status, commits, diffstat, RESULT.md summary, optional log tail and full diff vs the agenda branch.",
      inputSchema: {
        member_id: z.string(),
        tail: z.number().int().min(0).max(400).optional().describe("lines of log tail"),
        diff: z.boolean().optional().describe("include full diff (review before merging)"),
      },
    },
    async ({ member_id, tail, diff }) => guard(() => council.memberInfo(member_id, { tail, diff })),
  );

  server.registerTool(
    "council_wait",
    {
      title: "Wait for a member to finish",
      description: "Block until at least one running member finishes (or timeout). Returns finished members since the last call.",
      inputSchema: { timeout_sec: z.number().int().min(5).max(3600).optional().describe("default 600") },
    },
    async ({ timeout_sec }) =>
      guard(async () => {
        const done = await council.waitAny((timeout_sec ?? 600) * 1000);
        return { finished: done.map((m) => ({ id: m.id, status: m.status, task: m.taskId, commits: m.commits, summary: m.result?.summary })), still_running: council.runningCount() };
      }),
  );

  server.registerTool(
    "council_merge",
    {
      title: "Merge member branch into agenda branch",
      description: "Review the diff first (council_member diff:true). On conflict the merge is aborted and conflict files are returned.",
      inputSchema: { member_id: z.string() },
    },
    async ({ member_id }) => guard(() => council.merge(member_id)),
  );

  server.registerTool(
    "council_verify",
    {
      title: "Have a Claude member check finished work",
      description:
        "Start a Claude member that checks another member's finished work in the same worktree/branch: claims backed by code/docs, " +
        "no invented functions or addresses, tests re-run, out-of-scope edits. It fixes what is wrong and rewrites RESULT.md. " +
        "Runs automatically after Gemini Flash code work; use it yourself for any other result you do not trust. Merge after it finishes.",
      inputSchema: {
        member_id: z.string(),
        model: z.string().optional().describe("claude model within the limits (default sonnet)"),
        effort: z.string().optional().describe("default high, clamped to the limit"),
        reason: z.string().optional(),
      },
    },
    async ({ member_id, model, effort, reason }) => guard(() => council.verify(member_id, { model, effort, reason })),
  );

  server.registerTool(
    "council_stop_member",
    { title: "Stop member", description: "Kill a running member process. Its branch and partial work are kept.", inputSchema: { member_id: z.string() } },
    async ({ member_id }) => guard(() => ({ stopped: council.stopMember(member_id) })),
  );

  server.registerTool(
    "council_ask_user",
    {
      title: "Ask the user for a decision",
      description:
        "Mark this agenda as waiting for the user's decision. The UI shows a badge on the agenda and the question with answer buttons, " +
        "and Telegram notifies the user. Use it whenever you stop because only the user can decide (a choice between options, an approval, " +
        "information you cannot find). Ask one question, give 2-4 short options when they exist, then end your turn. " +
        "Work that needs no decision continues meanwhile.",
      inputSchema: {
        question: z.string().min(5).describe("one short question, in the user's language"),
        options: z.array(z.string()).max(6).optional().describe("short answers the user can tap, e.g. [\"A안으로 진행\", \"B안으로 진행\"]"),
      },
    },
    async ({ question, options }) => guard(() => council.askUser(question, options)),
  );

  server.registerTool(
    "council_finish",
    {
      title: "Finish the agenda",
      description:
        "End this agenda: after your current turn the server merges the agenda branch into the base branch, removes the worktrees " +
        "(notes are archived) and closes the agenda. Use when every goal is merged and verified, or when the user asks to finish. " +
        "Refused while members run, when finished work is unmerged (pass include_unmerged:true to drop it on purpose), or when the main checkout is not ready. " +
        "After a successful call, end your turn with a short summary of what is being merged.",
      inputSchema: {
        reason: z.string().min(3).describe("one line: why the agenda is done (shown to the user)"),
        include_unmerged: z.boolean().optional().describe("finish even though some finished member work is not merged (it is dropped)"),
      },
    },
    async ({ reason, include_unmerged }) =>
      guard(async () => {
        const r = await council.requestFinish(reason, { includeUnmerged: include_unmerged });
        return r.scheduled
          ? { scheduled: true, note: "이번 턴이 끝나면 베이스 브랜치에 머지하고 안건을 닫는다. 새 작업을 배정하지 말고 요약 보고로 턴을 끝내라." }
          : { scheduled: false, problems: r.problems };
      }),
  );

  server.registerTool(
    "council_checkpoint",
    {
      title: "Save chair state",
      description:
        "Overwrite chair/state.md with your current handover state: 한 일 / 하는 중 / 다음 할 일 / 막힌 점 / 사용자 결정 대기. " +
        "Call after every decomposition, assignment batch, merge, or important decision.",
      inputSchema: { state: z.string().min(10) },
    },
    async ({ state }) =>
      guard(() => {
        council.checkpoint(state);
        return { saved: true };
      }),
  );

  return server;
}

/** MCP server a claude member talks to for permission decisions (autonomy "chair"). */
export function createMemberMcp(council: Council, memberId: string): McpServer {
  const server = new McpServer({ name: "council_member", version: "0.1.0" });
  server.registerTool(
    "permission",
    {
      title: "Ask the chair for permission",
      description: "Permission prompt handler: the chair approves or denies a tool call on behalf of the user.",
      inputSchema: { tool_name: z.string(), input: z.record(z.unknown()), tool_use_id: z.string().optional() },
    },
    async ({ tool_name, input }) => {
      const d = await council.requestPermission(memberId, tool_name, input as Record<string, unknown>);
      return text(permissionToolResult(d, input as Record<string, unknown>));
    },
  );
  return server;
}

export async function handleMemberMcpRequest(council: Council, memberId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcp = createMemberMcp(council, memberId);
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

export interface CouncilHttp {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serve one MCP request (stateless streamable-http) for the given council. */
export async function handleCouncilMcpRequest(council: Council, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcp = createCouncilMcp(council);
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

/** Host the council MCP server alone on 127.0.0.1 (used by the terminal REPL). */
export function startCouncilHttp(council: Council, port = 0): Promise<CouncilHttp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const member = /^\/member\/([^/]+)\/mcp\/?$/.exec(req.url ?? "");
      if (member) {
        await handleMemberMcpRequest(council, decodeURIComponent(member[1]), req, res);
        return;
      }
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      await handleCouncilMcpRequest(council, req, res);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      council.setMemberMcp((id) => ({ url: `http://127.0.0.1:${p}/member/${encodeURIComponent(id)}/mcp` }));
      resolve({
        url: `http://127.0.0.1:${p}/mcp`,
        port: p,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
