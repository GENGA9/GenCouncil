// The workshop's full pages, opened over the picture: the wiki, the shared memory, the accounts and
// the settings. One sheet with tabs; the picture keeps moving behind it. The wiki, memory and
// accounts pages are the workshop's own components in the night sky's colours (sheet.css), so they
// do exactly what they do there. The settings page is laid out for this mode.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { locale, useT } from "../i18n";
import { AccountsView } from "../components/AccountsView";
import { GeminiOptIn, useGemini } from "../components/GeminiOptIn";
import { MemoryView } from "../components/MemoryView";
import { GuidelinesForm, ProjectSettingsForm } from "../components/Modals";
import { until } from "../components/UsagePanel";
import { WikiView } from "../components/WikiView";
import { THEME_LABEL, useTheme } from "../theme";
import type { AccountUsage, AgendaOv, Overview, ProjectOv, UsageSnapshot } from "../types";
import type { ProjectActions } from "./actions";
import { Bar } from "./Menus";
import { TINT, USAGE_NAME, usageIds, type Rgb } from "./scene";
import { LangSelect } from "../components/LangSelect";

const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;

export type SheetTab = "wiki" | "memory" | "accounts" | "settings";
export type ProjectView = "settings" | "guidelines" | "agendas";
/** where the sheet is open: which tab, and in the settings which project ("" or none: the space) and which part of it */
export interface SheetAt {
  tab: SheetTab;
  project?: string;
  view?: ProjectView;
}

const TABS: Array<{ id: SheetTab; icon: string; label: string; title: string }> = [
  { id: "wiki", icon: "❖", label: "위키", title: "Gen Wiki: 위원·의장·사용자가 함께 보는 정리된 문서" },
  { id: "memory", icon: "◈", label: "기억", title: "공유 기억: 위키로 옮기기 전의 기억과 제안 원본" },
  { id: "accounts", icon: "◎", label: "계정", title: "AI 계정: 로그인, 복구, 추가" },
  { id: "settings", icon: "⚙", label: "설정", title: "사용량, 연결, 제작위원회별 한도·가이드라인·안건" },
];

interface SheetProps {
  at: SheetAt;
  onAt: (at: SheetAt) => void;
  onClose: () => void;
  overview: Overview | null;
  selected: string;
  usage?: UsageSnapshot | null;
  wsUp: boolean;
  notify: (m: string) => void;
  projects: ProjectActions;
  onSelect: (key: string) => void;
  onSettingsSaved: (msg: string) => void;
  onWorkshop: () => void;
}

export function VisionSheet(props: SheetProps) {
  const { at, onAt, onClose, overview, notify } = props;
  const t = useT();

  /** a wiki page being written would be lost: ask before leaving it */
  const leave = useCallback(() => !document.querySelector(".vz-sheet .wiki-edit") || confirm(t("위키에서 편집 중인 내용이 저장되지 않았습니다. 그래도 나갈까요?")), [t]);
  const close = useCallback(() => {
    if (leave()) onClose();
  }, [leave, onClose]);
  const go = (tab: SheetTab) => {
    if (tab !== at.tab && leave()) onAt({ tab, project: at.project, view: at.view });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // a dialog over the sheet takes the key first; in a field it means "leave the field", not "close everything"
      if (document.querySelector(".modal-bg")) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        el.blur();
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const bad = overview?.accounts.filter((a) => a.status !== "ok").length ?? 0;
  const badge: Record<SheetTab, { n: number; warn: boolean; title: string } | undefined> = {
    wiki: overview && overview.memory.proposed > 0 ? { n: overview.memory.proposed, warn: true, title: t("위키 등록을 기다리는 제안") } : undefined,
    memory: overview && overview.memory.verified > 0 ? { n: overview.memory.verified, warn: false, title: t("아직 위키로 옮기지 않은 기억") } : undefined,
    accounts: bad > 0 ? { n: bad, warn: true, title: t("문제가 있는 계정") } : overview?.accounts.length ? { n: overview.accounts.length, warn: false, title: t("등록된 계정") } : undefined,
    settings: undefined,
  };

  return (
    <>
      <div className="vz-sheet-back" onClick={close} />
      <section className="vz-sheet" role="dialog" aria-label={t(TABS.find((x) => x.id === at.tab)?.title ?? "")}>
        <header className="vz-sheet-head">
          <nav className="vz-tabs" role="tablist">
            {TABS.map((tb) => {
              const b = badge[tb.id];
              return (
                <button key={tb.id} role="tab" aria-selected={tb.id === at.tab} className={tb.id === at.tab ? "on" : ""} title={t(tb.title)} onClick={() => go(tb.id)}>
                  <i>{tb.icon}</i>
                  <span>{t(tb.label)}</span>
                  {b && (
                    <em className={b.warn ? "warn" : ""} title={b.title}>
                      {b.n}
                    </em>
                  )}
                </button>
              );
            })}
          </nav>
          <button className="vz-sheet-close" onClick={close} aria-label={t("닫기")} title={t("닫고 그림으로 돌아가기 (Esc)")}>
            ✕
          </button>
        </header>
        <div className={`vz-sheet-body ${at.tab === "settings" ? "" : "vz-skin"}`} key={at.tab}>
          {at.tab === "wiki" && <WikiView notify={notify} onOpenMemory={() => go("memory")} />}
          {at.tab === "memory" && <MemoryView notify={notify} />}
          {at.tab === "accounts" && <AccountsView notify={notify} />}
          {at.tab === "settings" && <Settings {...props} onClose={onClose} />}
        </div>
      </section>
    </>
  );
}

/** The settings: the space everything shares, then one page per project. */
function Settings({ at, onAt, onClose, overview, selected, usage, wsUp, notify, projects, onSelect, onSettingsSaved, onWorkshop }: SheetProps) {
  const t = useT();
  const list = overview?.projects ?? [];
  const current = list.find((p) => p.id === at.project);
  const view = at.view ?? "settings";
  return (
    <div className="vz-set">
      <nav className="vz-set-rail" aria-label={t("설정 범위")}>
        <button className={current ? "" : "on"} onClick={() => onAt({ tab: "settings" })}>
          <i>✦</i>
          <span>{t("공간")}</span>
        </button>
        <div className="vz-set-rail-title">{t("제작위원회")}</div>
        {list.map((p) => {
          const open = p.agendas.filter((a) => a.status !== "closed");
          const live = open.some((a) => a.chairBusy || a.running > 0);
          return (
            <button key={p.id} className={p.id === current?.id ? "on" : ""} title={p.repo} onClick={() => onAt({ tab: "settings", project: p.id, view })}>
              <i className={`vz-live ${live ? "on" : ""}`} />
              <span>{p.name}</span>
              <em>{open.length}</em>
            </button>
          );
        })}
        <button className="vz-set-add" onClick={projects.onNewProject}>
          {t("＋ 제작위원회")}
        </button>
      </nav>
      <div className="vz-set-pane" key={current?.id ?? ""}>
        {current ? (
          <ProjectPage
            project={current}
            view={view}
            selected={selected}
            onView={(v) => onAt({ tab: "settings", project: current.id, view: v })}
            onOpen={(key) => {
              onSelect(key);
              onClose();
            }}
            onNewAgenda={() => {
              onClose();
              void projects.onNewAgenda(current.id);
            }}
            notify={notify}
            onSettingsSaved={onSettingsSaved}
          />
        ) : (
          <SpacePage overview={overview} usage={usage} wsUp={wsUp} notify={notify} onTab={(tab) => onAt({ tab })} onWorkshop={onWorkshop} />
        )}
      </div>
    </div>
  );
}

function SpacePage({ overview, usage, wsUp, notify, onTab, onWorkshop }: { overview: Overview | null; usage?: UsageSnapshot | null; wsUp: boolean; notify: (m: string) => void; onTab: (tab: SheetTab) => void; onWorkshop: () => void }) {
  const t = useT();
  const [theme, cycleTheme] = useTheme();
  const ts = overview?.server.tailscale;
  const bad = overview?.accounts.filter((a) => a.status !== "ok").length ?? 0;
  return (
    <>
      <header className="vz-set-head">
        <span className="vz-pop-kicker">SPACE</span>
        <h2>{t("공간")}</h2>
        <p>{t("모든 제작위원회가 함께 쓰는 것: 계정마다 남은 사용량, 지식, 연결, 화면.")}</p>
      </header>

      <UsageCards pushed={usage} />

      <section className="vz-set-sec">
        <h3>{t("제미나이")}</h3>
        <div className="vz-skin vz-set-gem">
          <GeminiOptIn notify={notify} />
        </div>
      </section>

      <section className="vz-set-sec">
        <h3>{t("지식 · 계정")}</h3>
        <div className="vz-tiles">
          <button className="vz-tile" onClick={() => onTab("wiki")}>
            <i>❖</i>
            <b>Gen Wiki</b>
            <span className={overview && overview.memory.proposed > 0 ? "warn" : ""}>{overview ? (overview.memory.proposed > 0 ? t("등록 대기 제안 {n}", { n: overview.memory.proposed }) : t("등록 대기 없음")) : "…"}</span>
          </button>
          <button className="vz-tile" onClick={() => onTab("memory")}>
            <i>◈</i>
            <b>{t("기억 원본")}</b>
            <span>{overview ? t("위키로 옮기지 않은 기억 {n}", { n: overview.memory.verified }) : "…"}</span>
          </button>
          <button className="vz-tile" onClick={() => onTab("accounts")}>
            <i>◎</i>
            <b>{t("계정")}</b>
            <span className={bad > 0 ? "warn" : ""}>{overview ? (bad > 0 ? t("{n}개 · 문제 {bad}", { n: overview.accounts.length, bad }) : t("{n}개", { n: overview.accounts.length })) : "…"}</span>
          </button>
        </div>
      </section>

      <section className="vz-set-sec">
        <h3>{t("연결")}</h3>
        <div className="vz-set-row">
          <span className={`vz-conn ${wsUp ? "up" : ""}`} />
          <div>
            <b>{wsUp ? t("실시간 연결됨") : t("연결 끊김")}</b>
            <span>
              {overview && overview.server.port ? t("포트 {port}", { port: overview.server.port }) : t("서버")}
              {ts?.dnsName ? ` · Tailscale https://${ts.dnsName}` : ts?.ip ? ` · Tailscale IP ${ts.ip}` : ""}
            </span>
          </div>
        </div>
      </section>

      <section className="vz-set-sec">
        <h3>{t("화면")}</h3>
        <div className="vz-set-row">
          <div>
            <b>{t("작업실")}</b>
            <span>{t("안건 목록·의장 대화·위원 카드가 한 화면에 있는 작업 화면")}</span>
          </div>
          <button className="vz-pill" onClick={onWorkshop}>
            {t("▤ 작업실로")}
          </button>
        </div>
        <div className="vz-set-row">
          <div>
            <b>{t("작업실 테마")}</b>
            <span>{t("작업실 화면의 밝기입니다. 시각화 화면은 늘 밤하늘입니다.")}</span>
          </div>
          <button className="vz-pill" onClick={cycleTheme} title={t("자동 → 라이트 → 다크")}>
            {t(THEME_LABEL[theme])}
          </button>
        </div>
        <div className="vz-set-row">
          <div>
            <b>{t("언어")}</b>
            <span>{t("화면 글자와 캐릭터 대사·음성의 언어입니다. 서버 메시지와 의장·위원의 대화는 그대로입니다.")}</span>
          </div>
          <LangSelect className="vz-pill vz-lang" />
        </div>
      </section>
    </>
  );
}

/** What each account has left, one card per company. */
function UsageCards({ pushed }: { pushed?: UsageSnapshot | null }) {
  const t = useT();
  const geminiOff = useGemini()?.enabled === false;
  const [snap, setSnap] = useState<UsageSnapshot | null>(pushed ?? null);
  const [loading, setLoading] = useState(false);
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
  }, [load]);
  useEffect(() => {
    if (pushed) setSnap(pushed);
  }, [pushed]);
  const items = snap?.items ?? [];
  return (
    <section className="vz-set-sec">
      <h3>
        {t("남은 사용량")}
        <button className="vz-set-refresh" onClick={() => void load(true)} disabled={loading} title={t("지금 새로 확인")}>
          {loading ? "…" : "↻"}
        </button>
        {snap?.at ? <span className="vz-usage-when">{t("마지막 확인 {time}", { time: new Date(snap.at).toLocaleTimeString(locale()) })}</span> : null}
      </h3>
      <div className="vz-usage">
        {usageIds(items).map((id) => {
          const rows = items.filter((u) => u.provider === id);
          return (
            <div key={id} className="vz-usage-card" style={{ "--c": css(TINT[id]) } as React.CSSProperties}>
              <b>{USAGE_NAME[id]}</b>
              {rows.length === 0 && <span className="vz-usage-none">{id === "gemini" && geminiOff ? t("꺼짐 · 아래에서 켤 수 있음") : snap ? t("계정 없음") : t("확인 중…")}</span>}
              {rows.map((u) => (
                <Meter key={u.account} u={u} named={rows.length > 1} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Meter({ u, named }: { u: AccountUsage; named: boolean }) {
  const t = useT();
  const groups = new Map<string, NonNullable<AccountUsage["details"]>>();
  for (const d of u.details ?? []) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  const reset = until(u.weekly?.resetsAt);
  return (
    <div className="vz-meter">
      {named && <span className="vz-meter-name">{u.account}</span>}
      {u.error ? (
        <span className="vz-meter-err" title={u.error}>
          {u.error.slice(0, 80)}
        </span>
      ) : (
        <>
          {/* Claude's 5-hour number is not reported reliably; its weekly bar is enough */}
          {!u.noFiveHour && u.provider !== "claude" && u.fiveHour && <Bar label={t("5시간")} used={u.fiveHour.usedPct} />}
          {u.weekly && <Bar label={t("주간")} used={u.weekly.usedPct} />}
          {!u.weekly && !u.fiveHour && <span className="vz-usage-none">{t("정보 없음")}</span>}
          {reset && <span className="vz-usage-reset">{t("주간 한도 {reset}", { reset })}</span>}
        </>
      )}
      {groups.size > 0 && (
        <details className="vz-usage-details">
          <summary>{t("세부 한도 {n}", { n: u.details!.length })}</summary>
          {[...groups].map(([group, list]) => (
            <div key={group} className="vz-usage-group">
              <span className="vz-meter-name">{group}</span>
              {list.map((d) => (
                <Bar key={d.label} label={d.label.replace(group, "").replace(/remaining/i, "").trim() || d.label} used={d.usedPct} wide />
              ))}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

interface ProjectPageProps {
  project: ProjectOv;
  view: ProjectView;
  selected: string;
  onView: (v: ProjectView) => void;
  onOpen: (key: string) => void;
  onNewAgenda: () => void;
  notify: (m: string) => void;
  onSettingsSaved: (msg: string) => void;
}

function ProjectPage({ project, view, selected, onView, onOpen, onNewAgenda, notify, onSettingsSaved }: ProjectPageProps) {
  const t = useT();
  const open = project.agendas.filter((a) => a.status !== "closed");
  const closed = project.agendas.filter((a) => a.status === "closed");
  const row = (a: AgendaOv) => (
    <button key={a.key} className={`vz-picker-row ${a.key === selected ? "on" : ""} ${a.status === "closed" ? "closed" : ""}`} onClick={() => onOpen(a.key)} title={t("이 안건을 그림으로 열기")}>
      <span className={`vz-live ${a.status !== "closed" && (a.chairBusy || a.running > 0) ? "on" : ""}`} />
      <span className="vz-picker-title">{a.title}</span>
      <span className="vz-picker-meta">
        {a.status === "closed" ? t("종료") + " · " : a.waitingForUser && !a.chairBusy ? t("결정 대기") + " · " : ""}
        {a.status !== "closed" && a.running > 0 ? t("{n} 실행", { n: a.running }) + " · " : ""}
        {a.taskCounts.done}/{a.taskCounts.total}
      </span>
    </button>
  );
  return (
    <>
      <header className="vz-set-head">
        <span className="vz-pop-kicker">{t("제작위원회")}</span>
        <h2>{project.name}</h2>
        <p className="mono">
          {project.repo || t("(작업 폴더 없음)")}
          {project.baseBranch ? ` · ${project.baseBranch}` : ""}
          {project.localGit ? ` · ${t("로컬 git")}` : ""}
        </p>
      </header>
      <div className="vz-seg" role="tablist">
        <button role="tab" aria-selected={view === "settings"} className={view === "settings" ? "on" : ""} onClick={() => onView("settings")}>
          {t("의장 · 위원 한도")}
        </button>
        <button role="tab" aria-selected={view === "guidelines"} className={view === "guidelines" ? "on" : ""} onClick={() => onView("guidelines")}>
          {t("가이드라인")}
        </button>
        <button role="tab" aria-selected={view === "agendas"} className={view === "agendas" ? "on" : ""} onClick={() => onView("agendas")}>
          {t("안건")} {open.length}
        </button>
      </div>
      {view === "settings" && (
        <div className="vz-set-form vz-skin">
          <ProjectSettingsForm project={project} onSaved={onSettingsSaved} />
        </div>
      )}
      {view === "guidelines" && (
        <div className="vz-set-form vz-skin">
          <p className="vz-set-note">{t("의장이 일을 나누고 모델을 고를 때 따르는 규칙입니다. 저장하면 의장의 다음 턴부터 반영됩니다.")}</p>
          <GuidelinesForm projectId={project.id} notify={notify} />
        </div>
      )}
      {view === "agendas" && (
        <div className="vz-set-agendas">
          {open.length > 0 ? <div className="vz-set-list">{open.map(row)}</div> : <p className="vz-set-note">{t("진행 중인 안건이 없습니다.")}</p>}
          <button className="vz-pill gold" onClick={onNewAgenda}>
            {t("＋ 새 안건")}
          </button>
          {closed.length > 0 && (
            <section className="vz-set-sec">
              <h3>{t("보관된 안건 {n}", { n: closed.length })}</h3>
              <div className="vz-set-list">{closed.map(row)}</div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
