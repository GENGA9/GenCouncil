// Screenshots of the avatar look for the README, in each screen language, from the demo page on the
// dev server (npm run dev --workspace @gencouncil/web). Real time, not the film's virtual clock:
// each shot opens the page, waits, does a few things in it and takes the picture.
//   node shots.mjs [lang ...]          (default: ko en ja) → docs/media/avatar/<shot>-<lang>.jpg
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "media", "avatar");
mkdirSync(OUT, { recursive: true });
const LANGS = process.argv.slice(2).length ? process.argv.slice(2) : ["ko", "en", "ja"];
const ONLY = process.env.SHOT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(HERE, "chrome-shots");
rmSync(profile, { recursive: true, force: true });
const PORT = 9800 + Math.floor(Math.random() * 100);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
  } catch {
    /* not up yet */
  }
}
if (!target) throw new Error("chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
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
const send = (method, params = {}) => new Promise((resolve, reject) => (waiting.set(++id, { resolve, reject }), ws.send(JSON.stringify({ id, method, params }))));
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send("Page.enable");
await send("Runtime.enable");

// helpers the shots use inside the page
const HELP = `
window.__bust = () => document.querySelector(".av-bust");
window.__menu = () => { const el = __bust(); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.3 })); };
window.__chip = (start) => [...document.querySelectorAll(".av-menu button")].find((b) => b.textContent.trim().startsWith(start));
window.__wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.__until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await __wait(100); } return null; };
`;

async function open(url, w, h, scale = 1, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile });
  await send("Page.navigate", { url: `${process.env.REC_ORIGIN ?? "http://localhost:5173"}${url}` });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await js("document.readyState === 'complete' && !!document.querySelector('#root > *')").catch(() => false)) break;
  }
  await js(HELP);
  await js("Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })))");
}
async function shot(name, lang, { clip, png = false } = {}) {
  const r = await send("Page.captureScreenshot", { format: png ? "png" : "jpeg", quality: 86, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const file = path.join(OUT, `${name}-${lang}.${png ? "png" : "jpg"}`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("wrote", path.relative(path.join(HERE, ".."), file));
  return file;
}

const SHOTS = {
  // the study on a wide screen: the chair, members at work on the desk, the record at the right
  async desktop(lang) {
    await open(`/vision-demo.html?avatar&lang=${lang}`, 1440, 900, 1);
    await sleep(9500);
    await shot("desktop", lang);
  },
  // the same on a phone
  async phone(lang) {
    await open(`/vision-demo.html?avatar&lang=${lang}`, 390, 844, 2, true);
    await sleep(9500);
    await shot("phone", lang);
  },
  // the chair's own menu: voice, bubbles, motion, language, dance, character
  async menu(lang) {
    await open(`/vision-demo.html?avatar&quiet&lang=${lang}`, 1440, 900, 1);
    await sleep(1500);
    await js("__menu()");
    await sleep(900);
    await shot("menu", lang);
  },
  // out in front of the desk, dancing
  async dance(lang) {
    await open(`/vision-demo.html?avatar&quiet&lang=${lang}`, 1280, 800, 1);
    await sleep(1500);
    await js("__menu()");
    await js("__until(() => __chip('♪')).then(Boolean)");
    await js("void __chip('♪').click()");
    await sleep(10500);
    await shot("dance", lang);
  },
  // a member picked up off the desk
  async pickup(lang) {
    await open(`/vision-demo.html?avatar&quiet&lang=${lang}`, 1280, 800, 1);
    await sleep(2500);
    await js(`(async () => {
      const vw = innerWidth;
      const el = [...document.querySelectorAll(".av-chibi-body")].sort((a, b) => Math.abs(a.getBoundingClientRect().x - vw * 0.4) - Math.abs(b.getBoundingClientRect().x - vw * 0.4))[0];
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height * 0.35;
      const p = (type, px, py) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: "mouse", button: 0, buttons: 1, clientX: px, clientY: py, isPrimary: true }));
      p("pointerdown", x, y);
      await __wait(350);
      for (let k = 1; k <= 12; k++) { p("pointermove", x + k * 4, y - k * 14); await __wait(40); }
    })()`);
    await sleep(700);
    await shot("pickup", lang);
  },
  // the desktop app's floating chair (the main window closed into the tray), on a desktop
  async float(lang) {
    await open(`/vision-demo.html?float=1&lang=${lang}`, 300, 420, 2);
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await sleep(6000);
    const file = await shot("float-window", lang, { png: true });
    await send("Emulation.setDefaultBackgroundColorOverride", {});
    // on a made-up desktop: a wallpaper and a code editor behind, the chair at the bottom right
    const out = path.join(OUT, `float-${lang}.jpg`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(HERE, "desktop-backdrop.jpg"), "-i", file, "-filter_complex", "[0]scale=1600:900[bg];[1]scale=450:-1[fc];[bg][fc]overlay=W-w-36:H-h-56", "-q:v", "3", out]);
    rmSync(file);
    console.log("wrote", path.relative(path.join(HERE, ".."), out));
  },
  // single mode: only members of the chair's own company
  async single(lang) {
    await open(`/vision-demo.html?avatar&quiet&lang=${lang}`, 1280, 900, 1);
    await sleep(1500);
    await js("void document.querySelectorAll('.vz-dock button')[1].click()");
    await js("__until(() => document.querySelector('.limits-single button')).then(Boolean)");
    await js("void document.querySelector('.limits-single button').click()");
    await sleep(400);
    await js("document.querySelector('.limits-single').scrollIntoView({ block: 'center' })");
    await sleep(500);
    await shot("single", lang);
  },
  // the meeting room: the members argue a topic out, the chair sums it up
  async meeting(lang) {
    await open(`/vision-demo.html?meeting&avatar&step=1.6&lang=${lang}`, 1440, 900, 1);
    await sleep(1500);
    const topic = { ko: "금요일 배포, 해도 될까?", en: "Should we ship on Fridays?", ja: "金曜日のデプロイ、やってもいい?" }[lang];
    await js(`(() => {
      const el = document.querySelector(".mt-go").previousElementSibling;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(topic)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(200);
    await js("void document.querySelector('.mt-go').click()");
    await sleep(7600);
    await shot("meeting", lang);
  },
};

for (const lang of LANGS) {
  for (const [name, fn] of Object.entries(SHOTS)) {
    if (ONLY && !ONLY.split(",").includes(name)) continue;
    try {
      await fn(lang);
    } catch (e) {
      console.error(`${name} ${lang}:`, e.message);
    }
  }
}
ws.close();
chrome.kill();
