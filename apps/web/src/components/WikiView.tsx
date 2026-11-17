import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { CurateStatus, WikiHit, WikiPage, WikiPageMeta, WikiStatus } from "../types";

import { buildSections, folderLabel, type Folder } from "../wikiTree";

/** Small markdown renderer: headings, lists, code blocks, quotes, tables, bold, inline code, links. No HTML passthrough. */
function inline(text: string, onLink: (p: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else {
      const href = m[4];
      const wiki = /^(common|models|projects)\//.test(href) ? href.replace(/\.md$/, "") : null;
      out.push(
        wiki ? (
          <a key={k} href="#" onClick={(e) => { e.preventDefault(); onLink(wiki); }}>{m[3]}</a>
        ) : /^https?:\/\//.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noreferrer">{m[3]}</a>
        ) : (
          <span key={k}>{m[3]}</span>
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text, onLink }: { text: string; onLink: (p: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${n++}`;
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={k}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 1, 5);
      const content = inline(h[2], onLink, k);
      blocks.push(level === 2 ? <h2 key={k}>{content}</h2> : level === 3 ? <h3 key={k}>{content}</h3> : <h4 key={k}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const indent = (lines[i].match(/^\s*/)?.[0].length ?? 0) >= 2;
        items.push(<li key={i} className={indent ? "sub" : undefined}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""), onLink, `${k}-${i}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      continue;
    }
    if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k}>{inline(q.join(" "), onLink, k)}</blockquote>);
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...rest] = rows;
      blocks.push(
        <div key={k} className="wiki-table">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, onLink, `${k}h${j}`)}</th>)}</tr></thead>
            <tbody>{rest.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, onLink, `${k}${ri}-${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k}>{inline(para.join(" "), onLink, k)}</p>);
  }
  return <div className="wiki-md">{blocks}</div>;
}

/** Proposal processing registers into the wiki; the full check is Fable reviewing the wiki's changes. */
function CurateBar({ notify, onDone }: { notify: (m: string) => void; onDone: () => void }) {
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [curate, setCurate] = useState<CurateStatus | null>(null);
  const [showResult, setShowResult] = useState(false);
  const loadStatus = () => api.wikiStatus().then(setStatus, () => undefined);

  useEffect(() => {
    let t: number | undefined;
    const poll = async () => {
      try {
        const s = await api.curateStatus();
        setCurate((prev) => {
          if (prev?.running && !s.running) {
            notify(s.isError ? `실패: ${(s.text ?? "").slice(0, 100)}` : s.kind === "reorganize" ? "Fable이 위키 점검을 마쳤습니다." : `위키 등록을 마쳤습니다${s.remaining ? ` (남은 항목 ${s.remaining}개)` : ""}.`);
            setShowResult(true);
            void loadStatus();
            onDone();
          }
          return s;
        });
        t = window.setTimeout(poll, s.running ? 3000 : 15000);
      } catch {
        t = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    void loadStatus();
    return () => window.clearTimeout(t);
  }, []);

  const start = async (kind: "register" | "review") => {
    if (
      kind === "review" &&
      !confirm(
        `Fable(추론 높음)이 위키를 점검합니다.\n1) 지난 점검 이후 바뀐 페이지 ${status?.changed ?? "?"}개 감수: 틀린 내용 바로잡기, 실수로 지워진 사실 되살리기, 바뀐 방법·중복 페이지 통합\n2) 전체 정리: 이제 필요 없는 페이지 정리, 긴 페이지 압축\n진행할까요?`,
      )
    )
      return;
    try {
      const s = kind === "register" ? await api.curate() : await api.reorganize();
      setCurate(s);
      if (!s.running && s.text) notify(s.text);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const waiting = (status?.proposals ?? 0) + (status?.unmigrated ?? 0);
  const running = curate?.running;
  return (
    <div className="wiki-curate">
      <div className="wiki-curate-row">
        <span className="small">
          등록 대기 <strong>{status?.proposals ?? "…"}</strong> 제안
          {(status?.unmigrated ?? 0) > 0 && <> · 위키로 옮길 기억 <strong>{status!.unmigrated}</strong></>}
          {" · "}점검 뒤 바뀐 페이지 <strong>{status?.changed ?? "…"}</strong>
          {status?.lastReview && <span className="muted"> (지난 점검 {new Date(status.lastReview).toLocaleDateString()})</span>}
        </span>
        <span className="wiki-curate-actions">
          <button className="primary small" disabled={running || waiting === 0} onClick={() => void start("register")} title="Opus가 제안과 위키로 옮기지 않은 기억을 한 번에 40개씩 읽어, 알맞은 위키 페이지에 합치거나 새 페이지로 등록합니다">
            {running && curate?.kind === "proposals" ? `위키 등록 중… (${curate.steps ?? 0})` : "제안 처리 (위키 등록)"}
          </button>
          <button className="ghost small" disabled={running || !status?.pages} onClick={() => void start("review")} title="Fable(추론 높음)이 지난 점검 이후 바뀐 위키 내용을 감수해 바로잡고 중복·개정된 방법을 통합한 뒤, 위키 전체에서 필요 없는 페이지를 정리하고 긴 페이지를 압축합니다">
            {running && curate?.kind === "reorganize" ? `전체 점검 중… (${curate.steps ?? 0})` : "전체 점검 (Fable)"}
          </button>
          {curate?.text && !running && (
            <button className="ghost small" onClick={() => setShowResult((v) => !v)}>
              지난 결과
            </button>
          )}
        </span>
      </div>
      {showResult && curate?.text && !running && (
        <pre className={`wiki-curate-result small ${curate.isError ? "error" : ""}`}>
          {curate.kind === "reorganize" ? "전체 점검" : "위키 등록"} · {curate.finishedAt ? new Date(curate.finishedAt).toLocaleString() : ""}
          {"\n"}
          {curate.text}
        </pre>
      )}
    </div>
  );
}

export function WikiView({ notify, onOpenMemory }: { notify: (m: string) => void; onOpenMemory?: () => void }) {
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WikiHit[] | null>(null);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [edit, setEdit] = useState<{ path: string; title: string; summary: string; body: string; isNew: boolean } | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const reload = async () => {
    try {
      setPages(await api.wikiList());
    } catch (e) {
      notify((e as Error).message);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => void api.wikiSearch(q).then(setHits, (e) => notify((e as Error).message)), 250);
    return () => clearTimeout(t);
  }, [q]);

  const open = async (p: string) => {
    try {
      setEdit(null);
      setShowHistory(false);
      setPage(await api.wikiPage(p));
    } catch (e) {
      notify((e as Error).message);
    }
  };

  /** one row per project (or common area), its deeper folders nested inside (wikiTree.ts) */
  const sections = useMemo(() => buildSections(pages), [pages]);
  const [openSecs, setOpenSecs] = useState<Set<string>>(new Set());
  const toggleSec = (s: string) =>
    setOpenSecs((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const save = async () => {
    if (!edit) return;
    try {
      const saved = await api.wikiSave({ path: edit.path, title: edit.title, summary: edit.summary, body: edit.body });
      notify(`저장했습니다: ${saved.path}`);
      await reload();
      await open(saved.path);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const remove = async () => {
    if (!page || !confirm(`'${page.title}' 페이지를 지울까요? (git 기록에는 남습니다)`)) return;
    try {
      await api.wikiRemove(page.path);
      setPage(null);
      await reload();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const list = hits ?? null;

  return (
    <div className="center-inner wiki">
      <div className="chair-head">
        <div className="chair-title">Gen Wiki <span className="small muted">위원·의장·사용자가 함께 보는 정리된 문서 · {pages.length}쪽</span></div>
        <span className="wiki-curate-actions">
          {onOpenMemory && (
            <button className="ghost small" onClick={onOpenMemory} title="위키로 옮기기 전의 공유 기억과 제안 원본">
              기억 원본
            </button>
          )}
          <button className="ghost small" onClick={() => setEdit({ path: "common/", title: "", summary: "", body: "", isNew: true })}>새 페이지</button>
        </span>
      </div>
      <CurateBar notify={notify} onDone={() => void reload()} />
      <div className="wiki-layout">
        <nav className="wiki-nav">
          <input className="wiki-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="위키 검색" />
          {list ? (
            list.length ? (
              list.map((h) => (
                <button key={h.path} className={`wiki-item ${page?.path === h.path ? "on" : ""}`} onClick={() => void open(h.path)}>
                  <div>{h.title}</div>
                  <div className="small muted">{h.snippet}</div>
                </button>
              ))
            ) : (
              <div className="small muted">찾은 페이지가 없습니다.</div>
            )
          ) : sections.length ? (
            sections.map((g) => {
              // a group stays open while the page being read is anywhere inside it, subfolders included
              const isOpen = openSecs.has(g.key) || page?.section === g.key || g.subs.some((s) => s.key === page?.section);
              const items = (f: Folder) => (
                <>
                  {f.index && (
                    <button className={`wiki-item wiki-index ${page?.path === f.index.path ? "on" : ""}`} onClick={() => void open(f.index!.path)}>
                      이 폴더 소개
                    </button>
                  )}
                  {f.pages.map((p) => (
                    <button key={p.path} className={`wiki-item ${page?.path === p.path ? "on" : ""}`} title={p.summary} onClick={() => void open(p.path)}>
                      {p.title}
                    </button>
                  ))}
                </>
              );
              return (
                <div key={g.key} className="wiki-section">
                  <button className="wiki-section-title" title={g.index?.summary} onClick={() => toggleSec(g.key)}>
                    <span className="wiki-caret">{isOpen ? "▾" : "▸"}</span>
                    <span className="wiki-section-name">{folderLabel(g, false)}</span>
                    <span className="wiki-count">{g.total}</span>
                  </button>
                  {isOpen && (
                    <>
                      {items(g)}
                      {g.subs.map((sub) => {
                        const subOpen = openSecs.has(sub.key) || page?.section === sub.key;
                        return (
                          <div key={sub.key} className="wiki-subsection">
                            <button className="wiki-section-title" title={sub.index?.summary} onClick={() => toggleSec(sub.key)}>
                              <span className="wiki-caret">{subOpen ? "▾" : "▸"}</span>
                              <span className="wiki-section-name">{folderLabel(sub, true)}</span>
                              <span className="wiki-count">{sub.pages.length}</span>
                            </button>
                            {subOpen && items(sub)}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })
          ) : (
            <div className="small muted wiki-empty">
              아직 페이지가 없습니다. 위원·의장이 wiki_write로 만들거나, "새 페이지"로 직접 쓸 수 있습니다.
            </div>
          )}
        </nav>
        <article className="wiki-page">
          {edit ? (
            <div className="wiki-edit">
              <label>
                경로 <span className="small muted">common/&lt;페이지&gt; · models/&lt;페이지&gt; · projects/&lt;프로젝트&gt;/&lt;페이지&gt;</span>
                <input value={edit.path} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, path: e.target.value })} />
              </label>
              <label>
                제목
                <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </label>
              <label>
                한 줄 요약
                <input value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
              </label>
              <label>
                본문 (마크다운)
                <textarea rows={20} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              </label>
              <div className="wiki-actions">
                <button className="primary small" onClick={() => void save()}>저장</button>
                <button className="ghost small" onClick={() => setEdit(null)}>취소</button>
              </div>
            </div>
          ) : page ? (
            <>
              <div className="wiki-page-head">
                <h1>{page.title}</h1>
                <div className="small muted">
                  {page.path} · {new Date(page.updated).toLocaleString()} · {page.by}
                  {page.sources.length > 0 && ` · 공용 기억 ${page.sources.length}개에서 옮김`}
                </div>
                {page.summary && <div className="wiki-summary">{page.summary}</div>}
                <div className="wiki-actions">
                  <button className="ghost small" onClick={() => setEdit({ path: page.path, title: page.title, summary: page.summary, body: page.body, isNew: false })}>편집</button>
                  <button className="ghost small" onClick={() => setShowHistory((v) => !v)}>변경 기록 {page.history?.length ?? 0}</button>
                  <button className="ghost small danger" onClick={() => void remove()}>삭제</button>
                </div>
                {showHistory && (
                  <ul className="wiki-history small">
                    {(page.history ?? []).map((h) => (
                      <li key={h.commit}>
                        <code>{h.commit}</code> {new Date(h.date).toLocaleString()} · {h.subject}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Markdown text={page.body} onLink={(p) => void open(p)} />
            </>
          ) : (
            <div className="muted wiki-empty">왼쪽에서 페이지를 고르세요.</div>
          )}
        </article>
      </div>
    </div>
  );
}
