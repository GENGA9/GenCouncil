// The avatar view in the main window and the floating chair (/?float=1, the desktop app's small window
// while the main one is minimized) are the same console page origin in the same browser profile, so
// they talk over a BroadcastChannel: the main window tells the float what the chair's short bubble says
// (its event lines: an order taken, all done, the agenda closed, a decision waited on, …) and whether its
// voice is heard; the float tells the main window when it sent the chair something, so the chair answers
// with the same acknowledgement as from its own input box. Only the main window plays sound.
import { useEffect, useMemo, useRef } from "react";

export type FloatMsg =
  /** the chair's short bubble: its words and for how long they stay up (the float keeps its own timer:
   * a minimized window's timers run late). `voice`: the main window speaks at all */
  | { type: "say"; id: string; text: string; ms: number; voice: boolean }
  /** the chair's voice is heard now (a recording, or the TTS reading its words) */
  | { type: "talk"; on: boolean; voice: boolean }
  /** a float window just opened: the main window tells it what is on now */
  | { type: "hello" }
  /** the float sent the chair something */
  | { type: "sent" };

const NAME = "gc-float";

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(NAME) : null;
}

/** how long a short line stays up: at least 3.2 s, longer for longer words (as in the avatar view) */
export const holdMs = (text: string): number => Math.max(3200, 1500 + text.length * 100);

/** the main window's side: mirror the chair's bubble and voice; `onSent` when the float sent something */
export function useFloatMirror(say: { id: string; text: string } | null, talking: boolean, voice: boolean, onSent: () => void): void {
  const ch = useRef<BroadcastChannel | null>(null);
  const now = useRef({ say, talking, voice, onSent });
  now.current = { say, talking, voice, onSent };
  const post = (m: FloatMsg) => ch.current?.postMessage(m);
  const postSay = () => {
    const c = now.current;
    if (c.say) post({ type: "say", id: c.say.id, text: c.say.text, ms: holdMs(c.say.text), voice: c.voice });
  };
  useEffect(() => {
    const c = channel();
    if (!c) return;
    ch.current = c;
    c.onmessage = (e: MessageEvent<FloatMsg>) => {
      const m = e.data;
      if (m?.type === "sent") now.current.onSent();
      else if (m?.type === "hello") {
        postSay();
        post({ type: "talk", on: now.current.talking, voice: now.current.voice });
      }
    };
    return () => {
      ch.current = null;
      c.close();
    };
  }, []);
  const id = say?.id;
  const text = say?.text;
  useEffect(() => {
    if (id && text) postSay();
  }, [id, text]);
  useEffect(() => {
    post({ type: "talk", on: talking, voice });
  }, [talking, voice]);
}

/** the float window's side: messages from the main window, a hello once open, and `sent` to tell it */
export function useFloatLink(onMsg: (m: FloatMsg) => void): { sent: () => void } {
  const ch = useRef<BroadcastChannel | null>(null);
  const fn = useRef(onMsg);
  fn.current = onMsg;
  useEffect(() => {
    const c = channel();
    if (!c) return;
    ch.current = c;
    c.onmessage = (e: MessageEvent<FloatMsg>) => e.data && fn.current(e.data);
    c.postMessage({ type: "hello" } satisfies FloatMsg);
    return () => {
      ch.current = null;
      c.close();
    };
  }, []);
  return useMemo(() => ({ sent: () => ch.current?.postMessage({ type: "sent" } satisfies FloatMsg) }), []);
}
