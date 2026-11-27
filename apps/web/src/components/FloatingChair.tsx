// The floating chair: the desktop app's small transparent, always-on-top window (/?float=1) that
// stands in for the main window while it is closed into the tray (whatever view it showed). The chair's bust, its
// latest words (or the question it waits on, or the latest member report) in a bubble, and the
// same input box as the avatar view, sending the same way (App's send / chair actions).
import { useEffect, useMemo, useRef, useState } from "react";
import { Bust } from "./AvatarView";
import { Composer } from "../vision/Console";
import type { ChairActions, SendFn } from "../vision/actions";
import type { VisionEvent } from "../vision/renderer";
import { chairCast } from "../avatar/cast";
import { chairFigure, useAvatarPrefs } from "../avatar/settings";
import { memberName, prettyModel } from "../model";
import { desktop, inDesktop } from "../desktop";
import { t, useT } from "../i18n";
import { useFloatLink, type FloatMsg } from "../avatar/floatLink";
import type { AgendaOv, ChatItem, Overview, RuntimeState } from "../types";
import "../vision/vision.css";
import "../avatar/avatar.css";
import "./float.css";

interface Props {
  overview: Overview | null;
  /** follow another agenda (a line of the reminder) */
  onPick: (key: string) => void;
  state: RuntimeState | null;
  chat: ChatItem[];
  subscribe: (fn: (e: VisionEvent) => void) => () => void;
  onSend: SendFn;
  chair: ChairActions;
  /** the app's latest notice (an error sending, …) */
  toast: string;
}

interface Said {
  key: string;
  text: string;
  /** the question the chair waits on */
  ask: boolean;
  dots: boolean;
  /** when it was said (ms), to tell whether a member's report came after it */
  at: number;
}

interface MemberReport {
  at: number;
  who: string;
  text: string;
  ok?: boolean;
}

function plain(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** what the chair says now: the question it waits on, else its last answer (dots while it works) */
function chairSaid(state: RuntimeState | null, chat: ChatItem[]): Said | null {
  if (!state) return null;
  const busy = state.chair.busy;
  const ask = state.agenda.waitingForUser && !busy && state.agenda.status !== "closed" ? state.agenda.waitingForUser : undefined;
  if (ask) return { key: `ask${ask.at}`, text: plain(ask.question, 600), ask: true, dots: false, at: Date.parse(ask.at) || 0 };
  let said = -1;
  let asked = -1;
  for (let i = chat.length - 1; i >= 0 && (said < 0 || asked < 0); i--) {
    if (said < 0 && chat[i].role === "assistant" && chat[i].text.trim()) said = i;
    if (asked < 0 && (chat[i].role === "user" || chat[i].role === "event")) asked = i;
  }
  if (said < 0 || (busy && said < asked)) return busy ? { key: "thinking", text: "", ask: false, dots: true, at: Date.now() } : null;
  return { key: `c${chat[said].id}`, text: plain(chat[said].text, 600), ask: false, dots: busy, at: Date.parse(chat[said].ts) || 0 };
}

export function FloatingChair({ overview, onPick, state, chat, subscribe, onSend, chair, toast }: Props) {
  const t = useT();
  const [prefs] = useAvatarPrefs();
  const company = chairCast(state?.chair.provider, state?.chair.model);
  const who = chairFigure(prefs, company);
  const chairName = state ? (prettyModel(state.chair.modelId ?? state.chair.model) ?? t("의장")) : t("의장");
  const busy = state?.chair.busy ?? false;
  const said = useMemo(() => chairSaid(state, chat), [state, chat]);

  // the window's size (fixed by the app, but a browser tab of /?float=1 can be anything)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const fn = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  // the latest member report (assigned, a sentence of its log, done), from the same events the avatar view uses
  const [report, setReport] = useState<MemberReport | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== "assign" && e.type !== "line" && e.type !== "done") return;
        const m = stateRef.current?.members.find((x) => x.id === e.member);
        const name = m ? memberName(m) : (e.type !== "line" && e.name) || e.member;
        if (e.type === "assign") {
          const task = stateRef.current?.tasks.find((t) => t.id === e.taskId)?.title;
          setReport({ at: Date.now(), who: name, text: t("시작: {task}", { task: plain(task ?? t("작업을 시작합니다"), 160) }) });
        } else if (e.type === "done") {
          const text = e.summary?.trim() || (e.ok === false ? t("작업이 중단되었습니다") : t("작업을 마쳤습니다"));
          setReport({ at: Date.now(), who: name, text: plain(text, 220), ok: e.ok });
        } else {
          const raw = (e.text ?? "").trim();
          if (!raw || /^tool\s+/.test(raw)) return; // tool calls would flicker by too fast to read
          setReport({ at: Date.now(), who: name, text: plain(raw, 200) });
        }
      }),
    [subscribe],
  );
  const showReport = report && !said?.ask && (!said || report.at > said.at) ? report : null;

  // the chair's short lines from the avatar view in the main window (an order taken, all done, the
  // agenda closed, a decision waited on, …), word for word, and whether its voice is heard there: the
  // sound stays in the main window, this one only shows the words and moves the mouth
  const [line, setLine] = useState<{ id: string; text: string; ms: number } | null>(null);
  const [lineUp, setLineUp] = useState(false);
  const [main, setMain] = useState<{ talk: boolean; voice: boolean } | null>(null);
  const link = useFloatLink((m: FloatMsg) => {
    if (m.type === "say") {
      setLine((cur) => (cur?.id === m.id && cur.text === m.text ? cur : { id: m.id, text: m.text, ms: m.ms }));
      setMain((cur) => ({ talk: cur?.talk ?? false, voice: m.voice }));
    } else if (m.type === "talk") setMain({ talk: m.on, voice: m.voice });
  });
  useEffect(() => {
    if (!line) return;
    setLineUp(true);
    const t = window.setTimeout(() => setLineUp(false), line.ms);
    return () => clearTimeout(t);
  }, [line]);
  // up for its time, and for as long as it is still being heard
  const shownLine = line && (lineUp || main?.talk) ? line : null;

  // the mouth: while the main window's voice is heard, or (with its sound off) while a short line is up.
  // With no main window to hear from (a browser tab of /?float=1), for a while when new words come in.
  const [wordsTalk, setWordsTalk] = useState(false);
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const key = said?.text ? said.key : null;
    const first = seen.current === undefined;
    if (key === seen.current) return;
    seen.current = key;
    if (first || !key || !said) return;
    setWordsTalk(true);
    const t = window.setTimeout(() => setWordsTalk(false), Math.min(9000, Math.max(1400, said.text.length * 55)));
    return () => clearTimeout(t);
  }, [said]);
  const talking = main ? main.talk || (Boolean(shownLine) && !main.voice) : wordsTalk;

  // the input box: folded to a button, opened by it or by a question waiting for an answer
  const [open, setOpen] = useState(false);
  const askKey = said?.ask ? said.key : null;
  useEffect(() => {
    if (askKey) setOpen(true);
  }, [askKey]);

  // a press on the chair picks the window up (as Tauri's own drag regions do: the drag starts on the
  // press, the system's move loop ends it on release); the second press of a double click brings the
  // main window back instead. In a browser tab there is no window to move: a click just pokes.
  const [poked, setPoked] = useState(0);
  const restore = () => desktop("float_restore");
  const on = {
    onMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.detail >= 2) {
        restore();
        return;
      }
      setPoked((n) => n + 1);
      desktop("float_drag");
    },
    onDoubleClick: restore,
  };

  // a right click anywhere on the window opens the app's small menu (메인 열기 / 잠시 숨기기 / 플로팅
  // 끄기) instead of the browser's; in the input box the browser's edit menu (paste, …) stays
  const desk = inDesktop();
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, input, [contenteditable='true']")) return;
      e.preventDefault();
      if (desk) desktop("float_menu");
    };
    document.addEventListener("contextmenu", fn);
    return () => document.removeEventListener("contextmenu", fn);
  }, [desk]);

  // the reminder: one line per open agenda (what it is on, how far along)
  const [remind, setRemind] = useState(false);

  // the bust stands on the bottom edge and fills most of the height; the bubble sits over its head
  const bustH = Math.round(size.h * 0.66);
  const bustW = Math.round((who.canvas[0] / who.canvas[1]) * bustH);
  const box = { x: Math.round((size.w - bustW) / 2), y: size.h - bustH, w: bustW, h: bustH };

  return (
    <div className={`vz av fc ${open ? "fc-open" : ""}`} style={{ "--halo": `rgb(${company.tint.join(",")})` } as React.CSSProperties}>
      <Bust cast={who} talking={talking} thinking={busy} poked={poked} on={on} box={box} />
      <div className="fc-top">
        {(said || showReport || shownLine) && (
          <div className={`fc-say ${said?.ask ? "ask" : ""}`} onDoubleClick={restore}>
            {shownLine && (
              <div className="fc-say-chair fc-say-line" key={shownLine.id}>
                <span className="av-say-tag">{chairName}</span>
                <span className="fc-say-text">{shownLine.text}</span>
              </div>
            )}
            {said && (said.ask || !shownLine) && (said.text || said.dots) && (
              <div className="fc-say-chair">
                <span className="av-say-tag">{said.ask ? t("결정 대기") : chairName}</span>
                {said.text && <span className="fc-say-text">{said.text}</span>}
                {said.dots && (
                  <span className="vz-dots" aria-label={t("생각 중")}>
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
            )}
            {showReport && (
              <div className={`fc-report ${showReport.ok === false ? "fail" : ""}`}>
                <b>{showReport.who}</b> {showReport.text}
              </div>
            )}
          </div>
        )}
        {toast && <div className="fc-toast">{toast}</div>}
      </div>
      {remind && <Reminder overview={overview} current={state?.key} onPick={(k) => { onPick(k); setRemind(false); }} onClose={() => setRemind(false)} />}
      <div className="fc-tools">
        <button className="fc-remind" title={t("리마인더: 진행 중인 안건 한 줄씩")} onClick={() => setRemind((v) => !v)}>
          !
        </button>
        {desk && (
          <button title={t("메인 창 열기 (의장을 더블클릭해도 됩니다)")} onClick={restore}>
            ⤢
          </button>
        )}
        {desk && (
          <button title={t("잠시 숨기기 (다음에 창을 닫으면 다시 뜹니다. 끄려면 우클릭 → 플로팅 끄기)")} onClick={() => desktop("float_hide")}>
            ✕
          </button>
        )}
      </div>
      <footer className="fc-bottom">
        {open ? (
          <div className="vz-float">
            <Composer
              state={state}
              compact
              onSend={(...args) => {
                link.sent();
                return onSend(...args);
              }}
              chair={chair}
            />
            <button className="fc-fold" title={t("입력창 접기")} onClick={() => setOpen(false)}>
              ▾
            </button>
          </div>
        ) : (
          <button className="fc-talk" title={t("의장에게 말하기")} onClick={() => setOpen(true)}>
            💬
          </button>
        )}
      </footer>
    </div>
  );
}

interface Line {
  a: AgendaOv;
  project: string;
}

function lineState(a: AgendaOv): { label: string; cls: string } {
  if (a.waitingForUser && !a.chairBusy) return { label: t("결정 대기"), cls: "ask" };
  if (a.running > 0 || a.chairBusy) return { label: t("진행중"), cls: "run" };
  if (a.taskCounts.total > 0 && a.taskCounts.done === a.taskCounts.total) return { label: t("마무리 대기"), cls: "idle" };
  return { label: t("대기"), cls: "idle" };
}

/** the open agendas of every project, one line each: busy ones first, then those waiting on you */
export function Reminder({ overview, current, onPick, onClose }: { overview: Overview | null; current?: string; onPick: (key: string) => void; onClose: () => void }) {
  const t = useT();
  const lines: Line[] = (overview?.projects ?? []).flatMap((p) => p.agendas.filter((a) => a.status !== "closed").map((a) => ({ a, project: p.name })));
  const rank = (a: AgendaOv) => (a.running > 0 || a.chairBusy ? 0 : a.waitingForUser ? 1 : 2);
  lines.sort((x, y) => rank(x.a) - rank(y.a));
  return (
    <div className="fc-remind-page" onMouseDown={(e) => e.stopPropagation()}>
      <div className="fc-remind-head">
        <b>{t("리마인더")}</b>
        <span>{t("진행 중")} {lines.length}</span>
        <button title={t("닫기")} onClick={onClose}>✕</button>
      </div>
      <ul>
        {lines.length === 0 && <li className="fc-remind-empty">{t("진행 중인 안건이 없습니다")}</li>}
        {lines.map(({ a, project }) => {
          const st = lineState(a);
          return (
            <li key={a.key} className={a.key === current ? "on" : ""} title={`${project} · ${a.title}${a.now ? `\n${t("지금: {now}", { now: a.now })}` : ""}\n${t("클릭하면 이 안건을 봅니다")}`} onClick={() => onPick(a.key)}>
              <span className={`fc-remind-dot ${st.cls}`} />
              <span className="fc-remind-text">
                <b>{a.title}</b>
                {a.now && <span className="fc-remind-now"> {a.now}</span>}
                <span className={`fc-remind-st ${st.cls}`}> {st.label}</span>
              </span>
              <span className="fc-remind-n">{a.taskCounts.done}/{a.taskCounts.total}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
