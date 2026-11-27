import { useEffect, useState } from "react";
import { api } from "../api";
import type { CurateStatus, MemoryHit } from "../types";
import { locale, t, useT } from "../i18n";

function curateLabel(kind?: CurateStatus["kind"]): string {
  return kind === "reorganize" ? t("전체 점검") : kind === "tidy" ? t("새 기억 정리") : t("제안 처리");
}

export function MemoryView({ notify }: { notify: (m: string) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [proposals, setProposals] = useState<MemoryHit[]>([]);
  const [recent, setRecent] = useState<MemoryHit[]>([]);
  const [open, setOpen] = useState<(MemoryHit & { body: string }) | null>(null);

  const [curate, setCurate] = useState<CurateStatus | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    const poll = async () => {
      try {
        const s = await api.curateStatus();
        if (!alive) return;
        setCurate((prev) => {
          if (prev?.running && !s.running) {
            notify(
              s.isError
                ? t("기억 정리 실패: {text}", { text: (s.text ?? "").slice(0, 100) })
                : s.kind === "reorganize"
                  ? t("Fable이 전체 점검을 마쳤습니다.")
                  : s.kind === "tidy"
                    ? s.remaining
                      ? t("새 기억 정리를 마쳤습니다 (남은 항목 {n}개).", { n: s.remaining })
                      : t("새 기억 정리를 마쳤습니다.")
                    : t("제안 처리를 마쳤습니다."),
            );
            void reload();
          }
          return s;
        });
        timer = window.setTimeout(poll, s.running ? 3000 : 15000);
      } catch {
        if (alive) timer = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);
  const startCurate = async () => {
    try {
      setCurate(await api.curate());
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const [stats, setStats] = useState<{ verified: number; common: number; byProject: Record<string, number> } | null>(null);
  const startTidy = async () => {
    try {
      const s = await api.tidy();
      setCurate(s);
      if (!s.running && s.text) notify(s.text);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const startReorganize = async () => {
    if (!confirm(t("Fable(추론 높음)이 승인된 기억 {n}개를 전부 읽고 점검합니다: 진짜 중복만 합치고, 여러 주제를 묶은 항목은 나누고, 반복·경위를 줄입니다. 기억이 많아 오래 걸리고 Fable 사용량이 많이 듭니다. 평소에는 \"새 기억 정리\"로 충분합니다. 진행할까요?", { n: stats?.verified ?? "" }))) return;
    try {
      setCurate(await api.reorganize());
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const clearAll = async () => {
    const typed = prompt(t("공유 기억을 전부 지웁니다 (승인된 기억 {n}개, 대기 제안 {p}개, 은퇴한 기억 포함). 모든 프로젝트의 의장·위원이 더 이상 이 기억을 보지 못합니다.\n지우기 전에 기억 폴더 전체를 backups 폴더에 복사해 둡니다.\n\n계속하려면 \"{word}\"라고 입력하세요.", { n: stats?.verified ?? "?", p: proposals.length, word: t("전체 삭제") }));
    if (typed === null) return;
    if (typed.trim() !== t("전체 삭제")) {
      notify(t("입력이 달라서 지우지 않았습니다."));
      return;
    }
    try {
      const r = await api.clearMemory();
      notify(t("기억 {n}개를 지웠습니다. 백업: {backup}", { n: r.removed, backup: r.backup }));
      setOpen(null);
      await reload();
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
    const timer = window.setTimeout(() => {
      if (q.trim()) api.memorySearch(q, all).then(setHits).catch(() => setHits([]));
      else setHits([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [q, all]);

  const show = async (id: string) => setOpen(await api.memoryEntry(id));

  const Row = ({ h, actions }: { h: MemoryHit; actions?: boolean }) => (
    <div className="mem-row">
      <button className="mem-title" onClick={() => show(h.id)}>
        <span className={`badge type-${h.type}`}>{h.type}</span>
        {h.scope && <span className={`badge scope-${h.scope}`}>{h.scope === "common" ? t("공용") : t("프로젝트")}</span>} {h.title}
        {h.project && <span className="small muted"> ({h.scope === "common" ? t("출처") + " " : ""}{h.project})</span>}
      </button>
      {h.snippet && <div className="small muted">{h.snippet}</div>}
      {h.source && <div className="small muted">{t("제안: {who}", { who: h.source })}</div>}
      {actions && (
        <div className="member-actions">
          <button className="primary small" onClick={async () => { await api.memoryApprove(h.id); notify(t("승인")); void reload(); }}>{t("승인")}</button>
          <button className="ghost small danger" onClick={async () => { await api.memoryReject(h.id); notify(t("거절")); void reload(); }}>{t("거절")}</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="center-inner memory">
      <div className="chair-head">
        <div className="chair-title">{t("공유 기억")}</div>
      </div>
      <div className="mem-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("검색 (한/영)")} autoFocus />
        <label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t("제안 포함")}</label>
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
            <h3>{t("검색 결과")} {hits.length}</h3>
            {hits.map((h) => <Row key={h.id} h={h} />)}
            {hits.length === 0 && <div className="muted small">{t("없음")}</div>}
          </section>
        )}
        <section>
          <div className="curate-bar">
            <h3>{t("승인 대기 제안")} {proposals.length}</h3>
            <button className="primary small" disabled={curate?.running || proposals.length === 0} onClick={startCurate} title={t("Opus(추론 중간)가 제안을 다듬고, 중복은 병합하고, 승인 또는 거절합니다")}>
              {curate?.running && curate.kind === "proposals" ? t("제안 처리 중…") : t("제안 처리")}
            </button>
            <button className="ghost small" disabled={curate?.running} onClick={startTidy} title={t("마지막 정리 이후 새로 들어왔거나 바뀐 기억만 골라(한 번에 30개) Opus(추론 중간)가 중복·길이·분류를 정리합니다")}>
              {curate?.running && curate.kind === "tidy" ? t("새 기억 정리 중…") : t("새 기억 정리")}
            </button>
            <button className="ghost small" disabled={curate?.running} onClick={startReorganize} title={t("Fable(추론 높음)이 승인된 기억 전체를 읽고 점검합니다. 오래 걸리고 사용량이 많아 가끔만 씁니다")}>
              {curate?.running && curate.kind === "reorganize" ? t("전체 점검 중…") : t("Fable 전체 점검")}
            </button>
          </div>
          {stats && (
            <div className="small muted">
              {t("승인된 기억 {verified}개 · 공용 {common}개 · 프로젝트 전용 {byProject}", { verified: stats.verified, common: stats.common, byProject: Object.entries(stats.byProject).map(([k, n]) => `${k} ${n}`).join(", ") || "0" })}
            </div>
          )}
          {curate?.running && (
            <div className="small muted">
              {t("{what} 중", { what: curateLabel(curate.kind) })}{curate.kind === "tidy" ? ` · ${t("항목 {n}개", { n: curate.pending ?? 0 })}` : ""} · {t("도구 호출 {n}회", { n: curate.steps ?? 0 })}
            </div>
          )}
          {!curate?.running && curate?.text && (
            <details className="curate-result">
              <summary className="small muted">{t("마지막 {what} 결과", { what: curateLabel(curate.kind) })}{curate.kind === "tidy" && curate.remaining ? ` · ${t("남은 항목 {n}개", { n: curate.remaining })}` : ""} ({curate.finishedAt ? new Date(curate.finishedAt).toLocaleString(locale()) : ""}{curate.costUsd !== undefined ? ` · $${curate.costUsd.toFixed(2)}` : ""})</summary>
              <pre className="mem-text">{curate.text}</pre>
            </details>
          )}
          {proposals.map((h) => <Row key={h.id} h={h} actions />)}
          {proposals.length === 0 && <div className="muted small">{t("없음")}</div>}
        </section>
        <section>
          <h3>{t("최근 기억")}</h3>
          {recent.map((h) => <Row key={h.id} h={h} />)}
        </section>
        <section className="mem-danger">
          <button className="ghost small danger" disabled={curate?.running} onClick={clearAll} title={t("승인된 기억·대기 제안·은퇴한 기억을 모두 지웁니다. 지우기 전에 기억 폴더를 backups에 복사합니다")}>
            {t("공유 기억 전체 삭제")}
          </button>
          <div className="small muted">{t("지우기 전에 기억 폴더 전체를 백업해 둡니다. 되돌리려면 백업 폴더 내용을 기억 폴더에 다시 복사하면 됩니다.")}</div>
        </section>
      </div>
    </div>
  );
}
