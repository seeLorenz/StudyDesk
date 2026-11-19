import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message, Note } from "./types";
import { renderMarkdown } from "../lib/markdown";
import { drawAnchor } from "../lib/highlight";
import { NoteCard } from "./NoteCard";

type Props = {
  message: Message;
  notes: Array<{ note: Note; number: number }>;
  wide: boolean;
  generating: boolean;
  busyNoteId: string | null;
  onToggleNote: (id: string, open?: boolean) => void;
  onDeleteNote: (id: string) => void;
  onFollowUp: (id: string, question: string) => void;
  onStopNote: () => void;
};

export const MessageRow = memo(function MessageRow({
  message,
  notes,
  wide,
  generating,
  busyNoteId,
  onToggleNote,
  onDeleteNote,
  onFollowUp,
  onStopNote,
}: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const html = useMemo(() => (message.role === "assistant" ? renderMarkdown(message.text) : ""), [message.role, message.text]);
  const anchorKey = notes.map(({ note, number }) => `${note.id}:${number}:${note.collapsed}:${note.nth}`).join("|");

  // Place each note beside its passage (wide screens), pushing notes down so they never overlap.
  const relayout = useCallback(() => {
    const row = rowRef.current;
    const col = notesRef.current;
    const body = bodyRef.current;
    if (!row || !col || !body) return;
    const cards = Array.from(col.querySelectorAll<HTMLElement>(":scope > .note-slot"));
    if (!wide) {
      cards.forEach((c) => (c.style.top = ""));
      col.style.minHeight = "";
      return;
    }
    const rowTop = col.getBoundingClientRect().top;
    const placed = cards
      .map((el) => {
        const mark = body.querySelector<HTMLElement>(`mark[data-note="${el.dataset.note}"]`);
        return { el, want: mark ? mark.getBoundingClientRect().top - rowTop - 8 : 0 };
      })
      .sort((a, b) => a.want - b.want);
    let y = 0;
    for (const p of placed) {
      const top = Math.max(p.want, y);
      p.el.style.top = `${top}px`;
      y = top + p.el.offsetHeight + 10;
    }
    col.style.minHeight = `${y}px`;
  }, [wide]);

  // Render the message and draw highlighter marks for its notes.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || message.role !== "assistant") return;
    body.innerHTML = html;
    const gone = new Set<string>();
    for (const { note, number } of notes) {
      if (!drawAnchor(body, note.id, note, number, !note.collapsed)) gone.add(note.id);
    }
    setMissing((prev) => (prev.size === gone.size && [...gone].every((g) => prev.has(g)) ? prev : gone));
    relayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, anchorKey, relayout]);

  // Re-place notes whenever any of them (or the message) changes size.
  useLayoutEffect(() => {
    if (!notes.length) return;
    const ro = new ResizeObserver(() => relayout());
    if (bodyRef.current) ro.observe(bodyRef.current);
    notesRef.current?.querySelectorAll(":scope > .note-slot").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [anchorKey, relayout, notes.length]);

  const onBodyClick = (e: React.MouseEvent) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>("mark[data-note], sup[data-note]");
    if (!hit || window.getSelection()?.toString()) return;
    const id = hit.dataset.note!;
    const note = notes.find((n) => n.note.id === id)?.note;
    onToggleNote(id, note?.collapsed ? true : undefined);
    requestAnimationFrame(() =>
      notesRef.current?.querySelector(`[data-note="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };

  const locate = (id: string) => {
    const mark = bodyRef.current?.querySelector<HTMLElement>(`mark[data-note="${id}"]`);
    if (!mark) return;
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    const marks = bodyRef.current!.querySelectorAll(`mark[data-note="${id}"]`);
    marks.forEach((m) => m.classList.add("is-flash"));
    setTimeout(() => marks.forEach((m) => m.classList.remove("is-flash")), 1200);
  };

  if (message.role === "user") {
    return (
      <div className="row row-user">
        <div className="bubble">
          {message.attachments?.length ? (
            <div className="bubble-files">
              {message.attachments.map((a) =>
                a.thumb ? (
                  <img key={a.id} src={a.thumb} alt={a.name} className="bubble-thumb" />
                ) : (
                  <span key={a.id} className="file-chip static">
                    <FileIcon kind={a.kind} />
                    {a.name}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {message.text && <p className="bubble-text">{message.text}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={"row row-assistant" + (notes.length ? " has-notes" : "")} ref={rowRef}>
      <div className="answer">
        <div
          ref={bodyRef}
          className="md"
          data-msg-body={message.id}
          data-selectable={generating ? undefined : "true"}
          onClick={onBodyClick}
        />
        {generating && !message.text && <p className="thinking">Thinking…</p>}
        {message.error && <p className="error-line">{message.error}</p>}
      </div>
      {notes.length > 0 && (
        <div className="notes" ref={notesRef}>
          {notes.map(({ note, number }) => (
            <div className="note-slot" data-note={note.id} key={note.id}>
              <NoteCard
                note={note}
                number={number}
                busy={busyNoteId === note.id}
                missing={missing.has(note.id)}
                onToggle={() => onToggleNote(note.id)}
                onDelete={() => onDeleteNote(note.id)}
                onFollowUp={(q) => onFollowUp(note.id, q)}
                onStop={onStopNote}
                onLocate={() => locate(note.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export function FileIcon({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 16 16" className="file-icon" aria-hidden="true">
      <path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      {kind === "pdf" && <path d="M6 9.5h4M6 11.5h4" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}
