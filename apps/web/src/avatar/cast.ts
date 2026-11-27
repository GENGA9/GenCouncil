// Who plays whom in the avatar mode: one character per company (the Agentg characters), each with
// the manner of speaking of its Agentg persona. The art lives in public/avatar/<rig>/ (built from
// the Agentg rigs and chibi stickers), so a checkout without it still works: the picture falls back
// to coloured shapes.
import type { Member } from "../types";
import { familyOf } from "../model";
import { TINT, type Rgb } from "../vision/scene";
import type { ChestRegion, Iris } from "./chest";
import type { Dance } from "./dance";
import EXPR from "./expressions.json";
import { t } from "../i18n";

/**
 * A rig's expressions (Agentg's rig.json, brought in by scripts/avatar-study/import-agentg.py): the
 * states each face layer has (a patch per state, <layer>-<state>.webp), the mouth sets a voice moves
 * through, and where the layers sit on the app's art.
 */
export interface Expr {
  regions: { eyes: number[]; mouth: number[]; skin: number[] };
  states: { eyes: string[]; mouth: string[]; skin: string[] };
  sets: Record<string, string[]>;
  chest: Array<{ x: number; y: number; rx: number; ry: number; focus: number[]; max: number }>;
  anchor?: number[];
  top?: number;
}

export type SeatId = "claudechan" | "gpichan" | "gemmini" | "grok-x" | "dotchan";
export type RigId = SeatId | `${SeatId}-full`;

export interface Character {
  rig: RigId;
  /** the character's own name */
  name: string;
  /** the Agentg persona it speaks as */
  persona: string;
  /** the colour of its company in the visualization: the chair's halo, a member's name tag */
  tint: Rgb;
  lines: { start: string[]; done: string[]; fail: string[]; idle: string[] };
  /** the bust art's size: the rig's 832 × 1216, or wider where the arms were painted whole */
  canvas: [number, number];
  /** where the face sits on the bust art (from the rig, moved by any widening): eyes and mouth patches */
  eyes: [number, number, number, number];
  mouth: [number, number, number, number];
  /** Agentg's physics.json: the two chest regions that swing (screen left, right), on the art */
  chest?: [ChestRegion, ChestRegion];
  /** full-body art: where the feet stand (x, y) and the top of the head, on the art */
  anchor?: [number, number];
  top?: number;
  /** where the irises are on the art, so the eyes can look about */
  irises?: [Iris, Iris];
  /** dances it can do when standing (videos of it, cut out of their background) */
  dances?: Dance[];
  /** its expressions, when the rig has them */
  expr?: Expr;
}

const GROK_TINT: Rgb = [236, 214, 150];

export const CAST: Record<SeatId, Character> = {
  claudechan: {
    rig: "claudechan",
    irises: [{ x: 490, y: 388, rx: 21, ry: 23 }, { x: 632, y: 339, rx: 23, ry: 26 }],
    chest: [{ x: 496, y: 850, rx: 75, ry: 68, focus: [484, 864], max: 36 }, { x: 702, y: 850, rx: 78, ry: 68, focus: [716, 864], max: 36 }],
    name: "클로드",
    // widened by 192 on each side, the cut-off arms painted whole (scripts/avatar-study/widen.py)
    canvas: [1216, 1216],
    persona: "다정한 비서",
    tint: TINT.claude,
    eyes: [240 + 192, 296, 248, 140],
    mouth: [340 + 192, 440, 108, 56],
    lines: {
      start: ["네, 제가 맡을게요.", "차근차근 해 볼게요.", "바로 시작할게요. 맡겨 주세요."],
      done: ["다 했어요. 확인해 주실래요?", "끝났어요! 정리해 두었어요.", "마쳤어요. 수고 많으셨어요."],
      fail: ["앗, 막혔어요. 같이 원인부터 볼까요?", "죄송해요, 여기서 멈췄어요."],
      idle: ["오늘도 차근차근 해 봐요.", "조금만 더 하면 돼요.", "차 한 잔 하면서 볼게요."],
    },
  },
  gpichan: {
    rig: "gpichan",
    irises: [{ x: 364, y: 376, rx: 25, ry: 16 }, { x: 509, y: 396, rx: 22, ry: 16 }],
    chest: [{ x: 458, y: 926, rx: 94, ry: 115, focus: [440, 947], max: 36 }, { x: 670, y: 930, rx: 102, ry: 112, focus: [691, 951], max: 36 }],
    canvas: [832, 1216],
    name: "지피티",
    persona: "간결한 보고형",
    tint: TINT.gpt,
    eyes: [292, 336, 288, 88],
    mouth: [384, 464, 96, 60],
    lines: {
      start: ["확인했습니다. 착수합니다.", "작업 시작합니다.", "준비됐습니다."],
      done: ["완료했습니다. 보고드립니다.", "끝났습니다. 검토 바랍니다."],
      fail: ["중단됐습니다. 원인 확인 필요.", "실패했습니다. 보고드립니다."],
      idle: ["진행 중입니다.", "이상 없습니다.", "다음 단계 확인 중."],
    },
  },
  gemmini: {
    rig: "gemmini",
    irises: [{ x: 335, y: 399, rx: 22, ry: 12 }, { x: 493, y: 394, rx: 22, ry: 12 }],
    chest: [{ x: 300, y: 994, rx: 94, ry: 126, focus: [283, 1018], max: 36 }, { x: 527, y: 992, rx: 105, ry: 128, focus: [548, 1018], max: 36 }],
    canvas: [832, 1216],
    name: "제미나이",
    persona: "쾌활한 후배",
    tint: TINT.gemini,
    eyes: [248, 352, 344, 80],
    mouth: [352, 460, 136, 84],
    lines: {
      start: ["네! 바로 할게요, 선배!", "맡겨만 주세요!", "앗, 제 차례예요? 갑니다!"],
      done: ["선배, 다 했어요! 칭찬해 주세요!", "끝! 완전 깔끔하게 했어요!"],
      fail: ["으앗, 망했어요… 다시 볼게요!", "선배, 여기 좀 도와주세요!"],
      idle: ["으쌰으쌰!", "이거 재밌는데요?", "잠깐 기지개 켜고 힘내요!"],
    },
  },
  "grok-x": {
    rig: "grok-x",
    irises: [{ x: 354, y: 334, rx: 19, ry: 14 }, { x: 498, y: 346, rx: 20, ry: 13 }],
    chest: [{ x: 327, y: 920, rx: 92, ry: 113, focus: [310, 944], max: 36 }, { x: 548, y: 924, rx: 98, ry: 113, focus: [568, 947], max: 36 }],
    canvas: [832, 1216],
    name: "그록",
    persona: "장난스러운 친구",
    tint: GROK_TINT,
    eyes: [276, 280, 284, 100],
    mouth: [360, 408, 124, 72],
    lines: {
      start: ["오케이, 나한테 맡겨.", "좋아, 재밌겠다.", "응, 금방 할게."],
      done: ["끝! 어때, 나 좀 하지?", "다 했어. 놀랐지?"],
      fail: ["어라, 꼬였네. 다시 볼게.", "에이, 이건 좀 막혔어."],
      idle: ["흠, 이거 재밌네.", "잠깐 딴짓 아니야, 생각 중이야.", "다들 바쁘네~"],
    },
  },
  dotchan: {
    rig: "dotchan",
    irises: [{ x: 361, y: 295, rx: 20, ry: 15 }, { x: 478, y: 280, rx: 18, ry: 14 }],
    chest: [{ x: 320, y: 780, rx: 74, ry: 73, focus: [306, 795], max: 30 }, { x: 574, y: 789, rx: 75, ry: 61, focus: [588, 799], max: 30 }],
    canvas: [832, 1216],
    name: "닷츠",
    persona: "차분한 집사",
    tint: TINT.relay,
    eyes: [296, 240, 244, 88],
    mouth: [384, 352, 88, 60],
    lines: {
      start: ["분부대로 하겠습니다.", "차분히 진행하겠습니다."],
      done: ["마쳤습니다. 살펴봐 주십시오.", "말씀하신 일을 끝냈습니다."],
      fail: ["송구합니다. 진행이 막혔습니다.", "여기서 멈추었습니다. 지시를 기다리겠습니다."],
      idle: ["차분히 진행하고 있습니다.", "곁에 있겠습니다."],
    },
  },
};

/**
 * Characters who can stand up and walk out in front of the desk: their full-body rig (Agentg's
 * "-full" rigs: 832 × 1664, the feet at each rig's anchor), with their eyes, chest and dances.
 */
export const FULL_FEET = 1645;
/** where a full-body art's feet stand and where its head starts (Claude's when a rig does not say) */
export const feetOf = (c: Character): [number, number] => c.anchor ?? [416, FULL_FEET];
export const topOf = (c: Character): number => c.top ?? 24;
export const STANDING: Partial<Record<RigId, Character>> = {
  claudechan: { ...CAST.claudechan, rig: "claudechan-full", canvas: [832, 1664], eyes: [348, 208, 136, 56], mouth: [388, 272, 56, 36],
    irises: [{ x: 379, y: 236, rx: 13, ry: 15 }, { x: 457, y: 236, rx: 13, ry: 15 }],
    dances: [{ id: "dance1", label: "댄스1", src: "/avatar/claudechan-full/dance1.mp4?v=6", w: 1216, h: 1968, feet: [640, 1909], height: 1757 }, { id: "dance2", label: "댄스2", src: "/avatar/claudechan-full/dance2.mp4?v=1", w: 1216, h: 2112, feet: [636, 1992], height: 1628 }],
    chest: [{ x: 349, y: 508, rx: 65, ry: 62, focus: [326, 526], max: 34 }, { x: 483, y: 508, rx: 65, ry: 62, focus: [506, 526], max: 34 }] },
  gpichan: { ...CAST.gpichan, rig: "gpichan-full", canvas: [832, 1664], eyes: [332,248,140,56], mouth: [384,312,56,32], anchor: [405,1622], top: 125,
    irises: [{ x: 365, y: 285, rx: 12, ry: 8 }, { x: 437, y: 271, rx: 13, ry: 9 }],
    dances: [{ id: "dance1", label: "댄스1", src: "/avatar/gpichan-full/dance1.mp4?v=4", w: 1216, h: 2112, feet: [638, 1997], height: 1793 }, { id: "dance2", label: "댄스2", src: "/avatar/gpichan-full/dance2.mp4?v=1", w: 560, h: 938, feet: [341, 922], height: 791 }],
    chest: [{ x: 392, y: 503, rx: 49, ry: 50, focus: [378, 518], max: 28 }, { x: 491, y: 503, rx: 48, ry: 50, focus: [505, 518], max: 28 }] },
  gemmini: { ...CAST.gemmini, rig: "gemmini-full", canvas: [832, 1664], eyes: [340,176,176,64], mouth: [384,236,68,48], anchor: [427,1645], top: 11,
    irises: [{ x: 385, y: 199, rx: 14, ry: 7 }, { x: 462, y: 216, rx: 12, ry: 7 }],
    dances: [{ id: "dance1", label: "댄스1", src: "/avatar/gemmini-full/dance1.mp4?v=4", w: 1208, h: 2030, feet: [630, 2013], height: 1855 }, { id: "dance2", label: "댄스2", src: "/avatar/gemmini-full/dance2.mp4?v=1", w: 580, h: 908, feet: [298, 875], height: 756 }],
    chest: [{ x: 383, y: 506, rx: 72, ry: 72, focus: [363, 528], max: 36 }, { x: 527, y: 508, rx: 72, ry: 72, focus: [547, 530], max: 36 }] },
  "grok-x": { ...CAST["grok-x"], rig: "grok-x-full", canvas: [832, 1664], eyes: [364,172,144,52], mouth: [404,228,68,36], anchor: [428,1655], top: 36,
    irises: [{ x: 387, y: 207, rx: 12, ry: 7 }, { x: 466, y: 190, rx: 12, ry: 7 }],
    dances: [{ id: "dance1", label: "댄스1", src: "/avatar/grok-x-full/dance1.mp4?v=1", w: 1216, h: 2054, feet: [733, 1951], height: 1745 }, { id: "dance2", label: "댄스2", src: "/avatar/grok-x-full/dance2.mp4?v=1", w: 590, h: 930, feet: [349, 897], height: 770 }],
    chest: [{ x: 372, y: 500, rx: 60, ry: 58, focus: [354, 517], max: 32 }, { x: 520, y: 500, rx: 46, ry: 58, focus: [534, 517], max: 32 }] },
  dotchan: { ...CAST.dotchan, rig: "dotchan-full", canvas: [832, 1664], eyes: [356,180,140,48], mouth: [412,252,44,20], anchor: [423,1625], top: 45,
    irises: [{ x: 390, y: 199, rx: 11, ry: 7 }, { x: 461, y: 199, rx: 11, ry: 7 }],
    chest: [{ x: 350, y: 472, rx: 58, ry: 56, focus: [336, 489], max: 30 }, { x: 500, y: 472, rx: 60, ry: 56, focus: [514, 489], max: 30 }] },
};

// every rig takes its face regions and expressions from Agentg's data (Grok's bust and Dots' full body
// were remade there); Dots' full body its feet, head and chest too
for (const c of [...Object.values(CAST), ...Object.values(STANDING)] as Character[]) {
  const e = (EXPR as Record<string, Expr>)[c.rig];
  if (!e) continue;
  c.expr = e;
  c.eyes = e.regions.eyes as Character["eyes"];
  c.mouth = e.regions.mouth as Character["mouth"];
}
{
  const d = STANDING.dotchan!;
  const e = d.expr!;
  if (e.anchor) d.anchor = e.anchor as [number, number];
  if (e.top !== undefined) d.top = e.top;
  if (e.chest.length === 2) d.chest = e.chest.map((c) => ({ x: c.x, y: c.y, rx: c.rx, ry: c.ry, focus: c.focus as [number, number], max: c.max })) as [ChestRegion, ChestRegion];
}

// the names on screen follow the screen language (the Korean name is the key in the dictionary)
for (const c of [...Object.values(CAST), ...Object.values(STANDING)]) {
  if (!c) continue;
  const ko = c.name;
  Object.defineProperty(c, "name", { get: () => t(ko), enumerable: true, configurable: true });
}

const isGrok = (text: string) => /grok|그록|xai|x\.ai/i.test(text);

/** the character a member plays: its company's, or for a relay member the one its label names */
export function castOf(m: Pick<Member, "provider" | "label" | "model"> & { site?: string }): Character {
  const fam = familyOf(m);
  if (fam === "claude") return CAST.claudechan;
  if (fam === "gpt") return CAST.gpichan;
  if (fam === "gemini") return CAST.gemmini;
  return isGrok(`${m.label ?? ""} ${m.model ?? ""}`) ? CAST["grok-x"] : CAST.dotchan;
}

/** the chair's character, from its provider */
export function chairCast(provider: string | undefined, model?: string): Character {
  if (provider === "gpt") return CAST.gpichan;
  if (provider === "gemini") return CAST.gemmini;
  if (provider === "claude" || !provider) return CAST.claudechan;
  return isGrok(`${provider} ${model ?? ""}`) ? CAST["grok-x"] : CAST.dotchan;
}

export const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
/** bump when any art under public/avatar changes: the server lets browsers keep it for a year */
const ART_REV = 4;
export const artUrl = (rig: RigId, file: string) => `/avatar/${rig}/${file}.webp?v=${ART_REV}`;
