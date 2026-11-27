import { useState } from "react";
import { familyColor, memberName } from "../model";
import type { Member, RuntimeState } from "../types";
import { GridSpinner } from "./GridSpinner";
import { locale, t, useT } from "../i18n";

interface Props {
  state: RuntimeState | null;
  onOpen: (id: string) => void;
  onMerge: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onRelay: (id: string) => void;
  onHandover: (id: string) => void;
}

const STATUS_KO: Record<Member["status"], string> = {
  starting: "시작 중",
  running: "실행 중",
  waiting: "전달 대기",
  done: "완료",
  failed: "실패",
  stopped: "중지",
  handed_over: "인계됨",
};

export function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 120;
  const h = 32;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden style={{ color }}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function metaLine(m: Member): string {
  const parts: string[] = [m.id];
  if (m.effort) parts.push(t("추론 {v}", { v: m.effort }));
  if (m.advisor) parts.push(`advisor ${m.advisor}`);
  if (m.account && m.account !== m.provider) parts.push(t("계정 {v}", { v: m.account }));
  if (m.handoverFrom) parts.push(t("{from}에서 인계", { from: m.handoverFrom }));
  return parts.join(" · ");
}

export function RightPane({ state, onOpen, onMerge, onStop, onRelay, onHandover }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!state) return <div className="right-empty muted small">{t("위원이 여기에 표시됩니다.")}</div>;
  const isActive = (m: Member) => m.status === "running" || m.status === "starting" || m.status === "waiting";
  const active = state.members.filter(isActive);
  const idle = state.members.filter((m) => !isActive(m)).reverse();
  const taskTitle = (id: string) => state.tasks.find((t) => t.id === id)?.title ?? id;
  const canHandover = (m: Member) => (m.status === "failed" || m.status === "stopped") && !m.handoverTo;

  return (
    <div className="right-inner">
      {state.members.length === 0 && <div className="muted small">{t("아직 위원이 없습니다. 의장이 작업을 배정하면 여기에 카드가 생깁니다.")}</div>}
      {active.map((m) => {
        const color = familyColor(m);
        return (
          <div key={m.id} className={`member card active ${m.status === "waiting" ? "relay" : ""}`} style={{ borderColor: color }}>
            <div className="member-head">
              <span className="member-name" style={{ color }}>{memberName(m)}</span>
              <span className="member-right">
                <GridSpinner color={color} size={14} title={t(STATUS_KO[m.status])} />
                <span className="badge" style={{ color }}>{t(STATUS_KO[m.status])}</span>
              </span>
            </div>
            {m.status === "waiting" ? (
              <div className="small relay-hint" style={{ color }}>{t("패킷을 복사해 웹 AI에 붙이고, 답변을 여기에 붙여넣으세요.")}{m.relayFiles?.length ? ` ${t("(파일 {n}개 포함)", { n: m.relayFiles.length })}` : ""}</div>
            ) : (
              <Sparkline data={state.activity[m.id] ?? []} color={color} />
            )}
            <div className="small">{taskTitle(m.taskId)}</div>
            <div className="small muted">{metaLine(m)}</div>
            <div className="small muted mono ellipsis">{m.branch}</div>
            {m.status !== "waiting" && <div className="small muted">{t("도구 호출 {n}회", { n: m.toolCalls })}</div>}
            {m.lastText && <div className="small last-text">{m.lastText.slice(0, 160)}</div>}
            <div className="member-actions">
              {m.status === "waiting" ? (
                <button className="primary small" style={{ background: color, borderColor: color }} onClick={() => onRelay(m.id)}>{t("패킷 · 답변")}</button>
              ) : (
                <button className="ghost small" onClick={() => onOpen(m.id)}>{t("로그")}</button>
              )}
              <button className="ghost small danger" onClick={() => onStop(m.id)}>{m.status === "waiting" ? t("취소") : t("중지")}</button>
            </div>
          </div>
        );
      })}
      {idle.length > 0 && active.length > 0 && <div className="divider small muted">{t("대기 · 완료")}</div>}
      {idle.map((m) => {
        const open = expanded[m.id] ?? false;
        const color = familyColor(m);
        return (
          <div key={m.id} className={`member card ${m.status}`} style={{ borderLeftColor: color, borderLeftWidth: 4 }}>
            <button className="member-head collapsible" onClick={() => setExpanded((e) => ({ ...e, [m.id]: !open }))}>
              <span className="member-name" style={{ color }}>{memberName(m)}</span>
              <span className="member-right">
                {m.merged && <span className="badge ok">{t("머지됨")}</span>}
                {m.handoverTo && <span className="badge">→ {m.handoverTo}</span>}
                <span className={`badge ${m.status === "failed" ? "warn" : ""}`}>{t(STATUS_KO[m.status])}</span>
                <span className="chev">{open ? "△" : "▽"}</span>
              </span>
            </button>
            {open && (
              <div className="member-body">
                <div className="small">{taskTitle(m.taskId)}</div>
                <div className="small muted">{metaLine(m)}</div>
                <div className="small muted mono ellipsis">{m.branch}</div>
                <div className="small muted">{t("커밋 {c} · 도구 호출 {n}", { c: m.commits?.length ?? 0, n: m.toolCalls })}</div>
                {m.failure && (
                  <div className="small warn-text">
                    {m.failure.kind === "quota" ? t("한도 소진") : m.failure.kind === "auth" ? t("로그인 필요") : m.failure.kind === "model" ? t("모델 미지원") : t("오류")}: {m.failure.message}
                    {m.failure.resetAt && <> · {t("리셋 {at}", { at: new Date(m.failure.resetAt).toLocaleString(locale()) })}</>}
                  </div>
                )}
                {m.result?.summary && <div className="small result">{m.result.summary}</div>}
                {m.result?.unfinished && m.result.unfinished !== "없음" && <div className="small warn-text">{t("미완료: {v}", { v: m.result.unfinished })}</div>}
                {m.error && !m.failure && <div className="small warn-text">{m.error}</div>}
                {m.diffstat && <pre className="diffstat">{m.diffstat}</pre>}
                <div className="member-actions">
                  <button className="ghost small" onClick={() => onOpen(m.id)}>{t("로그 · diff")}</button>
                  {canHandover(m) && <button className="ghost small" onClick={() => onHandover(m.id)}>{t("이어받기")}</button>}
                  {!m.merged && m.status === "done" && (m.commits?.length ?? 0) > 0 && (
                    <button className="primary small" onClick={() => onMerge(m.id)}>{t("머지")}</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
