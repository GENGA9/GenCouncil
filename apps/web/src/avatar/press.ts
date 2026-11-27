// One control, two gestures, as in Agentg: a tap or left click is an interaction (the character reacts),
// a long press or right click opens its menu. A long press that opened the menu does not also count as a
// tap, a finger that moves is a scroll and neither, and the phone's own long-press menu is kept away
// (with -webkit-touch-callout: none in the CSS).
import type React from "react";

const LONG_MS = 480;
const SLOP = 10;

interface PressState {
  timer?: number;
  at?: [number, number];
  fired?: boolean;
}
const states = new WeakMap<Element, PressState>();
const of = (el: Element) => {
  let s = states.get(el);
  if (!s) states.set(el, (s = {}));
  return s;
};
const clear = (s: PressState) => {
  if (s.timer) window.clearTimeout(s.timer);
  s.timer = undefined;
};

export interface PressPoint {
  clientX: number;
  clientY: number;
  currentTarget: HTMLElement;
}

export function press<T extends HTMLElement>(onTap: (e: React.MouseEvent<T>) => void, onMenu: (p: PressPoint) => void) {
  return {
    onPointerDown(e: React.PointerEvent<T>) {
      const s = of(e.currentTarget);
      s.fired = false;
      if (e.button !== 0) return;
      clear(s);
      const el = e.currentTarget;
      const p = { clientX: e.clientX, clientY: e.clientY, currentTarget: el };
      s.at = [e.clientX, e.clientY];
      s.timer = window.setTimeout(() => {
        s.timer = undefined;
        s.fired = true;
        navigator.vibrate?.(12);
        onMenu(p);
      }, LONG_MS);
    },
    onPointerMove(e: React.PointerEvent<T>) {
      const s = of(e.currentTarget);
      if (s.timer && s.at && Math.hypot(e.clientX - s.at[0], e.clientY - s.at[1]) > SLOP) clear(s);
    },
    onPointerUp(e: React.PointerEvent<T>) {
      clear(of(e.currentTarget));
    },
    onPointerCancel(e: React.PointerEvent<T>) {
      clear(of(e.currentTarget));
    },
    onPointerLeave(e: React.PointerEvent<T>) {
      clear(of(e.currentTarget));
    },
    onClick(e: React.MouseEvent<T>) {
      const s = of(e.currentTarget);
      if (s.fired) {
        // the long press already opened the menu
        s.fired = false;
        e.preventDefault();
        return;
      }
      onTap(e);
    },
    onContextMenu(e: React.MouseEvent<T>) {
      e.preventDefault();
      const s = of(e.currentTarget);
      clear(s);
      // an Android long press sends this after the timer has already opened the menu
      if (s.fired) return;
      s.fired = false;
      onMenu({ clientX: e.clientX, clientY: e.clientY, currentTarget: e.currentTarget });
    },
  };
}
