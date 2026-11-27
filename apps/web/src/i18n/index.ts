// The console's screen language. One setting for the whole app: the characters' lines and voices (the
// avatar options) and the screen text follow the same choice. The Korean text is the key: a string
// missing from the English or Japanese dictionary shows in Korean, so nothing ever goes blank.
// Only the console's own words are translated — what the server sends, what the chair and members
// say, and the user's data stay as they are.
import { useSyncExternalStore } from "react";
import { PARTS } from "./parts";

export type Lang = "ko" | "ja" | "en";
export const LANGS: Array<[Lang, string]> = [
  ["ko", "한국어"],
  ["ja", "日本語"],
  ["en", "English"],
];

const KEY = "gc.lang";
/** where the language lived before the screens followed it: the avatar options */
const OLD_KEY = "gc.avatar.prefs";

const isLang = (v: unknown): v is Lang => v === "ko" || v === "ja" || v === "en";

function read(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (isLang(v)) return v;
    const old = (JSON.parse(localStorage.getItem(OLD_KEY) ?? "{}") as { lang?: unknown }).lang;
    if (isLang(old)) return old;
  } catch {
    /* private mode */
  }
  return "ko";
}

let LANG: Lang = read();
const listeners = new Set<() => void>();
const notify = () => {
  document.documentElement.lang = LANG;
  listeners.forEach((fn) => fn());
};
if (typeof document !== "undefined") document.documentElement.lang = LANG;

export function getLang(): Lang {
  return LANG;
}

export function setLang(lang: Lang): void {
  if (lang === LANG) return;
  LANG = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  notify();
}

// another window of the same console changed it (the floating chair follows the main window)
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !isLang(e.newValue) || e.newValue === LANG) return;
    LANG = e.newValue;
    notify();
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** the current language; the component draws again when it changes */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

type Dict = Record<string, string>;
const DICTS: Record<Exclude<Lang, "ko">, Dict> = { en: {}, ja: {} };
for (const part of PARTS) {
  Object.assign(DICTS.en, part.en);
  Object.assign(DICTS.ja, part.ja);
}

export type Params = Record<string, string | number>;

/**
 * The text in the current language. `ko` is the Korean text and the key; `{name}` in it is filled
 * from `params` (in every language, so the translations keep the same placeholders).
 */
export function t(ko: string, params?: Params): string {
  const s = LANG === "ko" ? ko : (DICTS[LANG][ko] ?? ko);
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** `t`, in a component that should draw again when the language changes */
export function useT(): typeof t {
  useLang();
  return t;
}

/** the locale for dates and numbers */
export function locale(): string {
  return LANG === "ko" ? "ko-KR" : LANG === "ja" ? "ja-JP" : "en-US";
}
