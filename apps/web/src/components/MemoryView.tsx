import { useEffect, useState } from "react";
import { api } from "../api";
import type { MemoryHit } from "../types";

export function MemoryView({ notify }: { notify: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [proposals, setProposals] = useState<MemoryHit[]>([]);
  const [recent, setRecent] = useState<MemoryHit[]>([]);
  const [open, setOpen] = useState<(MemoryHit & { body: string }) | null>(null);

  const reload = async () => {
    setProposals(await api.memoryProposals());
    setRecent(await api.memoryRecent());
  };
  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (q.trim()) api.memorySearch(q, all).then(setHits).catch(() => setHits([]));
      else setHits([]);
    }, 250);
    return () => clearTimeout(t);
  }, [q, all]);

  const show = async (id: string) => setOpen(await api.memoryEntry(id));

  const Row = ({ h, actions }: { h: MemoryHit; actions?: boolean }) => (
    <div className="mem-row">
      <button className="mem-title" onClick={() => show(h.id)}>
        <span className={`badge type-${h.type}`}>{h.type}</span> {h.title}
        {h.project && <span className="small muted"> ({h.project})</span>}
      </button>
      {h.snippet && <div className="small muted">{h.snippet}</div>}
      {h.source && <div className="small muted">제안: {h.source}</div>}
      {actions && (
        <div className="member-actions">
          <button className="primary small" onClick={async () => { await api.memoryApprove(h.id); notify("승인"); void reload(); }}>승인</button>
          <button className="ghost small danger" onClick={async () => { await api.memoryReject(h.id); notify("거절"); void reload(); }}>거절</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="center-inner memory">
      <div className="chair-head">
        <div className="chair-title">공유 기억</div>
      </div>
      <div className="mem-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색 (한/영)" autoFocus />
        <label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> 제안 포함</label>
      </div>
      <div className="mem-body">
        {open && (
          <div className="mem-detail card">
            <div className="member-head">
              <span className="member-name">{open.title}</span>
              <button className="icon" onClick={() => setOpen(null)}>✕</button>
            </div>
            <div className="small muted">{open.id} · {open.type} · {open.status} · {open.tags.join(", ")}</div>
            <pre className="mem-text">{open.body}</pre>
          </div>
        )}
        {q.trim() && (
          <section>
            <h3>검색 결과 {hits.length}</h3>
            {hits.map((h) => <Row key={h.id} h={h} />)}
            {hits.length === 0 && <div className="muted small">없음</div>}
          </section>
        )}
        <section>
          <h3>승인 대기 제안 {proposals.length}</h3>
          {proposals.map((h) => <Row key={h.id} h={h} actions />)}
          {proposals.length === 0 && <div className="muted small">없음</div>}
        </section>
        <section>
          <h3>최근 기억</h3>
          {recent.map((h) => <Row key={h.id} h={h} />)}
        </section>
      </div>
    </div>
  );
}
