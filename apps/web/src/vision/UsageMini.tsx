// What each company has left, small and see-through in the top-left corner of the picture.
// One row per company: its weekly bar, and for GPT and Gemini a thinner five-hour bar under it.
// The best account of a company counts (the chair moves to it when one runs out).
import { useEffect, useState } from "react";
import { api } from "../api";
import { locale, useT } from "../i18n";
import { useGemini } from "../components/GeminiOptIn";
import type { AccountUsage, UsageSnapshot } from "../types";
import { TINT, USAGE_NAME, usageIds, type Rgb, type UsageId } from "./scene";

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** remaining percent of the account with the most left, or undefined when nothing was measured */
function best(rows: AccountUsage[], pick: (u: AccountUsage) => { usedPct: number } | undefined): number | undefined {
  const left = rows.map(pick).filter((w): w is { usedPct: number } => Boolean(w)).map((w) => Math.max(0, Math.min(100, 100 - w.usedPct)));
  return left.length ? Math.max(...left) : undefined;
}

export function UsageMini({ usage, onOpen }: { usage?: UsageSnapshot | null; onOpen: () => void }) {
  const t = useT();
  const [own, setOwn] = useState<UsageSnapshot | null>(null);
  const geminiOff = useGemini()?.enabled === false;
  // the app hears usage over the socket every few minutes; until it does (or on the demo page) ask once
  useEffect(() => {
    if (usage) return;
    let alive = true;
    api.usage().then(
      (u) => alive && setOwn(u),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [usage]);
  const snap = usage ?? own;
  const items = snap?.items ?? [];
  const row = (id: UsageId) => {
    const rows = items.filter((u) => u.provider === id && !u.error);
    const week = best(rows, (u) => u.weekly);
    // Claude does not report its five-hour window reliably; its weekly bar is enough
    const five = id === "claude" ? undefined : best(rows, (u) => (u.noFiveHour ? undefined : u.fiveHour));
    const off = id === "gemini" && geminiOff;
    const low = Math.min(week ?? 100, five ?? 100) < 20;
    return (
      <div key={id} className={`vz-use-row ${off ? "off" : ""} ${low ? "low" : ""}`} style={{ "--c": css(TINT[id]) } as React.CSSProperties}>
        <span className="vz-use-name">{USAGE_NAME[id]}</span>
        {off ? (
          <span className="vz-use-note">{t("꺼짐")}</span>
        ) : week === undefined && five === undefined ? (
          <span className="vz-use-note">{snap ? "—" : "…"}</span>
        ) : (
          <>
            <span className="vz-use-bars">
              <span className="vz-use-bar" title={week !== undefined ? t("주간 {pct}% 남음", { pct: week }) : t("주간 정보 없음")}>
                <i style={{ width: `${week ?? 0}%` }} />
              </span>
              {five !== undefined && (
                <span className="vz-use-bar thin" title={t("5시간 {pct}% 남음", { pct: five })}>
                  <i style={{ width: `${five}%` }} />
                </span>
              )}
            </span>
            <span className="vz-use-pct">{week ?? five}%</span>
          </>
        )}
      </div>
    );
  };
  return (
    <button className="vz-use" onClick={onOpen} title={`${t("남은 사용량 (굵은 막대 주간, 얇은 막대 5시간)")}${snap?.at ? ` · ${t("{time} 확인", { time: new Date(snap.at).toLocaleTimeString(locale()) })}` : ""} · ${t("눌러서 자세히")}`}>
      {usageIds(items).map(row)}
    </button>
  );
}
