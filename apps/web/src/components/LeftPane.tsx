import { useState } from "react";
import { familyColorByName } from "../model";
import type { AgendaOv, Overview, UsageSnapshot } from "../types";
import { THEME_LABEL, useTheme } from "../theme";
import { LangSelect } from "./LangSelect";
import { t, useT } from "../i18n";
import { GridSpinner } from "./GridSpinner";
import { ModeSwitch, type Mode } from "./ModeSwitch";
import { UsagePanel } from "./UsagePanel";

interface Props {
  overview: Overview | null;
  selected: string;
  memoryKey: string;
  wikiKey: string;
  accountsKey: string;
  wsUp: boolean;
  onSelect: (key: string) => void;
  onNewProject: () => void;
  onNewAgenda: (projectId: string) => void;
  onGuidelines: (projectId: string) => void;
  onSettings: (projectId: string) => void;
  /** live status of the open agenda (more current than the overview) */
  live?: { key: string; chairBusy: boolean; families: string[] };
  /** usage pushed over the websocket */
  usage?: UsageSnapshot | null;
  mode: Mode;
  onMode: (mode: Mode) => void;
}

/** spinner color for an agenda: the chair (claude) when it is thinking, else the first running family */
function agendaSpinner(a: AgendaOv, size: number) {
  if (a.chairBusy) return <GridSpinner color={familyColorByName("claude")} size={size} title={t("의장 작업 중")} />;
  if (a.running > 0) return <GridSpinner color={familyColorByName(a.runningFamilies[0] ?? "relay")} size={size} title={t("위원 {n}명 실행 중", { n: a.running })} />;
  return null;
}

function AgendaRow({ a, on, onSelect }: { a: AgendaOv; on: boolean; onSelect: (key: string) => void }) {
  const t = useT();
  return (
    <button className={`agenda ${on ? "on" : ""} ${a.status === "closed" ? "closed" : ""}`} onClick={() => onSelect(a.key)}>
      <span className="agenda-title">
        {agendaSpinner(a, 12)}
        {a.title}
      </span>
      <span className="agenda-meta">
        {a.waitingForUser && !a.chairBusy && a.status !== "closed" && (
          <span className="badge waiting" title={t("의장 질문: {q}", { q: a.waitingForUser.question })}>{t("결정 대기")}</span>
        )}
        {a.running > 0 && <span className="badge" style={{ color: familyColorByName(a.runningFamilies[0] ?? "relay") }}>{t("{n} 실행", { n: a.running })}</span>}
        {a.status === "closed" ? <span className="badge">{t("종료")}</span> : <span className="badge">{a.taskCounts.done}/{a.taskCounts.total}</span>}
      </span>
    </button>
  );
}

const ARCHIVE_KEY = "gencouncil.openArchives";
function readOpenArchives(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function LeftPane({ overview, selected, memoryKey, wikiKey, accountsKey, wsUp, onSelect, onNewProject, onNewAgenda, onGuidelines, onSettings, live, usage, mode, onMode }: Props) {
  const t = useT();
  const ts = overview?.server.tailscale;
  const [theme, cycleTheme] = useTheme();
  const [openArchives, setOpenArchives] = useState<string[]>(readOpenArchives);
  const toggleArchive = (projectId: string) =>
    setOpenArchives((cur) => {
      const next = cur.includes(projectId) ? cur.filter((x) => x !== projectId) : [...cur, projectId];
      try {
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(next));
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  const badAccounts = overview?.accounts.filter((a) => a.status !== "ok").length ?? 0;
  const current = overview?.projects.flatMap((p) => p.agendas.map((a) => ({ p, a }))).find((x) => x.a.key === selected);
  return (
    <div className="left-inner">
      <div className="space-head">
        <span className="space-title">SPACE</span>
        <span className="space-tools">
          <button className="theme-btn" onClick={() => location.reload()} title={t("새로고침 (F5)")}>↻</button>
          <button className="theme-btn" onClick={cycleTheme} title={t("화면 테마 (자동 → 라이트 → 다크)")}>{t(THEME_LABEL[theme])}</button>
          <LangSelect />
          <span className={`dot ${wsUp ? "up" : ""}`} title={wsUp ? t("실시간 연결됨") : t("연결 끊김")} />
        </span>
      </div>
      <ModeSwitch mode={mode} onChange={onMode} />

      <div className="tree">
        {overview?.projects.length === 0 && <div className="muted small">{t("프로젝트가 없습니다. 아래에서 추가하세요.")}</div>}
        {overview?.projects.map((p) => (
          <div key={p.id} className="project">
            <div className="project-row">
              <span className="project-name" title={p.repo}>{p.name}</span>
              <span className="row-actions">
                <button className="icon" title={t("설정 (의장·위원 한도)")} onClick={() => onSettings(p.id)}>⚙</button>
                <button className="icon" title={t("가이드라인 편집")} onClick={() => onGuidelines(p.id)}>✎</button>
                <button className="icon" title={t("안건 추가")} onClick={() => onNewAgenda(p.id)}>＋</button>
              </span>
            </div>
            {p.agendas.filter((a) => a.status !== "closed").map((a) => (
              <AgendaRow key={a.key} a={a} on={a.key === selected} onSelect={onSelect} />
            ))}
            {p.agendas.every((a) => a.status === "closed") && <div className="muted small indent">{t("진행 중인 안건 없음")}</div>}
            {(() => {
              // finished agendas are archived: folded away, still readable
              const closed = p.agendas.filter((a) => a.status === "closed");
              if (closed.length === 0) return null;
              const showing = openArchives.includes(p.id) || closed.some((a) => a.key === selected);
              return (
                <div className="archive">
                  <button className="archive-toggle small muted" onClick={() => toggleArchive(p.id)}>
                    {showing ? "▾" : "▸"} {t("보관된 안건 {n}", { n: closed.length })}
                  </button>
                  {showing && closed.map((a) => <AgendaRow key={a.key} a={a} on={a.key === selected} onSelect={onSelect} />)}
                </div>
              );
            })()}
          </div>
        ))}
        <button className="add-project" onClick={onNewProject}>＋ {t("제작위원회 추가")}</button>
      </div>

      <button className={`memory-link ${selected === wikiKey ? "on" : ""}`} onClick={() => onSelect(wikiKey)}>
        Gen Wiki
        {overview && overview.memory.proposed > 0 && (
          <span className="agenda-meta">
            <span className="badge warn">{t("{n} 제안", { n: overview.memory.proposed })}</span>
          </span>
        )}
      </button>
      <button className={`memory-link ${selected === memoryKey ? "on" : ""}`} onClick={() => onSelect(memoryKey)}>
        {t("기억 원본")}
        {overview && (
          <span className="agenda-meta">
            <span className="badge" title={t("아직 위키로 옮기지 않은 기억")}>{overview.memory.verified}</span>
          </span>
        )}
      </button>
      <button className={`memory-link ${selected === accountsKey ? "on" : ""}`} onClick={() => onSelect(accountsKey)}>
        {t("계정")}
        {overview && (
          <span className="agenda-meta">
            {badAccounts > 0 && <span className="badge warn">{t("{n} 문제", { n: badAccounts })}</span>}
            <span className="badge">{overview.accounts.length}</span>
          </span>
        )}
      </button>

      <div className="pinned">
        {current ? (
          <>
            <div className="small muted">{current.p.name}</div>
            <div className="pinned-title">
              {(() => {
                const a = live && live.key === current.a.key ? { ...current.a, chairBusy: live.chairBusy, running: live.families.length, runningFamilies: live.families } : current.a;
                return agendaSpinner(a, 18) ?? <GridSpinner color="var(--muted)" size={18} spinning={false} title={t("대기 중")} />;
              })()}
              {current.a.title}
            </div>
            <div className="small muted mono">{current.a.branch}</div>
          </>
        ) : (
          <div className="small muted">{t("안건을 선택하세요")}</div>
        )}
      </div>

      <UsagePanel pushed={usage} />

      {overview && (
        <div className="server-info small muted">
          <div>{t("포트 {n}", { n: overview.server.port })}</div>
          {ts?.dnsName && <div>Tailscale: https://{ts.dnsName}</div>}
          {!ts?.dnsName && ts?.ip && <div>Tailscale IP: {ts.ip}</div>}
        </div>
      )}
    </div>
  );
}
