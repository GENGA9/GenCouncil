// The members' conversations in the languages Agentg's scripts lack (dialogues-i18n.json): each one
// added as <id>.<lang>, with the source's speakers, trigger and emotions and no recording.
// build-lines.mjs calls it; run on its own it updates src/avatar/lines.json in place:
//   node translate-dialogues.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** the dialogues with the translations added (any added before are replaced) */
export function withTranslations(dialogues) {
  const T = JSON.parse(fs.readFileSync(path.join(here, "dialogues-i18n.json"), "utf8")).dialogues;
  const source = dialogues.filter((d) => !/\.(ko|ja|en)$/.test(d.id));
  const added = [];
  for (const d of source) {
    for (const [lang, texts] of Object.entries(T[d.id] ?? {})) {
      if (lang === d.lang) continue;
      if (texts.length !== d.turns.length) throw new Error(`${d.id} ${lang}: ${texts.length} turns, the source has ${d.turns.length}`);
      added.push({ id: `${d.id}.${lang}`, lang, trigger: d.trigger, chars: d.chars, turns: d.turns.map((t, i) => ({ char: t.char, text: texts[i], emotion: t.emotion })) });
    }
  }
  return [...source, ...added];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(here, "../../src/avatar/lines.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.dialogues = withTranslations(data.dialogues);
  fs.writeFileSync(file, JSON.stringify(data));
  const count = {};
  for (const d of data.dialogues) count[d.lang] = (count[d.lang] ?? 0) + 1;
  console.log("dialogues", count);
}
