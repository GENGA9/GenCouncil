import YAML from "yaml";

export const ENTRY_TYPES = ["solution", "tool", "convention", "account", "persona"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_STATUSES = ["verified", "proposed", "rejected"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const TYPE_DIR: Record<EntryType, string> = {
  solution: "solutions",
  tool: "tools",
  convention: "conventions",
  account: "accounts",
  persona: "personas",
};

export const TYPE_PREFIX: Record<EntryType, string> = {
  solution: "sol",
  tool: "tool",
  convention: "conv",
  account: "acct",
  persona: "pers",
};

export const PROPOSALS_DIR = "proposals";

export interface EntryMeta {
  id: string;
  title: string;
  type: EntryType;
  tags: string[];
  project?: string;
  status: EntryStatus;
  /** who wrote/proposed it, e.g. "claude-code", "gemini-cli", "chair" */
  source?: string;
  created: string;
  updated: string;
  /** free-form extra fields are preserved */
  [key: string]: unknown;
}

export interface Entry {
  meta: EntryMeta;
  body: string;
  /** absolute path of the markdown file */
  file: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseEntry(text: string, file: string): Entry | null {
  const m = FM_RE.exec(text);
  if (!m) return null;
  let meta: Record<string, unknown>;
  try {
    meta = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof meta.id !== "string" || typeof meta.title !== "string") return null;
  const type = ENTRY_TYPES.includes(meta.type as EntryType) ? (meta.type as EntryType) : "solution";
  const status = ENTRY_STATUSES.includes(meta.status as EntryStatus)
    ? (meta.status as EntryStatus)
    : "verified";
  const tags = Array.isArray(meta.tags)
    ? meta.tags.map(String)
    : typeof meta.tags === "string"
      ? meta.tags.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const now = new Date().toISOString();
  return {
    meta: {
      ...meta,
      id: meta.id,
      title: meta.title,
      type,
      status,
      tags,
      project: typeof meta.project === "string" && meta.project ? meta.project : undefined,
      source: typeof meta.source === "string" ? meta.source : undefined,
      created: typeof meta.created === "string" ? meta.created : now,
      updated: typeof meta.updated === "string" ? meta.updated : now,
    },
    body: m[2].replace(/^\r?\n/, ""),
    file,
  };
}

export function serializeEntry(meta: EntryMeta, body: string): string {
  const ordered: Record<string, unknown> = {
    id: meta.id,
    title: meta.title,
    type: meta.type,
    tags: meta.tags,
    project: meta.project,
    status: meta.status,
    source: meta.source,
    created: meta.created,
    updated: meta.updated,
  };
  for (const [k, v] of Object.entries(meta)) {
    if (!(k in ordered)) ordered[k] = v;
  }
  for (const k of Object.keys(ordered)) if (ordered[k] === undefined) delete ordered[k];
  const fm = YAML.stringify(ordered).trimEnd();
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

export function slugify(title: string, max = 40): string {
  const s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (s || "entry").slice(0, max).replace(/-+$/g, "");
}

export function makeId(type: EntryType, title: string, date = new Date()): string {
  const d = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${TYPE_PREFIX[type]}-${d}-${slugify(title)}`;
}
