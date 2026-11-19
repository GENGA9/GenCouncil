// Past member results per model and reasoning level: what counts, what is left out, and what the chair is shown.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { effortStats, effortStatsMarkdown, statModel } from "@gencouncil/council";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-effortstats-"));
const t0 = Date.parse("2026-11-01T00:00:00Z");
let seq = 0;
/** a finished member: `minutes` long, `calls` tool calls */
const member = (o) => {
  const id = o.id ?? `${o.provider ?? "claude"}-${++seq}`;
  return {
    id,
    provider: "claude",
    model: "sonnet",
    effort: "medium",
    taskId: "t1",
    branch: "b",
    worktree: "w",
    status: "done",
    toolCalls: o.calls ?? 10,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(t0 + (o.minutes ?? 5) * 60000).toISOString(),
    ...o,
    id,
  };
};
const write = (project, agenda, members) => {
  const dir = path.join(tmp, project, "agendas", agenda);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.json"), JSON.stringify(members));
  return path.join(dir, "members.json");
};

write("p1", "a1", [
  // sonnet medium: 3 done (calls 10, 20, 30), 1 failed for its own reasons
  member({ calls: 10, minutes: 2 }),
  member({ calls: 20, minutes: 4 }),
  member({ calls: 30, minutes: 6 }),
  member({ status: "failed", failure: { kind: "other", message: "boom" }, calls: 99, minutes: 60 }),
  // cut by quota and handed over automatically: not the model's fault
  member({ id: "q1", status: "failed", failure: { kind: "quota", message: "limit" }, handoverTo: "q2" }),
  member({ id: "q2", handoverFrom: "q1", handoverCause: "quota" }),
  // restarted mid-run: the first half is not a result
  member({ id: "r1", status: "handed_over", handoverTo: "r2" }),
  member({ id: "r2", handoverFrom: "r1", handoverCause: "resume" }),
  // an old record: handed over, nobody wrote down why
  member({ id: "o1", status: "handed_over", handoverTo: "o2" }),
  member({ id: "o2", handoverFrom: "o1" }),
  // the chair took it away from this one
  member({ id: "m1", status: "handed_over", handoverTo: "m2" }),
  member({ id: "m2", handoverFrom: "m1", handoverCause: "manual" }),
  // none of these is a result
  member({ verifyOf: "x" }),
  member({ status: "stopped", interrupted: true }),
  member({ status: "running", endedAt: undefined }),
  member({ provider: "relay", model: undefined }),
]);
write("p2", "a1", [
  member({ provider: "gpt", model: "gpt-6.1-sol", effort: "high", kind: "complex" }),
  member({ provider: "gpt", model: "gpt-6.2-sol", effort: "high", kind: "complex" }),
  member({ provider: "gpt", model: "gpt-6.2-sol", effort: "high", kind: "routine", status: "stopped" }),
  member({ provider: "gemini", model: "gemini-4-neon-xhigh", effort: "xhigh", kind: "complex" }),
  member({ provider: "claude", model: "claude-opus-5-5", effort: "high" }),
]);
fs.mkdirSync(path.join(tmp, "p3", "agendas", "broken"), { recursive: true });
fs.writeFileSync(path.join(tmp, "p3", "agendas", "broken", "members.json"), "{ not json");

const rows = effortStats(tmp);
const find = (model, effort, kind) => rows.find((r) => r.model === model && r.effort === effort && r.kind === kind);

const sm = find("sonnet", "medium", undefined);
// counted: 3 done + failed + q1 (cut) + q2 + r2 + o2 + m1 (trouble) + m2 = 10
check("restarts, unexplained old handovers, checks and unfinished members are left out", sm?.n === 10, JSON.stringify(sm));
check("done, cut and trouble are told apart", sm?.donePct === 70 && sm?.cutPct === 10 && sm?.troublePct === 20, JSON.stringify(sm));
check("cost is the median of the members that finished", sm?.calls === 10 && sm?.minutes === 5, JSON.stringify(sm));
check("a broken file does not stop the count", rows.length > 0);

check("model generations stay apart", find("gpt-6.1-sol", "high", undefined)?.n === 1 && find("gpt-6.2-sol", "high", undefined)?.n === 2);
check("kinds get their own lines next to the total", find("gpt-6.2-sol", "high", "complex")?.n === 1 && find("gpt-6.2-sol", "high", "routine")?.troublePct === 100);
check("records without a kind only count in the total", !rows.some((r) => r.model === "sonnet" && r.kind));
check("the agy effort suffix and full claude ids fold into the model", statModel("gemini", "gemini-4-neon-xhigh") === "gemini-4-neon" && statModel("claude", "claude-opus-5-5") === "opus" && Boolean(find("gemini-4-neon", "xhigh", "complex")) && Boolean(find("opus", "high", undefined)));
check("ladder order: claude, gemini, gpt; lower rungs first", rows.map((r) => r.model).filter((m, i, a) => a.indexOf(m) === i).join() === "sonnet,opus,gemini-4-neon,gpt-6.1-sol,gpt-6.2-sol", rows.map((r) => r.model).join());

const md = effortStatsMarkdown(rows);
check("the table shows only lines with enough results", md.includes("| sonnet | medium | 전체 | 10 | 70% | 10% | 20% | 10 | 5 |") && !md.includes("gpt-6.2-sol") && !md.includes("opus"), md);
const all = effortStatsMarkdown(rows, { minN: 1, minKindN: 1 });
check("lower thresholds show the rest, kinds included", all.includes("| gpt-6.2-sol | high | complex | 1 |") && all.includes("| gemini-4-neon | xhigh | complex | 1 |"));
check("models outside the limits are left out", !effortStatsMarkdown(rows, { minN: 1, minKindN: 1, allow: (p) => p !== "gpt" }).includes("gpt-6"));
check("nothing to show is an empty string", effortStatsMarkdown(rows, { minN: 1000 }) === "" && effortStatsMarkdown(effortStats(path.join(tmp, "nowhere"))) === "");

// a changed file is read again
const f = write("p2", "a2", [member({ provider: "gpt", model: "gpt-6.2-astra", effort: "high" })]);
check("a new agenda is picked up", effortStats(tmp).find((r) => r.model === "gpt-6.2-astra")?.n === 1);
fs.writeFileSync(f, JSON.stringify([member({ provider: "gpt", model: "gpt-6.2-astra", effort: "high" }), member({ provider: "gpt", model: "gpt-6.2-astra", effort: "high", calls: 1 })]));
check("a rewritten file is counted again", effortStats(tmp).find((r) => r.model === "gpt-6.2-astra")?.n === 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall effort stats checks passed");
process.exitCode = failed ? 1 : 0;
