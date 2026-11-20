// The layout of the visualization: which rung a member sits on, what is locked, where finished work goes,
// and which step of the loop is lit. No browser: src/vision/scene.ts is bundled here and loaded from memory.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = await build({ entryPoints: [path.join(HERE, "../src/vision/scene.ts")], bundle: true, format: "esm", write: false, logLevel: "silent" });
const { buildScene, FALLBACK_LADDERS, laddersFrom, rungIndex, stagesOf, tallExtent, tallFloor, tallSpace } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const ladder = (id) => FALLBACK_LADDERS.find((l) => l.id === id);
check("a ladder id is its own rung", rungIndex(ladder("claude"), "opus") === 2 && rungIndex(ladder("gpt"), "gpt-6.2-sol") === 2);
check("a full claude id lands on its rung", rungIndex(ladder("claude"), "claude-sonnet-5-5") === 1 && rungIndex(ladder("claude"), "claude-fable-5-2") === 3);
check("the agy effort suffix does not hide the rung", rungIndex(ladder("gemini"), "gemini-4-neon-xhigh") === 2 && rungIndex(ladder("gemini"), "gemini-3.8-flash-low") === 0);
check("an older generation still finds its rung", rungIndex(ladder("gpt"), "gpt-6.1-sol") === 2 && rungIndex(ladder("gpt"), "gpt-6-astra") === 3);
check("an unknown model is off the ladder", rungIndex(ladder("gpt"), "gpt-9-nope") === -1 && rungIndex(ladder("claude"), undefined) === -1);
check("no model list falls back to the built-in ladders", laddersFrom(null).map((l) => l.models.length).join() === "4,4,4");
check(
  "the server's ladder replaces the built-in one",
  laddersFrom({ providers: [{ id: "gpt", models: [{ id: "gpt-7-x", label: "X", note: "" }], effort: true }], sites: [], efforts: [], defaults: {} }).find((l) => l.id === "gpt").models[0].id === "gpt-7-x",
);

const member = (id, provider, model, status, extra = {}) => ({ id, provider, model, effort: "medium", taskId: "t1", branch: "", worktree: "", status, toolCalls: 3, startedAt: "", ...extra });
const state = (o = {}) => ({
  key: "p/a",
  project: { id: "p", name: "P", repo: "", baseBranch: "main" },
  agenda: { slug: "a", title: "A", goals: [], branch: "", status: "open" },
  tasks: [
    { id: "t1", title: "첫 과제", description: "", status: "doing", memberId: "claude-2" },
    { id: "t2", title: "둘째", description: "", status: "done" },
    { id: "t3", title: "셋째", description: "", status: "todo" },
  ],
  members: [
    member("claude-1", "claude", "sonnet", "done", { merged: true, commits: ["x"] }),
    member("claude-2", "claude", "claude-opus-5-5", "running"),
    member("claude-3", "claude", "opus", "running"),
    member("gpt-1", "gpt", "gpt-6.2-sol", "failed"),
    member("gpt-2", "gpt", "gpt-6.1-terra", "handed_over"),
    member("gemini-1", "gemini", "gemini-4-neon-high", "starting"),
    member("relay-1", "relay", undefined, "waiting", { label: "ChatGPT 웹" }),
    member("relay-2", "relay", undefined, "waiting", { label: "어떤 웹 AI" }),
  ],
  integrationWorktree: "",
  chairState: "",
  chair: { provider: "claude", model: "opus", busy: false },
  activity: { "claude-2": [0, 0, 0, 2, 6] },
  accounts: [],
  limits: { claude: { maxMembers: 3, maxModel: "opus" }, gpt: { maxMembers: 2, maxModel: "gpt-6.1-terra" }, gemini: { maxMembers: 2 } },
  active: {},
  mode: "git",
  ...o,
});

const s = buildScene(1600, 900, state(), FALLBACK_LADDERS);
const house = (id) => s.houses.find((h) => h.id === id);
check("three houses, claude above the chair and the other two below it", s.houses.map((h) => h.id).join() === "claude,gpt,gemini" && house("claude").y < s.chair.y && house("gpt").x < s.chair.x && house("gemini").x > s.chair.x && house("gpt").y > s.chair.y);
check("the lower houses mirror each other", Math.abs(house("gpt").x + house("gemini").x - 1600) < 0.01 && house("gpt").y === house("gemini").y);
check("working members stand beyond their house's ring", house("claude").workers.length === 2 && house("claude").workers.every((w) => Math.hypot(w.x - house("claude").x, w.y - house("claude").y) > house("claude").ringR));
check("two members on one rung do not share a spot", (() => { const [a, b] = house("claude").workers; return Math.hypot(a.x - b.x, a.y - b.y) > s.workerR * 2; })());
check("the rung in use is counted, the others are not", house("claude").rungs.map((r) => r.active).join() === "0,0,2,0");
check("rungs above the project's limit are locked", house("claude").rungs.map((r) => r.locked).join() === "false,false,false,true" && house("gpt").rungs.map((r) => r.locked).join() === "false,false,true,true");
check("no limit locks nothing", house("gemini").rungs.every((r) => !r.locked));
check("a member's label drops the agy effort suffix", house("gemini").workers[0].name === "Gemini 4 Neon", house("gemini").workers[0].name);
check("a relay goes to the house its label names", house("gpt").workers.map((w) => w.id).join() === "relay-1");
check("a relay nobody can place stays by the chair", s.relays.map((w) => w.id).join() === "relay-2");
check("finished members stay by their house; handed-over ones are not shown", house("claude").past.map((p) => p.kind).join() === "merged" && house("gpt").past.map((p) => `${p.id}:${p.kind}`).join() === "gpt-1:failed");
check("a finished member is smaller than a working one and carries its rung's letter", s.pastR < s.workerR && house("claude").past[0].letter === "S" && house("gpt").past[0].letter === "S" && house("claude").past[0].name === "Sonnet");
check("finished members sit outside the ring, clear of the working ones", (() => {
  const many = buildScene(1600, 900, state({ members: [...Array.from({ length: 12 }, (_, i) => member(`c${i}`, "claude", "sonnet", "done")), member("w", "claude", "opus", "running")] }), FALLBACK_LADDERS);
  const h = many.houses[0];
  const spots = new Set(h.past.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  return h.past.length === 12 && spots.size === 12 && h.past.every((p) => Math.hypot(p.x - h.x, p.y - h.y) > h.ringR && h.workers.every((w) => Math.hypot(p.x - w.x, p.y - w.y) > many.workerR * 2));
})());
check("recent activity becomes heat", house("claude").workers.find((w) => w.id === "claude-2").heat > 0.9 && house("claude").workers.find((w) => w.id === "claude-3").heat === 0);
check("each task is one arc of the chair's ring, in the worker's color when in progress", s.tasks.length === 3 && s.tasks[0].tint?.join() === "255,150,104" && s.tasks[1].tint === null && s.tasks[2].a1 > s.tasks[2].a0);
check("members sharing a rung are pushed apart along the arc, either side of the rung", (() => {
  const [a, b] = house("claude").workers;
  const rung = house("claude").rungs[2].angle;
  return b.angle - a.angle > 0.7 && a.angle < rung && b.angle > rung && Math.abs((a.angle + b.angle) / 2 - rung) < 0.01;
})());
check("a member alone stands in line with its rung", Math.abs(house("gemini").workers[0].angle - house("gemini").rungs[2].angle) < 1e-9);
check("a crowd on one rung fans out wide, every other one further out, all on the stage", (() => {
  for (const [w, h] of [[390, 844], [1600, 900]]) {
    const crowd = buildScene(w, h, state({ members: ["a", "b", "c", "d"].map((x) => member(`claude-${x}`, "claude", "sonnet", "running")) }), FALLBACK_LADDERS);
    const hs = crowd.houses[0];
    const ws = hs.workers;
    const dist = ws.map((p) => Math.hypot(p.x - hs.x, p.y - hs.y));
    const apart = ws.every((p, i) => ws.every((q, j) => i === j || Math.hypot(p.x - q.x, p.y - q.y) > crowd.workerR * 4));
    const spread = ws[3].angle - ws[0].angle;
    const onStage = ws.every((p) => p.x > crowd.workerR && p.x < crowd.w - crowd.workerR && p.y > crowd.workerR && p.y < crowd.h);
    if (!(ws.length === 4 && apart && spread > 1.9 && onStage && dist[1] > dist[0] && ws.every((p) => p.fromX === hs.rungs[1].x))) return false;
  }
  return true;
})());
check("twelve out of one house still fit its fan", (() => {
  const crowd = buildScene(1600, 900, state({ members: Array.from({ length: 12 }, (_, i) => member(`gpt-${i}`, "gpt", i % 2 ? "gpt-6.2-sol" : "gpt-6-luna", "running")) }), FALLBACK_LADDERS);
  const hs = crowd.houses[1];
  const turn = (a) => Math.atan2(Math.sin(a - hs.out), Math.cos(a - hs.out));
  return hs.workers.length === 12 && hs.workers.every((p) => Math.abs(turn(p.angle)) <= (100 * Math.PI) / 180 + 1e-6) && new Set(hs.workers.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size === 12;
})());
check("a hundred tasks are still a hundred arcs", (() => {
  const many = buildScene(1600, 900, state({ tasks: Array.from({ length: 134 }, (_, i) => ({ id: `t${i}`, title: "", description: "", status: "done" })) }), FALLBACK_LADDERS);
  return many.tasks.length === 134 && many.tasks.every((t) => t.a1 > t.a0) && many.tasks[133].a1 - many.tasks[0].a0 < Math.PI * 2;
})());
check("house counts follow the limits", house("claude").active === 2 && house("claude").max === 3 && house("gemini").active === 1);

const inside = (sc) => [...sc.houses.flatMap((h) => h.workers), ...sc.relays].every((w) => w.x > 0 && w.x < sc.w && w.y > 0 && w.y < sc.h);
check("everything fits a wide screen", inside(s) && !s.portrait);
const phone = buildScene(390, 844, state(), FALLBACK_LADDERS);
check("a phone gets the tall layout and still fits", phone.portrait && inside(phone) && phone.chair.r > buildScene(844, 390, state(), FALLBACK_LADDERS).chair.r);
check("on a phone the side houses stand just below the chair and Claude close above", (() => {
  const [claude, gpt, gemini] = phone.houses;
  const below = gpt.y - phone.chair.y;
  const above = phone.chair.y - claude.y;
  return below > 0 && below < 1.5 * phone.u && gemini.y === gpt.y && above < 3 * phone.u && above > phone.chair.haloR + claude.ringR;
})());
// the chair's words are a panel fixed over the input (74 high, 8 above an input that floats 124 up):
// no member's disc goes under it, on a tall phone or a short one
check("on a phone the picture ends above the chair's panel", [[390, 844], [390, 696], [375, 670], [320, 568]].every(([pw, ph]) => {
  const sc = buildScene(pw, ph, state(), FALLBACK_LADDERS);
  const lowest = Math.max(...sc.houses.flatMap((h) => [h.y + h.ringR, ...h.workers.map((w) => w.y + sc.workerR), ...h.past.map((p) => p.y + sc.pastR)]));
  return tallFloor(ph) === ph - 206 && lowest <= tallFloor(ph);
}));
check("on a phone the houses do not touch the chair or each other", phone.houses.every((h) => Math.hypot(h.x - phone.chair.x, h.y - phone.chair.y) > phone.chair.haloR + h.ringR) && phone.houses[2].x - phone.houses[1].x > 2 * phone.houses[1].ringR);
check("a squarish stage takes whichever layout draws larger", buildScene(520, 900, state(), FALLBACK_LADDERS).portrait && !buildScene(1000, 760, state(), FALLBACK_LADDERS).portrait);
check("the tall layout leaves the title card clear", phone.houses.flatMap((h) => h.workers).every((w) => w.y > 120));
// The tall picture is as high as what is in it: the sky over it (under the title card) is as deep as the
// sky under it (down to the chair's panel). When the screen is too short for that it sits right
// under the card. Sizes: a phone in the browser, a short one, an installed app, a small and a large phone.
const SIZES = [[390, 696], [375, 670], [390, 763], [390, 844], [320, 568], [430, 932]];
const idle = (o = {}) => ({ ...state(), members: state().members.filter((m) => m.status !== "running" && m.status !== "starting" && m.status !== "waiting"), ...o });
const balanced = (sc) => {
  const { above, below } = tallSpace(sc);
  return sc.portrait && above >= 5.5 && (Math.abs(above - below) < 1.5 || (above < 7 && below < above));
};
check("on a phone the sky above the picture matches the sky under it", SIZES.every(([pw, ph]) => balanced(buildScene(pw, ph, state(), FALLBACK_LADDERS)) && balanced(buildScene(pw, ph, idle(), FALLBACK_LADDERS)) && balanced(buildScene(pw, ph, null, FALLBACK_LADDERS))));
check("with nobody working above Claude the picture moves up, the same size", SIZES.every(([pw, ph]) => {
  const busy = buildScene(pw, ph, state(), FALLBACK_LADDERS);
  const quiet = buildScene(pw, ph, idle(), FALLBACK_LADDERS);
  return quiet.u === busy.u && quiet.chair.y < busy.chair.y - 10 && tallExtent(quiet).top > 118;
}));
check("the user's line ends at the edge beside the conversation", s.port.x > s.w - 10 && s.port.y < s.chair.y && phone.port.y > phone.h - 10 && phone.port.x === phone.chair.x);
const empty = buildScene(1200, 800, null, FALLBACK_LADDERS);
check("no agenda: the houses and their ladders are still there", empty.dormant && empty.houses.every((h) => h.rungs.length === 4 && h.workers.length === 0) && empty.tasks.length === 0);

const stages = (o) => [...stagesOf(state(o))].sort().join();
check("members out working: the work step", stages() === "work");
check("the chair thinking with nothing to review: handing out", stages({ members: [], chair: { busy: true } }) === "assign");
check("the chair thinking over results: review", stages({ members: [member("c", "claude", "opus", "done", { commits: ["x"] })], chair: { busy: true } }) === "review");
check("results waiting while the chair is idle: review", stages({ members: [member("c", "claude", "opus", "done", { commits: ["x"] })] }) === "review");
check("every task settled: the decision", stages({ members: [], tasks: [{ id: "t", title: "", description: "", status: "done" }] }) === "decide");
check("the chair proposing to finish: the decision", stages({ members: [], agenda: { slug: "a", title: "A", goals: [], branch: "", status: "open", waitingForUser: { question: "끝낼까요", at: "", kind: "finish" } } }).includes("decide"));
check("nothing open: nothing lit", stagesOf(null).size === 0);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall vision checks passed");
process.exitCode = failed ? 1 : 0;
