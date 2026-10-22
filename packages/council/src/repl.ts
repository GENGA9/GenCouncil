import readline from "node:readline";
import { memberDisplayName } from "./model.js";
import type { AgendaRuntime, RuntimeEvent } from "./session.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export async function runChat(rt: AgendaRuntime, opts: { out?: NodeJS.WritableStream } = {}): Promise<void> {
  const out = opts.out ?? process.stdout;
  const print = (s: string) => out.write(s + "\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt(bold("나> "));
  const council = rt.council;

  rt.on("event", (e: RuntimeEvent) => {
    switch (e.type) {
      case "chair:start":
        if (e.role === "event") print(dim("… 위원 이벤트를 의장에게 전달"));
        rl.pause();
        break;
      case "chair:text":
        print(cyan("의장> ") + e.text.trim());
        break;
      case "chair:tool": {
        const brief = e.input ? JSON.stringify(e.input).slice(0, 140) : "";
        print(dim(`  · ${e.name} ${brief}`));
        break;
      }
      case "chair:done":
        if (e.isError) print(yellow("의장 오류: ") + e.text.slice(0, 2000));
        if (e.costUsd !== undefined) print(dim(`  (turn cost $${e.costUsd.toFixed(3)})`));
        rl.resume();
        rl.prompt();
        break;
      case "member:start":
        print(dim(`  [${e.member.id}] ${memberDisplayName(e.member)} 시작 → ${e.member.branch}`));
        break;
      case "member:line":
        print(dim(`  [${e.member}] ${e.line}`));
        break;
      case "member:done":
        print(yellow(`  [${e.member.id}] ${e.member.status} (${e.member.commits?.length ?? 0} commits)`));
        break;
      case "log":
        print(dim(`  [council] ${e.line}`));
        break;
    }
  });

  const help = () =>
    print(dim("명령: /status /tasks /members /log <id> /merge <id> /stop <id> /reset /quit   (그 외 입력은 의장에게 전달)"));

  print(bold(`${council.project.name} · ${council.store.agenda().title}`));
  print(dim(`통합 worktree: ${council.store.integrationWorktree()}`));
  print(dim(`의장: ${rt.chair.model() ?? "(default model)"} effort=${rt.chair.effort() ?? "default"} advisor=${rt.chair.advisor() ?? "off"} account=${rt.chair.account()}`));
  help();

  if (rt.isFirstTurn()) await rt.send("");
  else rl.prompt();

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line.startsWith("/")) {
      const [cmd, ...a] = line.slice(1).split(/\s+/);
      try {
        switch (cmd) {
          case "quit":
          case "exit":
            rl.close();
            return;
          case "help":
            help();
            break;
          case "status": {
            const s = rt.state();
            print(`목표: ${s.agenda.goals.map((g, i) => `${i + 1}. ${g}`).join(" | ")}`);
            print(`작업: ${s.tasks.map((t) => `${t.id}[${t.status}] ${t.title}${t.memberId ? " ← " + t.memberId : ""}`).join("\n      ") || "(없음)"}`);
            print(`위원: ${s.members.map((m) => `${m.id}[${m.status}${m.merged ? ",merged" : ""}]`).join(" ") || "(없음)"}`);
            break;
          }
          case "tasks":
            for (const t of council.store.tasks()) print(`${t.id} [${t.status}] ${t.title}${t.memberId ? " ← " + t.memberId : ""}${t.note ? "  (" + t.note + ")" : ""}`);
            break;
          case "members":
            for (const m of council.members()) print(`${m.id} ${memberDisplayName(m)} [${m.status}${m.merged ? ", merged" : ""}] task=${m.taskId} commits=${m.commits?.length ?? 0} ${m.branch}`);
            break;
          case "log": {
            const info = await council.memberInfo(a[0], { tail: 30 });
            for (const l of info.logTail as string[]) print(dim(l));
            break;
          }
          case "merge": {
            const r = await council.merge(a[0]);
            print(r.ok ? `머지 완료: ${r.branch}` : `충돌: ${r.conflicts.join(", ")}`);
            break;
          }
          case "stop":
            print(council.stopMember(a[0]) ? `${a[0]} 중지` : `${a[0]} 는 실행 중이 아님`);
            break;
          case "reset":
            rt.resetChair();
            print("의장 세션을 초기화했습니다 (state.md는 유지).");
            break;
          default:
            help();
        }
      } catch (e) {
        print(yellow((e as Error).message));
      }
      rl.prompt();
      return;
    }
    try {
      await rt.send(line);
    } catch (e) {
      print(yellow((e as Error).message));
      rl.prompt();
    }
  });

  await new Promise<void>((resolve) => rl.on("close", resolve));
  if (council.runningCount()) print(yellow(`실행 중인 위원 ${council.runningCount()}명을 중지합니다.`));
  rt.close();
}
