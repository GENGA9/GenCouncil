import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, connectWs } from "./api";
import { familyOf, memberName } from "./model";
import { AccountsView } from "./components/AccountsView";
import { CenterPane } from "./components/CenterPane";
import { LeftPane } from "./components/LeftPane";
import { MemoryView } from "./components/MemoryView";
import { WikiView } from "./components/WikiView";
import { RightPane } from "./components/RightPane";
import { ModeSwitch, readMode, saveMode, type Mode } from "./components/ModeSwitch";
import { AvatarView } from "./components/AvatarView";
import { MeetingView } from "./components/MeetingView";
import { VisionView } from "./components/VisionView";
import { FloatingChair } from "./components/FloatingChair";
import { IS_FLOAT, reportMode } from "./desktop";
import { useT } from "./i18n";
import { reloadGemini } from "./components/GeminiOptIn";
import type { ChairActions, MemberActions, ProjectActions } from "./vision/actions";
import type { VisionEvent } from "./vision/renderer";
import { FolderTidyModal, GuidelinesModal, HandoverModal, MemberModal, NewProjectModal, ProjectSettingsModal, RelayModal } from "./components/Modals";
import type { Attachment, ChatItem, Meeting, MeetingSettings, Member, Overview, RuntimeState, TranscriptEntry, UploadHooks, UsageSnapshot } from "./types";

const MEMORY_KEY = "__memory__";
const ACCOUNTS_KEY = "__accounts__";
const WIKI_KEY = "__wiki__";
const isSpecial = (k: string) => k === MEMORY_KEY || k === ACCOUNTS_KEY || k === WIKI_KEY;
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
  const t = useT();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  // the meeting room: the meeting under way or the last one, kept current over the websocket
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  // who chairs and who sits in (saved on the server, the same on every device)
  const [meetingSettings, setMeetingSettings] = useState<MeetingSettings>({ chair: "claude", members: ["claude", "gpt", "gemini", "grok"] });
  const [selected, setSelected] = useState<string>(() => localStorage.getItem("gc.selected") ?? "");
  // the floating chair follows the agenda the main window opens
  useEffect(() => {
    if (!IS_FLOAT) return;
    const fn = (e: StorageEvent) => {
      if (e.key === "gc.selected" && e.newValue !== null) setSelected(e.newValue);
    };
    window.addEventListener("storage", fn);
    return () => window.removeEventListener("storage", fn);
  }, []);
  const [state, setState] = useState<RuntimeState | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [firstTurn, setFirstTurn] = useState(false);
  const [loadingAgenda, setLoadingAgenda] = useState(false);
  const [wsUp, setWsUp] = useState(false);
  const [tab, setTab] = useState<Tab>("center");
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = useCallback((m: Mode) => {
    saveMode(m);
    setModeState(m);
  }, []);
  // the desktop app shows the floating chair when its window is minimized in the avatar view (nothing in a browser)
  useEffect(() => {
    if (!IS_FLOAT) reportMode(authed && mode.room === "work" && mode.look === "avatar" ? "avatar" : "other");
  }, [authed, mode]);
  // what just happened on the open agenda, for the visualization to flash
  const visionListeners = useRef(new Set<(e: VisionEvent) => void>());
  const subscribeVision = useCallback((fn: (e: VisionEvent) => void) => {
    visionListeners.current.add(fn);
    return () => {
      visionListeners.current.delete(fn);
    };
  }, []);
  const flash = useCallback((e: VisionEvent) => visionListeners.current.forEach((fn) => fn(e)), []);
  const [modal, setModal] = useState<
    | null
    | { kind: "project" }
    | { kind: "guidelines"; projectId: string }
    | { kind: "settings"; projectId: string }
    | { kind: "member"; id: string }
    | { kind: "relay"; id: string }
    | { kind: "handover"; id: string }
    | { kind: "folders"; key: string }
  >(null);
  const [toast, setToast] = useState("");
  const uploaded = useRef(new WeakMap<File, Attachment>());
  const mobile = useMedia("(max-width: 900px)");
  const selectedRef = useRef(selected);
  const creatingAgenda = useRef(false);
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

  // after the phone sleeps or the socket drops, events were missed: reload the open agenda quietly
  const resync = useCallback(async () => {
    void refreshOverview();
    const key = selectedRef.current;
    if (!key || isSpecial(key)) return;
    try {
      const r = await api.agenda(key);
      if (key !== selectedRef.current) return;
      setState(r.state);
      setFirstTurn(r.firstTurn);
      setChat(
        r.transcript.map((t: TranscriptEntry) => ({
          ...item(t.role === "assistant" && t.isError ? "error" : t.role, t.text, t.ts),
          attachments: t.attachments,
        })),
      );
    } catch {
      /* ignore */
    }
  }, [refreshOverview]);

  useEffect(() => {
    if (!authed) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [authed, resync]);

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

  useEffect(() => {
    if (!authed || mode.room !== "meeting") return;
    api.meetingLatest().then((r) => setMeeting(r.meeting), () => undefined);
    api.meetingSettings().then((r) => setMeetingSettings(r.settings), () => undefined);
  }, [authed, mode, wsUp]);

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
    let everUp = false;
    return connectWs((msg) => {
      const type = msg.type as string;
      if (type === "overview") {
        void refreshOverview();
        void reloadGemini();
        return;
      }
      if (type === "meeting") {
        setMeeting(msg.meeting as Meeting);
        return;
      }
      if (type === "meeting-settings") {
        setMeetingSettings(msg.settings as MeetingSettings);
        return;
      }
      if (type === "meeting-removed") {
        setMeeting((cur) => (cur && cur.id === msg.id ? null : cur));
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
      if (type === "chair:start") flash(msg.role === "event" ? { type: "chair" } : { type: "user", text: String(msg.text ?? "") });
      else if (type === "chair:text" || type === "chair:show") flash({ type: "say", text: String(msg.text ?? "") });
      else if (type === "chair:tool") flash({ type: "chair" });
      else if (type === "member:line") flash({ type: "line", member: String(msg.member), text: String(msg.line ?? "") });
      else if (type === "member:start" || type === "member:done") {
        const m = msg.member as Member;
        const fam = familyOf(m);
        const house = fam === "relay" || fam === "grok" ? undefined : fam;
        const name = memberName({ ...m, model: m.model?.replace(/-(low|medium|high|xhigh|max)$/i, "") });
        if (type === "member:done") flash({ type: "done", member: m.id, house, name, ok: m.status === "done", summary: m.result?.summary ?? m.failure?.message ?? m.error });
        else if (house) flash({ type: "assign", house, member: m.id, name, taskId: m.taskId });
      } else if (type === "agenda:finished") flash({ type: "finish" });
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
          setChat((c) => [...c, item("event", t("의장 계정 전환: {from} → {to} ({reason})", { from: String(msg.from), to: String(msg.to), reason: String(msg.reason) }))]);
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
          setChat((c) => [...c, item("event", t("의장이 안건을 종료했습니다: {reason} (베이스 브랜치에 머지함)", { reason: String(msg.reason) }))]);
          void refreshOverview();
          void refreshState(key);
          break;
      }
    }, (up) => {
      setWsUp(up);
      if (up && everUp) void resync();
      if (up) everUp = true;
    });
  }, [authed, refreshOverview, refreshState, resync, flash]);

  const send = useCallback(
    async (message: string, files: File[] = [], hooks?: UploadHooks) => {
      if (!selected || isSpecial(selected)) return;
      let current = -1;
      try {
        const attachments = [];
        for (let i = 0; i < files.length; i++) {
          current = i;
          // uploaded in an earlier attempt: reuse it instead of sending the file again
          let att = uploaded.current.get(files[i]);
          if (!att) {
            hooks?.onProgress(i, 0);
            att = await api.upload(selected, files[i], (pct) => hooks?.onProgress(i, pct));
            uploaded.current.set(files[i], att);
          }
          attachments.push(att);
        }
        current = -1;
        await api.chat(selected, message, attachments);
      } catch (e) {
        if (current >= 0) {
          const msg = t("업로드 실패: {msg}", { msg: (e as Error).message });
          hooks?.onFail(current, msg);
          notify(msg);
        } else notify((e as Error).message);
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

  if (authed === null) return <div className="boot">{t("연결 중…")}</div>;
  if (authed === false) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>GenCouncil</h1>
          <p>{t("서버 토큰을 입력하세요.")} {t("토큰은 PC에서 다음 명령으로 볼 수 있습니다:")} <code>gencouncil web token</code></p>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" onKeyDown={(e) => e.key === "Enter" && onLogin()} autoFocus />
          <button onClick={onLogin}>{t("입장")}</button>
          {loginError && <div className="err">{loginError}</div>}
        </div>
      </div>
    );
  }

  // only ever show the state of the agenda that is selected now
  const shownState = state && state.key === selected ? state : null;

  const projectActions: ProjectActions = {
    onNewProject: () => setModal({ kind: "project" }),
    onNewAgenda: async (pid) => {
      // a second click while the first is still on its way would make a second agenda
      if (creatingAgenda.current) return;
      creatingAgenda.current = true;
      try {
        const r = await api.createAgenda(pid);
        setSelected(r.key);
        if (mobile) setTab("center");
        void refreshOverview();
      } catch (e) {
        notify((e as Error).message);
      } finally {
        creatingAgenda.current = false;
      }
    },
    onGuidelines: (pid) => setModal({ kind: "guidelines", projectId: pid }),
    onSettings: (pid) => setModal({ kind: "settings", projectId: pid }),
  };

  const left = (
    <LeftPane
      overview={overview}
      usage={usage}
      selected={selected}
      onSelect={(k) => {
        setSelected(k);
        if (mobile) setTab("center");
      }}
      {...projectActions}
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
      wikiKey={WIKI_KEY}
      accountsKey={ACCOUNTS_KEY}
      wsUp={wsUp}
      mode={mode}
      onMode={setMode}
    />
  );
  const chairActions: ChairActions = {
    onSetChair: async (model, effort, account, advisor) => {
      if (!selected) return;
      await api.setChair(selected, model, effort, account, advisor);
      notify(
        account !== undefined
          ? t("이 안건의 의장 계정을 {account}로 바꿨습니다. 새 세션으로 시작합니다. (다른 안건은 그대로입니다)", { account })
          : t("이 안건의 의장 설정을 저장했습니다. 다음 턴부터 적용됩니다. (다른 안건은 그대로입니다)"),
      );
      if (selected) void refreshState(selected);
    },
    onSetAutonomy: async (autonomy) => {
      if (!currentProject) return;
      try {
        await api.projectSettings(currentProject.id, { members: { autonomy } });
        notify(autonomy === "chair" ? t("위원 권한 요청을 의장이 대신 승인합니다. 다음에 시작하는 위원부터 적용됩니다.") : t("위원 자율성을 바꿨습니다. 다음에 시작하는 위원부터 적용됩니다."));
        void refreshOverview();
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onReset: async () => {
      if (!selected) return;
      await api.reset(selected);
      notify(t("의장 세션을 초기화했습니다 (state.md 유지)."));
      void refreshState(selected);
    },
    onRetrospect: async () => {
      if (!selected) return;
      try {
        notify(t("회고 시작: 의장이 교훈·성향을 공유 기억에 기록합니다."));
        const r = await api.retrospect(selected);
        notify(r.ran ? (r.isError ? t("회고 실패: {text}", { text: r.text.slice(0, 120) }) : t("회고 완료")) : t("의장 세션이 없어 회고할 내용이 없습니다."));
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onResume: async () => {
      if (!selected) return;
      try {
        const r = await api.resume(selected);
        notify(r.failed.length ? t("이어서 시작: 위원 {n}명, 실패 {f}명 ({errors})", { n: r.resumed.length, f: r.failed.length, errors: r.failed.map((f) => f.error).join("; ").slice(0, 120) }) : t("이어서 시작: 위원 {n}명", { n: r.resumed.length }));
        void refreshState(selected);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onDismissResume: async () => {
      if (!selected) return;
      await api.dismissResume(selected).catch((e) => notify((e as Error).message));
      void refreshState(selected);
    },
    onDelete: async () => {
      if (!selected || !state) return;
      if (!confirm(t("안건 \"{title}\"을 삭제할까요?\n작업 폴더와 브랜치를 지우고, 대화 기록은 프로젝트의 deleted 폴더로 옮깁니다.", { title: state.agenda.title }))) return;
      try {
        let r = await api.deleteAgenda(selected);
        if (!r.deleted) {
          if (!confirm(t("이 안건에는 아직 합치지 않은 작업이 있습니다:\n- {lost}\n\n삭제하면 이 작업은 사라집니다. 그래도 삭제할까요?", { lost: r.lost.join("\n- ") }))) return;
          r = await api.deleteAgenda(selected, true);
        }
        notify(t("안건을 삭제했습니다."));
        setSelected("");
        void refreshOverview();
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onApproveFinish: async () => {
      if (!selected) return;
      try {
        notify(t("회고 후 종료합니다…"));
        await api.finish(selected, true);
        notify(t("안건을 종료했습니다."));
        void refreshOverview();
        void refreshState(selected);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onMergeBase: async () => {
      if (!selected) return;
      if (!confirm(t("지금까지 안건 브랜치에 합쳐진 결과를 메인(베이스 브랜치)에 반영합니다. 안건은 계속 열려 있습니다. 진행할까요?"))) return;
      try {
        const r = await api.mergeBase(selected);
        notify(r.notIncluded.length ? t("메인에 반영했습니다. 아직 안건에 합치지 않은 위원 결과({list})는 빠졌습니다.", { list: r.notIncluded.join(", ") }) : t("메인에 반영했습니다."));
        void refreshState(selected);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onDismissFinish: async () => {
      if (!selected) return;
      await api.dismissFinish(selected).catch((e) => notify((e as Error).message));
      void refreshState(selected);
      void refreshOverview();
    },
    onTidyFolders: () => {
      if (selected) setModal({ kind: "folders", key: selected });
    },
    onFinish: async () => {
      if (!selected || !confirm(t("안건 브랜치를 베이스 브랜치에 머지하고 worktree를 정리합니다. 계속할까요?"))) return;
      if (!confirm(t("안건을 종료할까요? 의장이 회고(교훈·모델 성향을 공유 기억에 제안)를 먼저 하고, 안건 브랜치를 베이스 브랜치에 합친 뒤 닫습니다."))) return;
      const retro = true;
      try {
        if (retro) notify(t("회고 중… 끝나면 종료합니다."));
        await api.finish(selected, retro);
        notify(t("안건을 종료했습니다."));
        void refreshOverview();
        void loadAgenda(selected);
      } catch (e) {
        notify((e as Error).message);
      }
    },
  };

  const center =
    selected === MEMORY_KEY ? (
      <MemoryView notify={notify} />
    ) : selected === WIKI_KEY ? (
      <WikiView notify={notify} onOpenMemory={() => setSelected(MEMORY_KEY)} />
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
        {...chairActions}
      />
    );
  const memberActions: MemberActions = {
    onOpen: (id) => setModal({ kind: "member", id }),
    onMerge: async (id) => {
      if (!selected) return;
      try {
        const r = await api.merge(selected, id);
        notify(r.ok ? t("{id} 머지 완료", { id }) : t("충돌: {list}", { list: r.conflicts.join(", ") }));
      } catch (e) {
        notify((e as Error).message);
      }
    },
    onStop: async (id) => {
      if (!selected || !confirm(t("{id} 를 중지할까요?", { id }))) return;
      await api.stop(selected, id);
    },
    onRelay: (id) => setModal({ kind: "relay", id }),
    onHandover: (id) => setModal({ kind: "handover", id }),
  };

  const right = (
    <RightPane
      state={shownState}
      {...memberActions}
    />
  );

  if (IS_FLOAT) return <FloatingChair overview={overview} onPick={setSelected} state={shownState} chat={chat} subscribe={subscribeVision} onSend={send} chair={chairActions} toast={toast} />;

  return (
    <div className={`app ${mobile ? "mobile" : ""} ${mode.room !== "work" || mode.look !== "text" ? "is-vision" : ""}`}>
      {mode.room === "meeting" ? (
        <MeetingView
          look={mode.look}
          meeting={meeting}
          settings={meetingSettings}
          onSettings={async (patch) => {
            setMeetingSettings((cur) => ({ ...cur, ...patch }) as MeetingSettings);
            const r = await api.meetingSaveSettings(patch);
            setMeetingSettings(r.settings);
          }}
          loadModels={api.models}
          past={{
            list: async () => (await api.meetingList()).meetings,
            open: async (id) => (await api.meetingGet(id)).meeting,
            remove: async (id) => {
              await api.meetingDelete(id);
              setMeeting((cur) => (cur && cur.id === id ? null : cur));
            },
          }}
          usage={usage}
          onStart={async (topic) => {
            const r = await api.meetingStart(topic);
            setMeeting(r.meeting);
          }}
          onStop={async (id) => {
            const r = await api.meetingStop(id);
            if (r.meeting) setMeeting(r.meeting);
          }}
          onMode={setMode}
          onWorkshop={() => {
            setMode({ room: "work", look: "text" });
            setTab("center");
          }}
          notify={notify}
        />
      ) : mode.look === "avatar" ? (
        <AvatarView
          state={shownState}
          overview={overview}
          selected={selected}
          chat={chat}
          wsUp={wsUp}
          loading={loadingAgenda}
          firstTurn={firstTurn}
          usage={usage}
          onSelect={setSelected}
          onMode={setMode}
          onWorkshop={() => {
            setMode({ room: "work", look: "text" });
            setTab("center");
          }}
          notify={notify}
          onSettingsSaved={(m) => {
            notify(m);
            void refreshOverview();
            if (selected) void refreshState(selected);
          }}
          subscribe={subscribeVision}
          onSend={send}
          chair={chairActions}
          members={memberActions}
          projects={projectActions}
        />
      ) : mode.look === "vision" ? (
        <VisionView
          state={shownState}
          overview={overview}
          selected={selected}
          chat={chat}
          wsUp={wsUp}
          loading={loadingAgenda}
          firstTurn={firstTurn}
          usage={usage}
          onSelect={setSelected}
          onMode={setMode}
          onWorkshop={() => {
            setMode({ room: "work", look: "text" });
            setTab("center");
          }}
          notify={notify}
          onSettingsSaved={(m) => {
            notify(m);
            void refreshOverview();
            if (selected) void refreshState(selected);
          }}
          subscribe={subscribeVision}
          onSend={send}
          chair={chairActions}
          members={memberActions}
          projects={projectActions}
        />
      ) : mobile ? (
        <>
          <div className="mode-row">
            <ModeSwitch mode={mode} onChange={setMode} />
          </div>
          <div className="tabs">
            <button className={tab === "left" ? "on" : ""} onClick={() => setTab("left")}>{t("안건")}</button>
            <button className={tab === "center" ? "on" : ""} onClick={() => setTab("center")}>
              {t("의장")}{state?.agenda.waitingForUser && !state.chair.busy ? <span className="tab-ask" title={t("의장이 결정을 기다립니다")}>?</span> : null}
            </button>
            <button className={tab === "right" ? "on" : ""} onClick={() => setTab("right")}>
              {t("위원")}{state?.members.some((m) => m.status === "running") ? " ●" : ""}
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
      {modal?.kind === "folders" && (
        <FolderTidyModal
          agendaKey={modal.key}
          onClose={() => setModal(null)}
          onDone={(m) => {
            notify(m);
            void refreshState(modal.key);
          }}
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
