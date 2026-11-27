// Copies Agentg's recorded voice lines (ElevenLabs, resources/agentg/local/voice-lines/v1/<char>/*_ko.mp3,
// git-ignored; copied from %LOCALAPPDATA%/Agentg when Agentg was folded into GenCouncil)
// into public/avatar/voice/, as mono 64 kbps MP3 (half the size; speech holds up fine). Only the Korean
// lines that the script (lines.json) names, under the same relative paths it uses.
//   node build-voices.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RES = path.join(here, "..", "..", "..", "..", "resources", "agentg");
const SRC = path.join(RES, "local", "voice-lines", "v1");
const OUT = path.join(here, "..", "..", "public", "avatar", "voice");
const L = JSON.parse(fs.readFileSync(path.join(RES, "voice-lines", "lines.json"), "utf8"));
let n = 0;
let bytes = 0;
for (const l of L.lines) {
  if (l.lang !== "ko") continue;
  const src = path.join(SRC, l.file);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(OUT, l.file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", dst]);
  n++;
  bytes += fs.statSync(dst).size;
}
console.log("voices", n, Math.round(bytes / 1024), "KB");
