// Turning a text selection inside a rendered message into a stable anchor,
// and drawing that anchor back as highlighter marks after every render.
//
// Positions are character offsets into root.textContent, which is the same
// concatenation of text nodes that Range.toString() uses. Because a message
// always renders to the same DOM, an anchor stored as (quote, nth occurrence)
// finds the same text again on every load.

export type Anchor = { quote: string; label: string; nth: number };

/** Character offset of (node, offset) within root's text. */
function offsetIn(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Count how often `needle` occurs in `hay` before position `end`. */
export function occurrenceIndex(hay: string, needle: string, start: number): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && i < start) {
    n++;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

/** Position of the nth occurrence of needle in hay, or -1. */
export function findNth(hay: string, needle: string, nth: number): number {
  let i = hay.indexOf(needle);
  for (let k = 0; k < nth && i !== -1; k++) i = hay.indexOf(needle, i + 1);
  return i;
}

/** Build an anchor from a range that lies inside root. Returns null for empty or whitespace-only selections. */
export function anchorFromRange(root: HTMLElement, range: Range, label: string): Anchor | null {
  const full = root.textContent ?? "";
  let start = offsetIn(root, range.startContainer, range.startOffset);
  let end = offsetIn(root, range.endContainer, range.endOffset);
  while (start < end && /\s/.test(full[start])) start++;
  while (end > start && /\s/.test(full[end - 1])) end--;
  if (end - start < 1) return null;
  const quote = full.slice(start, end);
  const cleanLabel = label.replace(/\s+/g, " ").trim() || quote;
  return { quote, label: cleanLabel, nth: occurrenceIndex(full, quote, start) };
}

/**
 * Wrap the anchored text in <mark data-note=id> elements (one per text node it
 * spans) and put a numbered marker after it. Returns false when the text is
 * no longer in the message.
 */
export function drawAnchor(root: HTMLElement, noteId: string, anchor: Anchor, number: number, open: boolean): boolean {
  const full = root.textContent ?? "";
  const start = findNth(full, anchor.quote, anchor.nth);
  if (start === -1) return false;
  const end = start + anchor.quote.length;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces: Array<{ node: Text; from: number; to: number }> = [];
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + len);
    if (a < b) pieces.push({ node: n, from: a - pos, to: b - pos });
    pos += len;
    if (pos >= end) break;
  }

  let last: HTMLElement | null = null;
  for (const { node, from, to } of pieces) {
    // Skip the hidden MathML copy KaTeX keeps for screen readers.
    if (node.parentElement?.closest(".katex-mathml")) continue;
    let target = node;
    if (from > 0) target = target.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);
    if (!target.data.trim() && pieces.length > 1) continue;
    const mark = document.createElement("mark");
    mark.className = "sd-anchor" + (open ? " is-open" : "");
    mark.dataset.note = noteId;
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    last = mark;
  }
  if (!last) return false;
  const ref = document.createElement("sup");
  ref.className = "sd-ref";
  ref.dataset.note = noteId;
  ref.textContent = String(number);
  last.after(ref);
  return true;
}
