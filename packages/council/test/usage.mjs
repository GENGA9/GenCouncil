// Usage parsers and the Antigravity CLI driver helpers (no network, no CLIs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.GENCOUNCIL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-usage-"));
const { AccountRegistry, agyModelId, applyUsageToAccounts, makeAgyParser, parseAgyUsage, parseCodexRateLimits } = await import("@gencouncil/council");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

// agy -p /usage output (tab separated, remaining %)
const agy = parseAgyUsage(
  [
    "Gemini Models\tWeekly Limit Remaining\t59%\t2026-10-24T03:07:27Z",
    "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-22T17:58:37Z",
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-29T12:58:37Z",
    "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t60%\t2026-10-24T23:33:59Z",
  ].join("\r\n"),
);
check("agy weekly used = 41%", agy.weekly?.usedPct === 41 && agy.weekly.resetsAt === "2026-10-24T03:07:27Z", JSON.stringify(agy));
check("agy 5h used = 0%", agy.fiveHour?.usedPct === 0 && !agy.error);
check("agy details keep every limit, Argon included", agy.details?.length === 4 && agy.details[3].group === "Gemini 4 Argon" && agy.details[3].usedPct === 40, JSON.stringify(agy.details));
check("agy garbage -> error", Boolean(parseAgyUsage("not logged in").error));

// codex account/rateLimits/read
const weeklyOnly = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793084698 }, secondary: null } });
check("codex weekly-only plan", weeklyOnly.weekly?.usedPct === 100 && !weeklyOnly.fiveHour && weeklyOnly.noFiveHour === true, JSON.stringify(weeklyOnly));
const both = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 12.4, windowDurationMins: 300 }, secondary: { usedPercent: 30, windowDurationMins: 10080 } } });
check("codex 5h + weekly", both.fiveHour?.usedPct === 12 && both.weekly?.usedPct === 30 && !both.noFiveHour);

// model id with effort suffix
check("agy model + effort", agyModelId("gemini-4-argon", "high") === "gemini-4-argon-high" && agyModelId("gemini-3.8-flash", "max") === "gemini-3.8-flash-high" && agyModelId("gemini-3.8-flash", undefined) === "gemini-3.8-flash-medium");
check("agy model keeps explicit suffix", agyModelId("gemini-4-argon-low", "high") === "gemini-4-argon-low");

check("hydrogen high suffix", agyModelId("gemini-4-hydrogen", "high") === "gemini-4-hydrogen-high");
check("hydrogen xhigh and max clamp", agyModelId("gemini-4-hydrogen", "xhigh") === "gemini-4-hydrogen-xhigh" && agyModelId("gemini-4-hydrogen", "max") === "gemini-4-hydrogen-xhigh");
check("hydrogen explicit xhigh suffix kept once", agyModelId("gemini-4-hydrogen-xhigh", "low") === "gemini-4-hydrogen-xhigh");
check("other gemini models clamp xhigh", agyModelId("gemini-4-argon", "xhigh") === "gemini-4-argon-high" && agyModelId("gemini-3.8-flash-xhigh", "low") === "gemini-3.8-flash-high");

// stream-json from a real `agy -p ... --output-format stream-json` run
const parse = makeAgyParser();
const lines = [
  '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.8-flash-low","cwd":"x"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"run_command"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"run_command"}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"do"}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"ne\\n"}}',
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"done\\n"}}',
];
const evs = lines.flatMap((l) => parse(l));
check("agy init model", evs[0]?.kind === "init" && evs[0].model === "gemini-3.8-flash-low");
check("agy tool once", evs.filter((e) => e.kind === "tool").length === 1 && evs.find((e) => e.kind === "tool").name === "run_command");
check("agy text joined from deltas", evs.some((e) => e.kind === "text" && e.text === "done"), JSON.stringify(evs));
check("agy result ok", evs.at(-1).kind === "result" && evs.at(-1).isError === false);
check("agy failed result", makeAgyParser()('{"event":"result","result":{"status":"ERROR","response":"quota exceeded"}}')[0].isError === true);

// ---- stale limits: a model block ends at its reset, and a past error does not linger ----
{
  const reg = new AccountRegistry();
  reg.upsert({ id: "gemini", provider: "gemini" });
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  reg.blockModel("gemini", "gemini-4-argon", "quota", future);
  check("a live block steps down to the model below", reg.fitModel("gemini", "gemini-4-argon") === "gemini-4-hydrogen");
  reg.setModelBlock("gemini", "gemini-4-argon", past);
  check("a block past its reset is over", reg.fitModel("gemini", "gemini-4-argon") === "gemini-4-argon", JSON.stringify(reg.get("gemini")));

  // a usage check with room: the old error goes, and the per-model limit decides the block
  reg.markExhausted("gemini", "Individual quota reached. Resets in 121h5m54s.", future);
  applyUsageToAccounts(reg, [{ provider: "gemini", account: "gemini", checkedAt: new Date().toISOString(), weekly: { usedPct: 20 }, fiveHour: { usedPct: 0 }, details: [
    { group: "Gemini Models", label: "Weekly Limit Remaining", usedPct: 20 },
    { group: "Gemini 4 Argon", label: "Gemini 4 Argon Weekly Limit", usedPct: 100, resetsAt: future },
  ] }]);
  check("room on the account clears the old error", reg.get("gemini").status === "ok" && !reg.get("gemini").lastError, JSON.stringify(reg.get("gemini")));
  check("a spent per-model limit blocks that model only", reg.fitModel("gemini", "gemini-4-argon") === "gemini-4-hydrogen");
  applyUsageToAccounts(reg, [{ provider: "gemini", account: "gemini", checkedAt: new Date().toISOString(), weekly: { usedPct: 20 }, details: [
    { group: "Gemini 4 Argon", label: "Gemini 4 Argon Weekly Limit", usedPct: 19 },
  ] }]);
  check("the model comes back when it has room again", reg.fitModel("gemini", "gemini-4-argon") === "gemini-4-argon", JSON.stringify(reg.get("gemini")));
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall usage checks passed");
process.exitCode = failed ? 1 : 0;
