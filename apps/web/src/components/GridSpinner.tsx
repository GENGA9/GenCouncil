/** The rotating 2x2 squares loader from the reference mockup, tinted per AI family. */
export function GridSpinner({ color, size = 14, title }: { color: string; size?: number; title?: string }) {
  return (
    <span className="grid-spinner" style={{ color, width: size, height: size }} title={title} aria-label={title} role="img">
      <i /><i /><i /><i />
    </span>
  );
}
