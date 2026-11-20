// Before publishing a checkout (e.g. to GitHub): look through its tracked files, its commit messages,
// and, with --history, every older version of every file, for things that must not be public.
//
//   node scripts/check-public.mjs [repo dir] [--history]
//
// Checks: secret-looking strings (API keys, OAuth/JWT tokens, bot tokens, private keys), this PC's own
// secret values (the web server token and Telegram ids in ~/.gencouncil/server.json), private addresses,
// personal home folders, and the words listed in ~/.gencouncil/private-terms.txt (your own project
// names, people, places: one per line; the list itself never goes in a repo). Prints only the kind of
// finding and where; secret values are never printed. Exits 1 when anything is found.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const repo = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const history = args.includes("--history");
const home = path.join(os.homedir(), ".gencouncil");
const git = (a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 30 });

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RULES = [
  ["an Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["a Google key or token", /AIza[0-9A-Za-z_-]{35}|ya29\.[A-Za-z0-9_-]{20,}|\b1\/\/0[A-Za-z0-9_-]{30,}/],
  ["a JWT", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./],
  ["a Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ["a private key", /BEGIN [A-Z ]*PRIVATE KEY/],
  ["a token in JSON", /"(?:refresh|access|id)_token"\s*:\s*"[^"]{12,}/],
  ["a private address", /\b(?:192\.168|10\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/],
  ["a home folder", new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+${escape(os.userInfo().username)}\\b|/(?:c/)?Users/${escape(os.userInfo().username)}\\b`, "i")],
];
const secrets = [];
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
  for (const v of [cfg.token, cfg.telegram?.botToken, cfg.telegram?.chatId, cfg.telegram?.forumChatId]) if (v && String(v).length >= 5) secrets.push(String(v));
} catch {
  /* no server config on this PC */
}
if (secrets.length) RULES.push(["a secret value of this PC (server.json)", new RegExp(secrets.map(escape).join("|"))]);
try {
  const terms = fs.readFileSync(path.join(home, "private-terms.txt"), "utf8").split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !t.startsWith("#"));
  if (terms.length) RULES.push([`a private word (private-terms.txt)`, new RegExp(terms.map(escape).join("|"), "i")]);
} catch {
  console.log("(no ~/.gencouncil/private-terms.txt: your own project names are not checked)");
}

const found = [];
const scan = (where, text) => {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [what, re] of RULES) if (re.test(line)) found.push(`${what}  ${where}:${i + 1}`);
  });
};
for (const f of git(["ls-files"]).split("\n").filter(Boolean)) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(repo, f));
  } catch {
    continue;
  }
  if (!buf.includes(0)) scan(f, buf.toString("utf8"));
}
for (const rec of git(["log", "--format=%h%x1f%an <%ae>%n%B%x1e"]).split("\x1e")) {
  const [h, body] = rec.trim().split("\x1f");
  if (h) scan(`commit ${h}`, body ?? "");
}
if (history) {
  // every line ever added or removed, by commit
  let commit = "";
  for (const line of git(["log", "-p", "--format=@@commit %h"]).split("\n")) {
    if (line.startsWith("@@commit ")) commit = line.slice(9);
    else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
      for (const [what, re] of RULES) if (re.test(line)) found.push(`${what}  history ${commit}`);
  }
}
const unique = [...new Set(found)];
for (const f of unique) console.log("FOUND " + f);
console.log(unique.length ? `\n${unique.length} finding(s): do not publish as it is` : `nothing found${history ? " (files, messages and history)" : " (files and messages; add --history for older versions)"}`);
process.exit(unique.length ? 1 : 0);
