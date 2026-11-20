import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AccountUsage, UsageSnapshot, UsageWindow } from "../types";
import { useGemini } from "./GeminiOptIn";

const ORDER: Array<{ id: AccountUsage["provider"]; label: string; color: string }> = [
  { id: "claude", label: "Claude", color: "var(--c-claude)" },
  { id: "gpt", label: "GPT", color: "var(--c-gpt)" },
  { id: "gemini", label: "Gemini", color: "var(--c-gemini)" },
];

/** "2시간 10분 후" / "3일 후" */
export function until(iso?: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "곧 초기화";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}분 후 초기화`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 ${m % 60}분 후 초기화`;
  return `${Math.round(h / 24)}일 후 초기화`;
}

/** shows what is left: the bar fills like a battery and the number is the remaining percent */
function Bar({ label, w, color, none }: { label: string; w?: UsageWindow; color: string; none?: string }) {
  const pct = w?.usedPct ?? 0;
  const left = 100 - pct;
  const tip = w ? `${label} ${pct}% 사용 · ${100 - pct}% 남음${w.resetsAt ? " · " + until(w.resetsAt) + " (" + new Date(w.resetsAt).toLocaleString() + ")" : ""}` : none ?? "정보 없음";
  return (
    <div className="usage-bar-row" title={tip}>
      <span className="usage-bar-label">{label}</span>
      <span className="usage-bar">
        {w && <span className="usage-bar-fill" style={{ width: `${left}%`, background: left <= 10 ? "var(--danger, #d64545)" : color }} />}
      </span>
      <span className="usage-bar-pct">{w ? `${left}%` : none ? "-" : "?"}</span>
    </div>
  );
}

/** 5-hour and weekly usage bars for each AI account, under the left pane. */
export function UsagePanel({ pushed }: { pushed?: UsageSnapshot | null }) {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ u: AccountUsage; label: string; color: string } | null>(null);
  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      setSnap(await api.usage(refresh));
    } catch {
      /* keep the last numbers */
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (pushed) setSnap(pushed);
  }, [pushed]);

  const items = snap?.items ?? [];
  const geminiOff = useGemini()?.enabled === false;
  return (
    <div className="usage-panel">
      <div className="usage-head small muted">
        <span>남은 사용량</span>
        <button className="icon small" title={snap?.at ? `마지막 확인 ${new Date(snap.at).toLocaleTimeString()} · 눌러서 새로 확인` : "새로 확인"} onClick={() => void load(true)} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>
      {ORDER.map((p) => {
        const rows = items.filter((u) => u.provider === p.id);
        if (rows.length === 0) {
          return (
            <div key={p.id} className="usage-acct">
              <div className="usage-name" style={{ color: p.color }}>{p.label}</div>
              <div className="muted usage-err">{p.id === "gemini" && geminiOff ? "꺼짐" : snap ? "계정 없음" : "확인 중…"}</div>
            </div>
          );
        }
        return rows.map((u) => (
          <div
            key={u.account}
            className={`usage-acct${u.details?.length ? " clickable" : ""}`}
            onClick={u.details?.length ? () => setDetail({ u, label: rows.length > 1 ? `${p.label} · ${u.account}` : p.label, color: p.color }) : undefined}
          >
            <div className="usage-name" style={{ color: p.color }} title={u.details?.length ? "눌러서 세부 한도 보기" : rows.length > 1 ? `${p.label} · ${u.account}` : p.label}>
              {rows.length > 1 ? `${p.label}·${u.account}` : p.label}
            </div>
            {u.error ? (
              <div className="muted usage-err" title={u.error}>{u.error}</div>
            ) : (
              <div className="usage-bars">
                {/* Claude's 5-hour number is not reported reliably; its weekly bar is enough */}
                {!u.noFiveHour && p.id !== "claude" && <Bar label="5h" w={u.fiveHour} color={p.color} />}
                <Bar label="주" w={u.weekly} color={p.color} />
              </div>
            )}
          </div>
        ));
      })}
      {detail && <DetailPopup {...detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** every limit one account reports (Gemini: model groups plus per-model limits such as Argon) */
function DetailPopup({ u, label, color, onClose }: { u: AccountUsage; label: string; color: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const groups = new Map<string, NonNullable<AccountUsage["details"]>>();
  for (const d of u.details ?? []) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span style={{ color }}>{label} 세부 한도</span>
          <button className="icon" onClick={onClose}>✕</button>
        </div>
        {[...groups].map(([group, list]) => (
          <div key={group} className="usage-detail-group">
            <div className="usage-detail-title">{group}</div>
            {list.map((d) => {
              const left = 100 - d.usedPct;
              return (
                <div key={d.label} className="usage-detail-row">
                  <span className="usage-detail-label">{d.label.replace(group, "").replace(/remaining/i, "").trim() || d.label}</span>
                  <span className="usage-bar">
                    <span className="usage-bar-fill" style={{ width: `${left}%`, background: left <= 10 ? "var(--danger, #d64545)" : color }} />
                  </span>
                  <span className="usage-bar-pct">{left}%</span>
                  <span className="muted small usage-detail-reset" title={d.resetsAt ? new Date(d.resetsAt).toLocaleString() : ""}>
                    {d.resetsAt ? `${until(d.resetsAt)} (${new Date(d.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        <div className="muted small">마지막 확인 {new Date(u.checkedAt).toLocaleString()}</div>
      </div>
    </div>
  );
}
