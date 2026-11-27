import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { Limits, ModelsInfo } from "../types";
import { useGemini } from "./GeminiOptIn";
import { useT } from "../i18n";

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

/** the company a chair model belongs to (members of the same family are what single mode keeps) */
export function chairFamily(model: string | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (/gpt|codex|astra/.test(m)) return "gpt";
  if (/gemini/.test(m)) return "gemini";
  if (/grok/.test(m)) return "grok";
  return "claude";
}
const FAMILY_LABEL: Record<string, string> = { claude: "클로드", gpt: "GPT", gemini: "제미나이", grok: "그록" };

/** Per-provider caps: how many at once, the highest model and the highest effort the chair may use. */
export function LimitsEditor({ value, onChange, chairModel }: { value: Limits; onChange: (v: Limits) => void; chairModel?: string }) {
  const t = useT();
  const models = useModels();
  const gemini = useGemini();
  // what the limits were before single mode, to give them back when it is turned off
  const [before, setBefore] = useState<Limits | null>(null);
  if (!models) return <div className="muted small">{t("모델 목록 불러오는 중…")}</div>;
  const geminiOff = gemini?.enabled === false;
  const set = (key: string, patch: Partial<Limits[string]>) => onChange({ ...value, [key]: { ...value[key], ...patch } });
  // single mode: only members of the chair's own company (every other kind at 0)
  const fam = chairFamily(chairModel);
  const kinds = [...models.providers.map((p) => ({ id: p.id, family: p.id })), ...models.sites.map((s) => ({ id: s.id, family: s.family }))];
  const count = (id: string) => (value[id] ?? models.defaults[id])?.maxMembers ?? 0;
  const own = kinds.filter((k) => k.family === fam);
  const single = own.some((k) => count(k.id) > 0) && kinds.every((k) => k.family === fam || count(k.id) === 0);
  const toggleSingle = () => {
    if (single) {
      // back to what it was, or to the defaults for the kinds that were turned off
      const back: Limits = { ...value };
      for (const k of kinds) if (k.family !== fam) back[k.id] = { ...(value[k.id] ?? models.defaults[k.id]), maxMembers: (before?.[k.id] ?? models.defaults[k.id]).maxMembers };
      onChange(back);
      setBefore(null);
      return;
    }
    setBefore(value);
    const next: Limits = { ...value };
    for (const k of kinds) if (k.family !== fam) next[k.id] = { ...(value[k.id] ?? models.defaults[k.id]), maxMembers: 0 };
    // the chair's own kind needs at least one seat
    const main = own.find((k) => models.providers.some((p) => p.id === k.id));
    if (main && count(main.id) === 0) next[main.id] = { ...(value[main.id] ?? models.defaults[main.id]), maxMembers: Math.max(1, models.defaults[main.id]?.maxMembers ?? 1) };
    onChange(next);
  };
  return (
    <div className="limits">
      {own.length > 0 && (
        <div className="limits-single">
          <button type="button" className={single ? "primary" : "ghost"} onClick={toggleSingle}>
            {single ? t("단일 모드 켜짐 ({fam}만) · 끄기", { fam: t(FAMILY_LABEL[fam] ?? fam) }) : t("단일 모드: 의장과 같은 {fam} 위원만 쓰기", { fam: t(FAMILY_LABEL[fam] ?? fam) })}
          </button>
          <span className="small muted">{single ? t("다른 회사 위원은 0명입니다. 끄면 이전 한도로 돌아갑니다.") : t("다른 회사 위원 한도를 한 번에 0명으로 바꿉니다 (저장해야 적용).")}</span>
        </div>
      )}
      <div className="limits-head small muted">
        <span>{t("위원 종류")}</span>
        <span>{t("동시 최대")}</span>
        <span>{t("최대 모델")}</span>
        <span>{t("최대 추론")}</span>
      </div>
      {models.providers.map((p) => {
        const l = value[p.id] ?? models.defaults[p.id];
        return (
          <Fragment key={p.id}>
          <div className={`limits-row ${p.id === "gemini" && geminiOff ? "space-off" : ""}`} title={p.id === "gemini" && geminiOff ? t("공간 설정에서 꺼져 있어 이 한도와 상관없이 쓰지 않습니다 (계정 화면에서 켤 수 있음)") : undefined}>
            <span className={`limits-name fam-${p.id}`}>
              {t(LABEL[p.id] ?? p.id)}
              {p.id === "gemini" && geminiOff && <span className="badge">{t("꺼짐")}</span>}
            </span>
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
              <span className="small muted">{t("없음")}</span>
            )}
          </div>
          {(p.id === "claude" || p.id === "gpt") && (
            <div className="limits-floor small muted">
              <span>{t("최상위 모델({name}) 차단 기준: 주간", { name: p.id === "claude" ? "fable" : "astra" })}</span>
              <input
                type="number"
                min={0}
                max={100}
                value={l.topModelMinWeeklyLeft ?? (p.id === "claude" ? 30 : 50)}
                disabled={l.maxMembers === 0}
                onChange={(e) => set(p.id, { topModelMinWeeklyLeft: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
              />
              <span>{t("% 미만이면 차단 (0 = 차단 안 함)")}</span>
            </div>
          )}
          </Fragment>
        );
      })}
      {models.sites.map((s) => {
        const l = value[s.id] ?? models.defaults[s.id];
        return (
          <div key={s.id} className="limits-row">
            <span className={`limits-name fam-${s.family}`}>{t(LABEL[s.id] ?? s.label)}</span>
            <input type="number" min={0} max={10} value={l.maxMembers} onChange={(e) => set(s.id, { maxMembers: Number(e.target.value) })} />
            <span className="small muted">{t("웹에서 고름")}</span>
            <span className="small muted">-</span>
          </div>
        );
      })}
      {geminiOff && <div className="small muted">{t("제미나이(안티그래비티)는 공간 전체에서 꺼져 있어, 여기 한도와 상관없이 쓰지 않습니다. 켜려면 계정 화면에서 위험 고지를 읽고 직접 켜세요.")}</div>}
      <div className="small muted">{t("0명이면 그 종류는 쓰지 않습니다. 의장이 이 한도 안에서 작업마다 모델·추론 수준·advisor를 고릅니다.")}</div>
    </div>
  );
}
