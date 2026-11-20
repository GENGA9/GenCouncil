export type Mode = "work" | "vision";

const KEY = "gc.mode";

export function readMode(): Mode {
  try {
    return localStorage.getItem(KEY) === "vision" ? "vision" : "work";
  } catch {
    return "work";
  }
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

/** The two faces of the app: the picture of the council at work, and the workshop where the work is done. */
export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="화면 모드">
      <button role="tab" aria-selected={mode === "vision"} className={mode === "vision" ? "on" : ""} onClick={() => onChange("vision")} title="지금 일이 어떻게 돌아가는지 그림으로 봅니다">
        ✦ 시각화
      </button>
      <button role="tab" aria-selected={mode === "work"} className={mode === "work" ? "on" : ""} onClick={() => onChange("work")} title="안건·의장 대화·위원 카드가 있는 작업 화면">
        ▤ 작업실
      </button>
    </div>
  );
}
