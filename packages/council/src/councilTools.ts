/**
 * Chair-facing MCP server (tools prefixed council_*), hosted over Streamable HTTP
 * by the council process so the headless `claude -p` chair can call back into it.
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { permissionToolResult } from "./approval.js";
import { memberHelpers, userAskedToMergeBase, type Council } from "./council.js";

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
        model: z.string().optional().describe("e.g. haiku | sonnet | opus | fable, gemini-3.8-flash | gemini-4-hydrogen | gemini-4-argon | gemini-4-neon, gpt-6-luna | gpt-6.1-terra | gpt-6.1-sol | gpt-6-astra. default: the workhorse model within the limit"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("claude/gpt only. default medium (clamped to the limit)"),
        advisor: z.string().optional().describe("claude only: stronger model consulted before locking a plan, after a repeated error and before declaring done, e.g. opus. omit for short tasks"),
        account: z.string().optional().describe("preferred account id (see council_accounts)"),
        site: z.enum(["gemini-web", "aistudio", "chatgpt"]).optional().describe("relay only: which web AI; opens the user's pre-logged-in profile and counts toward that site's limit"),
        label: z.string().optional().describe("relay only: display label, e.g. 제미나이(agy)"),
        files: z.array(z.string()).optional().describe("relay only: repo-relative files/dirs to bundle into the packet"),
        verify: z.boolean().optional().describe("gemini flash only: false skips the automatic Claude check (use for doc-only or trivial work)"),
        override_usage: z.boolean().optional().describe("ONLY when the user's own message explicitly asked for this top model (fable / gpt-6-astra): skip the weekly-usage floor. Never set on your own judgment."),
        instructions: z.string().min(20),
      },
    },
    async ({ task_id, override_usage, ...rest }) =>
      guard(async () => {
        const m = await council.assign({ taskId: task_id, overrideUsage: override_usage, ...rest });
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
      description:
        "Status, commits, diffstat, RESULT.md summary, optional log tail and diff vs the agenda branch. " +
        "Judge from the event summary and diffstat first; for code read only the key files with diff:true + files:[...] instead of the whole diff.",
      inputSchema: {
        member_id: z.string(),
        tail: z.number().int().min(0).max(400).optional().describe("lines of log tail"),
        diff: z.boolean().optional().describe("include the diff (default cap 20000 chars without files)"),
        files: z.array(z.string()).optional().describe("repo-relative paths; with diff:true, diff only these files"),
        max_chars: z.number().int().min(1000).max(200000).optional().describe("cap on diff characters"),
      },
    },
    async ({ member_id, tail, diff, files, max_chars }) => guard(() => council.memberInfo(member_id, { tail, diff, files, maxChars: max_chars })),
  );

  server.registerTool(
    "council_consult",
    {
      title: "Consult the advisor",
      description:
        "Ask a stronger model one question and get its judgement back; it cannot edit anything. This is your advisor whatever provider you are: " +
        "Claude Code's --advisor is a claude-only flag, so this tool is how a GPT or Gemini chair gets the same second opinion. " +
        "Consult at three moments and no others: before locking the task breakdown, the second time the same kind of failure appears, and before declaring the agenda finishable. " +
        "Put everything the advisor needs in `context` — it sees nothing else, not this conversation and not the repo.",
      inputSchema: {
        question: z.string().min(1).describe("one decision, concrete. not 'review this'"),
        context: z.string().optional().describe("the plan / the error / the diff / what you decided so far. the advisor has no other context"),
        model: z.string().optional().describe("default: the strongest model your limits allow. e.g. opus | fable | gpt-6-astra | gemini-4-argon"),
      },
    },
    async (i) => guard(() => council.consult(i)),
  );

  server.registerTool(
    "council_explore",
    {
      title: "Look something up in the repository",
      description:
        "Have a cheap read-only model find it for you instead of reading and grepping the repo in this session. " +
        "Use it before planning a change and before writing assignment instructions: your own context is for handing work out, not for mapping the tree. " +
        "kind: search = which files relate to a topic, grep = every definition and use of a symbol, docs = how an API is used here.",
      inputSchema: {
        query: z.string().min(1).describe("the topic, symbol or API to look up"),
        kind: z.enum(["search", "grep", "docs"]).optional().describe("default search"),
      },
    },
    async (i) => guard(() => council.explore(i)),
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
      description: "Judge from the event summary and diffstat; docs and small changes can be merged right away, for code read the key files (council_member diff:true, files:[...]) or hand a big untrusted result to council_verify. On conflict the merge is aborted and conflict files are returned.",
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
        override_usage: z.boolean().optional().describe("ONLY when the user's own message explicitly asked for this top model (fable / gpt-6-astra): skip the weekly-usage floor. Never set on your own judgment."),
      },
    },
    async ({ member_id, model, effort, reason, override_usage }) => guard(() => council.verify(member_id, { model, effort, reason, overrideUsage: override_usage })),
  );

  server.registerTool(
    "council_stop_member",
    { title: "Stop member", description: "Kill a running member process. Its branch and partial work are kept.", inputSchema: { member_id: z.string() } },
    async ({ member_id }) => guard(() => ({ stopped: council.stopMember(member_id) })),
  );

  server.registerTool(
    "council_show",
    {
      title: "Show drafts / screenshots in the chat",
      description:
        "Put images, screenshots, HTML mockups, PDFs or videos into the user's chat with a short caption. " +
        "Files must be inside this agenda's worktrees or the project folder; relative paths are relative to the integration worktree. " +
        "Members leave screenshots in <their worktree>/.council/shots/ (listed in their completion event). " +
        "Use it whenever a report or a decision is about how something looks: show first, then explain briefly and ask with council_ask_user.",
      inputSchema: {
        paths: z.array(z.string()).min(1).max(8).describe("absolute paths or paths relative to the integration worktree"),
        caption: z.string().min(2).describe("what the user is looking at, e.g. 'A안: 타이틀 화면 (claude-3)'"),
      },
    },
    async ({ paths, caption }) => guard(() => ({ shown: council.showFiles(paths, caption).map((a) => a.name) })),
  );

  server.registerTool(
    "council_ask_user",
    {
      title: "Ask the user for a decision",
      description:
        "Mark this agenda as waiting for the user's decision. The UI shows a badge on the agenda and the question with answer buttons, and Telegram notifies the user with the question and tap buttons. " +
        "Use it whenever you stop because only the user can decide (a choice between options, an approval, " +
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
    "council_telegram",
    {
      title: "Send to the user's Telegram (only when told to)",
      description:
        "Use ONLY when the user explicitly told you to send something to Telegram (e.g. '텔레그램으로 보내줘', '텔레그램으로 답해줘'). " +
        "Agenda auto sending is ON by default (agenda.telegramAuto in council_state is true): then replies, drafts and member notices go to Telegram by themselves and you must NOT call this tool for them. " +
        "Use it only when agenda.telegramAuto is false (the user turned it off) AND the user explicitly asks; never on your own initiative. council_ask_user questions always go by themselves. " +
        "A message that arrived from Telegram (marked '[텔레그램]') is NOT a request to answer on Telegram; reply there only if the user said so. " +
        "Sends the text to the user's Telegram (this agenda's topic or the private chat), optionally with files (same path rules as council_show) " +
        "and, with ask:true, the question of your last council_ask_user as tap buttons (call council_ask_user first). " +
        "Returns whether it was sent; fails when Telegram is not connected.",
      inputSchema: {
        text: z.string().min(1).describe("what to send, in the user's language"),
        paths: z.array(z.string()).max(8).optional().describe("files to send too: absolute paths or paths relative to the integration worktree"),
        ask: z.boolean().optional().describe("attach the agenda's pending council_ask_user question and options as buttons; that question is already sent automatically, so use this only when the user asks to send it again"),
      },
    },
    async ({ text, paths, ask }) => guard(() => council.sendTelegram(text, paths, ask)),
  );

  server.registerTool(
    "council_finish",
    {
      title: "Finish the agenda",
      description:
        "End this agenda, or propose ending it. The agenda only ends when the user's latest message asks for it (\"종료해\", \"마무리하자\") " +
        "or the user approves your proposal; the server checks this, not you. When the work looks done but the user has not asked, call this " +
        "to PROPOSE: the user gets a card with an end button, and you end your turn with a short summary (show results first with council_show). " +
        "When it does end, after your turn the server merges the agenda branch into the base branch, removes the worktrees and closes the agenda. " +
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
        if (r.scheduled) return { scheduled: true, note: "사용자가 종료를 요청했다. 이번 턴이 끝나면 베이스 브랜치에 머지하고 안건을 닫는다. 새 작업을 배정하지 말고 요약 보고로 턴을 끝내라." };
        if (r.proposed)
          return { scheduled: false, proposed: true, note: "사용자가 아직 종료를 요청하지 않아 종료를 제안만 했다(종료 버튼이 있는 카드). 무엇을 합쳤는지 짧게 요약하고 턴을 끝내라. 사용자가 승인하면 서버가 종료한다." };
        return { scheduled: false, problems: r.problems };
      }),
  );

  server.registerTool(
    "council_merge_base",
    {
      title: "Merge the agenda branch into the main branch (agenda stays open)",
      description:
        "Bring what the agenda branch has so far into the base branch in the main checkout, without ending the agenda. " +
        "Only when the user's latest message asks for it (\"메인에 반영해\", \"메인에 합쳐\"); otherwise it is refused and you ask the user " +
        "with council_ask_user. Merge finished member work into the agenda branch first (council_merge); unmerged work is not included. " +
        "Refused when the main checkout is on another branch or has uncommitted changes.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        if (!userAskedToMergeBase(council.lastUserMessage()))
          return { merged: false, note: "사용자가 메인 반영을 요청하지 않았다. 필요하면 council_ask_user로 '지금까지 결과를 메인에 반영할까요?'를 묻는다." };
        const unmerged = council.unmergedMembers().map((m) => m.id);
        const output = await council.mergeToBase("chair");
        return { merged: true, output, notIncluded: unmerged.length ? unmerged : undefined };
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
/**
 * The member-facing server. `consult` and `explore` are always there — they are what a claude
 * member gets from `--advisor` and `--agents`, which Codex and Antigravity have no equivalent for.
 * `permission` is only registered in "chair approves" autonomy, where Claude Code points
 * --permission-prompt-tool at it.
 */
export function createMemberMcp(
  council: Council,
  memberId: string,
  opts: { permission?: boolean; helpers?: Array<"consult" | "explore"> } = {},
): McpServer {
  const server = new McpServer({ name: "council_member", version: "0.1.0" });
  const helpers = opts.helpers ?? ["consult", "explore"];

  if (helpers.includes("consult"))
    server.registerTool(
      "consult",
      {
        title: "Consult the advisor",
        description:
          "Ask a stronger model one question and get its judgement back; it cannot edit your files. " +
          "Consult at three moments and no others: before you lock your plan, the second time the same error appears, and before you declare the task done. " +
          "Put everything it needs in `context` — it sees neither this conversation nor your worktree.",
        inputSchema: {
          question: z.string().min(1).describe("one decision, concrete. not 'review this'"),
          context: z.string().optional().describe("your plan / the error and what you tried / the diff. the advisor has no other context"),
        },
      },
      async (i) => guard(() => council.consult({ ...i, memberId })),
    );

  if (helpers.includes("explore"))
    server.registerTool(
      "explore",
      {
        title: "Look something up in your worktree",
        description:
          "Have a cheap read-only model find it for you instead of grepping the tree yourself. Use it before planning the change. " +
          "kind: search = which files relate to a topic, grep = every definition and use of a symbol, docs = how an API is used here.",
        inputSchema: {
          query: z.string().min(1).describe("the topic, symbol or API to look up"),
          kind: z.enum(["search", "grep", "docs"]).optional().describe("default search"),
        },
      },
      async (i) => guard(() => council.explore({ ...i, memberId })),
    );

  if (!opts.permission) return server;
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
  const m = council.members().find((x) => x.id === memberId);
  const mcp = createMemberMcp(council, memberId, {
    permission: council.project.members.autonomy === "chair",
    helpers: m ? memberHelpers(m, council.project) : undefined,
  });
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
