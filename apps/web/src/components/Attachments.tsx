import { useState } from "react";
import { api } from "../api";
import type { Attachment } from "../types";
import { Lightbox } from "./Lightbox";
import { useT } from "../i18n";

/**
 * A message's attachments as the workshop shows them: pictures (a click opens them whole), videos with
 * their controls, HTML pages in a sandboxed frame, anything else as a link. The same in every look (the
 * text workshop's chat and the record beside the picture and the avatars).
 */
export function Attachments({ agenda, items, shown, className = "" }: { agenda: string; items: Attachment[]; shown: boolean; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  const pics = items.filter((a) => a.type.startsWith("image/")).map((a) => ({ src: api.attachmentUrl(agenda, a.id), name: a.name }));
  return (
    <div className={`msg-attachments ${shown ? "shown" : ""} ${className}`}>
      {items.map((a) => {
        const url = api.attachmentUrl(agenda, a.id);
        if (a.type.startsWith("image/"))
          return (
            <a
              key={a.id}
              className="lb-open"
              href={url}
              target="_blank"
              rel="noreferrer"
              title={a.name}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setOpen(pics.findIndex((p) => p.src === url));
              }}
            >
              <img src={url} alt={a.name} loading="lazy" />
            </a>
          );
        if (a.type === "text/html")
          return (
            <div key={a.id} className="shown-html">
              <iframe src={url} sandbox="allow-scripts" title={a.name} />
              <a className="small" href={url} target="_blank" rel="noreferrer">
                ↗ {t("{name} 새 창에서 열기", { name: a.name })}
              </a>
            </div>
          );
        if (a.type.startsWith("video/")) return <video key={a.id} src={url} controls playsInline preload="metadata" />;
        return (
          <a key={a.id} className="file-chip" href={url} target="_blank" rel="noreferrer">
            📎 {a.name}
          </a>
        );
      })}
      {open !== null && open >= 0 && <Lightbox images={pics} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
