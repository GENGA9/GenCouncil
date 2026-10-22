/** The rotating 2x2 squares loader from the reference mockup, tinted per AI family. */
export function GridSpinner({ color, size = 14, title, spinning = true }: { color: string; size?: number; title?: string; spinning?: boolean }) {
  return (
    <span className={`grid-spinner ${spinning ? "" : "idle"}`} style={{ color, width: size, height: size }} title={title} aria-label={title} role="img">
      <i /><i /><i /><i />
    </span>
  );
}
