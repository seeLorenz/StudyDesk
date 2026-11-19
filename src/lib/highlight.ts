// Turning a text selection inside a rendered message into a stable anchor,
// and drawing that anchor back as highlighter marks after every render.
//
// Positions are character offsets into root.textContent, which is the same
// concatenation of text nodes that Range.toString() uses. Because a message
// always renders to the same DOM, an anchor stored as (quote, nth occurrence)
// finds the same text again on every load.

export type Anchor = { quote: string; label: string; nth: number; context?: PassageContext };

/** Open side notes and note numbers live inside the message DOM; their text is never part of the message's text. */
const NOTE_HOST = ".note-host, sup.sd-ref";

/** The message's own text: every text node except those inside open side notes. */
export function messageText(root: HTMLElement): string {
  if (!root.querySelector(NOTE_HOST)) return root.textContent ?? "";
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(NOTE_HOST).forEach((n) => n.remove());
  return clone.textContent ?? "";
}

/** Character offset of (node, offset) within the message's own text. */
function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  const frag = r.cloneContents();
  frag.querySelectorAll(NOTE_HOST).forEach((n) => n.remove());
  return frag.textContent?.length ?? 0;
}

/**
 * The selection as a person reads it: math becomes its TeX source ($x^3 + 4$)
 * instead of KaTeX's doubled screen-reader and visual text.
 */
export function readableText(range: Range, keepLines = false): string {
  const frag = range.cloneContents();
  // Keep blocks apart ("Step 2" and the paragraph under it must not run together).
  frag.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, .katex-display").forEach((b) => b.append("\n"));
  frag.querySelectorAll(NOTE_HOST).forEach((n) => n.remove());
  frag.querySelectorAll(".katex").forEach((k) => {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const visual = k.querySelector(".katex-html")?.textContent ?? k.textContent ?? "";
    k.replaceWith(document.createTextNode(tex ? `$${tex.trim()}$` : visual));
  });
  // A formula cut by the selection edge: keep only its visual part.
  frag.querySelectorAll(".katex-mathml").forEach((n) => n.remove());
  const text = frag.textContent ?? "";
  return keepLines
    ? text.replace(/[^\S\n]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim()
    : text.replace(/\s+/g, " ").trim();
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
export function anchorFromRange(root: HTMLElement, range: Range, label: string = readableText(range)): Anchor | null {
  const full = messageText(root);
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
  const full = messageText(root);
  const start = findNth(full, anchor.quote, anchor.nth);
  if (start === -1) return false;
  const end = start + anchor.quote.length;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(NOTE_HOST) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
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

/**
 * Put an open note's container right under the line it is about: after the
 * paragraph, list item, heading or formula that holds the end of its marked
 * passage. Several notes on the same block stack in the order placed.
 */
export function placeHost(root: HTMLElement, noteId: string, host: HTMLElement): boolean {
  const marks = root.querySelectorAll<HTMLElement>(`mark[data-note="${noteId}"]`);
  const last = marks[marks.length - 1];
  if (!last) return false;
  let block = last.closest<HTMLElement>("li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, table, .katex-display");
  if (block?.classList.contains("katex-display") && block.parentElement?.tagName === "P") block = block.parentElement;
  if (!block || !root.contains(block)) {
    block = last;
    while (block.parentElement && block.parentElement !== root) block = block.parentElement;
  }
  if (block.tagName === "LI") {
    // Inside the item, before any nested list, so the note stays with its line.
    const nested = Array.from(block.children).find((c) => c.tagName === "UL" || c.tagName === "OL");
    if (nested) block.insertBefore(host, nested);
    else block.appendChild(host);
    return true;
  }
  let after: Element = block;
  while (after.nextElementSibling?.classList.contains("note-host")) after = after.nextElementSibling;
  after.after(host);
  return true;
}

export type PassageContext = {
  /** The part of the answer around the passage, with the passage between ⟦ and ⟧. */
  excerpt: string;
  /** The heading of the section the passage is in, if any. */
  section?: string;
  /** When the selection was part of a formula: the whole formula, as TeX. */
  formula?: string;
};

/**
 * Where the passage sits in the answer, so Claude knows exactly which "3"
 * the student means. A selection that starts or ends inside a formula is
 * widened to the whole formula for the excerpt.
 */
export function passageContext(root: HTMLElement, range: Range): PassageContext {
  const katexOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(".katex");
  const wide = range.cloneRange();
  const kStart = katexOf(range.startContainer);
  const kEnd = katexOf(range.endContainer);
  if (kStart && root.contains(kStart)) wide.setStartBefore(kStart);
  if (kEnd && root.contains(kEnd)) wide.setEndAfter(kEnd);

  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(wide.startContainer, wide.startOffset);
  const after = document.createRange();
  after.setStart(wide.endContainer, wide.endOffset);
  after.setEnd(root, root.childNodes.length);

  const pre = readableText(before, true);
  const mid = readableText(wide);
  const post = readableText(after, true);
  const excerpt = `${pre.length > 1500 ? "…" + pre.slice(-1500) : pre} ⟦${mid}⟧ ${post.length > 700 ? post.slice(0, 700) + "…" : post}`.trim();

  let section: string | undefined;
  for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    if (h.closest(NOTE_HOST)) continue;
    const pos = h.compareDocumentPosition(wide.startContainer);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING || h.contains(wide.startContainer)) section = (h.textContent ?? "").trim();
  }
  return { excerpt, section, formula: kStart || kEnd ? mid : undefined };
}
