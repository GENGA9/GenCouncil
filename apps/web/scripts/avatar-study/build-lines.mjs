// Builds src/avatar/lines.json from Agentg's voice-line scripts (voice-lines/lines.json for events,
// voice-lines/banter.json for monologues and conversations): every language (ko, ja, en …), each line
// marked with its language, keyed by this app's rig ids, with the recorded file names kept for when the
// voices are made. The page picks the viewer's language and falls back to Korean where a line is missing.
//   node build-lines.mjs [path to the sources]   (default: resources/agentg in this repo: Agentg's
//   scripts, copied there when Agentg was folded into GenCouncil)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTranslations } from "./translate-dialogues.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentg = process.argv[2] ?? path.join(here, "../../../../resources/agentg");
const L = JSON.parse(fs.readFileSync(path.join(agentg, "voice-lines/lines.json"), "utf8"));
const B = JSON.parse(fs.readFileSync(path.join(agentg, "voice-lines/banter.json"), "utf8"));
const rig = (c) => (c === "grokchan" ? "grok-x" : c);

// the app calls the characters by their plain names (클로드, 지피티, 제미나이, 그록, 닷츠); in the lines
// nobody recorded (conversations, monologues) a name is changed, and the particle after it fitted to the
// new name's last sound. Recorded lines keep their words (they never name anyone).
const NAMES = [["클로드쨩", "클로드"], ["지피쨩", "지피티"], ["젬미니", "제미나이"], ["그록쨩", "그록"], ["닷쨩", "닷츠"]];
const hasFinal = (word) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c < 11172 && c % 28 !== 0;
};
const PARTICLES = [["이랑", "랑"], ["이에요", "예요"], ["이", "가"], ["은", "는"], ["을", "를"], ["과", "와"], ["아", "야"]];
const rename = (text) => {
  let t = text;
  for (const [from, to] of NAMES) {
    const fromFinal = hasFinal(from);
    const toFinal = hasFinal(to);
    t = t.replace(new RegExp(from + "(이랑|이에요|이|가|은|는|을|를|과|와|아|야)?(?![가-힣])", "g"), (_, p) => {
      if (!p || fromFinal === toFinal) return to + (p ?? "");
      const pair = PARTICLES.find(([c, v]) => p === (fromFinal ? c : v));
      return to + (pair ? (toFinal ? pair[0] : pair[1]) : p);
    });
    t = t.split(from).join(to);
  }
  return t;
};

const events = {};
for (const l of L.lines) {
  ((events[rig(l.char)] ??= {})[l.event] ??= []).push({ text: l.text, lang: l.lang, emotion: l.emotion, file: l.file });
}
const monologues = {};
for (const m of B.monologues) {
  (monologues[rig(m.char)] ??= []).push({ text: rename(m.text), lang: m.lang, tags: m.tags, emotion: m.emotion, file: m.file });
}
// a conversation is in one language (the first turn's)
// plus the translations made here (dialogues-i18n.json) for the languages the scripts lack
const dialogues = withTranslations(B.dialogues
  .filter((d) => d.turns.length && d.turns.every((t) => t.lang === d.turns[0].lang))
  .map((d) => ({ id: d.id, lang: d.turns[0].lang, trigger: d.trigger, chars: d.chars.map(rig), turns: d.turns.map((t) => ({ char: rig(t.char), text: rename(t.text), emotion: t.emotion, file: t.file })) })));

const out = { source: "Agentg voice-lines (lines.json v" + L.version + ", banter.json v" + B.version + ")", events, monologues, dialogues };
fs.writeFileSync(path.join(here, "../../src/avatar/lines.json"), JSON.stringify(out));
console.log("events", Object.values(events).reduce((n, e) => n + Object.values(e).flat().length, 0), "monologues", Object.values(monologues).flat().length, "dialogues", dialogues.length);
