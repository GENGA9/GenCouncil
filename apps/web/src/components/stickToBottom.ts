import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** how close to the foot still counts as "reading the newest line" (px) */
const NEAR = 60;

/**
 * Keep a chat list at its newest line while the reader is there.
 *
 * Scrolling once when a message arrives is not enough: images and videos load afterwards and push
 * the foot down, so a long agenda opened with media ended up near its first lines. Here the list
 * follows any growth of its content (a ResizeObserver on every message) as long as the reader was
 * at the foot, and lets go once they scroll up. A list that mounts later (the agenda's state came
 * after its chat) is caught through the callback ref, and a newly opened agenda (`resetKey`)
 * always starts at its foot.
 */
export function useStickToBottom<T extends HTMLElement>(resetKey: unknown): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null);
  const pinned = useRef(true);

  const toFoot = useCallback(() => {
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [el]);

  useLayoutEffect(() => {
    pinned.current = true;
    toFoot();
  }, [resetKey, toFoot]);

  useEffect(() => {
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => toFoot()) : undefined;
    const watchChildren = () => {
      if (!ro) return;
      for (const c of Array.from(el.children)) ro.observe(c);
    };
    ro?.observe(el);
    watchChildren();
    // new messages: watch them too, and follow
    const mo = new MutationObserver(() => {
      watchChildren();
      toFoot();
    });
    mo.observe(el, { childList: true });
    toFoot();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      mo.disconnect();
    };
  }, [el, toFoot]);

  return setEl;
}
