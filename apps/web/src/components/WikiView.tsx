import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { CurateStatus, MemoryHit, WikiHit, WikiPage, WikiPageMeta, WikiStatus } from "../types";

import { buildSections, folderLabel, type Folder } from "../wikiTree";
import { locale, useT } from "../i18n";

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
function CurateBar({ notify, onDone, onReview, reviewing, version }: { notify: (m: string) => void; onDone: () => void; onReview: () => void; reviewing: boolean; version: number }) {
  const t = useT();
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [curate, setCurate] = useState<CurateStatus | null>(null);
  const [showResult, setShowResult] = useState(false);
  const loadStatus = () => api.wikiStatus().then(setStatus, () => undefined);

  useEffect(() => {
    let timer: number | undefined;
    const poll = async () => {
      try {
        const s = await api.curateStatus();
        setCurate((prev) => {
          if (prev?.running && !s.running) {
            notify(s.isError ? t("실패: {text}", { text: (s.text ?? "").slice(0, 100) }) : s.kind === "reorganize" ? t("Fable이 위키 점검을 마쳤습니다.") : s.remaining ? t("위키 등록을 마쳤습니다 (남은 항목 {n}개).", { n: s.remaining }) : t("위키 등록을 마쳤습니다."));
            setShowResult(true);
            void loadStatus();
            onDone();
          }
          return s;
        });
        timer = window.setTimeout(poll, s.running ? 3000 : 15000);
      } catch {
        timer = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    void loadStatus();
    return () => window.clearTimeout(timer);
  }, []);
  // a proposal was rejected in the review: the counts change
  useEffect(() => {
    if (version) void loadStatus();
  }, [version]);

  const start = async (kind: "register" | "review") => {
    if (
      kind === "review" &&
      !confirm(
        t("Fable(추론 높음)이 위키를 점검합니다.\n1) 지난 점검 이후 바뀐 페이지 {n}개 감수: 틀린 내용 바로잡기, 실수로 지워진 사실 되살리기, 바뀐 방법·중복 페이지 통합\n2) 전체 정리: 이제 필요 없는 페이지 정리, 긴 페이지 압축\n진행할까요?", { n: status?.changed ?? "?" }),
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
          {t("등록 대기 제안")} <strong>{status?.proposals ?? "…"}</strong>{" "}
          <button className={`ghost small ${reviewing ? "on" : ""}`} onClick={onReview} title={t("제안을 하나씩 읽고, 위키에 넣지 않을 것은 반려합니다")}>
            {reviewing ? t("제안 닫기") : t("제안 검토")}
          </button>
          {(status?.unmigrated ?? 0) > 0 && <> · {t("위키로 옮길 기억")} <strong>{status!.unmigrated}</strong></>}
          {" · "}{t("점검 뒤 바뀐 페이지")} <strong>{status?.changed ?? "…"}</strong>
          {status?.lastReview && <span className="muted"> ({t("지난 점검 {date}", { date: new Date(status.lastReview).toLocaleDateString(locale()) })})</span>}
        </span>
        <span className="wiki-curate-actions">
          <button className="primary small" disabled={running || waiting === 0} onClick={() => void start("register")} title={t("Opus가 제안과 위키로 옮기지 않은 기억을 한 번에 40개씩 읽어, 알맞은 위키 페이지에 합치거나 새 페이지로 등록합니다")}>
            {running && curate?.kind === "proposals" ? t("위키 등록 중… ({n})", { n: curate.steps ?? 0 }) : t("제안 처리 (위키 등록)")}
          </button>
          <button className="ghost small" disabled={running || !status?.pages} onClick={() => void start("review")} title={t("Fable(추론 높음)이 지난 점검 이후 바뀐 위키 내용을 감수해 바로잡고 중복·개정된 방법을 통합한 뒤, 위키 전체에서 필요 없는 페이지를 정리하고 긴 페이지를 압축합니다")}>
            {running && curate?.kind === "reorganize" ? t("전체 점검 중… ({n})", { n: curate.steps ?? 0 }) : t("전체 점검 (Fable)")}
          </button>
          {curate?.text && !running && (
            <button className="ghost small" onClick={() => setShowResult((v) => !v)}>
              {t("지난 결과")}
            </button>
          )}
        </span>
      </div>
      {showResult && curate?.text && !running && (
        <pre className={`wiki-curate-result small ${curate.isError ? "error" : ""}`}>
          {curate.kind === "reorganize" ? t("전체 점검") : t("위키 등록")} · {curate.finishedAt ? new Date(curate.finishedAt).toLocaleString(locale()) : ""}
          {"\n"}
          {curate.text}
        </pre>
      )}
    </div>
  );
}

const KIND: Record<string, string> = { solution: "해결책", tool: "도구", convention: "규약", account: "계정", persona: "모델 성향", project: "프로젝트" };

/** "위키 수정: common/git/x — 무엇" -> { path: "common/git/x", change: "무엇" } */
function proposalTarget(h: MemoryHit): { path?: string; change: string } {
  const path = h.tags.find((t) => t.startsWith("wiki:"))?.slice(5);
  const m = h.title.match(/^위키 수정: (\S+) — (.*)$/);
  return { path: path ?? m?.[1], change: m ? m[2] : h.title };
}

/**
 * Proposals waiting for the wiki: from members and the chair (wiki_propose: a fix to a page) and
 * from shared memory (memory_propose: a new fact). Read each one; reject what should not go in.
 * What is left goes into the wiki when "제안 처리" runs.
 */
function ProposalReview({ notify, onOpenPage, onChanged, onClose }: { notify: (m: string) => void; onOpenPage: (p: string) => void; onChanged: () => void; onClose: () => void }) {
  const t = useT();
  const [list, setList] = useState<MemoryHit[] | null>(null);
  const [open, setOpen] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "wiki" | "memory">("all");
  useEffect(() => {
    api.memoryProposals().then(
      (l) => setList([...l].sort((a, b) => String(b.updated).localeCompare(String(a.updated)))),
      (e) => notify((e as Error).message),
    );
  }, []);
  const toggle = async (id: string) => {
    if (id in open) {
      setOpen(({ [id]: _, ...rest }) => rest);
      return;
    }
    setOpen((o) => ({ ...o, [id]: null }));
    try {
      const e = await api.memoryEntry(id);
      setOpen((o) => ({ ...o, [id]: e.body }));
    } catch (e) {
      setOpen((o) => ({ ...o, [id]: t("(읽지 못했습니다: {msg})", { msg: (e as Error).message }) }));
    }
  };
  const reject = async (h: MemoryHit) => {
    const reason = prompt(t("'{change}' 제안을 반려할까요?\n이유를 적으면 함께 남습니다(비워도 됩니다).", { change: proposalTarget(h).change }), "");
    if (reason === null) return;
    setBusy(h.id);
    try {
      await api.memoryReject(h.id, reason.trim() || undefined);
      setList((l) => (l ?? []).filter((x) => x.id !== h.id));
      notify(t("제안을 반려했습니다. 위키에 반영되지 않습니다."));
      onChanged();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const shown = (list ?? []).filter((h) => filter === "all" || (filter === "wiki") === Boolean(proposalTarget(h).path));
  const wikiCount = (list ?? []).filter((h) => proposalTarget(h).path).length;
  return (
    <div className="wiki-review">
      <div className="wiki-review-head">
        <h1>{t("등록 대기 제안")} {list ? list.length : "…"}</h1>
        <button className="ghost small" onClick={onClose}>{t("닫기")}</button>
      </div>
      <p className="small muted">
        {t("위원·의장이 낸 위키 수정 제안과 공유 기억 제안입니다. 위키에 넣지 않을 것은 반려하세요. 남겨 둔 제안은 \"제안 처리 (위키 등록)\"를 누를 때 알맞은 페이지에 합쳐집니다.")}
      </p>
      {list && list.length > 0 && (
        <div className="wiki-review-filter">
          <button className={`ghost small ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>{t("전체")} {list.length}</button>
          <button className={`ghost small ${filter === "wiki" ? "on" : ""}`} onClick={() => setFilter("wiki")}>{t("위키 수정")} {wikiCount}</button>
          <button className={`ghost small ${filter === "memory" ? "on" : ""}`} onClick={() => setFilter("memory")}>{t("기억")} {list.length - wikiCount}</button>
        </div>
      )}
      {!list && <div className="muted small">{t("불러오는 중…")}</div>}
      {list && list.length === 0 && <div className="muted wiki-empty">{t("기다리는 제안이 없습니다.")}</div>}
      {shown.map((h) => {
        const pt = proposalTarget(h);
        const body = open[h.id];
        return (
          <div key={h.id} className={`wiki-prop ${h.id in open ? "open" : ""}`}>
            <button className="wiki-prop-main" onClick={() => void toggle(h.id)}>
              <span className={`badge ${pt.path ? "type-wiki" : "type-" + h.type}`}>{pt.path ? t("위키 수정") : t(KIND[h.type] ?? h.type)}</span>
              <span className="wiki-prop-title">{pt.change}</span>
              <span className="wiki-caret">{h.id in open ? "▾" : "▸"}</span>
            </button>
            <div className="wiki-prop-meta small muted">
              {pt.path && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenPage(pt.path!);
                  }}
                >
                  {pt.path}
                </a>
              )}
              {h.source && <span>{t("제안: {who}", { who: h.source })}</span>}
              {h.project && <span>{h.project}</span>}
              <span>{new Date(h.updated).toLocaleString(locale())}</span>
            </div>
            {h.id in open && (body === null ? <div className="muted small">{t("읽는 중…")}</div> : <pre className="wiki-prop-body">{body}</pre>)}
            <div className="wiki-actions">
              <button className="ghost small danger" disabled={busy === h.id} onClick={() => void reject(h)}>
                {busy === h.id ? t("반려하는 중…") : t("반려")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WikiView({ notify, onOpenMemory }: { notify: (m: string) => void; onOpenMemory?: () => void }) {
  const t = useT();
  const [pages, setPages] = useState<WikiPageMeta[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WikiHit[] | null>(null);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [edit, setEdit] = useState<{ path: string; title: string; summary: string; body: string; isNew: boolean } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [version, setVersion] = useState(0);

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
    const timer = setTimeout(() => void api.wikiSearch(q).then(setHits, (e) => notify((e as Error).message)), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const open = async (p: string) => {
    try {
      setEdit(null);
      setShowHistory(false);
      setReviewing(false);
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
      notify(t("저장했습니다: {path}", { path: saved.path }));
      await reload();
      await open(saved.path);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const remove = async () => {
    if (!page || !confirm(t("'{title}' 페이지를 지울까요? (git 기록에는 남습니다)", { title: page.title }))) return;
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
    <div className={`center-inner wiki ${page || edit || reviewing ? "has-page" : ""}`}>
      <div className="chair-head">
        <div className="chair-title">Gen Wiki <span className="small muted">{t("위원·의장·사용자가 함께 보는 정리된 문서 · {n}쪽", { n: pages.length })}</span></div>
        <span className="wiki-curate-actions">
          {onOpenMemory && (
            <button className="ghost small" onClick={onOpenMemory} title={t("위키로 옮기기 전의 공유 기억과 제안 원본")}>
              {t("기억 원본")}
            </button>
          )}
          <button className="ghost small" onClick={() => setEdit({ path: "common/", title: "", summary: "", body: "", isNew: true })}>{t("새 페이지")}</button>
        </span>
      </div>
      <CurateBar notify={notify} onDone={() => void reload()} onReview={() => setReviewing((v) => !v)} reviewing={reviewing} version={version} />
      <div className="wiki-layout">
        <nav className="wiki-nav">
          <input className="wiki-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("위키 검색")} />
          {list ? (
            list.length ? (
              list.map((h) => (
                <button key={h.path} className={`wiki-item ${page?.path === h.path ? "on" : ""}`} onClick={() => void open(h.path)}>
                  <div>{h.title}</div>
                  <div className="small muted">{h.snippet}</div>
                </button>
              ))
            ) : (
              <div className="small muted">{t("찾은 페이지가 없습니다.")}</div>
            )
          ) : sections.length ? (
            sections.map((g) => {
              // a group stays open while the page being read is anywhere inside it, subfolders included
              const isOpen = openSecs.has(g.key) || page?.section === g.key || g.subs.some((s) => s.key === page?.section);
              const items = (f: Folder) => (
                <>
                  {f.index && (
                    <button className={`wiki-item wiki-index ${page?.path === f.index.path ? "on" : ""}`} onClick={() => void open(f.index!.path)}>
                      {t("이 폴더 소개")}
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
                    <span className="wiki-section-name">{folderLabel(g, false, t)}</span>
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
                              <span className="wiki-section-name">{folderLabel(sub, true, t)}</span>
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
              {t("아직 페이지가 없습니다. 위원·의장이 wiki_write로 만들거나, \"새 페이지\"로 직접 쓸 수 있습니다.")}
            </div>
          )}
        </nav>
        <article className="wiki-page">
          {reviewing ? (
            <ProposalReview notify={notify} onOpenPage={(p) => void open(p)} onChanged={() => setVersion((v) => v + 1)} onClose={() => setReviewing(false)} />
          ) : (
          <>
          {/* only where the list and the page cannot be side by side (the vision sheet on a phone) */}
          {(page || edit) && (
            <button
              className="wiki-back ghost small"
              onClick={() => {
                if (edit && !confirm(t("편집 중인 내용을 버리고 목록으로 돌아갈까요?"))) return;
                setEdit(null);
                setPage(null);
              }}
            >
              {t("‹ 목록")}
            </button>
          )}
          {edit ? (
            <div className="wiki-edit">
              <label>
                {t("경로")} <span className="small muted">{t("common/<페이지> · models/<페이지> · projects/<프로젝트>/<페이지>")}</span>
                <input value={edit.path} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, path: e.target.value })} />
              </label>
              <label>
                {t("제목")}
                <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </label>
              <label>
                {t("한 줄 요약")}
                <input value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
              </label>
              <label>
                {t("본문 (마크다운)")}
                <textarea rows={20} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              </label>
              <div className="wiki-actions">
                <button className="primary small" onClick={() => void save()}>{t("저장")}</button>
                <button className="ghost small" onClick={() => setEdit(null)}>{t("취소")}</button>
              </div>
            </div>
          ) : page ? (
            <>
              <div className="wiki-page-head">
                <h1>{page.title}</h1>
                <div className="small muted">
                  {page.path} · {new Date(page.updated).toLocaleString(locale())} · {page.by}
                  {page.sources.length > 0 && ` · ${t("공용 기억 {n}개에서 옮김", { n: page.sources.length })}`}
                </div>
                {page.summary && <div className="wiki-summary">{page.summary}</div>}
                <div className="wiki-actions">
                  <button className="ghost small" onClick={() => setEdit({ path: page.path, title: page.title, summary: page.summary, body: page.body, isNew: false })}>{t("편집")}</button>
                  <button className="ghost small" onClick={() => setShowHistory((v) => !v)}>{t("변경 기록")} {page.history?.length ?? 0}</button>
                  <button className="ghost small danger" onClick={() => void remove()}>{t("삭제")}</button>
                </div>
                {showHistory && (
                  <ul className="wiki-history small">
                    {(page.history ?? []).map((h) => (
                      <li key={h.commit}>
                        <code>{h.commit}</code> {new Date(h.date).toLocaleString(locale())} · {h.subject}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Markdown text={page.body} onLink={(p) => void open(p)} />
            </>
          ) : (
            <div className="muted wiki-empty">{t("왼쪽에서 페이지를 고르세요.")}</div>
          )}
          </>
          )}
        </article>
      </div>
    </div>
  );
}
