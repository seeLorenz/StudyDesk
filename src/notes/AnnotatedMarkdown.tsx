import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Note } from "../chat/types";
import { renderMarkdown } from "../lib/markdown";
import { drawAnchor, placeHost } from "../lib/highlight";
import { NoteCard } from "../chat/NoteCard";
import type { PendingAttachment } from "../lib/files";

// Select-to-reply, usable anywhere in StudyDesk: renders Markdown whose
// passages can be selected and asked about (with <SelectionReply> on the
// page). Passages with side notes are drawn as highlighter marks; a collapsed
// note is only its mark, an open note unfolds right under the line it's about.

export type NoteEntry = { note: Note; number: number };

export type NoteHandlers = {
  busyNoteId: string | null;
  onToggleNote: (id: string, open?: boolean) => void;
  onDeleteNote: (id: string) => void;
  onFollowUp: (id: string, text: string, attachments: PendingAttachment[]) => void;
  onStopNote: () => void;
};

type Props = NoteHandlers & {
  /** Identifies this block of text; notes point at it with `messageId`. */
  blockId: string;
  text: string;
  notes: NoteEntry[];
  /** False while the text is still streaming in. */
  selectable?: boolean;
  className?: string;
};

export const AnnotatedMarkdown = memo(function AnnotatedMarkdown({
  blockId,
  text,
  notes,
  selectable = true,
  className = "md",
  busyNoteId,
  onToggleNote,
  onDeleteNote,
  onFollowUp,
  onStopNote,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // One container element per note, reused across renders so an open note keeps its state.
  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const [open, setOpen] = useState<Array<{ id: string; host: HTMLDivElement }>>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const anchorKey = notes.map(({ note, number }) => `${note.id}:${number}:${note.collapsed}:${note.nth}:${note.quote.length}`).join("|");

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.innerHTML = html;
    const shown: Array<{ id: string; host: HTMLDivElement }> = [];
    const gone: string[] = [];
    // Draw every mark first: an open note's own text must not count as block text.
    const drawn = new Map(notes.map(({ note, number }) => [note.id, drawAnchor(body, note.id, note, number, !note.collapsed)]));
    for (const { note } of notes) {
      if (!drawn.get(note.id)) gone.push(note.id);
      if (note.collapsed) continue;
      let host = hostsRef.current.get(note.id);
      if (!host) {
        host = document.createElement("div");
        host.className = "note-host";
        host.dataset.noteHost = note.id;
        hostsRef.current.set(note.id, host);
      }
      if (!drawn.get(note.id) || !placeHost(body, note.id, host)) body.prepend(host);
      shown.push({ id: note.id, host });
    }
    for (const id of hostsRef.current.keys()) if (!notes.some((n) => n.note.id === id)) hostsRef.current.delete(id);
    setOpen((prev) => (prev.length === shown.length && prev.every((p, i) => p.id === shown[i].id && p.host === shown[i].host) ? prev : shown));
    setMissing((prev) => (prev.join() === gone.join() ? prev : gone));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, anchorKey]);

  const onBodyClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".note-host")) return;
    const hit = target.closest<HTMLElement>("mark[data-note], sup[data-note]");
    if (!hit || window.getSelection()?.toString()) return;
    const id = hit.dataset.note!;
    onToggleNote(id);
    requestAnimationFrame(() => hostsRef.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  return (
    <>
      <div ref={bodyRef} className={className} data-msg-body={blockId} data-selectable={selectable ? "true" : undefined} onClick={onBodyClick} />
      {open.map(({ id, host }) => {
        const entry = notes.find((n) => n.note.id === id);
        if (!entry) return null;
        return createPortal(
          <NoteCard
            note={entry.note}
            number={entry.number}
            busy={busyNoteId === id}
            missing={missing.includes(id)}
            onCollapse={() => onToggleNote(id, false)}
            onDelete={() => onDeleteNote(id)}
            onFollowUp={(t, a) => onFollowUp(id, t, a)}
            onStop={onStopNote}
          />,
          host,
          id,
        );
      })}
    </>
  );
});
