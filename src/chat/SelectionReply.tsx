import { useEffect, useRef, useState } from "react";
import { anchorFromRange, type Anchor } from "../lib/highlight";

type Pending = { messageId: string; anchor: Anchor; rect: DOMRect; range: Range };

type Props = {
  /** The scrolling chat area: selections are only picked up inside it. */
  scope: React.RefObject<HTMLElement>;
  disabled: boolean;
  onAsk: (messageId: string, anchor: Anchor, question: string) => void;
};

const supportsHighlights = typeof CSS !== "undefined" && "highlights" in CSS;

/**
 * The floating "Reply" button that appears over selected text in Claude's
 * answers, and the small question box it turns into.
 */
export function SelectionReply({ scope, disabled, onAsk }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let timer = 0;
    const read = () => {
      if (asking) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return setPending(null);
      const range = sel.getRangeAt(0);
      const startBody = (range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement)?.closest<HTMLElement>("[data-selectable]");
      const endBody = (range.endContainer.nodeType === 1 ? (range.endContainer as Element) : range.endContainer.parentElement)?.closest<HTMLElement>("[data-selectable]");
      if (!startBody || startBody !== endBody || !scope.current?.contains(startBody)) return setPending(null);
      const anchor = anchorFromRange(startBody, range, sel.toString());
      if (!anchor) return setPending(null);
      setPending({ messageId: startBody.dataset.msgBody!, anchor, rect: range.getBoundingClientRect(), range: range.cloneRange() });
    };
    const onChange = () => {
      clearTimeout(timer);
      timer = window.setTimeout(read, 120);
    };
    document.addEventListener("selectionchange", onChange);
    const onScroll = () => !asking && setPending(null);
    const scroller = scope.current;
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [asking, scope]);

  // Keep the passage visibly marked while the selection is replaced by the input's focus.
  useEffect(() => {
    if (!supportsHighlights) return;
    const reg = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
    if (asking && pending) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reg.set("sd-pending", new (window as any).Highlight(pending.range));
    } else reg.delete("sd-pending");
    return () => void reg.delete("sd-pending");
  }, [asking, pending]);

  useEffect(() => {
    if (!asking) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [asking]);

  function close() {
    setAsking(false);
    setPending(null);
    setQuestion("");
  }

  if (!pending || disabled) return null;

  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  const r = pending.rect;
  const width = asking ? Math.min(360, window.innerWidth - 32) : 92;
  const left = Math.max(16, Math.min(window.innerWidth - width - 16, r.left + r.width / 2 - width / 2));
  // On touch screens the system's own copy menu sits above the selection, so go below it.
  const below = coarse || r.top < 72;
  const style: React.CSSProperties = below ? { left, top: r.bottom + 10, width } : { left, top: r.top - (asking ? 58 : 46), width };

  return (
    <div className={"sel-pop" + (asking ? " is-asking" : "")} style={style} ref={boxRef} role="dialog" aria-label="Ask about the selected text">
      {asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = question.trim();
            if (!q) return;
            onAsk(pending.messageId, pending.anchor, q);
            window.getSelection()?.removeAllRanges();
            close();
          }}
        >
          <input
            id="selection-question"
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this passage"
            autoComplete="off"
          />
          <button type="submit" className="mini-btn primary" disabled={!question.trim()}>
            Ask
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="reply-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAsking(true)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.5 4L3 7.5 6.5 11M3.5 7.5H9a4 4 0 014 4V12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Reply
        </button>
      )}
    </div>
  );
}
