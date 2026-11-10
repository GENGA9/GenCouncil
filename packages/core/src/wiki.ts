/**
 * Gen Wiki: organised, editable pages that members, the chair and the user all read.
 *
 * Shared memory collects small facts as they come up; the wiki is where they settle into
 * pages a member can read top to bottom ("how H3 video jobs work", "what Sonnet is good at").
 * Pages are markdown files under space/wiki/, tracked in the space git repo, so every edit
 * has a history and can be undone.
 *
 *   wiki/
 *     common/<page>.md              tools, procedures and environment for any project
 *     models/<page>.md              what each model is good and bad at, phrases to give it
 *     projects/<project>/<page>.md  one project's structure, rules and pipelines
 */
import fs from "node:fs";
import path from "node:path";
import { commitAll, ensureRepo, gitLog } from "./git.js";
import { spaceDir } from "./paths.js";
import { makeSnippet, tokenize } from "./search.js";

export function wikiDir(): string {
  return path.join(spaceDir(), "wiki");
}

export interface WikiPageMeta {
  /** e.g. "projects/h3_studio/video-jobs" (no .md) */
  path: string;
  title: string;
  /** one line: what the page answers */
  summary: string;
  updated: string;
  /** who last edited (agent label or "user") */
  by: string;
  /** memory ids folded into this page */
  sources: string[];
  /** "common" | "models" | "projects/<key>" */
  section: string;
  chars: number;
}

export interface WikiPage extends WikiPageMeta {
  body: string;
}

export interface WikiWriteInput {
  title: string;
  summary?: string;
  body: string;
  sources?: string[];
}

export interface WikiHit extends WikiPageMeta {
  score: number;
  snippet: string;
}

const TOP_SECTIONS = ["common", "models", "projects"] as const;
const SEGMENT_RE = /^[\p{L}\p{N}_.-]+$/u;
const MAX_BODY_CHARS = 60_000;
/** the contents list goes into chair turns and member packets */
const MAX_TOC_CHARS = 8_000;
/** pages longer than this are read by outline and section */
export const LONG_PAGE = 3_000;

/** "Projects/H3_studio/Video Jobs.md" -> "projects/h3_studio/video-jobs"; throws on anything outside the layout */
export function normalizeWikiPath(p: string): string {
  const parts = p
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .split("/")
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);
  if (parts.some((s) => s === "." || s === ".." || !SEGMENT_RE.test(s))) throw new Error(`잘못된 위키 경로: ${p}`);
  const top = parts[0] as (typeof TOP_SECTIONS)[number];
  if (!TOP_SECTIONS.includes(top)) throw new Error(`위키 경로는 common/, models/, projects/<프로젝트>/ 로 시작해야 한다: ${p}`);
  // one optional topic folder under common/ and each project, so a long list can be split up
  const [min, max] = top === "projects" ? [3, 4] : top === "common" ? [2, 3] : [2, 2];
  if (parts.length < min || parts.length > max) {
    throw new Error(
      top === "projects"
        ? `프로젝트 페이지는 projects/<프로젝트>/<페이지> 또는 projects/<프로젝트>/<주제>/<페이지> 형식이다: ${p}`
        : top === "common"
          ? `공용 페이지는 common/<페이지> 또는 common/<주제>/<페이지> 형식이다: ${p}`
          : `models/<페이지> 형식이다 (하위 폴더 없음): ${p}`,
    );
  }
  return parts.join("/");
}

/** the folder a page sits in ("common", "common/comfyui", "projects/h3_studio", ...) */
function sectionOf(p: string): string {
  return p.split("/").slice(0, -1).join("/");
}

/** a folder's "index" page describes the folder and is not listed as a page of its own */
const FOLDER_INDEX = "index";

/** pages of other projects are left out when a project is given */
function inProject(p: string, project?: string): boolean {
  const parts = p.split("/");
  return !project || parts[0] !== "projects" || parts[1] === project.toLowerCase();
}

/** "## 방법" sections of a page body: heading text and character count */
export function pageOutline(body: string): Array<{ heading: string; chars: number }> {
  const out: Array<{ heading: string; chars: number }> = [];
  let cur: { heading: string; chars: number } | null = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = { heading: h[1], chars: 0 };
      out.push(cur);
    } else if (cur) cur.chars += line.length + 1;
  }
  return out;
}

/** The text of one "## heading" section (case-insensitive, prefix match), or undefined. */
export function pageSection(body: string, heading: string): string | undefined {
  const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const lines = body.split("\n");
  const start = lines.findIndex((l) => {
    const h = l.match(/^##\s+(.+?)\s*$/);
    return h && h[1].toLowerCase().startsWith(want);
  });
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join("\n").trim();
}

function parsePage(text: string, p: string): WikiPage {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = m?.[1] ?? "";
  const get = (k: string) => (fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"))?.[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
  const body = m ? text.slice(m[0].length) : text;
  const title = get("title") || p.split("/").pop()!;
  return {
    path: p,
    title,
    summary: get("summary"),
    updated: get("updated"),
    by: get("by"),
    sources: get("sources").split(",").map((s) => s.trim()).filter(Boolean),
    section: sectionOf(p),
    chars: body.length,
    body,
  };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function serializePage(page: Omit<WikiPage, "section" | "chars">): string {
  const lines = ["---", `title: ${oneLine(page.title)}`, `summary: ${oneLine(page.summary)}`, `updated: ${page.updated}`, `by: ${oneLine(page.by)}`];
  if (page.sources.length) lines.push(`sources: ${page.sources.join(", ")}`);
  lines.push("---", "");
  return lines.join("\n") + page.body.replace(/^\n+/, "").trimEnd() + "\n";
}

const HOME = `# Gen Wiki

위원·의장·사용자가 함께 보는 정리된 문서다. 공용 기억(memory)이 그때그때 쌓인 작은 사실이라면, 위키는 그것을 주제별로 묶어 처음부터 끝까지 읽을 수 있게 한 페이지다.

- common/<페이지>: 어느 프로젝트에서나 쓰는 도구·절차·환경
- models/<페이지>: 모델별 강점·약점·지시에 넣을 문구
- projects/<프로젝트>/<페이지>: 한 프로젝트의 구조·규칙·작업 순서

모든 수정은 git에 기록되므로 되돌릴 수 있다.
`;

export class WikiStore {
  readonly dir: string;
  private readonly root: string;
  private readonly useGit: boolean;

  constructor(opts: { dir?: string; git?: boolean } = {}) {
    this.dir = opts.dir ? path.resolve(opts.dir) : wikiDir();
    this.root = opts.dir ? path.dirname(this.dir) : spaceDir();
    this.useGit = opts.git ?? true;
  }

  async init(): Promise<void> {
    for (const s of TOP_SECTIONS) fs.mkdirSync(path.join(this.dir, s), { recursive: true });
    const home = path.join(this.dir, "README.md");
    if (!fs.existsSync(home)) fs.writeFileSync(home, HOME, "utf8");
    if (this.useGit) await ensureRepo(this.root);
  }

  private file(p: string): string {
    return path.join(this.dir, ...p.split("/")) + ".md";
  }

  list(opts: { project?: string } = {}): WikiPageMeta[] {
    const out: WikiPageMeta[] = [];
    const walk = (dir: string, rel: string[]) => {
      if (!fs.existsSync(dir)) return;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(path.join(dir, d.name), [...rel, d.name]);
        else if (d.name.endsWith(".md") && rel.length) {
          const p = [...rel, d.name.slice(0, -3)].join("/");
          try {
            const { body: _body, ...meta } = parsePage(fs.readFileSync(path.join(dir, d.name), "utf8"), p);
            out.push(meta);
          } catch {
            /* removed between readdir and read */
          }
        }
      }
    };
    for (const s of TOP_SECTIONS) walk(path.join(this.dir, s), [s]);
    return out
      .filter((m) => inProject(m.path, opts.project))
      .sort((a, b) => a.section.localeCompare(b.section) || a.title.localeCompare(b.title));
  }

  /**
   * One level of the tree: the sub-folders of `folder` (with page counts and the folder's index
   * summary) and the pages directly in it. "" is the root. Agents walk down from the root instead
   * of reading the whole contents list.
   */
  children(folder = "", opts: { project?: string } = {}): {
    folder: string;
    summary?: string;
    folders: Array<{ path: string; pages: number; summary?: string }>;
    pages: WikiPageMeta[];
  } {
    const f = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const all = this.list(opts);
    const depth = f ? f.split("/").length : 0;
    const under = all.filter((m) => !f || m.path.startsWith(f + "/"));
    const folders = new Map<string, number>();
    const pages: WikiPageMeta[] = [];
    let summary: string | undefined;
    for (const m of under) {
      const parts = m.path.split("/");
      if (parts.length === depth + 1) {
        if (parts[depth] === FOLDER_INDEX) summary = m.summary || m.title;
        else pages.push(m);
      } else {
        // a sub-folder; its index page describes it and is not counted as a page
        const sub = parts.slice(0, depth + 1).join("/");
        folders.set(sub, (folders.get(sub) ?? 0) + (parts[parts.length - 1] === FOLDER_INDEX ? 0 : 1));
      }
    }
    const indexOf = (sub: string) => all.find((m) => m.path === `${sub}/${FOLDER_INDEX}`);
    return {
      folder: f,
      summary,
      folders: [...folders.entries()].map(([p, n]) => ({ path: p, pages: n, summary: indexOf(p)?.summary || undefined })).sort((a, b) => a.path.localeCompare(b.path)),
      pages,
    };
  }

  /** One level as text for wiki_toc: folders first, then pages with their one-line summary. */
  renderChildren(folder = "", opts: { project?: string } = {}): string {
    const c = this.children(folder, opts);
    if (!c.folders.length && !c.pages.length) return c.folder ? `${c.folder}/ 아래에 페이지가 없다.` : "위키가 비어 있다.";
    const lines: string[] = [`${c.folder || "(위키 맨 위)"}${c.summary ? ` — ${c.summary}` : ""}`];
    for (const d of c.folders) lines.push(`- ${d.path}/ (${d.pages}쪽)${d.summary ? ` — ${d.summary}` : ""}`);
    for (const p of c.pages) lines.push(`- ${p.path}: ${p.title}${p.summary ? ` — ${p.summary}` : ""}${p.chars > LONG_PAGE ? ` (${p.chars}자, 목차부터 본다)` : ""}`);
    return lines.join("\n");
  }

  /**
   * What goes into every chair turn and member packet: only the top folders and their page counts,
   * a few hundred characters however big the wiki grows. The rest is found with wiki_toc / wiki_search.
   */
  renderRoot(opts: { project?: string } = {}): string {
    const all = this.list(opts);
    if (!all.length) return "";
    const count = (prefix: string) => all.filter((m) => m.path.startsWith(prefix + "/") && !m.path.endsWith(`/${FOLDER_INDEX}`)).length;
    const subs = (prefix: string) =>
      this.children(prefix, opts)
        .folders.map((d) => d.path.slice(prefix.length + 1))
        .slice(0, 12);
    const line = (prefix: string, label: string) => {
      const n = count(prefix);
      if (!n) return "";
      const s = subs(prefix);
      return `- ${prefix}/ (${n}쪽) ${label}${s.length ? ` · 하위: ${s.join(", ")}` : ""}`;
    };
    const lines = [];
    const proj = opts.project?.toLowerCase();
    if (proj) lines.push(line(`projects/${proj}`, "이 프로젝트"));
    lines.push(line("common", "공용 도구·절차·환경"), line("models", "모델별 강점·약점"));
    return lines.filter(Boolean).join("\n");
  }

  read(p: string): WikiPage | undefined {
    const norm = normalizeWikiPath(p);
    const f = this.file(norm);
    if (!fs.existsSync(f)) return undefined;
    return parsePage(fs.readFileSync(f, "utf8"), norm);
  }

  /** Create or replace a page. Returns the saved page. */
  async write(p: string, input: WikiWriteInput, by: string, reason = ""): Promise<WikiPage> {
    const norm = normalizeWikiPath(p);
    const title = oneLine(input.title ?? "");
    if (!title) throw new Error("title이 비어 있다");
    const body = (input.body ?? "").trim();
    if (body.length < 10) throw new Error("본문이 너무 짧다 (10자 이상)");
    if (body.length > MAX_BODY_CHARS) throw new Error(`본문이 너무 길다 (${body.length}자, 최대 ${MAX_BODY_CHARS}자). 페이지를 나눠라.`);
    const prev = this.read(norm);
    const page = {
      path: norm,
      title,
      summary: oneLine(input.summary ?? prev?.summary ?? ""),
      updated: new Date().toISOString(),
      by,
      // sources only grow: a rewrite keeps the ids earlier writes folded in
      sources: [...new Set([...(prev?.sources ?? []), ...(input.sources ?? [])].map((s) => s.trim()).filter(Boolean))],
      body,
    };
    const f = this.file(norm);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, serializePage(page), "utf8");
    if (this.useGit) await commitAll(this.root, `wiki: ${prev ? "edit" : "add"} ${norm} (${by})${reason ? `: ${oneLine(reason).slice(0, 80)}` : ""}`);
    return { ...page, section: sectionOf(norm), chars: page.body.length };
  }

  async remove(p: string, by: string, reason = ""): Promise<boolean> {
    const norm = normalizeWikiPath(p);
    const f = this.file(norm);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    if (this.useGit) await commitAll(this.root, `wiki: remove ${norm} (${by})${reason ? `: ${oneLine(reason).slice(0, 80)}` : ""}`);
    return true;
  }

  search(query: string, opts: { project?: string; limit?: number } = {}): WikiHit[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const hits: WikiHit[] = [];
    for (const meta of this.list(opts)) {
      const page = this.read(meta.path);
      if (!page) continue;
      const fields: Array<[string, number]> = [
        [page.title, 4],
        [page.summary, 2],
        [page.path, 2],
        [page.body, 1],
      ];
      let score = 0;
      let matched = 0;
      for (const t of q) {
        let s = 0;
        for (const [text, w] of fields) {
          const n = tokenize(text).filter((x) => x === t).length;
          s += Math.min(n, 5) * w;
        }
        if (s) matched++;
        score += s;
      }
      if (!score) continue;
      score *= matched / q.length;
      const { body, ...rest } = page;
      hits.push({ ...rest, score: Math.round(score * 10) / 10, snippet: makeSnippet(body, query) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
  }

  /** Contents list for prompts: common and model pages, plus the given project's pages. */
  renderToc(opts: { project?: string } = {}): string {
    const pages = this.list(opts);
    if (!pages.length) return "";
    const bySection = new Map<string, WikiPageMeta[]>();
    for (const m of pages) bySection.set(m.section, [...(bySection.get(m.section) ?? []), m]);
    const order = [...bySection.keys()].sort((a, b) => (a.startsWith("projects/") ? 0 : 1) - (b.startsWith("projects/") ? 0 : 1) || a.localeCompare(b));
    const lines: string[] = [];
    for (const s of order) {
      lines.push(`### ${s}`);
      for (const m of bySection.get(s)!) lines.push(`- ${m.path}: ${m.title}${m.summary ? ` — ${m.summary}` : ""}`);
    }
    let out = lines.join("\n");
    if (out.length > MAX_TOC_CHARS) out = out.slice(0, MAX_TOC_CHARS).replace(/\n[^\n]*$/, "") + "\n- … (나머지는 wiki_search로 찾는다)";
    return out;
  }

  /** Recent edits of one page (newest first). */
  history(p: string, limit = 20): Promise<Array<{ commit: string; date: string; subject: string }>> {
    const norm = normalizeWikiPath(p);
    return gitLog(this.root, path.relative(this.root, this.file(norm)), limit);
  }
}
