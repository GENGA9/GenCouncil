// What the characters say: Agentg's voice-line scripts (built into lines.json by
// scripts/avatar-study/build-lines.mjs). Event lines for what happens in the council, monologues by
// situation, and short conversations between two or three characters, started by a scene (both idle,
// a peer done / failed / fallen / asleep). Recently used ones are skipped so nothing repeats soon.
import DATA from "./lines.json";
import REACTIONS from "./reactions.json";
import type { RigId } from "./cast";

export interface Turn {
  char: string;
  text: string;
  emotion?: string;
}
export interface Dialogue {
  id: string;
  lang?: string;
  trigger: "both_idle" | "peer_done" | "peer_failed" | "peer_fell" | "peer_sleeping" | "handoff" | string;
  chars: string[];
  turns: Turn[];
}

type Line = { text: string; lang?: string; tags?: string[]; file?: string };
export type Lang = "ko" | "ja" | "en";

/** the viewer's language (the avatar options); a line missing in it is said in Korean */
let LANG: Lang = "ko";
export function setLineLang(lang: Lang): void {
  LANG = lang;
}
/** the lines in the viewer's language, or the Korean ones when there are none */
function inLang<T extends { lang?: string }>(list: T[]): T[] {
  const mine = list.filter((l) => (l.lang ?? "ko") === LANG);
  return mine.length ? mine : list.filter((l) => (l.lang ?? "ko") === "ko");
}
/** a line to say: its words, and its recording (Agentg's ElevenLabs voices) when there is one */
export interface Spoken {
  text: string;
  url?: string;
}
const voiceUrl = (file?: string) => (file ? `/avatar/voice/${file}?v=1` : undefined);
const EVENTS = DATA.events as Record<string, Record<string, Line[]>>;
const MONOLOGUES = DATA.monologues as Record<string, Line[]>;
const DIALOGUES = DATA.dialogues as Dialogue[];

const recent: string[] = [];
const fresh = <T,>(list: T[], key: (t: T) => string): T | undefined => {
  if (!list.length) return undefined;
  const unused = list.filter((t) => !recent.includes(key(t)));
  const choice = (unused.length ? unused : list)[Math.floor(Math.random() * (unused.length || list.length))];
  recent.push(key(choice));
  if (recent.length > 60) recent.shift();
  return choice;
};

/** a line for an event (task_started, task_done, task_failed, usage_limit, …) with its recording, or undefined */
export function eventLine(rig: RigId | string, event: string): Spoken | undefined {
  const l = fresh(inLang(EVENTS[rig]?.[event] ?? []), (x) => x.text);
  return l ? { text: l.text, url: voiceUrl(l.file) } : undefined;
}

/** a monologue for the situation: the first tag that has one (idle, waiting, late_night, long_wait, random) */
export function monologue(rig: RigId | string, tags: string[]): string | undefined {
  const all = inLang(MONOLOGUES[rig] ?? []);
  for (const t of tags) {
    const l = fresh(all.filter((m) => m.tags?.includes(t)), (m) => m.text);
    if (l) return l.text;
  }
  return fresh(all, (m) => m.text)?.text;
}

/**
 * A conversation for the scene among the characters present. `must` is a character that has to be in it
 * (the one who finished, fell, …).
 */
export function dialogue(trigger: string, present: Set<string>, must?: string): Dialogue | undefined {
  const fits = inLang(DIALOGUES).filter((d) => d.trigger === trigger && d.chars.every((c) => present.has(c)) && (!must || d.chars.includes(must)));
  return fresh(fits, (d) => d.id);
}

/**
 * A short line for a touch (Agentg's reaction presets, personas/reactions): in the viewer's language, or
 * Korean when there is none in it; with its recording (Agentg's voice-lines/touch.json) when it has one.
 */
export function reactionLine(rig: RigId | string): Spoken | undefined {
  const all = (REACTIONS as Record<string, Array<{ text: string; lang: string; file?: string }>>)[rig.replace(/-full$/, "")] ?? [];
  const l = fresh(inLang(all), (x) => x.text);
  return l ? { text: l.text, url: voiceUrl(l.file) } : undefined;
}
