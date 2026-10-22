import { useEffect, useState } from "react";
import { api } from "../api";
import type { Limits, ModelsInfo } from "../types";

const LABEL: Record<string, string> = {
  claude: "클로드",
  gemini: "제미나이 (Antigravity)",
  gpt: "GPT (Codex)",
  "gemini-web": "웹 제미나이",
  aistudio: "AI Studio",
  chatgpt: "ChatGPT 웹",
};

let cache: ModelsInfo | null = null;
export function useModels(): ModelsInfo | null {
  const [m, setM] = useState<ModelsInfo | null>(cache);
  useEffect(() => {
    if (!cache) api.models().then((r) => setM((cache = r))).catch(() => undefined);
  }, []);
  return m;
}

/** Per-provider caps: how many at once, the highest model and the highest effort the chair may use. */
export function LimitsEditor({ value, onChange }: { value: Limits; onChange: (v: Limits) => void }) {
  const models = useModels();
  if (!models) return <div className="muted small">모델 목록 불러오는 중…</div>;
  const set = (key: string, patch: Partial<Limits[string]>) => onChange({ ...value, [key]: { ...value[key], ...patch } });
  return (
    <div className="limits">
      <div className="limits-head small muted">
        <span>위원 종류</span>
        <span>동시 최대</span>
        <span>최대 모델</span>
        <span>최대 추론</span>
      </div>
      {models.providers.map((p) => {
        const l = value[p.id] ?? models.defaults[p.id];
        return (
          <div key={p.id} className="limits-row">
            <span className={`limits-name fam-${p.id}`}>{LABEL[p.id] ?? p.id}</span>
            <input type="number" min={0} max={20} value={l.maxMembers} onChange={(e) => set(p.id, { maxMembers: Number(e.target.value) })} />
            <select value={l.maxModel ?? ""} disabled={l.maxMembers === 0} onChange={(e) => set(p.id, { maxModel: e.target.value })}>
              {p.models.map((m) => (
                <option key={m.id} value={m.id} title={m.note}>{m.label}</option>
              ))}
            </select>
            {p.effort ? (
              <select value={l.maxEffort ?? ""} disabled={l.maxMembers === 0} onChange={(e) => set(p.id, { maxEffort: e.target.value })}>
                {(p.efforts ?? models.efforts).map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            ) : (
              <span className="small muted">없음</span>
            )}
          </div>
        );
      })}
      {models.sites.map((s) => {
        const l = value[s.id] ?? models.defaults[s.id];
        return (
          <div key={s.id} className="limits-row">
            <span className={`limits-name fam-${s.family}`}>{LABEL[s.id] ?? s.label}</span>
            <input type="number" min={0} max={10} value={l.maxMembers} onChange={(e) => set(s.id, { maxMembers: Number(e.target.value) })} />
            <span className="small muted">웹에서 고름</span>
            <span className="small muted">-</span>
          </div>
        );
      })}
      <div className="small muted">0명이면 그 종류는 쓰지 않습니다. 의장이 이 한도 안에서 작업마다 모델·추론 수준·advisor를 고릅니다.</div>
    </div>
  );
}
