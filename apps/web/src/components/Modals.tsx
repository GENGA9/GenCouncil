import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Limits, ProjectOv } from "../types";
import { FolderPicker } from "./FolderPicker";
import { LimitsEditor, useModels } from "./LimitsEditor";

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
  return (
    <div className="row2">
      <label>의장 모델
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {CHAIR_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label>의장 추론
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          {["", "low", "medium", "high", "xhigh", "max"].map((x) => <option key={x} value={x}>{x || "기본"}</option>)}
        </select>
      </label>
    </div>
  );
}

const SUFFIX = "제작위원회";
const withSuffix = (n: string) => (n.trim().endsWith(SUFFIX) ? n.trim() : `${n.trim()} ${SUFFIX}`);

export function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (b: Record<string, unknown>) => Promise<void> }) {
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
    <Modal title="제작위원회 추가" onClose={onClose} wide>
      <label>프로젝트 이름<input value={name} onChange={(e) => setName(e.target.value)} placeholder="RF PROJECT" autoFocus /></label>
      {name.trim() && <div className="small muted name-preview">→ {withSuffix(name)}</div>}
      <label>작업 폴더
        <span className="folder-row">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={"D:\\PROJECT\\RF"} />
          <button className="ghost" type="button" onClick={() => setPicking(true)}>폴더 선택</button>
        </span>
      </label>
      <div className="small muted">이 폴더에서 바로 작업합니다. git 저장소가 아니면 폴더 안에 로컬 git을 만듭니다(어디에도 올라가지 않음). 파이썬 가상환경·바이너리·큰 이미지/영상/압축 파일은 git에서 제외되고 폴더에는 그대로 남습니다.</div>
      <ChairFields model={chairModel} effort={chairEffort} setModel={setChairModel} setEffort={setChairEffort} />
      <label className="check-row">
        <input type="checkbox" checked={directEdit} onChange={(e) => setDirectEdit(e.target.checked)} />
        의장 직접 수정 허용
      </label>
      <div className="small muted">
        켜면 의장이 통합 작업 폴더의 파일을 직접 고치고 머지 충돌을 풀 수 있습니다. 고친 내용은 턴이 끝날 때마다 안건 브랜치에 자동 커밋됩니다. 큰 작업은 계속 위원에게 맡깁니다. 읽기 전용 명령(git 확인, 테스트 실행)과 웹 검색은 항상 허용됩니다.
      </div>
      <label>위원 자율성
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
          <option value="full">full (권한 확인 없음)</option>
          <option value="chair">chair (의장이 대신 승인)</option>
          <option value="edits">edits (편집만 자동)</option>
        </select>
      </label>
      <h4>위원 한도</h4>
      {limits && <LimitsEditor value={limits} onChange={setLimits} />}
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>취소</button>
        <button className="primary" onClick={submit} disabled={busy || !name.trim() || !folder.trim()}>{busy ? "만드는 중…" : "만들기"}</button>
      </div>
      {picking && <FolderPicker start={folder || undefined} onClose={() => setPicking(false)} onPick={(p) => { setFolder(p); setPicking(false); }} />}
    </Modal>
  );
}

export function ProjectSettingsModal({ project, onClose, onSaved }: { project: ProjectOv; onClose: () => void; onSaved: (msg: string) => void }) {
  return (
    <Modal title={`${project.name} 설정`} onClose={onClose} wide>
      <ProjectSettingsForm project={project} onClose={onClose} onSaved={onSaved} />
    </Modal>
  );
}

/** The fields of a project's settings. In a modal `onClose` closes it after saving; inline there is none. */
export function ProjectSettingsForm({ project, onClose, onSaved }: { project: ProjectOv; onClose?: () => void; onSaved: (msg: string) => void }) {
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
      onSaved(r.scanSummary ? `설정을 저장했습니다. ${r.scanSummary}` : "설정을 저장했습니다. 의장의 다음 턴부터 적용됩니다.");
      onClose?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label>프로젝트 이름<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      {name.trim() && <div className="small muted name-preview">→ {withSuffix(name)}</div>}
      <label>작업 폴더
        <span className="folder-row">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
          <button className="ghost" type="button" onClick={() => setPicking(true)}>폴더 선택</button>
        </span>
      </label>
      <div className="small muted">
        {project.localGit ? "로컬 git (GenCouncil이 만듦)" : "git 저장소"}
        {folderChanged ? " · 폴더를 바꾸면 새 폴더 기준으로 다시 연결합니다. 진행 중인 안건이 있으면 바꿀 수 없습니다." : ""}
      </div>
      <ChairFields model={chairModel} effort={chairEffort} setModel={setChairModel} setEffort={setChairEffort} />
      <label className="check-row">
        <input type="checkbox" checked={directEdit} onChange={(e) => setDirectEdit(e.target.checked)} />
        의장 직접 수정 허용
      </label>
      <div className="small muted">
        켜면 의장이 통합 작업 폴더의 파일을 직접 고치고 머지 충돌을 풀 수 있습니다. 고친 내용은 턴이 끝날 때마다 안건 브랜치에 자동 커밋됩니다. 큰 작업은 계속 위원에게 맡깁니다. 읽기 전용 명령(git 확인, 테스트 실행)과 웹 검색은 항상 허용됩니다.
      </div>
      <label>위원 자율성
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
          <option value="full">full (권한 확인 없음)</option>
          <option value="chair">chair (의장이 대신 승인)</option>
          <option value="edits">edits (편집만 자동)</option>
        </select>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={verifyFlash} onChange={(e) => setVerifyFlash(e.target.checked)} />
        Gemini Flash 코드 작업 뒤 Claude 검증
      </label>
      <div className="small muted">
        켜면 Gemini Flash 위원이 코드를 고친 작업을 끝낼 때마다, 머지 전에 Claude 위원(기본 Sonnet, 추론 높음, 한도 안)이 같은 브랜치에서 근거·테스트·범위를 확인하고 틀린 곳을 고칩니다. 문서 정리 같은 좁은 일은 의장이 건너뛸 수 있습니다.
      </div>
      <h4>위원 한도</h4>
      {limits && <LimitsEditor value={limits} onChange={setLimits} />}
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        {onClose && <button className="ghost" onClick={onClose}>취소</button>}
        <button className="primary" onClick={save} disabled={busy || !name.trim() || !folder.trim()}>{busy ? "저장 중…" : "저장"}</button>
      </div>
      {picking && <FolderPicker start={folder || undefined} onClose={() => setPicking(false)} onPick={(p) => { setFolder(p); setPicking(false); }} />}
    </>
  );
}

export function NewAgendaModal({ projectId, onClose, onCreate }: { projectId: string; onClose: () => void; onCreate: (title: string, goals: string[]) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [goals, setGoals] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    try {
      await onCreate(title, goals.split("\n").map((g) => g.trim()).filter(Boolean));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title={`안건 추가 · ${projectId}`} onClose={onClose}>
      <label>제목<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="밸런스 안건" autoFocus /></label>
      <label>목표 (한 줄에 하나)<textarea rows={5} value={goals} onChange={(e) => setGoals(e.target.value)} placeholder={"목표1\n목표2\n목표3"} /></label>
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>취소</button>
        <button className="primary" onClick={submit} disabled={!title.trim()}>만들기</button>
      </div>
    </Modal>
  );
}

export function GuidelinesModal({ projectId, onClose, notify }: { projectId: string; onClose: () => void; notify: (m: string) => void }) {
  return (
    <Modal title="업무 분장 가이드라인" onClose={onClose} wide>
      <GuidelinesForm projectId={projectId} onClose={onClose} notify={notify} />
    </Modal>
  );
}

/** The guidelines editor. In a modal `onClose` closes it after saving; inline there is none. */
export function GuidelinesForm({ projectId, onClose, notify }: { projectId: string; onClose?: () => void; notify: (m: string) => void }) {
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
      notify("가이드라인 저장. 의장의 다음 턴부터 반영됩니다.");
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
        {onClose && <button className="ghost" onClick={onClose}>닫기</button>}
        {/* never save over the file with the empty text of a load that has not come back */}
        <button className="primary" disabled={!loaded} onClick={() => void save()}>저장</button>
      </div>
    </>
  );
}

export function RelayModal({ agendaKey, memberId, site, onClose, onDone }: { agendaKey: string; memberId: string; site?: string; onClose: () => void; onDone: (msg: string) => void }) {
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
      setErr("클립보드 접근이 막혀 있습니다. 텍스트를 직접 선택해 복사하세요.");
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
    <Modal title={`릴레이 위원 ${memberId}`} onClose={onClose} wide>
      <div className="tabs inline">
        <button className={tab === "packet" ? "on" : ""} onClick={() => setTab("packet")}>1. 패킷 복사</button>
        <button className={tab === "answer" ? "on" : ""} onClick={() => setTab("answer")}>2. 답변 붙여넣기</button>
      </div>
      {tab === "packet" ? (
        <>
          <p className="small muted">아래 전체를 웹 제미나이 / AI Studio / Antigravity 채팅에 붙여넣으세요. 답변은 FILE/RESULT 블록 양식으로 오도록 패킷에 적혀 있습니다.</p>
          <div className="modal-actions" style={{ marginTop: 0, marginBottom: 8 }}>
            {site && (
              <button className="ghost small" onClick={async () => { await copy(); try { await api.openWeb(agendaKey, memberId); } catch (e) { setErr((e as Error).message); } }}>
                복사하고 사이트 열기 (PC)
              </button>
            )}
            <button className="primary small" onClick={copy}>{copied ? "복사됨 ✓" : "전체 복사"}</button>
          </div>
          <textarea id="relay-packet" className="editor" rows={18} value={packet} readOnly />
        </>
      ) : (
        <>
          <p className="small muted">웹 AI의 답변 전체를 붙여넣으세요. <code>=== FILE: 경로 ===</code> 블록은 worktree에 저장·커밋되고, <code>=== RESULT ===</code> 블록은 결과 보고가 됩니다. 파일을 직접 고친 경우(Antigravity)는 RESULT 블록만 붙여도 됩니다.</p>
          <textarea className="editor" rows={16} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="=== FILE: src/x.js ===&#10;...&#10;=== END ===&#10;=== RESULT ===&#10;## 결과&#10;...&#10;=== END ===" />
          {err && <div className="err">{err}</div>}
          <div className="modal-actions">
            <button className="ghost" onClick={onClose}>닫기</button>
            <button className="primary" onClick={submit} disabled={busy || !response.trim()}>적용하고 완료</button>
          </div>
        </>
      )}
      {tab === "packet" && err && <div className="err">{err}</div>}
    </Modal>
  );
}

export function HandoverModal({ agendaKey, memberId, accounts, onClose, onDone }: { agendaKey: string; memberId: string; accounts: { id: string; provider: string; status: string }[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [provider, setProvider] = useState("");
  const [account, setAccount] = useState("");
  const [model, setModel] = useState("");
  const [err, setErr] = useState("");
  const usable = accounts.filter((a) => (!provider || a.provider === provider) && a.status === "ok");
  const submit = async () => {
    try {
      const r = await api.handover(agendaKey, memberId, { provider: provider || undefined, account: account || undefined, model: model || undefined });
      onDone(`${memberId} → ${r.id} (${r.provider}/${r.account ?? "default"}) 인계 시작`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title={`${memberId} 이어받기`} onClose={onClose}>
      <p className="small muted">같은 worktree·브랜치에서 새 위원이 남은 작업을 이어갑니다. 비워 두면 같은 제공자의 다른 계정을 자동으로 고릅니다.</p>
      <div className="row2">
        <label>제공자
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setAccount(""); }}>
            <option value="">자동</option>
            <option value="claude">claude</option>
            <option value="gemini">gemini</option>
            <option value="gpt">gpt</option>
          </select>
        </label>
        <label>계정
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">자동</option>
            {usable.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.provider})</option>)}
          </select>
        </label>
      </div>
      <label>모델 (선택)<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" /></label>
      {err && <div className="err">{err}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>취소</button>
        <button className="primary" onClick={submit}>이어받기</button>
      </div>
    </Modal>
  );
}

export function MemberModal({ agendaKey, memberId, onClose }: { agendaKey: string; memberId: string; onClose: () => void }) {
  const [tab, setTab] = useState<"log" | "diff" | "result" | "state">("result");
  const [info, setInfo] = useState<Record<string, unknown> & { logTail: string[]; diff?: string; stateMd?: string } | null>(null);
  useEffect(() => {
    api.member(agendaKey, memberId, { tail: 200, diff: true }).then(setInfo).catch(() => setInfo(null));
  }, [agendaKey, memberId]);
  const result = info?.result as { summary?: string; changedFiles?: string; unfinished?: string } | undefined;
  return (
    <Modal title={`위원 ${memberId}`} onClose={onClose} wide>
      <div className="tabs inline">
        <button className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>결과</button>
        <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>diff</button>
        <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>로그</button>
        <button className={tab === "state" ? "on" : ""} onClick={() => setTab("state")}>STATE.md</button>
      </div>
      {!info && <div className="muted small">불러오는 중…</div>}
      {info && tab === "result" && (
        <div className="member-detail">
          <div className="small muted mono">{String(info.branch)} · {String(info.status)} · 커밋 {(info.commits as string[] | undefined)?.length ?? 0}</div>
          <h4>결과</h4><pre className="mem-text">{result?.summary || "(없음)"}</pre>
          <h4>변경 파일</h4><pre className="mem-text">{result?.changedFiles || String(info.diffstat ?? "(없음)")}</pre>
          <h4>미완료·막힌 점</h4><pre className="mem-text">{result?.unfinished || "(없음)"}</pre>
          {Boolean(info.error) && <div className="err">{String(info.error)}</div>}
        </div>
      )}
      {info && tab === "diff" && <pre className="log">{info.diff || "(diff 없음)"}</pre>}
      {info && tab === "log" && <pre className="log">{info.logTail.join("\n") || "(로그 없음)"}</pre>}
      {info && tab === "state" && <pre className="log">{info.stateMd || "(STATE.md 없음: 위원이 아직 체크포인트를 쓰지 않음)"}</pre>}
    </Modal>
  );
}
