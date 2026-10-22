import { useEffect, useState } from "react";
import { api } from "../api";
import type { FolderListing } from "../types";

/** Browse folders on the PC (served by the local server) and pick one. */
export function FolderPicker({ start, onPick, onClose }: { start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [err, setErr] = useState("");
  const go = (p: string) =>
    api
      .fs(p)
      .then((l) => {
        setListing(l);
        setErr("");
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void go(start ?? "");
  }, [start]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>폴더 선택</span>
          <button className="icon" onClick={onClose}>✕</button>
        </div>
        <div className="fp-roots">
          {listing?.roots.map((r) => (
            <button key={r.path} className="ghost small" onClick={() => go(r.path)}>{r.name}</button>
          ))}
        </div>
        <div className="fp-path mono small">
          {listing?.parent && <button className="ghost small" onClick={() => go(listing.parent!)}>⬑ 위로</button>}
          <span>{listing?.path}</span>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="fp-list">
          {listing?.entries.length === 0 && <div className="muted small">하위 폴더 없음</div>}
          {listing?.entries.map((e) => (
            <button key={e.path} className="fp-item" onClick={() => go(e.path)} onDoubleClick={() => onPick(e.path)}>
              <span>📁 {e.name}</span>
              {e.git && <span className="badge ok">git</span>}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <span className="small muted" style={{ marginRight: "auto" }}>git 저장소가 아니어도 됩니다.</span>
          <button className="ghost" onClick={onClose}>취소</button>
          <button className="primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>이 폴더 선택</button>
        </div>
      </div>
    </div>
  );
}
