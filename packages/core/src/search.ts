import type { Entry, EntryStatus, EntryType } from "./entry.js";

const CJK_RE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Tokenizer that works for Korean/English mixed text without a morphological
 * analyzer: whole words plus character bigrams for CJK words, so "경로를"
 * still matches "경로".
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const w of words) {
    out.push(w);
    if (w.length > 1 && CJK_RE.test(w)) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
  }
  return out;
}

interface FieldTf {
  title: number;
  tags: number;
  body: number;
}

interface IndexedEntry {
  entry: Entry;
  tf: Map<string, FieldTf>;
}

export interface SearchOptions {
  type?: EntryType;
  project?: string;
  status?: EntryStatus | "any";
  limit?: number;
}

export interface SearchHit {
  id: string;
  title: string;
  type: EntryType;
  status: EntryStatus;
  tags: string[];
  project?: string;
  score: number;
  snippet: string;
  updated: string;
}

function count(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export class SearchIndex {
  private entries = new Map<string, IndexedEntry>();

  clear(): void {
    this.entries.clear();
  }

  add(entry: Entry): void {
    const tf = new Map<string, FieldTf>();
    const bump = (tokens: Map<string, number>, field: keyof FieldTf) => {
      for (const [tok, n] of tokens) {
        const cur = tf.get(tok) ?? { title: 0, tags: 0, body: 0 };
        cur[field] += n;
        tf.set(tok, cur);
      }
    };
    bump(count(tokenize(entry.meta.title)), "title");
    bump(count(tokenize(entry.meta.tags.join(" "))), "tags");
    bump(count(tokenize(entry.body)), "body");
    this.entries.set(entry.meta.id, { entry, tf });
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0) return [];
    const limit = opts.limit ?? 10;
    const status = opts.status ?? "verified";
    const hits: SearchHit[] = [];

    for (const { entry, tf } of this.entries.values()) {
      const m = entry.meta;
      if (opts.type && m.type !== opts.type) continue;
      if (opts.project && (m.project ?? "").toLowerCase() !== opts.project.toLowerCase()) continue;
      if (status !== "any" && m.status !== status) continue;

      let score = 0;
      let matched = 0;
      for (const q of qTokens) {
        let f = tf.get(q);
        if (!f && q.length >= 4) {
          // prefix match for longer latin tokens (e.g. "ffmpe" -> "ffmpeg")
          for (const [tok, ftf] of tf) {
            if (tok.startsWith(q)) {
              f = f ? { title: f.title + ftf.title, tags: f.tags + ftf.tags, body: f.body + ftf.body } : ftf;
            }
          }
        }
        if (!f) continue;
        matched++;
        // whole-word tokens are worth more than CJK bigrams
        const w = q.length >= 3 || !CJK_RE.test(q) ? 1 : 0.5;
        score += w * (3 * f.title + 2 * f.tags + Math.log1p(f.body));
      }
      if (matched === 0) continue;
      // reward matching more distinct query tokens
      score *= 1 + matched / qTokens.length;
      if (m.status === "verified") score *= 1.1;
      hits.push({
        id: m.id,
        title: m.title,
        type: m.type,
        status: m.status,
        tags: m.tags,
        project: m.project,
        score: Math.round(score * 100) / 100,
        snippet: makeSnippet(entry.body, query),
        updated: m.updated,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated));
    return hits.slice(0, limit);
  }
}

export function makeSnippet(body: string, query: string, radius = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const words = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).sort((a, b) => b.length - a.length);
  const lower = flat.toLowerCase();
  let pos = -1;
  for (const w of words) {
    pos = lower.indexOf(w);
    if (pos >= 0) break;
  }
  if (pos < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? "…" : "");
  const start = Math.max(0, pos - radius);
  const end = Math.min(flat.length, pos + radius);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}
