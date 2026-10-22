import { useEffect, useState } from "react";

export type ThemeChoice = "auto" | "light" | "dark";
const KEY = "gc.theme";
const ORDER: ThemeChoice[] = ["auto", "light", "dark"];

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function effective(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "auto") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Set data-theme on <html> and the mobile browser bar color. */
export function applyTheme(choice: ThemeChoice = read()): void {
  const root = document.documentElement;
  if (choice === "auto") delete root.dataset.theme;
  else root.dataset.theme = choice;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", effective(choice) === "dark" ? "#0d0f13" : "#1f2937");
}

export function useTheme(): [ThemeChoice, () => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  useEffect(() => {
    applyTheme(choice);
    try {
      if (choice === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
    if (choice !== "auto") return;
    // keep the browser bar color in sync when the OS switches
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => applyTheme("auto");
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [choice]);
  const cycle = () => setChoice((c) => ORDER[(ORDER.indexOf(c) + 1) % ORDER.length]);
  return [choice, cycle];
}

export const THEME_LABEL: Record<ThemeChoice, string> = { auto: "◐ 자동", light: "☀ 라이트", dark: "☾ 다크" };
