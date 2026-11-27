// The avatar mode's own settings, as in Agentg's avatar menu: the voice on or off, the chair's
// character fixed to another one, the click reaction lines, the speech bubbles, the model badge and
// whether the chair walks out in front of the desk. They are this viewer's choices, kept in the browser.
import { useCallback, useEffect, useRef, useState } from "react";
import { CAST, STANDING, type Character, type SeatId } from "./cast";
import type { Dance } from "./dance";
import { setLineLang, type Lang } from "./lines";
import { LANGS as APP_LANGS, getLang, setLang, useLang, useT } from "../i18n";

export type Seat = SeatId;

export interface AvatarPrefs {
  /** the recorded voices: the chair's lines (and, if memberVoice is on, the members') */
  voice: boolean;
  /** members say their start and finish lines aloud too */
  memberVoice: boolean;
  /** words nobody recorded — the chair's answers, the banter — read by the TTS (another voice) */
  readAloud: boolean;
  /** a short line in character when the chair is clicked */
  reactions: boolean;
  /** "auto": the company's character; otherwise this one, whoever is in the chair */
  character: "auto" | Seat;
  /** the chair's company character when the pick was made: a pick holds only while the chair stays with that company */
  characterFor?: string;
  bubbles: boolean;
  badge: boolean;
  /** stand up and walk out in front of the desk when clicked (characters with a full-body rig) */
  walkOut: boolean;
  /** the members on the desk: wander about (on), sit working and only walk over to report (min), or
   * sit still in one pose (off) */
  memberMotion: "on" | "min" | "off";
  /** the app's one language (kept by ../i18n, shared with the screens): the characters' lines,
   * recordings and voices follow it */
  lang: Lang;
}

const KEY = "gc.avatar.prefs";
const DEFAULTS: AvatarPrefs = { voice: true, memberVoice: false, readAloud: false, reactions: true, character: "auto", bubbles: true, badge: true, walkOut: true, memberMotion: "min", lang: "ko" };

/** who sits in the chair: the company's own character, or the one picked by hand while the chair is still with
 * the company it was picked under (a new chair from another company brings its own character back) */
export function chairFigure(prefs: AvatarPrefs, company: Character): Character {
  if (prefs.character === "auto") return company;
  // (a pick saved before picks were tied to a company counts as made under another one)
  if (prefs.characterFor !== company.name) return company;
  return { ...CAST[prefs.character], tint: company.tint };
}

export function useAvatarPrefs(): [AvatarPrefs, (patch: Partial<AvatarPrefs>) => void] {
  const [prefs, setPrefs] = useState<AvatarPrefs>(() => {
    try {
      return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AvatarPrefs>), lang: getLang() };
    } catch {
      return DEFAULTS;
    }
  });
  const lang = useLang();
  useEffect(() => {
    setLineLang(lang);
    setPrefs((cur) => (cur.lang === lang ? cur : { ...cur, lang }));
  }, [lang]);
  // another window of the same console changed them (the floating chair, loaded early and kept hidden,
  // follows the character picked in the main window)
  useEffect(() => {
    const fn = (e: StorageEvent) => {
      if (e.key !== KEY || e.newValue === null) return;
      try {
        setPrefs({ ...DEFAULTS, ...(JSON.parse(e.newValue) as Partial<AvatarPrefs>), lang: getLang() });
      } catch {
        /* keep what we have */
      }
    };
    window.addEventListener("storage", fn);
    return () => window.removeEventListener("storage", fn);
  }, []);
  const set = useCallback((patch: Partial<AvatarPrefs>) => {
    if (patch.lang) setLang(patch.lang);
    setPrefs((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  }, []);
  return [prefs, set];
}

/** each character's voice preset (Agentg's: Claude F1, GPT F2, Gemini F3, Grok F4, Dots F5); the TTS
 * takes it as "<language>_<preset>" */
export const VOICE: Record<Seat, string> = { claudechan: "F1", gpichan: "F2", gemmini: "F3", "grok-x": "F4", dotchan: "F5" };
export const LANGS: Array<[Lang, string]> = APP_LANGS;
/** the language a text is written in, for the TTS: Hangul is Korean, kana Japanese, else English */
export function langOf(text: string): Lang {
  if (/[가-힣]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  return /[a-z]/i.test(text) ? "en" : "ko";
}

/**
 * Speech, one line after another. `speaking` is the character talking now, so its mouth can move for
 * as long as the sound lasts. Lines that cannot be spoken (no TTS on the server, a browser that will not
 * play) are dropped quietly: the bubbles still say them.
 */
export function useVoice(enabled: boolean) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [speaking, setSpeaking] = useState<Seat | null>(null);
  /** the line being heard now: who, whether it is the chair's own, and the words to show in its bubble */
  const [heard, setHeard] = useState<{ id: number; chair: boolean; shown: string } | null>(null);
  const queue = useRef<Array<{ text: string; who: Seat; url?: string; chair: boolean; shown: string; id: number }>>([]);
  const lineId = useRef(0);
  const busy = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const on = useRef(enabled);
  on.current = enabled;

  useEffect(() => {
    let alive = true;
    fetch("/api/tts", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d: { available?: boolean }) => alive && setAvailable(Boolean(d.available)))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, []);

  const stop = useCallback(() => {
    queue.current = [];
    audio.current?.pause();
    audio.current = null;
    busy.current = false;
    setSpeaking(null);
    setHeard(null);
  }, []);
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  useEffect(() => stop, [stop]);

  const next = useCallback(async () => {
    if (busy.current) return;
    const line = queue.current.shift();
    if (!line) return;
    busy.current = true;
    // one sound to its end: false when it would not load or play
    const sound = (url: string) =>
      new Promise<boolean>((done) => {
        const a = new Audio(url);
        audio.current = a;
        setSpeaking(line.who);
        setHeard({ id: line.id, chair: line.chair, shown: line.shown });
        a.onended = () => done(true);
        a.onerror = () => done(false);
        a.play().catch(() => done(false));
      });
    const tts = async () => {
      const r = await fetch("/api/tts", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: line.text, voice: `${langOf(line.text)}_${VOICE[line.who]}` }) });
      if (!r.ok || !on.current) throw new Error(String(r.status));
      const url = URL.createObjectURL(await r.blob());
      await sound(url);
      URL.revokeObjectURL(url);
    };
    try {
      if (!on.current) throw new Error("off");
      // a recording not made yet (a language still being recorded) is read by the TTS when it may be
      if (line.url) {
        if (!(await sound(line.url)) && line.text && on.current) await tts();
      } else await tts();
    } catch {
      /* not spoken: the bubble is enough */
    } finally {
      audio.current = null;
      busy.current = false;
      setSpeaking(null);
      setHeard(null);
      if (queue.current.length) void next();
    }
  }, []);

  /** `as`: the chair's own words (its mouth moves for these only, not for a member of the same character);
   * `shown`: the words its bubble must show while this is heard */
  const say = useCallback(
    (text: string, who: Seat, as: { chair?: boolean; shown?: string } = {}) => {
      if (!on.current || available === false || !text.trim()) return;
      // a long backlog is not worth hearing: keep the newest few
      queue.current = [...queue.current, { text: text.slice(0, 300), who, chair: as.chair ?? false, shown: as.shown ?? "", id: ++lineId.current }].slice(-3);
      void next();
    },
    [available, next],
  );
  /** a recorded line; `text`, if given, is read by the TTS when the recording will not play */
  const play = useCallback(
    (url: string, who: Seat, text = "", as: { chair?: boolean; shown?: string } = {}) => {
      if (!on.current) return;
      queue.current = [...queue.current, { text: available === false ? "" : text.slice(0, 300), url, who, chair: as.chair ?? false, shown: as.shown ?? "", id: ++lineId.current }].slice(-3);
      void next();
    },
    [available, next],
  );
  return { available, speaking, heard, say, play, stop };
}

const SEATS: Seat[] = ["claudechan", "gpichan", "gemmini", "grok-x", "dotchan"];

/** the avatar part of the chair's menu: Agentg's avatar menu, for this page */
export function AvatarMenu({ prefs, set, current, company, voiceAvailable, onClearBubbles, dances, onDance, canStand, out, onWalkOut, onWalkBack }: { prefs: AvatarPrefs; set: (p: Partial<AvatarPrefs>) => void; current: Character; company?: Character; voiceAvailable: boolean | null; onClearBubbles: () => void; dances?: Dance[]; onDance?: (d: Dance) => void; canStand?: boolean; out?: boolean; onWalkOut?: () => void; onWalkBack?: () => void }) {
  const t = useT();
  const chip = (on: boolean, label: string, toggle: () => void, title?: string, disabled?: boolean) => (
    <button className={`av-chip ${on ? "on" : ""}`} onClick={toggle} title={title} disabled={disabled}>
      {on ? "●" : "○"} {label}
    </button>
  );
  return (
    <div className="av-menu">
      <div className="av-menu-head">{t("아바타")} · {current.name}</div>
      <div className="av-menu-row">
        {chip(prefs.voice, t("음성"), () => set({ voice: !prefs.voice }), t("녹음된 캐릭터 목소리로 의장이 알립니다 (결정 요청·종료 제안·완료·인사 등)"))}
        {chip(prefs.memberVoice, t("위원 음성"), () => set({ memberVoice: !prefs.memberVoice }), t("위원이 시작·완료·실패할 때 녹음된 목소리로 한마디"), !prefs.voice)}
        {chip(prefs.readAloud, t("답변·잡담 읽기"), () => set({ readAloud: !prefs.readAloud }), voiceAvailable === false ? t("서버에 TTS가 없어 쓸 수 없습니다") : t("녹음이 없는 말(의장 답변·혼잣말·대화)을 TTS로 읽습니다 — 녹음과 다른 목소리"), !prefs.voice || voiceAvailable === false)}
        {chip(prefs.reactions, t("반응 대사"), () => set({ reactions: !prefs.reactions }), t("누를 때 캐릭터가 한마디"))}
      </div>
      <div className="av-menu-row">
        {chip(prefs.bubbles, t("말풍선"), () => set({ bubbles: !prefs.bubbles }))}
        {chip(prefs.badge, t("모델 배지"), () => set({ badge: !prefs.badge }), t("머리 위 모델 이름"))}
        <button className="av-chip" onClick={onClearBubbles} title={t("떠 있는 말풍선을 모두 닫습니다")}>
          {t("말풍선 지우기")}
        </button>
      </div>
      <div className="av-menu-label">{t("위원 움직임")}</div>
      <div className="av-menu-row">
        {([
          ["on", "켜기", "책상 위를 이따금 돌아다닙니다"],
          ["min", "최소", "앉아서 일하다가 끝나면 의장에게 보고하러만 갑니다"],
          ["off", "끄기", "제자리에 앉아 같은 자세로 일만 합니다"],
        ] as const).map(([m, label, title]) => (
          <button key={m} className={`av-chip ${prefs.memberMotion === m ? "on" : ""}`} onClick={() => set({ memberMotion: m })} title={t(title)}>
            {t(label)}
          </button>
        ))}
      </div>
      <div className="av-menu-label">{t("언어")}</div>
      <div className="av-menu-row">
        {LANGS.map(([l, label]) => (
          <button key={l} className={`av-chip ${prefs.lang === l ? "on" : ""}`} onClick={() => set({ lang: l })} title={t("화면 글자와 캐릭터 대사·녹음 목소리의 언어 — 그 언어로 녹음된 대사가 아직 없으면 한국어로 말합니다")}>
            {label}
          </button>
        ))}
      </div>
      {canStand && (
        <>
          <div className="av-menu-label">{t("동작")}</div>
          <div className="av-menu-row">
            {out ? (
              <button className="av-chip" onClick={onWalkBack} title={t("책상 뒤 자리로 돌아갑니다")}>
                {t("↩ 자리로")}
              </button>
            ) : (
              <button className="av-chip" onClick={onWalkOut} title={t("일어나 책상 앞으로 나옵니다")}>
                {t("↗ 앞으로 나오기")}
              </button>
            )}
            {(dances ?? []).map((d) => (
              <button key={d.id} className="av-chip" onClick={() => onDance?.(d)} title={t("책상 앞으로 나와 춤춥니다 (소리는 음성 설정을 따릅니다)")}>
                ♪ {t(d.label)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="av-menu-label">{t("캐릭터")}</div>
      <div className="av-menu-row">
        <button className={`av-chip ${prefs.character === "auto" || (company && prefs.characterFor !== company.name) ? "on" : ""}`} onClick={() => set({ character: "auto", characterFor: undefined })} title={t("의장 회사의 캐릭터")}>
          {t("자동")}
        </button>
        {SEATS.map((r) => (
          <button key={r} className={`av-chip ${prefs.character === r && (!company || prefs.characterFor === company.name) ? "on" : ""}`} onClick={() => set({ character: r, characterFor: company?.name })} title={`${t(CAST[r].persona)}${STANDING[r] ? ` · ${t("전신 있음")}` : ""}`} style={{ "--c": `rgb(${CAST[r].tint.join(",")})` } as React.CSSProperties}>
            <img src={`/avatar/${r}/chibi-smile.webp?v=2`} alt="" />
            {CAST[r].name}
          </button>
        ))}
      </div>
    </div>
  );
}
