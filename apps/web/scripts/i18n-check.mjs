// Lists the t("…") keys the English or Japanese dictionary lacks, translations whose {placeholders}
// differ from the Korean, and (when files are named, or with --bare) lines with Korean text outside
// t() — a rough look that skips comments.
//   node apps/web/scripts/i18n-check.mjs [--bare] [file-or-dir ...]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "src");
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.tsx?$/.test(p) ? [p] : []);
const args = process.argv.slice(2);
const bareToo = args.includes("--bare") || args.some((a) => !a.startsWith("--"));
const targets = args.filter((a) => !a.startsWith("--"));
const partsDir = join(root, "i18n", "parts");
const files = (targets.length ? targets : [root]).flatMap((a) => walk(a)).filter((f) => !f.includes(partsDir) && !f.includes(`i18n${sep}parts`));

// the dictionaries (Node strips the types; the parts import only a type)
const dict = { en: {}, ja: {} };
for (const f of walk(partsDir)) {
  if (f.endsWith("index.ts")) continue;
  const part = (await import(pathToFileURL(f).href)).default;
  for (const lang of ["en", "ja"]) {
    for (const [k, v] of Object.entries(part[lang])) {
      if (k in dict[lang] && dict[lang][k] !== v) console.log(`conflict ${lang}  ${relative(root, f)}: ${k}  (${dict[lang][k]} / ${v})`);
      dict[lang][k] = v;
    }
  }
}

const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const KEY = /\bt\(\s*("(?:[^"\\\n]|\\.)*")/g;
let missing = 0;
let bare = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = relative(root, f);
  for (const m of src.matchAll(KEY)) {
    const key = JSON.parse(m[1]);
    if (!/[가-힣]/.test(key)) continue;
    for (const lang of ["en", "ja"]) {
      if (!(key in dict[lang])) {
        missing++;
        console.log(`missing ${lang}  ${rel}: ${key}`);
      } else if (ph(dict[lang][key]) !== ph(key)) console.log(`placeholders ${lang}  ${rel}: ${key}`);
    }
  }
  if (!bareToo) continue;
  let inBlock = false;
  src.split("\n").forEach((line, i) => {
    let code = line;
    if (inBlock) {
      const end = code.indexOf("*/");
      if (end < 0) return;
      code = code.slice(end + 2);
      inBlock = false;
    }
    code = code.replace(/\/\*.*?\*\//g, "");
    const open = code.indexOf("/*");
    if (open >= 0) {
      code = code.slice(0, open);
      inBlock = true;
    }
    code = code.replace(/(^|[^:"'`])\/\/.*$/, "$1").replace(/\{\/\*.*?\*\/\}/g, "");
    const rest = code.replace(KEY, "");
    if (/[가-힣]/.test(rest)) {
      bare++;
      console.log(`bare  ${rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
    }
  });
}
console.log(`\n${missing} missing translations${bareToo ? `, ${bare} lines with Korean outside t()` : ""}`);
