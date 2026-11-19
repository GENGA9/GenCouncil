/**
 * How past members did, per model and reasoning level: what the chair needs to tell whether a
 * higher level earns its cost. Read from the member records of every project, because a model
 * behaves the same whichever project it works in.
 */
import fs from "node:fs";
import path from "node:path";
import { projectsDir, TASK_KINDS, type MemberRecord, type TaskKind } from "./model.js";
import { CLI_PROVIDERS, EFFORTS, tierOf, type CliProvider } from "./models.js";

/**
 * done: finished its task. cut: its login ran out or stopped working, which says nothing about the
 * work. trouble: handed over for another reason, failed, or stopped by someone.
 */
type Outcome = "done" | "cut" | "trouble";

interface Sample {
  provider: CliProvider;
  model: string;
  effort: string;
  kind?: TaskKind;
  outcome: Outcome;
  calls: number;
  minutes: number;
}

export interface EffortStatRow {
  provider: CliProvider;
  model: string;
  effort: string;
  /** undefined: every kind together, including records from before kinds were written down */
  kind?: TaskKind;
  n: number;
  donePct: number;
  cutPct: number;
  troublePct: number;
  /** medians over the members that finished (over all of them when none did) */
  calls: number;
  minutes: number;
}

/**
 * The name results are counted under. Generations stay apart (gpt-6.1-sol and gpt-6.2-sol are two
 * rows): what held for one model is not assumed for the next. Claude ids fold into their alias,
 * which is all older records carry.
 */
export function statModel(provider: CliProvider, model: string): string {
  let m = model.trim().toLowerCase();
  if (provider === "gemini") m = m.replace(/-(low|medium|high|xhigh)$/, "");
  if (provider === "claude") {
    const alias = /haiku|sonnet|opus|fable|mythos/.exec(m)?.[0];
    if (alias) m = alias === "mythos" ? "fable" : alias;
  }
  return m;
}

function samplesOf(members: MemberRecord[]): Sample[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: Sample[] = [];
  for (const m of members) {
    if (!m || !(CLI_PROVIDERS as readonly string[]).includes(m.provider) || !m.model) continue;
    // still running, cut off by a shutdown, or a check of someone else's work: not a result of its own
    if (!m.endedAt || m.interrupted || m.verifyOf) continue;
    let outcome: Outcome;
    if (m.status === "done") outcome = "done";
    else if (m.handoverTo) {
      const failed = m.failure?.kind === "quota" || m.failure?.kind === "auth" ? m.failure.kind : undefined;
      const cause = byId.get(m.handoverTo)?.handoverCause ?? failed;
      // the same work went on after a restart; and a record from before causes were written down
      // cannot tell a restart from a rescue, so it is left out rather than counted against the model
      if (cause === "resume" || cause === undefined) continue;
      outcome = cause === "manual" ? "trouble" : "cut";
    } else if (m.status === "failed" || m.status === "stopped") {
      outcome = m.failure?.kind === "quota" || m.failure?.kind === "auth" ? "cut" : "trouble";
    } else continue;
    const provider = m.provider as CliProvider;
    const minutes = (Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60000;
    out.push({
      provider,
      model: statModel(provider, m.model),
      effort: m.effort ?? "-",
      kind: (TASK_KINDS as readonly string[]).includes(m.kind ?? "") ? m.kind : undefined,
      outcome,
      calls: m.toolCalls ?? 0,
      minutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : 0,
    });
  }
  return out;
}

/** one entry per members.json, re-read only when the file changed: there are hundreds, some large */
const cache = new Map<string, { mtimeMs: number; size: number; samples: Sample[] }>();

function fileSamples(file: string): Sample[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(file);
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.samples;
  let samples: Sample[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) samples = samplesOf(parsed as MemberRecord[]);
  } catch {
    /* a file being written, or a broken one: counted next time */
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, samples });
  return samples;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function row(key: Pick<EffortStatRow, "provider" | "model" | "effort" | "kind">, group: Sample[]): EffortStatRow {
  const pct = (o: Outcome) => Math.round((100 * group.filter((s) => s.outcome === o).length) / group.length);
  const done = group.filter((s) => s.outcome === "done");
  const cost = done.length ? done : group;
  return { ...key, n: group.length, donePct: pct("done"), cutPct: pct("cut"), troublePct: pct("trouble"), calls: Math.round(median(cost.map((s) => s.calls))), minutes: Math.round(median(cost.map((s) => s.minutes))) };
}

const rank = (list: readonly string[], v: string | undefined) => (v === undefined ? -1 : list.indexOf(v) < 0 ? list.length : list.indexOf(v));

/** Every model × level, all kinds together and then per kind, in ladder order. */
export function effortStats(root = projectsDir()): EffortStatRow[] {
  const samples: Sample[] = [];
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const p of projects) {
    const agendas = path.join(root, p, "agendas");
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(agendas);
    } catch {
      continue;
    }
    for (const a of slugs) samples.push(...fileSamples(path.join(agendas, a, "members.json")));
  }
  const groups = new Map<string, { key: Pick<EffortStatRow, "provider" | "model" | "effort" | "kind">; list: Sample[] }>();
  const add = (s: Sample, kind: TaskKind | undefined) => {
    const id = `${s.provider}\n${s.model}\n${s.effort}\n${kind ?? ""}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { key: { provider: s.provider, model: s.model, effort: s.effort, kind }, list: [] }));
    g.list.push(s);
  };
  for (const s of samples) {
    add(s, undefined);
    if (s.kind) add(s, s.kind);
  }
  return [...groups.values()]
    .map((g) => row(g.key, g.list))
    .sort(
      (a, b) =>
        rank(CLI_PROVIDERS, a.provider) - rank(CLI_PROVIDERS, b.provider) ||
        tierOf(a.provider, a.model) - tierOf(b.provider, b.model) ||
        a.model.localeCompare(b.model) ||
        rank(EFFORTS, a.effort) - rank(EFFORTS, b.effort) ||
        rank(TASK_KINDS, a.kind) - rank(TASK_KINDS, b.kind),
    );
}

export interface EffortStatsView {
  /** leave out models this project may not use */
  allow?: (provider: CliProvider, model: string) => boolean;
  /** fewest results for a model × level line (default 10) and for a per-kind line (default 5) */
  minN?: number;
  minKindN?: number;
}

/** The table the chair reads under the effort rules; empty when nothing has enough results. */
export function effortStatsMarkdown(rows: EffortStatRow[], view: EffortStatsView = {}): string {
  const minN = view.minN ?? 10;
  const minKindN = view.minKindN ?? 5;
  const shown = rows.filter((r) => r.n >= (r.kind ? minKindN : minN) && (view.allow?.(r.provider, r.model) ?? true));
  if (!shown.length) return "";
  const lines = shown.map((r) => `| ${r.model} | ${r.effort} | ${r.kind ?? "전체"} | ${r.n} | ${r.donePct}% | ${r.cutPct}% | ${r.troublePct}% | ${r.calls} | ${r.minutes} |`);
  return `지금까지 위원 실적 (모든 프로젝트의 끝난 위원. tool call과 분은 완주한 위원의 중앙값이다)
| 모델 | 추론 | 유형 | 건수 | 완주 | 한도·로그인으로 끊김 | 인계·실패·중단 | tool call | 분 |
|---|---|---|---|---|---|---|---|---|
${lines.join("\n")}
- 높은 수준에는 더 어려운 일이 갔다. 완주율은 수준끼리 그대로 비교하지 않고, 유형이 같은 줄끼리 비교한다. '전체' 줄은 유형을 적기 전 기록까지 합친 것이다.
- 같은 유형에서 한 단계 위 수준의 완주율이 눈에 띄게 높지 않으면 아래 수준으로 시작한다. 건수가 적은 줄은 참고만 한다.`;
}
