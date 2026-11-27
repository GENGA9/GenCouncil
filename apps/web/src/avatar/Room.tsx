// The chair's study, painted by a GPT member (Codex image generation) and cut into layers
// (public/avatar/study, sizes in study.json): the room with its window glass taken out, the view
// through the window for each season by day and by night, and the desk, drawn in front of the chair.
// The world is the painting's own pixels. The season and the time of day follow the computer's clock,
// and so does the wall clock, whose hands are drawn here over a fresh face. The clock and the lamp
// are placed by hand on this painting (scripts/avatar-study paints and cuts it): measure them again
// after a repaint.
import { memo, useEffect, useState } from "react";
import STUDY from "./study.json";
import { t as tr, useLang } from "../i18n";

export const WORLD_W = STUDY.w;
export const WORLD_H = STUDY.h;
/** where the desk's surface meets the wall: the chair is hidden below this line */
export const DESK_Y = STUDY.deskY;
/** the desk's front edge: members stand between DESK_Y and here */
export const DESK_FRONT = STUDY.deskFront;
/** the zoomed-out painting of the same room (ceiling, the desk's ends and legs, the floor and rug), in world units */
export const WIDE = STUDY.wide ?? { x: 0, y: 0, w: WORLD_W, h: WORLD_H };
// measured by hand on the zoomed-out painting
/** the bottom of the desk's front panel: below it the floor shows between the legs */
export const DESK_PANEL_BOTTOM = 1017;
/** where one standing behind the desk has their feet, and one standing on the rug in front of it */
export const FLOOR_BACK = 1190;
export const FLOOR_FRONT = 1400;

export type Season = "spring" | "summer" | "autumn" | "winter";
export type DayTime = "day" | "dusk" | "night";

export const seasonOf = (month: number): Season => (month >= 2 && month <= 4 ? "spring" : month >= 5 && month <= 7 ? "summer" : month >= 8 && month <= 10 ? "autumn" : "winter");
export const timeOf = (hour: number): DayTime => (hour >= 7 && hour < 17 ? "day" : (hour >= 17 && hour < 19) || (hour >= 5 && hour < 7) ? "dusk" : "night");

const art = (file: string) => `/avatar/study/${file}.webp?v=${STUDY.rev}`;
const [WX, WY, WW, WH] = STUDY.window;

/** the view a season and time has, or the nearest one painted */
function viewFile(season: Season, time: DayTime): string {
  const want = `${season}-${time === "night" ? "night" : "day"}`;
  if (STUDY.views.includes(want)) return `view-${want}`;
  const same = STUDY.views.find((v) => v.endsWith(time === "night" ? "-night" : "-day")) ?? STUDY.views[0];
  return `view-${same}`;
}

/** the painted wall clock gets a clean face and hands that keep the computer's time */
function Clock() {
  useLang();
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const h = t.getHours() % 12;
  const m = t.getMinutes();
  const s = t.getSeconds();
  const R = ["XII", "I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
  return (
    <svg className="av-clock" viewBox="-60 -60 120 120" style={{ left: 481.5 - 60, top: 198.5 - 60, width: 120, height: 120 }} aria-label={tr("{h}시 {m}분", { h: t.getHours(), m })}>
      <defs>
        <radialGradient id="av-face" cx="0.45" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#f8eed8" />
          <stop offset="1" stopColor="#e6d4ae" />
        </radialGradient>
      </defs>
      <circle r={53} fill="url(#av-face)" />
      <circle r={47.5} fill="none" stroke="#5a3a22" strokeWidth={0.8} />
      <circle r={45.5} fill="none" stroke="#5a3a22" strokeWidth={0.5} strokeDasharray="0.8 2.2" />
      {R.map((n, i) => {
        const a = (i * Math.PI) / 6;
        return (
          <text key={n} x={Math.sin(a) * 38} y={-Math.cos(a) * 38 + 4} textAnchor="middle" fontSize={11} fontFamily="'Times New Roman', Georgia, serif" fontWeight={600} fill="#2a1a10" transform={`rotate(${i * 30} ${Math.sin(a) * 38} ${-Math.cos(a) * 38})`}>
            {n}
          </text>
        );
      })}
      <line x1={0} y1={4} x2={0} y2={-21} stroke="#1e130b" strokeWidth={3.4} strokeLinecap="round" transform={`rotate(${h * 30 + m / 2})`} />
      <line x1={0} y1={5} x2={0} y2={-31} stroke="#1e130b" strokeWidth={2.2} strokeLinecap="round" transform={`rotate(${m * 6 + s / 10})`} />
      <line x1={0} y1={7} x2={0} y2={-33} stroke="#a3322a" strokeWidth={0.9} strokeLinecap="round" transform={`rotate(${s * 6})`} />
      <circle r={3.6} fill="#b68a3a" stroke="#6b4b1c" strokeWidth={0.8} />
    </svg>
  );
}

/** the room behind the chair: the view outside, the room, the clock, and the light of the hour */
export const Study = memo(function Study({ season, time, onMissing }: { season: Season; time: DayTime; onMissing: () => void }) {
  return (
    <>
      {STUDY.wide && <img className="av-wide" src={art("wide")} alt="" draggable={false} style={{ left: WIDE.x, top: WIDE.y, width: WIDE.w, height: WIDE.h }} />}
      <div className={`av-view ${time}`} style={{ left: WX - 4, top: WY - 4, width: WW + 8, height: WH + 8 }}>
        <img src={art(viewFile(season, time))} alt="" draggable={false} />
      </div>
      <img className="av-room" src={art("room")} alt="" draggable={false} width={WORLD_W} height={WORLD_H} onError={onMissing} />
      <Clock />
    </>
  );
});

/** the desk, in front of the chair, and the light of the hour over everything but the members */
export function DeskFront({ time }: { time: DayTime }) {
  return (
    <>
      <img className="av-desk-art" src={art("desk")} alt="" draggable={false} style={{ top: STUDY.deskTop, width: WORLD_W }} />
      {/* the light of the hour over the room, the chair and the desk; the brass lamp glows after dark */}
      <div className={`av-light ${time}`} style={{ left: WIDE.x, top: WIDE.y, width: WIDE.w, height: WIDE.h }} />
      {time !== "day" && <div className="av-lamp" style={{ left: 1424, top: 612 }} />}
    </>
  );
}

export const roomArt = art(STUDY.wide ? "wide" : "room");
