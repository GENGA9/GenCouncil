import { t, useT } from "../i18n";

/**
 * The app's screens are two choices made apart: the room (what is handled: the workshop, where the
 * agenda's work is done, or the meeting room, where the members talk a topic over) and the look (how
 * it is shown: the picture of the council, the avatars, or plain text).
 */
export type Room = "work" | "meeting";
export type Look = "vision" | "avatar" | "text";
export interface Mode {
  room: Room;
  look: Look;
}

const ROOM_KEY = "gc.room";
const LOOK_KEY = "gc.look";
/** the one-switch setting before the two were split */
const OLD_KEY = "gc.mode";

export function readMode(): Mode {
  try {
    const room = localStorage.getItem(ROOM_KEY);
    const look = localStorage.getItem(LOOK_KEY);
    if ((room === "work" || room === "meeting") && (look === "vision" || look === "avatar" || look === "text")) return { room, look };
    const old = localStorage.getItem(OLD_KEY);
    if (old === "vision" || old === "avatar") return { room: "work", look: old };
    if (old === "meeting") return { room: "meeting", look: "avatar" };
  } catch {
    /* private mode */
  }
  return { room: "work", look: "text" };
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(ROOM_KEY, mode.room);
    localStorage.setItem(LOOK_KEY, mode.look);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

const ROOMS: Array<[Room, string, string, string]> = [
  ["work", "▤", "작업실", "안건을 의장과 위원들이 처리하는 곳"],
  ["meeting", "◎", "회의실", "주제를 던지면 위원들이 의견을 내고 토론하고, 의장이 결론을 정리하는 곳"],
];
const LOOKS: Array<[Look, string, string, string]> = [
  ["vision", "✦", "시각화", "그림으로 봅니다"],
  ["avatar", "☕", "아바타", "캐릭터들로 봅니다"],
  ["text", "≡", "텍스트", "글로만 봅니다"],
];

/** the button's own short name (the screens are narrow on a phone); the full name stays in the tooltip */
const short = (label: string) => {
  const s = t(`모드:${label}`);
  return s.startsWith("모드:") ? t(label) : s;
};

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  useT();
  return (
    <div className="mode-switch" aria-label={t("화면 모드")}>
      <span className="ms-group" role="tablist" aria-label={t("방")}>
        {ROOMS.map(([room, icon, label, title]) => (
          <button key={room} role="tab" aria-selected={mode.room === room} className={mode.room === room ? "on" : ""} onClick={() => onChange({ ...mode, room })} title={`${t(label)}: ${t(title)}`}>
            <i className="ms-icon">{icon}</i>
            <span className="ms-label">{short(label)}</span>
          </button>
        ))}
      </span>
      <span className="ms-sep" aria-hidden />
      <span className="ms-group" role="tablist" aria-label={t("보기")}>
        {LOOKS.map(([look, icon, label, title]) => (
          <button key={look} role="tab" aria-selected={mode.look === look} className={`look ${mode.look === look ? "on" : ""}`} onClick={() => onChange({ ...mode, look })} title={`${t(label)}: ${t(title)}`}>
            <i className="ms-icon">{icon}</i>
            <span className="ms-label">{short(label)}</span>
          </button>
        ))}
      </span>
    </div>
  );
}
