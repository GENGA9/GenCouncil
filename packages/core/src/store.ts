import fs from "node:fs";
import path from "node:path";
import {
  ENTRY_TYPES,
  PROPOSALS_DIR,
  TYPE_DIR,
  makeId,
  parseEntry,
  serializeEntry,
  type Entry,
  type EntryMeta,
  type EntryStatus,
  type EntryType,
} from "./entry.js";
import { commitAll, ensureRepo } from "./git.js";
import { memoryDir, spaceDir } from "./paths.js";
import { SearchIndex, type SearchHit, type SearchOptions } from "./search.js";

export interface NewEntryInput {
  title: string;
  type: EntryType;
  body: string;
  tags?: string[];
  project?: string;
  source?: string;
}

export interface UpdateEntryInput {
  title?: string;
  body?: string;
  /** appended under a "## 추가 (date)" heading instead of replacing */
  append?: string;
  tags?: string[];
  project?: string;
}

export interface ListOptions {
  type?: EntryType;
  status?: EntryStatus | "any";
  project?: string;
  limit?: number;
}

export interface StoreOptions {
  /** defaults to memoryDir() */
  dir?: string;
  /** commit to git on every write (default true) */
  git?: boolean;
  /** watch the directory and reload on external changes (default false) */
  watch?: boolean;
}

const INDEX_FILE = "INDEX.md";
const MAX_INDEX_LINES = 150;

export class MemoryStore {
  readonly dir: string;
  readonly root: string;
  private readonly useGit: boolean;
  private entries = new Map<string, Entry>();
  private index = new SearchIndex();
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: StoreOptions = {}) {
    this.dir = opts.dir ? path.resolve(opts.dir) : memoryDir();
    this.root = opts.dir ? path.dirname(this.dir) : spaceDir();
    this.useGit = opts.git ?? true;
    if (opts.watch) this.startWatch();
  }

  // ---------- lifecycle ----------

  /** Create the folder layout (idempotent). Returns true if anything was created. */
  async init(): Promise<boolean> {
    let created = false;
    const mk = (p: string) => {
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        created = true;
      }
    };
    mk(this.dir);
    for (const t of ENTRY_TYPES) mk(path.join(this.dir, TYPE_DIR[t]));
    mk(path.join(this.dir, PROPOSALS_DIR));
    const readme = path.join(this.dir, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, README, "utf8");
      created = true;
    }
    if (this.useGit) await ensureRepo(this.root);
    this.load();
    this.writeIndex();
    if (created && this.useGit) await commitAll(this.root, "init: space memory layout");
    return created;
  }

  /** Read every entry from disk and rebuild the search index. */
  load(): number {
    this.entries.clear();
    this.index.clear();
    if (!fs.existsSync(this.dir)) return 0;
    const dirs = [...ENTRY_TYPES.map((t) => TYPE_DIR[t]), PROPOSALS_DIR];
    for (const d of dirs) {
      const full = path.join(this.dir, d);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith(".md")) continue;
        const file = path.join(full, f);
        const e = parseEntry(fs.readFileSync(file, "utf8"), file);
        if (!e) continue;
        if (this.entries.has(e.meta.id)) continue; // first wins; duplicates are a user error
        this.entries.set(e.meta.id, e);
        this.index.add(e);
      }
    }
    return this.entries.size;
  }

  private startWatch(): void {
    if (this.watcher || !fs.existsSync(this.dir)) return;
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.load(), 300);
      });
      this.watcher.unref?.();
    } catch {
      this.watcher = null;
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Wait for background git commits to finish (call before a short-lived process exits). */
  async flush(): Promise<void> {
    await this.pending;
  }

  private commit(msg: string): void {
    if (!this.useGit) return;
    this.pending = commitAll(this.root, msg).catch(() => undefined);
  }

  // ---------- reads ----------

  size(): number {
    return this.entries.size;
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  list(opts: ListOptions = {}): EntryMeta[] {
    const status = opts.status ?? "any";
    const out: EntryMeta[] = [];
    for (const e of this.entries.values()) {
      const m = e.meta;
      if (opts.type && m.type !== opts.type) continue;
      if (status !== "any" && m.status !== status) continue;
      if (opts.project && (m.project ?? "").toLowerCase() !== opts.project.toLowerCase()) continue;
      out.push(m);
    }
    out.sort((a, b) => b.updated.localeCompare(a.updated));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    return this.index.search(query, opts);
  }

  /** The compact index that gets injected into agent prompts. */
  renderIndex(): string {
    const verified = this.list({ status: "verified" });
    const proposed = this.list({ status: "proposed" }).length;
    const lines: string[] = [];
    lines.push("# Space Memory Index");
    lines.push("");
    lines.push(
      `${verified.length} verified entries` +
        (proposed ? `, ${proposed} pending proposals` : "") +
        `. Use memory_search / memory_read for details.`,
    );
    let budget = MAX_INDEX_LINES;
    for (const t of ENTRY_TYPES) {
      const items = verified.filter((m) => m.type === t);
      if (items.length === 0) continue;
      lines.push("");
      lines.push(`## ${TYPE_DIR[t]} (${items.length})`);
      for (const m of items) {
        if (budget-- <= 0) break;
        const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const proj = m.project ? ` (${m.project})` : "";
        lines.push(`- ${m.id}: ${m.title}${tags}${proj}`);
      }
      if (budget <= 0) {
        lines.push(`- … (index truncated, ${verified.length} total; search for the rest)`);
        break;
      }
    }
    return lines.join("\n") + "\n";
  }

  writeIndex(): string {
    const text = this.renderIndex();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, INDEX_FILE), text, "utf8");
    return text;
  }

  // ---------- writes ----------

  private fileFor(meta: EntryMeta): string {
    const sub = meta.status === "proposed" ? PROPOSALS_DIR : TYPE_DIR[meta.type];
    return path.join(this.dir, sub, `${meta.id}.md`);
  }

  private uniqueId(type: EntryType, title: string): string {
    const base = makeId(type, title);
    let id = base;
    let n = 2;
    while (this.entries.has(id)) id = `${base}-${n++}`;
    return id;
  }

  private persist(entry: Entry, commitMsg: string): Entry {
    fs.mkdirSync(path.dirname(entry.file), { recursive: true });
    fs.writeFileSync(entry.file, serializeEntry(entry.meta, entry.body), "utf8");
    this.entries.set(entry.meta.id, entry);
    this.index.remove(entry.meta.id);
    this.index.add(entry);
    this.writeIndex();
    this.commit(commitMsg);
    return entry;
  }

  /** Direct, verified write (owner/chair). */
  write(input: NewEntryInput): Entry {
    return this.create(input, "verified");
  }

  /** Member write: lands in proposals/ until approved. */
  propose(input: NewEntryInput): Entry {
    return this.create(input, "proposed");
  }

  private create(input: NewEntryInput, status: EntryStatus): Entry {
    const title = input.title.trim();
    if (!title) throw new Error("title is required");
    if (!ENTRY_TYPES.includes(input.type)) throw new Error(`unknown type: ${input.type}`);
    const now = new Date().toISOString();
    const meta: EntryMeta = {
      id: this.uniqueId(input.type, title),
      title,
      type: input.type,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      project: input.project?.trim() || undefined,
      status,
      source: input.source,
      created: now,
      updated: now,
    };
    const entry: Entry = { meta, body: input.body.trim(), file: "" };
    entry.file = this.fileFor(meta);
    return this.persist(entry, `${status === "proposed" ? "propose" : "add"}: ${meta.id}`);
  }

  update(id: string, patch: UpdateEntryInput): Entry {
    const cur = this.entries.get(id);
    if (!cur) throw new Error(`not found: ${id}`);
    const meta: EntryMeta = { ...cur.meta, updated: new Date().toISOString() };
    if (patch.title?.trim()) meta.title = patch.title.trim();
    if (patch.tags) meta.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
    if (patch.project !== undefined) meta.project = patch.project.trim() || undefined;
    let body = cur.body;
    if (patch.body !== undefined) body = patch.body.trim();
    if (patch.append?.trim()) {
      const date = meta.updated.slice(0, 10);
      body = `${body.trim()}\n\n## 추가 (${date})\n\n${patch.append.trim()}`;
    }
    return this.persist({ meta, body, file: cur.file }, `update: ${id}`);
  }

  approve(id: string, opts: { source?: string } = {}): Entry {
    const cur = this.entries.get(id);
    if (!cur) throw new Error(`not found: ${id}`);
    if (cur.meta.status === "verified") return cur;
    const meta: EntryMeta = {
      ...cur.meta,
      status: "verified",
      updated: new Date().toISOString(),
      approvedBy: opts.source ?? cur.meta.approvedBy,
    };
    const next: Entry = { meta, body: cur.body, file: this.fileFor(meta) };
    if (next.file !== cur.file && fs.existsSync(cur.file)) fs.rmSync(cur.file);
    return this.persist(next, `approve: ${id}`);
  }

  reject(id: string, reason?: string): Entry {
    const cur = this.entries.get(id);
    if (!cur) throw new Error(`not found: ${id}`);
    const meta: EntryMeta = {
      ...cur.meta,
      status: "rejected",
      updated: new Date().toISOString(),
      rejectReason: reason,
    };
    // rejected entries stay in proposals/ for the record
    const file = path.join(this.dir, PROPOSALS_DIR, `${meta.id}.md`);
    if (file !== cur.file && fs.existsSync(cur.file)) fs.rmSync(cur.file);
    return this.persist({ meta, body: cur.body, file }, `reject: ${id}`);
  }

  remove(id: string): boolean {
    const cur = this.entries.get(id);
    if (!cur) return false;
    if (fs.existsSync(cur.file)) fs.rmSync(cur.file);
    this.entries.delete(id);
    this.index.remove(id);
    this.writeIndex();
    this.commit(`remove: ${id}`);
    return true;
  }
}

const README = `# Space Memory

내 PC 전체(Space)에 적용되는 공유 기억. 모든 AI 위원이 GenCouncil MCP 서버를 통해 읽고, 제안한다.

폴더
- solutions/     "X 문제는 Y로 해결했다"
- tools/         도구 위치·실행법
- conventions/   규약 (커밋 메시지, 폴더 구조, 네이밍)
- accounts/      계정별 특성·한도 패턴
- personas/      각 AI의 성향 관찰
- proposals/     위원이 제안했지만 아직 승인되지 않은 항목 (승인되면 위 폴더로 이동)
- INDEX.md       자동 생성 색인. 직접 편집하지 말 것.

파일 하나 = 기억 하나. YAML frontmatter(id, title, type, tags, project, status, source) + 본문.
직접 편집해도 된다. 서버가 변경을 감지해 다시 읽는다. 이 폴더는 git으로 버전 관리된다.
`;
