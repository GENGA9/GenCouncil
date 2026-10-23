import { useEffect, useState } from "react";
import { api } from "../api";
import type { CurateStatus, MemoryHit } from "../types";

export function MemoryView({ notify }: { notify: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [proposals, setProposals] = useState<MemoryHit[]>([]);
  const [recent, setRecent] = useState<MemoryHit[]>([]);
  const [open, setOpen] = useState<(MemoryHit & { body: string }) | null>(null);

  const [curate, setCurate] = useState<CurateStatus | null>(null);
  useEffect(() => {
    let t: number | undefined;
    const poll = async () => {
      try {
        const s = await api.curateStatus();
        setCurate((prev) => {
          if (prev?.running && !s.running) {
            notify(s.isError ? `기억 정리 실패: ${(s.text ?? "").slice(0, 100)}` : s.kind === "reorganize" ? "Fable이 공용/프로젝트 재분류와 정리를 마쳤습니다." : "Fable이 제안 처리를 마쳤습니다.");
            void reload();
          }
          return s;
        });
        t = window.setTimeout(poll, s.running ? 3000 : 15000);
      } catch {
        t = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => window.clearTimeout(t);
  }, []);
  const startCurate = async () => {
    try {
      setCurate(await api.curate());
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const [stats, setStats] = useState<{ verified: number; common: number; byProject: Record<string, number> } | null>(null);
  const startReorganize = async () => {
    if (!confirm("Fable(추론 높음)이 승인된 기억 전체를 공용 지식과 프로젝트 전용 지식으로 다시 나누고, 겹치는 항목을 합칩니다. 몇 분 걸리고 Fable 사용량이 듭니다. 진행할까요?")) return;
    try {
      setCurate(await api.reorganize());
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const reload = async () => {
    setProposals(await api.memoryProposals());
    setRecent(await api.memoryRecent());
    setStats(await api.memoryStats().catch(() => null));
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
        <span className={`badge type-${h.type}`}>{h.type}</span>
        {h.scope && <span className={`badge scope-${h.scope}`}>{h.scope === "common" ? "공용" : "프로젝트"}</span>} {h.title}
        {h.project && <span className="small muted"> ({h.scope === "common" ? "출처 " : ""}{h.project})</span>}
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
          <div className="curate-bar">
            <h3>승인 대기 제안 {proposals.length}</h3>
            <button className="primary small" disabled={curate?.running || proposals.length === 0} onClick={startCurate} title="Fable(추론 높음)이 제안을 다듬고, 중복은 병합하고, 승인 또는 거절합니다">
              {curate?.running && curate.kind !== "reorganize" ? "Fable 처리 중…" : "Fable로 제안 처리"}
            </button>
            <button className="ghost small" disabled={curate?.running} onClick={startReorganize} title="Fable(추론 높음)이 승인된 기억 전체를 공용 지식과 프로젝트 전용 지식으로 다시 나누고, 겹치는 항목을 합치고, 낡은 항목을 정리합니다">
              {curate?.running && curate.kind === "reorganize" ? "재분류 중…" : "Fable로 공용·프로젝트 재분류"}
            </button>
          </div>
          {stats && (
            <div className="small muted">
              승인된 기억 {stats.verified}개 · 공용 {stats.common}개 · 프로젝트 전용 {Object.entries(stats.byProject).map(([k, n]) => `${k} ${n}`).join(", ") || "0"}
            </div>
          )}
          {curate?.running && <div className="small muted">{curate.kind === "reorganize" ? "재분류" : "처리"} 중 · 도구 호출 {curate.steps ?? 0}회</div>}
          {!curate?.running && curate?.text && (
            <details className="curate-result">
              <summary className="small muted">마지막 {curate.kind === "reorganize" ? "재분류" : "처리"} 결과 ({curate.finishedAt ? new Date(curate.finishedAt).toLocaleString() : ""}{curate.costUsd !== undefined ? ` · $${curate.costUsd.toFixed(2)}` : ""})</summary>
              <pre className="mem-text">{curate.text}</pre>
            </details>
          )}
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
