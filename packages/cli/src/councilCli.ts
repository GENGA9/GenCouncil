import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MemoryStore } from "@gencouncil/core";
import { spawnSync } from "node:child_process";
import {
  AccountRegistry,
  AgendaRuntime,
  AgendaStore,
  Chair,
  Council,
  ProjectRegistry,
  currentBranch,
  findExecutable,
  hasCommits,
  isRepo,
  memberDisplayName,
  projectDir,
  runChat,
  startCouncilHttp,
  type Autonomy,
  type CliProvider,
  type MemberRecord,
  type Provider,
} from "@gencouncil/council";

export const COUNCIL_HELP = `council commands
  project add <name> --repo <path> [--base <branch>] [--chair-model m] [--chair-effort e] [--chair-advisor a]
                     [--autonomy full|edits] [--provider claude|gemini] [--member-model m] [--member-advisor a]
                     (defaults: chair sonnet + advisor opus; claude members sonnet + advisor opus + haiku explorers)
  project list | project show <project> | project guidelines <project>   (prints path to edit)
  project set <project> [--chair-model m] [--chair-advisor a] [--member-model m] [--member-advisor a]
                        [--explorers on|off] [--autonomy ..] [--provider ..] [--fallback-provider ..]
  agenda add <project> "<title>" --goal "..." [--goal "..."]
  agenda list <project>
  council chat <project> <agenda> [--chair-model m] [--chair-effort e]   talk to the chair (REPL)
  council status <project> <agenda>
  council run <project> <agenda> --task "<title>" --instructions "<brief>" [--provider p] [--model m] [--account a]
                     run ONE member directly (no chair), wait, print result
  council merge <project> <agenda> <member>
  council finish <project> <agenda> [--retro] merge agenda branch into base branch, remove worktrees
                     (--retro: the chair first writes lessons/personas to shared memory and reviews proposals)
  council clean <project> <agenda> [--delete-branches]
  council handover <project> <agenda> <member> [--provider p] [--account a] [--model m]
                     continue a failed/stopped member's task in the same worktree with a new member
  council relay packet <project> <agenda> <member>            print the packet to paste into a web AI
  council relay submit <project> <agenda> <member> --file answer.txt [--result-file r.md]
                     apply the web AI's answer (FILE/RESULT blocks) and finish the relay member
  account add <id> --provider claude|gemini --config-dir <dir> [--priority n] [--note ..]
  account list | account reset <id> | account remove <id>
  account login <id>   open the CLI interactively on that account (claude: type /login; gemini: follow the prompt)
`;

export const COUNCIL_COMMANDS = new Set(["project", "agenda", "council", "account"]);

const registry = new ProjectRegistry();

function requireProject(ref: string | undefined) {
  if (!ref) throw new Error("project required");
  const p = registry.get(ref);
  if (!p) throw new Error(`unknown project: ${ref} (gencouncil project list)`);
  return p;
}

function requireAgenda(projectRef: string | undefined, agendaRef: string | undefined) {
  const p = requireProject(projectRef);
  if (!agendaRef) throw new Error("agenda required");
  const a = AgendaStore.find(p, agendaRef);
  if (!a) throw new Error(`unknown agenda: ${agendaRef} (gencouncil agenda list ${p.id})`);
  return { project: p, store: a };
}

async function openCouncil(projectRef: string | undefined, agendaRef: string | undefined): Promise<Council> {
  const { store } = requireAgenda(projectRef, agendaRef);
  const memory = new MemoryStore({ watch: true });
  await memory.init();
  const council = new Council(store, memory);
  await council.open();
  return council;
}

function printMember(m: MemberRecord): void {
  console.log(`${m.id} ${memberDisplayName(m)}${m.account ? ` @${m.account}` : ""} [${m.status}${m.merged ? ", merged" : ""}] task=${m.taskId} tools=${m.toolCalls} commits=${m.commits?.length ?? 0}`);
  console.log(`  branch   : ${m.branch}`);
  console.log(`  worktree : ${m.worktree}`);
  if (m.diffstat) console.log(`  diffstat :\n    ${m.diffstat.split("\n").join("\n    ")}`);
  if (m.result?.summary) console.log(`  결과     : ${m.result.summary.split("\n").join("\n             ")}`);
  if (m.result?.unfinished) console.log(`  미완료   : ${m.result.unfinished.split("\n").join("\n             ")}`);
  if (m.result?.proposals.length) console.log(`  기억 제안: ${m.result.proposals.length}건 (gencouncil proposals)`);
  if (m.error) console.log(`  오류     : ${m.error}`);
}

export async function councilMain(cmd: string, rest: string[]): Promise<number> {
  const sub = rest[0];
  const args = rest.slice(1);

  // ---------- project ----------
  if (cmd === "project") {
    switch (sub) {
      case "add": {
        const { values, positionals } = parseArgs({
          args,
          allowPositionals: true,
          options: {
            repo: { type: "string" }, base: { type: "string" }, "chair-model": { type: "string" }, "chair-effort": { type: "string" },
            "chair-advisor": { type: "string" }, "chair-account": { type: "string" }, autonomy: { type: "string" }, provider: { type: "string" },
            "member-model": { type: "string" }, "member-advisor": { type: "string" },
          },
        });
        const name = positionals.join(" ").trim();
        if (!name || !values.repo) throw new Error("usage: project add <name> --repo <path>");
        const repo = path.resolve(values.repo);
        if (!(await isRepo(repo))) throw new Error(`not a git repository: ${repo} (run git init + first commit)`);
        if (!(await hasCommits(repo))) throw new Error(`repository has no commits yet: ${repo}`);
        const base = values.base ?? (await currentBranch(repo));
        const p = registry.add({
          name, repo, baseBranch: base,
          chairModel: values["chair-model"], chairEffort: values["chair-effort"], chairAdvisor: values["chair-advisor"], chairAccount: values["chair-account"],
          autonomy: values.autonomy as Autonomy | undefined, defaultProvider: values.provider as CliProvider | undefined,
          claudeModel: values["member-model"], claudeAdvisor: values["member-advisor"],
        });
        console.log(`project ${p.id} -> ${projectDir(p.id)}`);
        console.log(`guidelines: ${registry.guidelinesPath(p)}`);
        return 0;
      }
      case "list": {
        const all = registry.list();
        if (!all.length) console.log("(no projects)");
        for (const p of all)
          console.log(
            `${p.id}  "${p.name}"  repo=${p.repo}  base=${p.baseBranch}  chair=${p.chair.model ?? "default"}/${p.chair.effort ?? "default"}${p.chair.advisor ? "+" + p.chair.advisor : ""}  members=${p.members.claudeModel ?? "default"}${p.members.claudeAdvisor ? "+" + p.members.claudeAdvisor : ""}`,
          );
        return 0;
      }
      case "set": {
        const { values, positionals } = parseArgs({
          args, allowPositionals: true,
          options: {
            "chair-model": { type: "string" }, "chair-effort": { type: "string" }, "chair-advisor": { type: "string" }, "chair-account": { type: "string" },
            "member-model": { type: "string" }, "member-advisor": { type: "string" }, explorers: { type: "string" }, autonomy: { type: "string" },
            provider: { type: "string" }, "fallback-provider": { type: "string" },
          },
        });
        const p = requireProject(positionals[0]);
        const v = values;
        if (v["chair-model"] !== undefined) p.chair.model = v["chair-model"] || undefined;
        if (v["chair-effort"] !== undefined) p.chair.effort = v["chair-effort"] || undefined;
        if (v["chair-advisor"] !== undefined) p.chair.advisor = v["chair-advisor"];
        if (v["chair-account"] !== undefined) p.chair.account = v["chair-account"] || undefined;
        if (v["member-model"] !== undefined) p.members.claudeModel = v["member-model"] || undefined;
        if (v["member-advisor"] !== undefined) p.members.claudeAdvisor = v["member-advisor"];
        if (v.explorers !== undefined) p.members.explorers = v.explorers !== "false" && v.explorers !== "off";
        if (v.autonomy) p.members.autonomy = v.autonomy as Autonomy;
        if (v.provider) p.members.defaultProvider = v.provider as CliProvider;
        if (v["fallback-provider"] !== undefined) p.members.fallbackProvider = (v["fallback-provider"] as CliProvider) || undefined;
        registry.save(p);
        console.log(JSON.stringify({ chair: p.chair, members: p.members }, null, 2));
        return 0;
      }
      case "show": {
        const p = requireProject(args[0]);
        console.log(JSON.stringify(p, null, 2));
        for (const a of AgendaStore.list(p)) console.log(`agenda ${a.slug} [${a.status}] "${a.title}" branch=${a.branch}`);
        return 0;
      }
      case "guidelines": {
        const p = requireProject(args[0]);
        console.log(registry.guidelinesPath(p));
        return 0;
      }
      default:
        process.stdout.write(COUNCIL_HELP);
        return 2;
    }
  }

  // ---------- agenda ----------
  if (cmd === "agenda") {
    switch (sub) {
      case "add": {
        const { values, positionals } = parseArgs({
          args, allowPositionals: true,
          options: { goal: { type: "string", multiple: true } },
        });
        const p = requireProject(positionals[0]);
        const title = positionals.slice(1).join(" ").trim();
        if (!title) throw new Error('usage: agenda add <project> "<title>" --goal "..."');
        const store = AgendaStore.create(p, title, values.goal ?? []);
        const a = store.agenda();
        console.log(`agenda ${a.slug} "${a.title}" branch=${a.branch} goals=${a.goals.length}`);
        return 0;
      }
      case "list": {
        const p = requireProject(args[0]);
        const all = AgendaStore.list(p);
        if (!all.length) console.log("(no agendas)");
        for (const a of all) console.log(`${a.slug} [${a.status}] "${a.title}" goals=${a.goals.length} branch=${a.branch}`);
        return 0;
      }
      default:
        process.stdout.write(COUNCIL_HELP);
        return 2;
    }
  }

  // ---------- account ----------
  if (cmd === "account") {
    const accounts = new AccountRegistry();
    switch (sub) {
      case "add": {
        const { values, positionals } = parseArgs({
          args, allowPositionals: true,
          options: { provider: { type: "string" }, "config-dir": { type: "string" }, priority: { type: "string" }, note: { type: "string" } },
        });
        const id = positionals[0];
        if (!id || !values.provider || !values["config-dir"]) throw new Error("usage: account add <id> --provider claude|gemini --config-dir <dir>");
        if (!["claude", "gemini"].includes(values.provider)) throw new Error("--provider must be claude or gemini");
        const dir = path.resolve(values["config-dir"]);
        fs.mkdirSync(dir, { recursive: true });
        const a = accounts.upsert({
          id, provider: values.provider as CliProvider, configDir: dir,
          priority: values.priority ? Number(values.priority) : undefined, note: values.note,
        });
        console.log(`account ${a.id} saved (${a.provider}, ${a.configDir})`);
        console.log(`next: gencouncil account login ${a.id}`);
        return 0;
      }
      case "reset":
        console.log(`${accounts.markOk(args[0] ?? "").id}: ok`);
        return 0;
      case "remove":
        console.log(accounts.remove(args[0] ?? "") ? `removed ${args[0]}` : `not found: ${args[0]}`);
        return 0;
      case "login": {
        const a = accounts.get(args[0] ?? "");
        if (!a) throw new Error(`unknown account: ${args[0]}`);
        const exe = findExecutable(a.provider);
        if (!exe) throw new Error(`${a.provider} CLI not found on PATH`);
        const env = { ...process.env, ...accounts.env(a) };
        delete env.CLAUDECODE;
        console.log(`opening ${a.provider} on account ${a.id}${a.configDir ? ` (${a.configDir})` : ""}. ${a.provider === "claude" ? "Type /login, finish in the browser, then /exit." : "Follow the login prompt, then type /quit."}`);
        const r = spawnSync(exe, [], { stdio: "inherit", env, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(exe) });
        if (r.status === 0) accounts.markOk(a.id);
        return r.status ?? 1;
      }
      default: {
        for (const a of accounts.list()) {
          const extra = a.status === "exhausted" ? `  reset ${a.resetAt}` : a.lastError ? `  ${a.lastError.slice(0, 80)}` : "";
          console.log(`${a.id.padEnd(14)} ${a.provider.padEnd(7)} ${a.status.padEnd(10)} ${a.configDir ?? "(default login)"}${extra}`);
        }
        return 0;
      }
    }
  }

  // ---------- council ----------
  switch (sub) {
    case "chat": {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { "chair-model": { type: "string" }, "chair-effort": { type: "string" } },
      });
      const council = await openCouncil(positionals[0], positionals[1]);
      const http = await startCouncilHttp(council);
      const chair = new Chair(council, { councilUrl: http.url, model: values["chair-model"], effort: values["chair-effort"] });
      const rt = new AgendaRuntime(council, chair);
      try {
        await runChat(rt);
      } finally {
        await http.close();
      }
      return 0;
    }
    case "status": {
      const { store } = requireAgenda(args[0], args[1]);
      const a = store.agenda();
      console.log(`${a.title} [${a.status}] branch=${a.branch} base=${a.baseBranch}`);
      a.goals.forEach((g, i) => console.log(`  목표 ${i + 1}: ${g}`));
      console.log("작업:");
      for (const t of store.tasks()) console.log(`  ${t.id} [${t.status}] ${t.title}${t.memberId ? " ← " + t.memberId : ""}${t.note ? "  (" + t.note + ")" : ""}`);
      console.log("위원:");
      for (const m of store.members()) printMember(m);
      const st = store.chairState();
      if (st) console.log(`의장 state.md:\n${st}`);
      return 0;
    }
    case "run": {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: {
          task: { type: "string" }, instructions: { type: "string" }, "instructions-file": { type: "string" },
          provider: { type: "string" }, model: { type: "string" }, account: { type: "string" },
        },
      });
      const instructions = values["instructions-file"] ? fs.readFileSync(values["instructions-file"], "utf8") : values.instructions;
      if (!values.task || !instructions) throw new Error('usage: council run <project> <agenda> --task "<title>" --instructions "<brief>"');
      const council = await openCouncil(positionals[0], positionals[1]);
      council.on("log", (l: string) => console.log(`  [council] ${l}`));
      council.on("member:line", (m: MemberRecord, l: string) => console.log(`  [${m.id}] ${l}`));
      const task = council.addTask({ title: values.task, description: instructions });
      const member = await council.assign({
        taskId: task.id, provider: values.provider as Provider | undefined, model: values.model, account: values.account, instructions,
      });
      console.log(`member ${member.id} running in ${member.worktree}`);
      const done = await council.waitAny(6 * 60 * 60 * 1000);
      council.memory.close();
      for (const m of done) printMember(m);
      return done.every((m) => m.status === "done") ? 0 : 1;
    }
    case "merge": {
      const council = await openCouncil(args[0], args[1]);
      const r = await council.merge(args[2] ?? "");
      council.memory.close();
      console.log(r.ok ? `merged ${r.branch} into agenda branch` : `CONFLICT in: ${r.conflicts.join(", ")}\n${r.output}`);
      return r.ok ? 0 : 1;
    }
    case "finish": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { retro: { type: "boolean" }, "no-retro": { type: "boolean" } } });
      const council = await openCouncil(positionals[0], positionals[1]);
      if (values.retro && !values["no-retro"]) {
        const http = await startCouncilHttp(council);
        const rt = new AgendaRuntime(council, new Chair(council, { councilUrl: http.url }));
        rt.on("event", (e) => {
          if (e.type === "chair:text") console.log(`의장> ${e.text.trim()}`);
          else if (e.type === "chair:tool") console.log(`  · ${e.name}`);
        });
        try {
          const r = await rt.retrospect();
          console.log(r ? (r.isError ? `회고 실패: ${r.text}` : "회고 완료") : "(의장 세션이 없어 회고 생략)");
        } finally {
          await http.close();
        }
      }
      const out = await council.finish();
      council.memory.close();
      console.log(out || "merged");
      console.log("agenda closed; worktrees removed");
      return 0;
    }
    case "clean": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "delete-branches": { type: "boolean" } } });
      const council = await openCouncil(positionals[0], positionals[1]);
      await council.clean({ deleteBranches: values["delete-branches"] });
      council.memory.close();
      console.log("worktrees removed");
      return 0;
    }
    case "handover": {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { provider: { type: "string" }, account: { type: "string" }, model: { type: "string" }, reason: { type: "string" } },
      });
      const council = await openCouncil(positionals[0], positionals[1]);
      council.on("log", (l: string) => console.log(`  [council] ${l}`));
      council.on("member:line", (m: MemberRecord, l: string) => console.log(`  [${m.id}] ${l}`));
      const next = await council.handover(positionals[2] ?? "", {
        provider: values.provider as CliProvider | undefined, account: values.account, model: values.model, reason: values.reason ?? "manual (cli)",
      });
      console.log(`handover → ${next.id} (${next.provider}/${next.account}) on ${next.branch}`);
      const done = await council.waitAny(6 * 60 * 60 * 1000);
      council.memory.close();
      for (const m of done) printMember(m);
      return done.every((m) => m.status === "done") ? 0 : 1;
    }
    case "relay": {
      const action = args[0];
      const council = await openCouncil(args[1], args[2]);
      try {
        if (action === "packet") {
          process.stdout.write(council.relayPacket(args[3] ?? ""));
          return 0;
        }
        if (action === "submit") {
          const { values } = parseArgs({ args: args.slice(4), options: { file: { type: "string" }, "result-file": { type: "string" } } });
          if (!values.file && !values["result-file"]) throw new Error("--file <answer.txt> or --result-file <RESULT.md> required");
          const m = await council.relaySubmit(args[3] ?? "", {
            response: values.file ? fs.readFileSync(values.file, "utf8") : undefined,
            result: values["result-file"] ? fs.readFileSync(values["result-file"], "utf8") : undefined,
          });
          printMember(m);
          return m.status === "done" ? 0 : 1;
        }
        throw new Error("usage: council relay packet|submit <project> <agenda> <member>");
      } finally {
        council.memory.close();
      }
    }
    default:
      process.stdout.write(COUNCIL_HELP);
      return 2;
  }
}
