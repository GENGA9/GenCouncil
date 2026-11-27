import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

export interface LightboxImage {
  src: string;
  name: string;
}

const MAX_SCALE = 8;

/** Whole-screen picture viewer: arrows / swipe to step, wheel or double click to zoom, drag to pan, Esc / backdrop / ✕ to close. */
export function Lightbox({ images, start, onClose }: { images: LightboxImage[]; start: number; onClose: () => void }) {
  const t = useT();
  const [idx, setIdx] = useState(Math.min(Math.max(start, 0), images.length - 1));
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const many = images.length > 1;
  const cur = images[idx];

  const go = useCallback(
    (d: number) => {
      if (images.length < 2) return;
      setIdx((i) => (i + d + images.length) % images.length);
      setScale(1);
      setPos({ x: 0, y: 0 });
    },
    [images.length],
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", key, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key, true);
      document.body.style.overflow = prev;
    };
  }, [go, onClose]);

  if (!cur) return null;

  const zoomTo = (s: number) => {
    const n = Math.min(MAX_SCALE, Math.max(1, s));
    setScale(n);
    if (n === 1) setPos({ x: 0, y: 0 });
  };

  return createPortal(
    <div
      className="lb-root"
      role="dialog"
      aria-modal="true"
      aria-label={cur.name}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => zoomTo(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2))}
    >
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-count">{many ? `${idx + 1} / ${images.length}` : ""}</span>
        <span className="lb-name">{cur.name}</span>
        <a className="lb-btn" href={cur.src} target="_blank" rel="noreferrer" title={t("원본을 새 탭으로 열기")}>
          ↗ {t("새 탭")}
        </a>
        <button className="lb-btn" onClick={onClose} aria-label={t("닫기")} title={t("닫기 (Esc)")}>
          ✕
        </button>
      </div>
      <div
        className="lb-stage"
        onTouchStart={(e) => {
          swipe.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
        }}
        onTouchEnd={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || scale > 1) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - s.x;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(t.clientY - s.y) * 1.5) go(dx < 0 ? 1 : -1);
        }}
      >
        <img
          key={cur.src}
          className={`lb-img ${scale > 1 ? "zoomed" : ""}`}
          src={cur.src}
          alt={cur.name}
          draggable={false}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
          onClick={(e) => {
            e.stopPropagation();
            // a drag that ended on the picture is not a click; a plain tap on an unzoomed picture closes
            if (drag.current?.moved) return;
            if (scale === 1) onClose();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (scale > 1) zoomTo(1);
            else zoomTo(2.5);
          }}
          onPointerDown={(e) => {
            if (scale <= 1) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            setPos({ x: d.px + dx, y: d.py + dy });
          }}
          onPointerUp={() => {
            // keep `moved` until the click event that follows has been swallowed
            setTimeout(() => (drag.current = null), 0);
          }}
        />
      </div>
      {many && (
        <>
          <button
            className="lb-nav lb-prev"
            aria-label={t("이전")}
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
          >
            ‹
          </button>
          <button
            className="lb-nav lb-next"
            aria-label={t("다음")}
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
          >
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** A picture that opens the lightbox when clicked (for the input previews). Stops the click so a surrounding button does not fire. */
export function ZoomImg({ src, name }: { src: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt=""
        style={{ cursor: "zoom-in" }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
      />
      {open && <Lightbox images={[{ src, name }]} start={0} onClose={() => setOpen(false)} />}
    </>
  );
}
