import { familyColorByName } from "../model";
import type { AgendaOv, Overview } from "../types";
import { THEME_LABEL, useTheme } from "../theme";
import { GridSpinner } from "./GridSpinner";

interface Props {
  overview: Overview | null;
  selected: string;
  memoryKey: string;
  accountsKey: string;
  wsUp: boolean;
  onSelect: (key: string) => void;
  onNewProject: () => void;
  onNewAgenda: (projectId: string) => void;
  onGuidelines: (projectId: string) => void;
  onSettings: (projectId: string) => void;
}

/** spinner color for an agenda: the chair (claude) when it is thinking, else the first running family */
function agendaSpinner(a: AgendaOv, size: number) {
  if (a.chairBusy) return <GridSpinner color={familyColorByName("claude")} size={size} title="의장 작업 중" />;
  if (a.running > 0) return <GridSpinner color={familyColorByName(a.runningFamilies[0] ?? "relay")} size={size} title={`위원 ${a.running}명 실행 중`} />;
  return null;
}

export function LeftPane({ overview, selected, memoryKey, accountsKey, wsUp, onSelect, onNewProject, onNewAgenda, onGuidelines, onSettings }: Props) {
  const ts = overview?.server.tailscale;
  const [theme, cycleTheme] = useTheme();
  const badAccounts = overview?.accounts.filter((a) => a.status !== "ok").length ?? 0;
  const current = overview?.projects.flatMap((p) => p.agendas.map((a) => ({ p, a }))).find((x) => x.a.key === selected);
  return (
    <div className="left-inner">
      <div className="space-head">
        <span className="space-title">SPACE</span>
        <span className="space-tools">
          <button className="theme-btn" onClick={cycleTheme} title="화면 테마 (자동 → 라이트 → 다크)">{THEME_LABEL[theme]}</button>
          <span className={`dot ${wsUp ? "up" : ""}`} title={wsUp ? "실시간 연결됨" : "연결 끊김"} />
        </span>
      </div>

      <div className="tree">
        {overview?.projects.length === 0 && <div className="muted small">프로젝트가 없습니다. 아래에서 추가하세요.</div>}
        {overview?.projects.map((p) => (
          <div key={p.id} className="project">
            <div className="project-row">
              <span className="project-name" title={p.repo}>{p.name}</span>
              <span className="row-actions">
                <button className="icon" title="설정 (의장·위원 한도)" onClick={() => onSettings(p.id)}>⚙</button>
                <button className="icon" title="가이드라인 편집" onClick={() => onGuidelines(p.id)}>✎</button>
                <button className="icon" title="안건 추가" onClick={() => onNewAgenda(p.id)}>＋</button>
              </span>
            </div>
            {p.agendas.map((a) => (
              <button key={a.key} className={`agenda ${a.key === selected ? "on" : ""} ${a.status === "closed" ? "closed" : ""}`} onClick={() => onSelect(a.key)}>
                <span className="agenda-title">
                  {agendaSpinner(a, 12)}
                  {a.title}
                </span>
                <span className="agenda-meta">
                  {a.running > 0 && <span className="badge" style={{ color: familyColorByName(a.runningFamilies[0] ?? "relay") }}>{a.running} 실행</span>}
                  <span className="badge">{a.taskCounts.done}/{a.taskCounts.total}</span>
                </span>
              </button>
            ))}
            {p.agendas.length === 0 && <div className="muted small indent">안건 없음</div>}
          </div>
        ))}
        <button className="add-project" onClick={onNewProject}>＋ 제작위원회 추가</button>
      </div>

      <button className={`memory-link ${selected === memoryKey ? "on" : ""}`} onClick={() => onSelect(memoryKey)}>
        공유 기억
        {overview && (
          <span className="agenda-meta">
            {overview.memory.proposed > 0 && <span className="badge warn">{overview.memory.proposed} 제안</span>}
            <span className="badge">{overview.memory.verified}</span>
          </span>
        )}
      </button>
      <button className={`memory-link ${selected === accountsKey ? "on" : ""}`} onClick={() => onSelect(accountsKey)}>
        계정
        {overview && (
          <span className="agenda-meta">
            {badAccounts > 0 && <span className="badge warn">{badAccounts} 문제</span>}
            <span className="badge">{overview.accounts.length}</span>
          </span>
        )}
      </button>

      <div className="pinned">
        {current ? (
          <>
            <div className="small muted">{current.p.name}</div>
            <div className="pinned-title">
              {agendaSpinner(current.a, 18) ?? <span className="pinned-idle">▦</span>}
              {current.a.title}
            </div>
            <div className="small muted mono">{current.a.branch}</div>
          </>
        ) : (
          <div className="small muted">안건을 선택하세요</div>
        )}
      </div>

      {overview && (
        <div className="server-info small muted">
          <div>포트 {overview.server.port}</div>
          {ts?.dnsName && <div>Tailscale: https://{ts.dnsName}</div>}
          {!ts?.dnsName && ts?.ip && <div>Tailscale IP: {ts.ip}</div>}
        </div>
      )}
    </div>
  );
}
