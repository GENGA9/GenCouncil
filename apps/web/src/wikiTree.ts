// How the wiki's pages become the rows of the left-hand list. Kept apart from the view so it can be
// tested: packages/web test (apps/web/test/wikitree.mjs) runs it against a real page list.
import type { WikiPageMeta } from "./types";

/** folder path -> label: "common/comfyui" -> "공용 · comfyui", "projects/h3_studio/video" -> "프로젝트 · h3_studio · video" */
export const SECTION_LABEL = (s: string): string => {
  const [top, ...rest] = s.split("/");
  const head = top === "common" ? "공용" : top === "models" ? "모델" : top === "projects" ? "프로젝트" : top;
  return [head, ...rest].join(" · ");
};

/** a folder of the wiki: its pages and the index page that describes it */
export type Folder = { key: string; index?: WikiPageMeta; pages: WikiPageMeta[] };
/** a project (or common area) and the folders nested inside it */
export type Group = Folder & { subs: Folder[]; total: number };

/**
 * One group per project (or common area), with its deeper folders nested inside — not one group per
 * folder. A project that organises its pages ("projects/h3_studio/storyboard", ".../video", …) was
 * otherwise spread over as many sibling rows as it had folders, which reads as several projects of
 * the same name; two of h3_studio's read the same thing once the index titles were cut to fit.
 * The group is the first two path segments ("common/git", "projects/h3_studio"), anything deeper is
 * a folder inside it. Order follows the page list, which the server sorts by folder then title.
 */
export function buildSections(pages: WikiPageMeta[]): Group[] {
  const folder = (key: string): Folder => ({ key, pages: [] });
  const put = (f: Folder, p: WikiPageMeta) => (p.path.endsWith("/index") ? (f.index = p) : f.pages.push(p));
  const m = new Map<string, Folder & { subs: Map<string, Folder> }>();
  for (const p of pages) {
    const top = p.section.split("/").slice(0, 2).join("/");
    const g = m.get(top) ?? { ...folder(top), subs: new Map<string, Folder>() };
    if (p.section === top) put(g, p);
    else {
      const sub = g.subs.get(p.section) ?? folder(p.section);
      put(sub, p);
      g.subs.set(p.section, sub);
    }
    m.set(top, g);
  }
  return [...m.values()].map((g) => {
    const subs = [...g.subs.values()];
    return { ...g, subs, total: g.pages.length + subs.reduce((n, s) => n + s.pages.length, 0) };
  });
}

/**
 * What a folder's row says. A group keeps the path prefix ("프로젝트 · h3_studio · 심연의 복수 …") so it
 * can be told from other projects; a folder nested inside one already sits under that name, so it
 * shows its own title only — repeating the project there is what made two rows read alike.
 */
export function folderLabel(f: Folder, nested: boolean): string {
  if (nested) return f.index?.title ?? f.key.split("/").pop() ?? f.key;
  const parent = f.key.split("/").slice(0, -1).join("/");
  return f.index ? `${SECTION_LABEL(parent || f.key)} · ${f.index.title}` : SECTION_LABEL(f.key);
}
