// The desktop (Tauri) app around the console. In a browser none of this does anything: Tauri puts
// __TAURI_INTERNALS__ on the page only inside its own windows, and only the commands its
// capabilities grant to the localhost console are let through (apps/desktop/src-tauri/capabilities).

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function internals(): Internals | null {
  const t = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
  return t && typeof t.invoke === "function" ? t : null;
}

/** inside a window of the desktop app */
export const inDesktop = (): boolean => internals() !== null;

type Cmd = "desktop_mode" | "float_restore" | "float_drag" | "float_hide" | "float_menu";

/** a desktop command; quietly nothing in a browser or when the app refuses it */
export function desktop(cmd: Cmd, args?: Record<string, unknown>): void {
  internals()
    ?.invoke(cmd, args)
    .catch(() => undefined);
}

// Tauri adds its IPC to a remote page while it loads, now and then only after the page's first
// effects ran: the view the console shows is sent again once the IPC is there (a browser gives up
// after a few seconds without it). Only the latest view counts.
let pendingMode: string | null = null;
let modeTimer: number | undefined;
export function reportMode(mode: string): void {
  pendingMode = mode;
  window.clearTimeout(modeTimer);
  let tries = 0;
  const again = () => {
    if (++tries < 24) modeTimer = window.setTimeout(go, 250);
  };
  const go = () => {
    const t = internals();
    if (t) t.invoke("desktop_mode", { mode: pendingMode }).catch(again);
    else again();
  };
  go();
}

/** this page is the floating chair window (the desktop app opens the console's /?float=1 there) */
export const IS_FLOAT = new URLSearchParams(window.location.search).get("float") === "1";

// the float window is transparent: no page colour from the first paint on
if (IS_FLOAT) document.documentElement.classList.add("gc-float");
