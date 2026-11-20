// Records /vision-demo.html?film frame by frame with a headless Chrome and a virtual clock, then
// encodes the frames with ffmpeg. Nothing is recorded in real time: every frame advances the page's
// clock by the same step, so the result is smooth whatever the capture speed.
//   node record.mjs <name> <cssWidth> <cssHeight> <scale> [fps=60] [filmSeconds=9.9] [outSeconds=8] [slow]
// filmSeconds / outSeconds is the speed the film plays at (10 and 10: as it is). `slow` plays stretches
// of the film slower still: "from:to:speed" in film seconds, comma-separated, e.g. "2.6:3.8:0.6".
// The video is always outSeconds long, so a slowed stretch takes its time from the film's end.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [name = "promo", W = "1280", H = "720", SCALE = "1.5", FPS = "60", FILM = "9.9", OUT = "8", SLOW = "", STOP = ""] = process.argv.slice(2);
const slow = SLOW.split(",").filter(Boolean).map((x) => x.split(":").map(Number));
/** how fast the film runs at this point of it (in film milliseconds), on top of the overall speed */
const speedAt = (ms) => slow.find(([from, to]) => ms >= from * 1000 && ms < to * 1000)?.[2] ?? 1;
const width = Number(W), height = Number(H), scale = Number(SCALE), fps = Number(FPS), film = Number(FILM), outSeconds = Number(OUT);
const frames = STOP ? Number(STOP) : Math.round(fps * outSeconds);
const total = Math.round(fps * outSeconds);
const step = (film * 1000) / total;
const dir = path.join(HERE, `frames-${name}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const profile = path.join(HERE, `chrome-${name}`);
rmSync(profile, { recursive: true, force: true });
const PORT = 9300 + Math.floor(Math.random() * 400);

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  `--window-size=${width},${height}`,
  "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {
    /* not up yet */
  }
}
if (!target) throw new Error("chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    waiting.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

// the page's clock: timers, animation frames, performance.now and Date.now all read `now`,
// which only moves when __step is called; CSS and Web animations are pinned to it too
const CLOCK = `(() => {
  let now = 0;
  const base = Date.now();
  const realTimeout = window.setTimeout.bind(window);
  const timers = new Map();
  const rafs = new Map();
  let next = 1;
  window.setTimeout = (fn, ms = 0, ...args) => { const i = next++; timers.set(i, { at: now + (Number(ms) || 0), fn, args }); return i; };
  window.setInterval = (fn, ms = 0, ...args) => { const i = next++; timers.set(i, { at: now + Math.max(1, Number(ms) || 0), fn, args, every: Math.max(1, Number(ms) || 0) }); return i; };
  window.clearTimeout = window.clearInterval = (i) => { timers.delete(i); };
  window.requestAnimationFrame = (fn) => { const i = next++; rafs.set(i, fn); return i; };
  window.cancelAnimationFrame = (i) => { rafs.delete(i); };
  performance.now = () => now;
  Date.now = () => base + now;
  const started = new WeakMap();
  const pin = () => {
    for (const a of document.getAnimations()) {
      if (!started.has(a)) { started.set(a, now - Number(a.currentTime ?? 0)); try { a.pause(); } catch {} }
      try { a.currentTime = now - started.get(a); } catch {}
    }
  };
  window.__pin = pin;
  window.__step = (dt) => {
    now += dt;
    for (let guard = 0; guard < 10000; guard++) {
      let pick = null;
      for (const [i, t] of timers) if (t.at <= now && (!pick || t.at < pick[1].at)) pick = [i, t];
      if (!pick) break;
      const [i, t] = pick;
      if (t.every) t.at += t.every; else timers.delete(i);
      try { typeof t.fn === "function" && t.fn(...t.args); } catch (e) { console.error(e); }
    }
    const cbs = [...rafs.values()];
    rafs.clear();
    for (const fn of cbs) { try { fn(now); } catch (e) { console.error(e); } }
    pin();
  };
  // let React commit what the step set off: a few real turns of the event loop
  window.__settle = () => new Promise((r) => realTimeout(() => realTimeout(() => realTimeout(r, 0), 0), 4));
})();`;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });
await send("Page.navigate", { url: "http://localhost:5173/vision-demo.html?film" });
for (let i = 0; i < 100; i++) {
  await sleep(150);
  if (await evaluate("!!document.querySelector('.vz-chair') && !!window.__step").catch(() => false)) break;
}
await sleep(400);

const t0 = Date.now();
let filmNow = 0;
for (let f = 0; f < frames; f++) {
  const dt = step * speedAt(filmNow);
  filmNow += dt;
  await evaluate(`__step(${dt})`);
  await evaluate("__settle()");
  await evaluate("__pin()");
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(dir, `f_${String(f).padStart(5, "0")}.png`), Buffer.from(shot.data, "base64"));
  if (f % 60 === 0) console.log(`frame ${f}/${frames} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ws.close();
chrome.kill();
await sleep(500);

if (!STOP) {
  const out = path.join(HERE, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "f_%05d.png"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: "inherit" });
  console.log("wrote", out);
}
console.log(`done: ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
