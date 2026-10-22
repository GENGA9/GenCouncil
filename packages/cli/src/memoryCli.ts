import fs from "node:fs";
import { parseArgs } from "node:util";
import { ENTRY_TYPES, MemoryStore, type EntryStatus, type EntryType } from "@gencouncil/core";
import { serveStdio } from "@gencouncil/mcp";
import { install, serverEntry, type Target } from "@gencouncil/mcp/install";

export const MEMORY_HELP = `memory commands
  init                         create ~/.gencouncil/space/memory (git-tracked) with starter entries
  serve                        run the memory MCP server on stdio (what Claude Code / Gemini CLI launch)
  status                       where the memory lives and how many entries there are
  index                        regenerate INDEX.md and print it
  search <query> [--type t] [--project p] [--limit n] [--all]
  read <id>
  list [--type t] [--status s] [--project p]
  add --type t --title "..." (--body "..." | --body-file f) [--tags a,b] [--project p]
  propose  (same options as add; lands in proposals/)
  update <id> [--title ..] [--append ..] [--body-file f] [--tags a,b]
  proposals                    list pending proposals
  approve <id> | reject <id> [--reason ..] | remove <id>
  install <claude|gemini|antigravity|all> [--role owner|chair|member] [--no-rules] [--dry-run]
  server-path                  print the absolute path of the MCP server entry
`;

export const MEMORY_COMMANDS = new Set([
  "init", "serve", "status", "index", "search", "read", "list", "add", "propose", "update",
  "proposals", "approve", "reject", "remove", "install", "server-path",
]);

export async function memoryMain(cmd: string, rest: string[]): Promise<number> {
  if (cmd === "serve") {
    await serveStdio();
    return -1; // keep running
  }
  if (cmd === "server-path") {
    console.log(serverEntry());
    return 0;
  }
  if (cmd === "install") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { role: { type: "string" }, "no-rules": { type: "boolean" }, "dry-run": { type: "boolean" } },
    });
    const target = (positionals[0] ?? "all") as Target | "all";
    if (!["claude", "gemini", "antigravity", "all"].includes(target)) {
      console.error(`unknown install target: ${target}`);
      return 2;
    }
    const store = new MemoryStore();
    await store.init();
    const role = values.role as "owner" | "chair" | "member" | undefined;
    for (const line of install(target, { role, rules: !values["no-rules"], dryRun: values["dry-run"] })) console.log(line);
    return 0;
  }

  const store = new MemoryStore();
  try {
    return await dispatch(cmd, rest, store);
  } finally {
    await store.flush();
  }
}

async function dispatch(cmd: string, rest: string[], store: MemoryStore): Promise<number> {
  if (cmd === "init") {
    const created = await store.init();
    if (store.size() === 0) await seed(store);
    console.log(`${created ? "created" : "ok"}: ${store.dir} (${store.size()} entries)`);
    return 0;
  }
  store.load();

  switch (cmd) {
    case "status": {
      console.log(`memory dir : ${store.dir}`);
      console.log(`entries    : ${store.size()} (${store.list({ status: "verified" }).length} verified, ${store.list({ status: "proposed" }).length} proposed)`);
      console.log(`git        : ${fs.existsSync(`${store.root}/.git`) ? "yes" : "no"}`);
      console.log(`server     : ${serverEntry()}`);
      return 0;
    }
    case "index": {
      process.stdout.write(store.writeIndex());
      return 0;
    }
    case "search": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { type: { type: "string" }, project: { type: "string" }, limit: { type: "string" }, all: { type: "boolean" } },
      });
      const q = positionals.join(" ");
      if (!q) {
        console.error("search: query required");
        return 2;
      }
      const hits = store.search(q, {
        type: values.type as EntryType | undefined,
        project: values.project,
        limit: values.limit ? Number(values.limit) : undefined,
        status: values.all ? "any" : "verified",
      });
      if (hits.length === 0) console.log("(no hits)");
      for (const h of hits) {
        console.log(`${h.score.toString().padStart(6)}  ${h.id}  [${h.type}${h.status !== "verified" ? "/" + h.status : ""}]  ${h.title}`);
        if (h.snippet) console.log(`        ${h.snippet}`);
      }
      return 0;
    }
    case "read": {
      const e = store.get(rest[0] ?? "");
      if (!e) {
        console.error(`not found: ${rest[0]}`);
        return 1;
      }
      process.stdout.write(fs.readFileSync(e.file, "utf8"));
      return 0;
    }
    case "list":
    case "proposals": {
      const { values } = parseArgs({
        args: rest,
        options: { type: { type: "string" }, status: { type: "string" }, project: { type: "string" } },
      });
      const items = store.list({
        type: values.type as EntryType | undefined,
        status: cmd === "proposals" ? "proposed" : ((values.status as EntryStatus | "any" | undefined) ?? "any"),
        project: values.project,
      });
      if (items.length === 0) console.log("(none)");
      for (const m of items) {
        console.log(`${m.id}  [${m.type}/${m.status}]  ${m.title}${m.project ? `  (${m.project})` : ""}${m.source ? `  <${m.source}>` : ""}`);
      }
      return 0;
    }
    case "add":
    case "propose": {
      const { values } = parseArgs({
        args: rest,
        options: {
          type: { type: "string" }, title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" },
          tags: { type: "string" }, project: { type: "string" }, source: { type: "string" },
        },
      });
      const type = values.type as EntryType;
      if (!ENTRY_TYPES.includes(type)) {
        console.error(`--type must be one of ${ENTRY_TYPES.join("|")}`);
        return 2;
      }
      if (!values.title) {
        console.error("--title required");
        return 2;
      }
      const body = values["body-file"] ? fs.readFileSync(values["body-file"], "utf8") : (values.body ?? "");
      if (!body.trim()) {
        console.error("--body or --body-file required");
        return 2;
      }
      const input = {
        type, title: values.title, body,
        tags: values.tags?.split(",").map((s) => s.trim()).filter(Boolean),
        project: values.project, source: values.source ?? "cli",
      };
      const e = cmd === "add" ? store.write(input) : store.propose(input);
      console.log(`${cmd === "add" ? "added" : "proposed"} ${e.meta.id} -> ${e.file}`);
      return 0;
    }
    case "update": {
      const id = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          title: { type: "string" }, append: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" },
          tags: { type: "string" }, project: { type: "string" },
        },
      });
      const e = store.update(id ?? "", {
        title: values.title, append: values.append,
        body: values["body-file"] ? fs.readFileSync(values["body-file"], "utf8") : values.body,
        tags: values.tags?.split(",").map((s) => s.trim()).filter(Boolean),
        project: values.project,
      });
      console.log(`updated ${e.meta.id}`);
      return 0;
    }
    case "approve": {
      const e = store.approve(rest[0] ?? "", { source: "cli" });
      console.log(`approved ${e.meta.id} -> ${e.file}`);
      return 0;
    }
    case "reject": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: "string" } } });
      const e = store.reject(positionals[0] ?? "", values.reason);
      console.log(`rejected ${e.meta.id}`);
      return 0;
    }
    case "remove": {
      console.log(store.remove(rest[0] ?? "") ? `removed ${rest[0]}` : `not found: ${rest[0]}`);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      process.stdout.write(MEMORY_HELP);
      return 2;
  }
}

async function seed(store: MemoryStore): Promise<void> {
  store.write({
    type: "convention",
    title: "공유 기억 작성 규칙: 제목은 검색할 문장, 본문은 문제/해결/적용",
    tags: ["gencouncil", "memory", "convention"],
    source: "seed",
    body: `## 규칙

- 제목(title)은 나중에 내가 검색창에 칠 문장으로 쓴다. 예: "ffmpeg가 PATH에 없을 때 실행 경로"
- 본문은 세 절로 쓴다.
  - ## 문제 : 어떤 상황에서 무엇이 안 됐는지
  - ## 해결 : 무엇으로 해결했는지 (명령, 경로, 설정값을 그대로)
  - ## 적용 방법 : 다른 프로젝트에서 재사용할 때 바꿔야 하는 부분, 주의점
- tags는 소문자 키워드: 도구 이름, 오류 이름, 분야
- 한 프로젝트에만 해당하면 project를 채운다. 비워 두면 Space 전체에 적용되는 기억이다.
- 위원(member)은 memory_propose로 제안만 한다. 승인은 owner/chair가 한다.`,
  });
  store.write({
    type: "tool",
    title: "GenCouncil 공유 기억 위치와 CLI 사용법",
    tags: ["gencouncil", "mcp", "cli"],
    source: "seed",
    body: `## 위치

- 기억 원본: \`${store.dir}\` (markdown, git 관리)
- MCP 서버: \`${serverEntry()}\`
- CLI: \`gencouncil <command>\` (저장소에서 \`npm run gencouncil -- <command>\`)

## 자주 쓰는 명령

\`\`\`
gencouncil search "검색어"
gencouncil add --type solution --title "..." --body-file note.md --tags a,b
gencouncil proposals / approve <id> / reject <id>
gencouncil install claude|gemini
\`\`\``,
  });
}
