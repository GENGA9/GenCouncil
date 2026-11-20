// The default wiki that ships with the code (packages/core/wiki-default): it seeds an empty wiki once,
// never an existing one, and nothing personal is in it (the repo is public).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-wikidefault-"));
process.env.GENCOUNCIL_HOME = home;
const { WikiStore, defaultWikiDir } = await import("@gencouncil/core");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const pages = [];
const walk = (dir, rel) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) walk(path.join(dir, d.name), [...rel, d.name]);
    else if (d.name.endsWith(".md")) pages.push({ path: [...rel, d.name.slice(0, -3)].join("/"), text: fs.readFileSync(path.join(dir, d.name), "utf8") });
  }
};
const src = defaultWikiDir();
check("the default wiki ships with the code", fs.existsSync(src));
if (fs.existsSync(src)) walk(src, []);
check("it has pages", pages.length >= 50, String(pages.length));
check("only common/ and models/ pages (no project pages)", pages.every((p) => /^(common|models)\//.test(p.path)), pages.filter((p) => !/^(common|models)\//.test(p.path)).map((p) => p.path).join(", "));

// nothing personal: the user's folders, NAS, projects, memory ids, accounts, keys
const PERSONAL = [
  ["a personal drive path", /\b[A-Z]:[\\/]+(?:PROJECT|Users|OneDrive)/i],
  ["a home folder", /Users[\\/]+(?!<)[A-Za-z]/],
  ["a private address", /\b(?:10|100|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ["an email", /[A-Za-z0-9._%+-]+@(?!local\b)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/],
  ["a NAS", /\bNAS\b|synology|volume1/i],
  ["a project of the user", /h3[_-]?studio|h3-web-ui|reinforce_project|sns_project|abyss|심연의 복수/i],
  ["a link to a project page", /\]\(projects\//],
  ["a memory id", /\b(?:sol|conv|tool|conv|acc|per)-20\d{6}-/],
  ["an account id", /\bgenga\d/i],
  ["a key or token", /sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|\d{8,10}:[A-Za-z0-9_-]{35}/],
  ["a sources line", /^sources:/m],
];
for (const [what, re] of PERSONAL) {
  const bad = pages.filter((p) => re.test(p.text)).map((p) => p.path);
  check(`no page has ${what}`, bad.length === 0, bad.join(", "));
}

// every link points at a page that ships
const known = new Set(pages.map((p) => p.path));
const broken = [];
for (const p of pages) for (const m of p.text.matchAll(/\]\(((?:common|models)\/[^)\s#]+)\)/g)) if (!known.has(m[1].replace(/\.md$/, ""))) broken.push(`${p.path} -> ${m[1]}`);
check("every link points at a page that ships", broken.length === 0, broken.slice(0, 8).join(", "));

// the front matter a wiki page needs
const bad = pages.filter((p) => !/^---\ntitle: .+\n(?:summary: .*\n)?updated: .+\nby: .+\n---\n/.test(p.text.replace(/\r\n/g, "\n"))).map((p) => p.path);
check("every page has title, updated and by", bad.length === 0, bad.slice(0, 8).join(", "));

// seeding: an empty wiki gets the pages once, a wiki with a page of its own gets nothing
const fresh = new WikiStore({ git: false });
await fresh.init({ seed: true });
check("a fresh wiki starts with the default pages", fresh.pageCount() === pages.length, `${fresh.pageCount()} / ${pages.length}`);
check("they read as wiki pages", fresh.list().length === pages.length && Boolean(fresh.read(pages[0].path)?.title));
const firstPage = path.join(fresh.dir, ...pages[0].path.split("/")) + ".md";
fs.writeFileSync(firstPage, fs.readFileSync(firstPage, "utf8").replace(/^title: .*$/m, "title: 내가 고친 제목"), "utf8");
await fresh.init({ seed: true });
check("starting again changes nothing the user edited", fresh.read(pages[0].path)?.title === "내가 고친 제목" && fresh.pageCount() === pages.length);

const ownDir = path.join(home, "own", "wiki");
const own = new WikiStore({ dir: ownDir, git: false });
await own.init();
await own.write("common/mine", { title: "내 페이지", summary: "직접 쓴 것", body: "## 내용\n직접 쓴 페이지 하나가 있는 위키다. 기본 페이지는 들어오지 않아야 한다." }, "user");
await own.init({ seed: true });
check("a wiki with a page of its own gets no default pages", own.pageCount() === 1);
const plain = new WikiStore({ dir: path.join(home, "plain", "wiki"), git: false });
await plain.init();
check("without seed nothing is copied (tests, tools)", plain.pageCount() === 0);

fs.rmSync(home, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall default wiki checks passed");
