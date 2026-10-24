import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, connectWs } from "./api";
import { familyOf } from "./model";
import { AccountsView } from "./components/AccountsView";
import { CenterPane } from "./components/CenterPane";
import { LeftPane } from "./components/LeftPane";
import { MemoryView } from "./components/MemoryView";
import { RightPane } from "./components/RightPane";
import { GuidelinesModal, HandoverModal, MemberModal, NewProjectModal, ProjectSettingsModal, RelayModal } from "./components/Modals";
import type { Attachment, ChatItem, Overview, RuntimeState, TranscriptEntry, UsageSnapshot } from "./types";

const MEMORY_KEY = "__memory__";
const ACCOUNTS_KEY = "__accounts__";
const isSpecial = (k: string) => k === MEMORY_KEY || k === ACCOUNTS_KEY;
type Tab = "left" | "center" | "right";

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setM(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return m;
}

let seq = 1;
const item = (role: ChatItem["role"], text: string, ts = new Date().toISOString()): ChatItem => ({ id: seq++, role, text, ts });

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [selected, setSelected] = useState<string>(() => localStorage.getItem("gc.selected") ?? "");
  const [state, setState] = useState<RuntimeState | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [firstTurn, setFirstTurn] = useState(false);
  const [loadingAgenda, setLoadingAgenda] = useState(false);
  const [wsUp, setWsUp] = useState(false);
  const [tab, setTab] = useState<Tab>("center");
  const [modal, setModal] = useState<
    | null
    | { kind: "project" }
    | { kind: "guidelines"; projectId: string }
    | { kind: "settings"; projectId: string }
    | { kind: "member"; id: string }
    | { kind: "relay"; id: string }
    | { kind: "handover"; id: string }
  >(null);
  const [toast, setToast] = useState("");
  const mobile = useMedia("(max-width: 900px)");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 4000);
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      setOverview(await api.overview());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
    }
  }, []);

  const loadAgenda = useCallback(
    async (key: string) => {
      if (!key || isSpecial(key)) {
        setState(null);
        setChat([]);
        return;
      }
      setLoadingAgenda(true);
      // drop the previous agenda's goals/chat right away instead of showing them while loading
      setState(null);
      setChat([]);
      try {
        const r = await api.agenda(key);
        // the user may have switched again while this was loading
        if (key !== selectedRef.current) return;
        setState(r.state);
        setFirstTurn(r.firstTurn);
        setChat(
          r.transcript.map((t: TranscriptEntry) => ({
            ...item(t.role === "assistant" && t.isError ? "error" : t.role, t.text, t.ts),
            attachments: t.attachments,
          })),
        );
      } catch (e) {
        notify((e as Error).message);
      } finally {
        if (key === selectedRef.current) setLoadingAgenda(false);
      }
    },
    [notify],
  );

  const refreshState = useCallback(async (key: string) => {
    try {
      const r = await api.agenda(key);
      // a late answer for an agenda that is no longer open must not overwrite the current one
      if (key !== selectedRef.current) return;
      setState(r.state);
      setFirstTurn(r.firstTurn);
    } catch {
      /* ignore */
    }
  }, []);

  // auth bootstrap
  useEffect(() => {
    api.me().then(
      () => setAuthed(true),
      () => setAuthed(false),
    );
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refreshOverview();
  }, [authed, refreshOverview]);

  useEffect(() => {
    if (!authed) return;
    localStorage.setItem("gc.selected", selected);
    void loadAgenda(selected);
  }, [authed, selected, loadAgenda]);

  // websocket
  const stateTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!authed) return;
    const scheduleState = (key: string) => {
      if (stateTimer.current) return;
      stateTimer.current = window.setTimeout(() => {
        stateTimer.current = undefined;
        void refreshState(key);
      }, 800);
    };
    return connectWs((msg) => {
      const type = msg.type as string;
      if (type === "overview") {
        void refreshOverview();
        return;
      }
      if (type === "usage") {
        setUsage({ at: Number(msg.at), items: (msg.items as UsageSnapshot["items"]) ?? [] });
        return;
      }
      const key = msg.key as string | undefined;
      if (!key || key !== selectedRef.current) {
        if (type === "member:done" || type === "member:start") void refreshOverview();
        return;
      }
      switch (type) {
        case "chair:start":
          void refreshOverview();
          setChat((c) => [...c, { ...item(msg.role === "event" ? "event" : "user", String(msg.text)), attachments: (msg.attachments as Attachment[] | undefined) ?? undefined }]);
          setState((s) => (s ? { ...s, chair: { ...s.chair, busy: true } } : s));
          setFirstTurn(false);
          break;
        case "chair:text":
          setChat((c) => [...c, item("assistant", String(msg.text))]);
          break;
        case "chair:tool": {
          const input = msg.input ? JSON.stringify(msg.input) : "";
          setChat((c) => [...c, item("tool", `${String(msg.name).replace(/^mcp__\w+__/, "")} ${input.slice(0, 200)}`)]);
          break;
        }
        case "chair:done":
          void refreshOverview();
          if (msg.isError) setChat((c) => [...c, item("error", String(msg.text))]);
          setState((s) => (s ? { ...s, chair: { ...s.chair, busy: false } } : s));
          scheduleState(key);
          break;
        case "member:line":
        case "member:start":
        case "member:done":
        case "state":
          scheduleState(key);
          if (type !== "member:line") void refreshOverview();
          break;
        case "log":
          setChat((c) => [...c, item("system", String(msg.line))]);
          break;
        case "chair:handover":
          setChat((c) => [...c, item("event", `의장 계정 전환: ${String(msg.from)} → ${String(msg.to)} (${String(msg.reason)})`)]);
          void refreshOverview();
          break;
        case "chair:show":
          setChat((c) => [...c, { ...item("assistant", String(msg.text ?? "")), attachments: (msg.attachments as Attachment[]) ?? [] }]);
          break;
        case "chair:ask":
          void refreshOverview();
          void refreshState(key);
          break;
        case "agenda:finished":
          setChat((c) => [...c, item("event", `의장이 안건을 종료했습니다: ${String(msg.reason)} (베이스 브랜치에 머지함)`)]);
          void refreshOverview();
          void refreshState(key);
          break;
      }
    }, setWsUp);
  }, [authed, refreshOverview, refreshState]);

  const send = useCallback(
    async (message: string, files: File[] = []) => {
      if (!selected || isSpecial(selected)) return;
      try {
        const attachments = [];
        for (const f of files) attachments.push(await api.upload(selected, f));
        await api.chat(selected, message, attachments);
      } catch (e) {
        notify((e as Error).message);
        throw e;
      }
    },
    [selected, notify],
  );

  const onLogin = async () => {
    try {
      await api.login(token.trim());
      setLoginError("");
      setAuthed(true);
    } catch (e) {
      setLoginError((e as Error).message);
    }
  };

  const currentProject = useMemo(() => overview?.projects.find((p) => selected.startsWith(p.id + "/")), [overview, selected]);

  if (authed === null) return <div className="boot">연결 중…</div>;
  if (authed === false) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>GenCouncil</h1>
          <p>서버 토큰을 입력하세요. 토큰은 PC에서 <code>gencouncil web token</code> 으로 볼 수 있습니다.</p>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" onKeyDown={(e) => e.key === "Enter" && onLogin()} autoFocus />
          <button onClick={onLogin}>입장</button>
          {loginError && <div className="err">{loginError}</div>}
        </div>
      </div>
    );
  }

  // only ever show the state of the agenda that is selected now
  const shownState = state && state.key === selected ? state : null;

  const left = (
    <LeftPane
      overview={overview}
      usage={usage}
      selected={selected}
      onSelect={(k) => {
        setSelected(k);
        if (mobile) setTab("center");
      }}
      onNewProject={() => setModal({ kind: "project" })}
      onNewAgenda={async (pid) => {
        try {
          const r = await api.createAgenda(pid);
          await refreshOverview();
          setSelected(r.key);
          if (mobile) setTab("center");
        } catch (e) {
          notify((e as Error).message);
        }
      }}
      onGuidelines={(pid) => setModal({ kind: "guidelines", projectId: pid })}
      onSettings={(pid) => setModal({ kind: "settings", projectId: pid })}
      live={
        state && selected === state.key
          ? {
              key: state.key,
              chairBusy: state.chair.busy,
              families: [...new Set(state.members.filter((m) => m.status === "running" || m.status === "waiting").map((m) => familyOf(m)))],
            }
          : undefined
      }
      memoryKey={MEMORY_KEY}
      accountsKey={ACCOUNTS_KEY}
      wsUp={wsUp}
    />
  );
  const center =
    selected === MEMORY_KEY ? (
      <MemoryView notify={notify} />
    ) : selected === ACCOUNTS_KEY ? (
      <AccountsView notify={notify} />
    ) : (
      <CenterPane
        state={shownState}
        chat={chat}
        firstTurn={firstTurn}
        loading={loadingAgenda}
        project={currentProject}
        onSend={send}
        onSetChair={async (model, effort, account, advisor) => {
          if (!currentProject) return;
          await api.setChair(currentProject.id, model, effort, account, advisor);
          notify(account !== undefined ? `의장 계정을 ${account}로 바꿨습니다. 새 세션으로 시작합니다.` : "의장 설정을 저장했습니다. 다음 턴부터 적용됩니다.");
          if (selected) void refreshState(selected);
        }}
        onSetAutonomy={async (autonomy) => {
          if (!currentProject) return;
          try {
            await api.projectSettings(currentProject.id, { members: { autonomy } });
            notify(autonomy === "chair" ? "위원 권한 요청을 의장이 대신 승인합니다. 다음에 시작하는 위원부터 적용됩니다." : "위원 자율성을 바꿨습니다. 다음에 시작하는 위원부터 적용됩니다.");
            void refreshOverview();
          } catch (e) {
            notify((e as Error).message);
          }
        }}
        onReset={async () => {
          if (!selected) return;
          await api.reset(selected);
          notify("의장 세션을 초기화했습니다 (state.md 유지).");
          void refreshState(selected);
        }}
        onRetrospect={async () => {
          if (!selected) return;
          try {
            notify("회고 시작: 의장이 교훈·성향을 공유 기억에 기록합니다.");
            const r = await api.retrospect(selected);
            notify(r.ran ? (r.isError ? `회고 실패: ${r.text.slice(0, 120)}` : "회고 완료") : "의장 세션이 없어 회고할 내용이 없습니다.");
          } catch (e) {
            notify((e as Error).message);
          }
        }}
        onResume={async () => {
          if (!selected) return;
          try {
            const r = await api.resume(selected);
            notify(`이어서 시작: 위원 ${r.resumed.length}명${r.failed.length ? `, 실패 ${r.failed.length}명 (${r.failed.map((f) => f.error).join("; ").slice(0, 120)})` : ""}`);
            void refreshState(selected);
          } catch (e) {
            notify((e as Error).message);
          }
        }}
        onDismissResume={async () => {
          if (!selected) return;
          await api.dismissResume(selected).catch((e) => notify((e as Error).message));
          void refreshState(selected);
        }}
        onDelete={async () => {
          if (!selected || !state) return;
          if (!confirm(`안건 "${state.agenda.title}"을 삭제할까요?\n작업 폴더와 브랜치를 지우고, 대화 기록은 프로젝트의 deleted 폴더로 옮깁니다.`)) return;
          try {
            let r = await api.deleteAgenda(selected);
            if (!r.deleted) {
              if (!confirm(`이 안건에는 아직 합치지 않은 작업이 있습니다:\n- ${r.lost.join("\n- ")}\n\n삭제하면 이 작업은 사라집니다. 그래도 삭제할까요?`)) return;
              r = await api.deleteAgenda(selected, true);
            }
            notify("안건을 삭제했습니다.");
            setSelected("");
            void refreshOverview();
          } catch (e) {
            notify((e as Error).message);
          }
        }}
        onApproveFinish={async () => {
          if (!selected) return;
          try {
            await api.finish(selected, false);
            notify("안건을 종료했습니다.");
            void refreshOverview();
            void refreshState(selected);
          } catch (e) {
            notify((e as Error).message);
          }
        }}
        onDismissFinish={async () => {
          if (!selected) return;
          await api.dismissFinish(selected).catch((e) => notify((e as Error).message));
          void refreshState(selected);
          void refreshOverview();
        }}
        onFinish={async () => {
          if (!selected || !confirm("안건 브랜치를 베이스 브랜치에 머지하고 worktree를 정리합니다. 계속할까요?")) return;
          const retro = confirm("종료 전에 의장이 회고(교훈·성향을 공유 기억에 기록, 제안 승인)를 먼저 할까요?\n확인 = 회고 후 종료 / 취소 = 바로 종료");
          try {
            if (retro) notify("회고 중… 끝나면 종료합니다.");
            await api.finish(selected, retro);
            notify("안건을 종료했습니다.");
            void refreshOverview();
            void loadAgenda(selected);
          } catch (e) {
            notify((e as Error).message);
          }
        }}
      />
    );
  const right = (
    <RightPane
      state={shownState}
      onOpen={(id) => setModal({ kind: "member", id })}
      onMerge={async (id) => {
        if (!selected) return;
        try {
          const r = await api.merge(selected, id);
          notify(r.ok ? `${id} 머지 완료` : `충돌: ${r.conflicts.join(", ")}`);
        } catch (e) {
          notify((e as Error).message);
        }
      }}
      onStop={async (id) => {
        if (!selected || !confirm(`${id} 를 중지할까요?`)) return;
        await api.stop(selected, id);
      }}
      onRelay={(id) => setModal({ kind: "relay", id })}
      onHandover={(id) => setModal({ kind: "handover", id })}
    />
  );

  return (
    <div className={`app ${mobile ? "mobile" : ""}`}>
      {mobile ? (
        <>
          <div className="tabs">
            <button className={tab === "left" ? "on" : ""} onClick={() => setTab("left")}>안건</button>
            <button className={tab === "center" ? "on" : ""} onClick={() => setTab("center")}>
              의장{state?.agenda.waitingForUser && !state.chair.busy ? <span className="tab-ask" title="의장이 결정을 기다립니다">?</span> : null}
            </button>
            <button className={tab === "right" ? "on" : ""} onClick={() => setTab("right")}>
              위원{state?.members.some((m) => m.status === "running") ? " ●" : ""}
            </button>
          </div>
          <div className="pane-mobile">{tab === "left" ? left : tab === "center" ? center : right}</div>
        </>
      ) : (
        <>
          <aside className="pane left">{left}</aside>
          <main className="pane center">{center}</main>
          <aside className="pane right">{right}</aside>
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
      {modal?.kind === "project" && (
        <NewProjectModal
          onClose={() => setModal(null)}
          onCreate={async (b) => {
            const created = await api.createProject(b);
            if (created.scanSummary) notify(created.scanSummary);
            setModal(null);
            void refreshOverview();
          }}
        />
      )}
      {modal?.kind === "guidelines" && <GuidelinesModal projectId={modal.projectId} onClose={() => setModal(null)} notify={notify} />}
      {modal?.kind === "settings" && overview?.projects.find((p) => p.id === modal.projectId) && (
        <ProjectSettingsModal
          project={overview.projects.find((p) => p.id === modal.projectId)!}
          onClose={() => setModal(null)}
          onSaved={(m) => {
            notify(m);
            void refreshOverview();
            if (selected) void refreshState(selected);
          }}
        />
      )}
      {modal?.kind === "member" && selected && <MemberModal agendaKey={selected} memberId={modal.id} onClose={() => setModal(null)} />}
      {modal?.kind === "relay" && selected && (
        <RelayModal
          agendaKey={selected}
          memberId={modal.id}
          site={state?.members.find((m) => m.id === modal.id)?.site}
          onClose={() => setModal(null)}
          onDone={(m) => { notify(m); void refreshState(selected); }}
        />
      )}
      {modal?.kind === "handover" && selected && (
        <HandoverModal
          agendaKey={selected}
          memberId={modal.id}
          accounts={state?.accounts ?? []}
          onClose={() => setModal(null)}
          onDone={(m) => { notify(m); void refreshState(selected); }}
        />
      )}
    </div>
  );
}
