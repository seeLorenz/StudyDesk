import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// Chat scrolling like claude.ai: when the student sends a message, it moves to
// the top of the view and the answer comes in below it, so they scroll as
// little as possible. A spacer at the end of the chat (`tail`) gives the
// message room to reach the top while the answer is still short; it shrinks
// as the answer grows. Opening a chat starts at its end.
//
// Messages carry `data-msg={id}`; `lastSent` is the id of the newest message
// the student sent. `loaded` is false while the chat is still loading, so the
// newest message of a chat that just loaded isn't taken for a new one.

const GAP = 16;

export function useSentToTop(scroller: RefObject<HTMLElement>, lastSent: string | undefined, loaded = true): { tail: number; tailRef: RefObject<HTMLDivElement> } {
  const tailRef = useRef<HTMLDivElement>(null);
  const [tail, setTail] = useState(0);
  const seen = useRef<string | undefined | null>(null);

  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s || !loaded) return;
    if (seen.current === null) {
      // First render with this chat: start at the end, as before.
      seen.current = lastSent;
      s.scrollTop = s.scrollHeight;
      return;
    }
    if (!lastSent || lastSent === seen.current) return;
    seen.current = lastSent;
    const msg = s.querySelector<HTMLElement>(`[data-msg="${CSS.escape(lastSent)}"]`);
    const end = tailRef.current;
    if (!msg || !end) return;
    const top = () => msg.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
    const fit = () => {
      // Room needed below the content so the message can sit at the top of the view.
      const below = end.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - top();
      setTail(Math.max(0, s.clientHeight - below - GAP));
    };
    fit();
    requestAnimationFrame(() => s.scrollTo({ top: Math.max(0, top() - GAP), behavior: "smooth" }));
    // Keep the room right while the answer grows (and drop it once the answer fills the view).
    const content = end.parentElement;
    if (!content || typeof MutationObserver === "undefined") return;
    let queued = false;
    const later = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fit();
      });
    };
    const mo = new MutationObserver(later);
    mo.observe(content, { childList: true, subtree: true, characterData: true });
    const stop = setTimeout(() => mo.disconnect(), 5 * 60_000);
    return () => {
      mo.disconnect();
      clearTimeout(stop);
    };
  }, [scroller, lastSent, loaded]);

  return { tail, tailRef };
}
