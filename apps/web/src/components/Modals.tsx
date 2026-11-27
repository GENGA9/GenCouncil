import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { FolderReport, Limits, ProjectOv } from "../types";
import { FolderPicker } from "./FolderPicker";
import { LimitsEditor, useModels } from "./LimitsEditor";
import { useT } from "../i18n";
import { rich } from "../i18n/rich";

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="icon" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const CHAIR_MODELS = [
  ["opus", "opus (권장)"],
  ["sonnet", "sonnet"],
  ["fable", "fable"],
  ["haiku", "haiku"],
];

function ChairFields({ model, effort, setModel, setEffort }: { model: string; effort: string; setModel: (v: string) => void; setEffort: (v: string) => void }) {
  const t = useT();
  return (
    <div className="row2">
      <label>{t("의장 모델")}
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {CHAIR_MODELS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
        </select>
      </label>
      <label>{t("의장 추론")}
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          {["", "low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{x || t("기본")}</option>)}
        </select>
      </label>
    </div>
  );
}

const SUFFIX = "제작위원회";
const withSuffix = (n: string) => (n.trim().endsWith(SUFFIX) ? n.trim() : `${n.trim()} ${SUFFIX}`);

export function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (b: Record<string, unknown>) => Promise<void> }) {
  const t = useT();
  const models = useModels();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [picking, setPicking] = useState(false);
  const [chairModel, setChairModel] = useState("opus");
  const [chairEffort, setChairEffort] = useState("");
  const [autonomy, setAutonomy] = useState("full");
  const [directEdit, setDirectEdit] = useState(false);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (models && !limits) setLimits(models.defaults);
  }, [models, limits]);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await onCreate({ name, path: folder, chairModel, chairEffort, chairDirectEdit: directEdit, autonomy, limits });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("제작위원회 추가")} onClose={onClose} wide>
      <label>{t("프로젝트 이름")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="MY GAME" autoFocus /></label>
      {name.trim() && <div className="small muted name-preview">→ {withSuffix(name)}</div>}
      <label>{t("작업 폴더")}
        <span className="folder-row">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={"D:\\work\\my-game"} />
          <button className="ghost" type="button" onClick={() => setPicking(true)}>{t("폴더 선택")}</button>
        </span>
      </label>
      <div className="small muted">{t("이 폴더에서 바로 작업합니다. git 저장소가 아니면 폴더 안에 로컬 git을 만듭니다(어디에도 올라가지 않음). 파이썬 가상환경·바이너리·큰 이미지/영상/압축 파일은 git에서 제외되고 폴더에는 그대로 남습니다.")}</div>
      <ChairFields model={chairModel} effort={chairEffort} setModel={setChairModel} setEffort={setChairEffort} />
      <label className="check-row">
        <input type="checkbox" checked={directEdit} onChange={(e) => setDirectEdit(e.target.checked)} />
        {t("의장 직접 수정 허용")}
      </label>
      <div className="small muted">
        {t("켜면 의장이 통합 작업 폴더의 파일을 직접 고치고 머지 충돌을 풀 수 있습니다. 고친 내용은 턴이 끝날 때마다 안건 브랜치에 자동 커밋됩니다. 큰 작업은 계속 위원에게 맡깁니다. 읽기 전용 명령(git 확인, 테스트 실행)과 웹 검색은 항상 허용됩니다.")}
      </div>
      <label>{t("위원 자율성")}
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
          <option value="full">{t("full (권한 확인 없음)")}</option>
          <option value="chair">{t("chair (의장이 대신 승인)")}</option>
          <option value="edits">{t("edits (편집만 자동)")}</option>
        </select>
      </label>
      <h4>{t("위원 한도")}</h4>
      {limits && <LimitsEditor value={limits} onChange={setLimits} chairModel={chairModel} />}
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>{t("취소")}</button>
        <button className="primary" onClick={submit} disabled={busy || !name.trim() || !folder.trim()}>{busy ? t("만드는 중…") : t("만들기")}</button>
      </div>
      {picking && <FolderPicker start={folder || undefined} onClose={() => setPicking(false)} onPick={(p) => { setFolder(p); setPicking(false); }} />}
    </Modal>
  );
}

export function ProjectSettingsModal({ project, onClose, onSaved }: { project: ProjectOv; onClose: () => void; onSaved: (msg: string) => void }) {
  const t = useT();
  return (
    <Modal title={t("{name} 설정", { name: project.name })} onClose={onClose} wide>
      <ProjectSettingsForm project={project} onClose={onClose} onSaved={onSaved} />
    </Modal>
  );
}

/** The fields of a project's settings. In a modal `onClose` closes it after saving; inline there is none. */
export function ProjectSettingsForm({ project, onClose, onSaved }: { project: ProjectOv; onClose?: () => void; onSaved: (msg: string) => void }) {
  const t = useT();
  const models = useModels();
  const [name, setName] = useState(project.name.replace(/\s*제작위원회$/, ""));
  const [folder, setFolder] = useState(project.repo);
  const [picking, setPicking] = useState(false);
  const [chairModel, setChairModel] = useState(project.chair.model ?? "opus");
  const [chairEffort, setChairEffort] = useState(project.chair.effort ?? "");
  const [autonomy, setAutonomy] = useState(project.members.autonomy);
  const [directEdit, setDirectEdit] = useState(Boolean(project.chair.directEdit));
  const [verifyFlash, setVerifyFlash] = useState(project.members.verifyGeminiFlash !== false);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (models && !limits) setLimits({ ...models.defaults, ...(project.members.limits ?? {}) });
  }, [models, limits, project]);
  const folderChanged = folder.trim() !== project.repo;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.projectSettings(project.id, {
        name,
        ...(folderChanged ? { path: folder.trim() } : {}),
        chair: { model: chairModel, effort: chairEffort, directEdit },
        members: { autonomy, limits, verifyGeminiFlash: verifyFlash },
      });
      onSaved(r.scanSummary ? t("설정을 저장했습니다. {summary}", { summary: r.scanSummary }) : t("설정을 저장했습니다. 의장의 다음 턴부터 적용됩니다."));
      onClose?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const n = project.agendas.length;
    if (!confirm(t("\"{name}\"를 삭제할까요?\n안건 {n}개의 작업 폴더(.worktrees)와 안건 브랜치를 지우고, 위원회 기록은 deleted-projects 폴더로 옮깁니다.\n작업 폴더({repo})의 코드와 메인 브랜치는 그대로 둡니다.", { name: project.name, n, repo: project.repo }))) return;
    setBusy(true);
    setErr("");
    try {
      let r = await api.deleteProject(project.id);
      if (!r.deleted) {
        if (!confirm(t("아직 합치지 않은 작업이 있습니다:\n- {lost}\n\n삭제하면 이 작업은 사라집니다. 그래도 삭제할까요?", { lost: r.lost.join("\n- ") }))) return;
        r = await api.deleteProject(project.id, true);
      }
      onSaved(t("{name}를 삭제했습니다.", { name: project.name }));
      onClose?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label>{t("프로젝트 이름")}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      {name.trim() && <div className="small muted name-preview">→ {withSuffix(name)}</div>}
      <label>{t("작업 폴더")}
        <span className="folder-row">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
          <button className="ghost" type="button" onClick={() => setPicking(true)}>{t("폴더 선택")}</button>
        </span>
      </label>
      <div className="small muted">
        {project.localGit ? t("로컬 git (GenCouncil이 만듦)") : t("git 저장소")}
        {folderChanged ? " · " + t("폴더를 바꾸면 새 폴더 기준으로 다시 연결합니다. 진행 중인 안건이 있으면 바꿀 수 없습니다.") : ""}
      </div>
      <ChairFields model={chairModel} effort={chairEffort} setModel={setChairModel} setEffort={setChairEffort} />
      <label className="check-row">
        <input type="checkbox" checked={directEdit} onChange={(e) => setDirectEdit(e.target.checked)} />
        {t("의장 직접 수정 허용")}
      </label>
      <div className="small muted">
        {t("켜면 의장이 통합 작업 폴더의 파일을 직접 고치고 머지 충돌을 풀 수 있습니다. 고친 내용은 턴이 끝날 때마다 안건 브랜치에 자동 커밋됩니다. 큰 작업은 계속 위원에게 맡깁니다. 읽기 전용 명령(git 확인, 테스트 실행)과 웹 검색은 항상 허용됩니다.")}
      </div>
      <label>{t("위원 자율성")}
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
          <option value="full">{t("full (권한 확인 없음)")}</option>
          <option value="chair">{t("chair (의장이 대신 승인)")}</option>
          <option value="edits">{t("edits (편집만 자동)")}</option>
        </select>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={verifyFlash} onChange={(e) => setVerifyFlash(e.target.checked)} />
        {t("Gemini Flash 코드 작업 뒤 Claude 검증")}
      </label>
      <div className="small muted">
        {t("켜면 Gemini Flash 위원이 코드를 고친 작업을 끝낼 때마다, 머지 전에 Claude 위원(기본 Sonnet, 추론 높음, 한도 안)이 같은 브랜치에서 근거·테스트·범위를 확인하고 틀린 곳을 고칩니다. 문서 정리 같은 좁은 일은 의장이 건너뛸 수 있습니다.")}
      </div>
      <h4>{t("위원 한도")}</h4>
      {limits && <LimitsEditor value={limits} onChange={setLimits} chairModel={chairModel} />}
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        {onClose && <button className="ghost" onClick={onClose}>{t("취소")}</button>}
        <button className="primary" onClick={save} disabled={busy || !name.trim() || !folder.trim()}>{busy ? t("저장 중…") : t("저장")}</button>
      </div>
      <div className="danger-zone">
        <button className="ghost danger" onClick={remove} disabled={busy}>{t("위원회 삭제")}</button>
        <span className="small muted">{t("안건·작업 폴더·안건 브랜치를 지웁니다. 작업 폴더의 코드는 그대로 둡니다.")}</span>
      </div>
      {picking && <FolderPicker start={folder || undefined} onClose={() => setPicking(false)} onPick={(p) => { setFolder(p); setPicking(false); }} />}
    </>
  );
}

export function GuidelinesModal({ projectId, onClose, notify }: { projectId: string; onClose: () => void; notify: (m: string) => void }) {
  const t = useT();
  return (
    <Modal title={t("업무 분장 가이드라인")} onClose={onClose} wide>
      <GuidelinesForm projectId={projectId} onClose={onClose} notify={notify} />
    </Modal>
  );
}

/** The guidelines editor. In a modal `onClose` closes it after saving; inline there is none. */
export function GuidelinesForm({ projectId, onClose, notify }: { projectId: string; onClose?: () => void; notify: (m: string) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [file, setFile] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    api.guidelines(projectId).then(
      (r) => {
        if (!alive) return;
        setText(r.text);
        setFile(r.path);
        setLoaded(true);
      },
      (e) => alive && notify((e as Error).message),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  const save = async () => {
    try {
      await api.saveGuidelines(projectId, text);
      notify(t("가이드라인 저장. 의장의 다음 턴부터 반영됩니다."));
      onClose?.();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <>
      <div className="small muted mono">{file}</div>
      <textarea className="editor" rows={22} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="modal-actions">
        {onClose && <button className="ghost" onClick={onClose}>{t("닫기")}</button>}
        {/* never save over the file with the empty text of a load that has not come back */}
        <button className="primary" disabled={!loaded} onClick={() => void save()}>{t("저장")}</button>
      </div>
    </>
  );
}

export function RelayModal({ agendaKey, memberId, site, onClose, onDone }: { agendaKey: string; memberId: string; site?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const t = useT();
  const [packet, setPacket] = useState("");
  const [response, setResponse] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"packet" | "answer">("packet");
  useEffect(() => {
    api.packet(agendaKey, memberId).then(setPacket).catch((e) => setErr((e as Error).message));
  }, [agendaKey, memberId]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(packet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.getElementById("relay-packet") as HTMLTextAreaElement | null;
      ta?.select();
      setErr(t("클립보드 접근이 막혀 있습니다. 텍스트를 직접 선택해 복사하세요."));
    }
  };
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.relay(agendaKey, memberId, { response });
      onDone(`${r.id} ${r.status}: ${r.summary?.slice(0, 80) ?? ""}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("릴레이 위원 {id}", { id: memberId })} onClose={onClose} wide>
      <div className="tabs inline">
        <button className={tab === "packet" ? "on" : ""} onClick={() => setTab("packet")}>{t("1. 패킷 복사")}</button>
        <button className={tab === "answer" ? "on" : ""} onClick={() => setTab("answer")}>{t("2. 답변 붙여넣기")}</button>
      </div>
      {tab === "packet" ? (
        <>
          <p className="small muted">{t("아래 전체를 웹 제미나이 / AI Studio / Antigravity 채팅에 붙여넣으세요. 답변은 FILE/RESULT 블록 양식으로 오도록 패킷에 적혀 있습니다.")}</p>
          <div className="modal-actions" style={{ marginTop: 0, marginBottom: 8 }}>
            {site && (
              <button className="ghost small" onClick={async () => { await copy(); try { await api.openWeb(agendaKey, memberId); } catch (e) { setErr((e as Error).message); } }}>
                {t("복사하고 사이트 열기 (PC)")}
              </button>
            )}
            <button className="primary small" onClick={copy}>{copied ? t("복사됨 ✓") : t("전체 복사")}</button>
          </div>
          <textarea id="relay-packet" className="editor" rows={18} value={packet} readOnly />
        </>
      ) : (
        <>
          <p className="small muted">{rich(t("웹 AI의 답변 전체를 붙여넣으세요. <code>=== FILE: 경로 ===</code> 블록은 worktree에 저장·커밋되고, <code>=== RESULT ===</code> 블록은 결과 보고가 됩니다. 파일을 직접 고친 경우(Antigravity)는 RESULT 블록만 붙여도 됩니다."))}</p>
          <textarea className="editor" rows={16} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="=== FILE: src/x.js ===&#10;...&#10;=== END ===&#10;=== RESULT ===&#10;## 결과&#10;...&#10;=== END ===" />
          {err && <div className="err">{err}</div>}
          <div className="modal-actions">
            <button className="ghost" onClick={onClose}>{t("닫기")}</button>
            <button className="primary" onClick={submit} disabled={busy || !response.trim()}>{t("적용하고 완료")}</button>
          </div>
        </>
      )}
      {tab === "packet" && err && <div className="err">{err}</div>}
    </Modal>
  );
}

export function HandoverModal({ agendaKey, memberId, accounts, onClose, onDone }: { agendaKey: string; memberId: string; accounts: { id: string; provider: string; status: string }[]; onClose: () => void; onDone: (msg: string) => void }) {
  const t = useT();
  const [provider, setProvider] = useState("");
  const [account, setAccount] = useState("");
  const [model, setModel] = useState("");
  const [err, setErr] = useState("");
  const usable = accounts.filter((a) => (!provider || a.provider === provider) && a.status === "ok");
  const submit = async () => {
    try {
      const r = await api.handover(agendaKey, memberId, { provider: provider || undefined, account: account || undefined, model: model || undefined });
      onDone(t("{from} → {to} ({provider}/{account}) 인계 시작", { from: memberId, to: r.id, provider: r.provider, account: r.account ?? "default" }));
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title={t("{id} 이어받기", { id: memberId })} onClose={onClose}>
      <p className="small muted">{t("같은 worktree·브랜치에서 새 위원이 남은 작업을 이어갑니다. 비워 두면 같은 제공자의 다른 계정을 자동으로 고릅니다.")}</p>
      <div className="row2">
        <label>{t("제공자")}
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setAccount(""); }}>
            <option value="">{t("자동")}</option>
            <option value="claude">claude</option>
            <option value="gemini">gemini</option>
            <option value="gpt">gpt</option>
          </select>
        </label>
        <label>{t("계정")}
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">{t("자동")}</option>
            {usable.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.provider})</option>)}
          </select>
        </label>
      </div>
      <label>{t("모델 (선택)")}<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" /></label>
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>{t("취소")}</button>
        <button className="primary" onClick={submit}>{t("이어받기")}</button>
      </div>
    </Modal>
  );
}

const FOLDER_KIND: Record<FolderReport["folders"][number]["kind"], string> = {
  busy: "작업 중",
  parked: "재사용 대기",
  free: "머지됨 · 정리",
  unmerged: "머지 전 · 정리 (브랜치에 보관)",
  dirty: "커밋 안 된 변경 · 남김",
};
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);

/**
 * Member folders of a long agenda: what is on disk and what a tidy removes. Nothing is removed until
 * the user presses the button; branches always stay, and work not merged yet comes back when needed.
 */
export function FolderTidyModal({ agendaKey, onClose, onDone }: { agendaKey: string; onClose: () => void; onDone: (msg: string) => void }) {
  const t = useT();
  const [report, setReport] = useState<FolderReport | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.folders(agendaKey).then(setReport, (e) => setErr((e as Error).message));
  }, [agendaKey]);
  const c = report?.counts;
  const est = report?.perFolderMb !== undefined && report.removable ? gb(report.perFolderMb * report.removable) : undefined;
  const tidy = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.tidyFolders(agendaKey);
      const left = [
        t("재사용 대기 {n}개", { n: r.kept }),
        ...(r.dirty.length ? [t("커밋 안 된 변경이 있는 {n}개", { n: r.dirty.length })] : []),
        ...(r.locked.length ? [t("사용 중이라 못 지운 {n}개", { n: r.locked.length })] : []),
      ];
      onDone(t("위원 폴더 {n}개를 정리했습니다{est}. 남긴 폴더: {left}.", { n: r.removed, est: est ? ` (~${est})` : "", left: left.join(", ") }));
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("위원 폴더 정리")} onClose={onClose} wide>
      <p className="small muted">
        {rich(t("위원마다 저장소의 작업 파일을 통째로 꺼낸 폴더가 하나씩 생깁니다. 안건이 길어지면 이 폴더가 쌓여 디스크를 많이 차지합니다. 정리는 아무도 쓰지 않는 폴더만 지우고, <b>브랜치는 지우지 않습니다</b>. 머지 전 결과도 브랜치에 그대로 있어 나중에 머지할 수 있고, 이어받기·검증을 하면 폴더를 브랜치에서 다시 꺼냅니다. 위원 노트와 캡처는 먼저 보관합니다."))}
      </p>
      {!report && !err && <div className="muted small">{t("폴더를 확인하는 중… (폴더가 많으면 수십 초 걸립니다)")}</div>}
      {c && (
        <>
          <div className="folder-sum">
            <div><b>{report!.folders.length}</b><span>{t("전체")}</span></div>
            <div className="go"><b>{report!.removable}</b><span>{t("정리할 폴더")}{est ? ` · ${t("약 {est}", { est })}` : ""}</span></div>
            <div><b>{c.parked}</b><span>{t("재사용 대기")}</span></div>
            <div><b>{c.busy}</b><span>{t("작업 중")}</span></div>
            <div className={c.dirty ? "warn" : ""}><b>{c.dirty}</b><span>{t("변경 남음")}</span></div>
          </div>
          {report!.perFolderMb !== undefined && <div className="small muted">{t("폴더 하나를 재 보니 약 {size}였습니다. 정리할 양은 그 크기로 어림한 값입니다.", { size: gb(report!.perFolderMb) })}</div>}
          {c.dirty > 0 && <div className="small warn-text">{t("커밋하지 않은 변경이 남은 폴더는 지우지 않습니다. 필요한 변경이면 그 위원을 이어받게 하거나 직접 커밋하세요.")}</div>}
          <div className="folder-list">
            {report!.folders.map((f) => (
              <div key={f.name} className={`folder-row ${f.kind}`}>
                <span className="mono">{f.name}</span>
                <span className="small muted">{f.members.map((m) => `${m.id}${m.merged ? ` (${t("머지")})` : ` (${m.status})`}`).join(", ")}</span>
                <span className={`badge ${f.kind === "dirty" ? "warn" : f.kind === "free" || f.kind === "unmerged" ? "ok" : ""}`}>
                  {t(FOLDER_KIND[f.kind])}
                  {f.changed ? ` ${f.changed}` : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>{t("닫기")}</button>
        <button className="primary" disabled={!report || !report.removable || busy} onClick={() => void tidy()}>
          {busy ? t("정리하는 중…") : report ? t("{n}개 정리", { n: report.removable }) : t("정리")}
        </button>
      </div>
    </Modal>
  );
}

export function MemberModal({ agendaKey, memberId, onClose }: { agendaKey: string; memberId: string; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<"log" | "diff" | "result" | "state">("result");
  const [info, setInfo] = useState<Record<string, unknown> & { logTail: string[]; diff?: string; stateMd?: string } | null>(null);
  useEffect(() => {
    api.member(agendaKey, memberId, { tail: 200, diff: true }).then(setInfo).catch(() => setInfo(null));
  }, [agendaKey, memberId]);
  const result = info?.result as { summary?: string; changedFiles?: string; unfinished?: string } | undefined;
  return (
    <Modal title={t("위원 {id}", { id: memberId })} onClose={onClose} wide>
      <div className="tabs inline">
        <button className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>{t("결과")}</button>
        <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>diff</button>
        <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>{t("로그")}</button>
        <button className={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>STATE.md</button>
      </div>
      {!info && <div className="muted small">{t("불러오는 중…")}</div>}
      {info && tab === "result" && (
        <div className="member-detail">
          <div className="small muted mono">{String(info.branch)} · {String(info.status)} · {t("커밋 {n}", { n: (info.commits as string[] | undefined)?.length ?? 0 })}</div>
          <h4>{t("결과")}</h4><pre className="mem-text">{result?.summary || t("(없음)")}</pre>
          <h4>{t("변경 파일")}</h4><pre className="mem-text">{result?.changedFiles || String(info.diffstat ?? t("(없음)"))}</pre>
          <h4>{t("미완료·막힌 점")}</h4><pre className="mem-text">{result?.unfinished || t("(없음)")}</pre>
          {Boolean(info.error) && <div className="err">{String(info.error)}</div>}
        </div>
      )}
      {info && tab === "diff" && <pre className="log">{info.diff || t("(diff 없음)")}</pre>}
      {info && tab === "log" && <pre className="log">{info.logTail.join("\n") || t("(로그 없음)")}</pre>}
      {info && tab === "state" && <pre className="log">{info.stateMd || t("(STATE.md 없음: 위원이 아직 체크포인트를 쓰지 않음)")}</pre>}
    </Modal>
  );
}
