import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Message, Note } from "./types";
import { renderMarkdown } from "../lib/markdown";
import { drawAnchor, placeHost } from "../lib/highlight";
import { NoteCard } from "./NoteCard";
import { FileIcon } from "./FileIcon";
import type { PendingAttachment } from "../lib/files";

type Props = {
  message: Message;
  notes: Array<{ note: Note; number: number }>;
  generating: boolean;
  busyNoteId: string | null;
  onToggleNote: (id: string, open?: boolean) => void;
  onDeleteNote: (id: string) => void;
  onFollowUp: (id: string, text: string, attachments: PendingAttachment[]) => void;
  onStopNote: () => void;
};

/**
 * One message. In Claude's answers, passages with side notes are drawn as
 * highlighter marks. A collapsed note is only its mark; an open note unfolds
 * right under the line it is about, inside the answer.
 */
export const MessageRow = memo(function MessageRow({ message, notes, generating, busyNoteId, onToggleNote, onDeleteNote, onFollowUp, onStopNote }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // One container element per note, reused across renders so an open note keeps its state.
  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const [open, setOpen] = useState<Array<{ id: string; host: HTMLDivElement }>>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const html = useMemo(() => (message.role === "assistant" ? renderMarkdown(message.text) : ""), [message.role, message.text]);
  const anchorKey = notes.map(({ note, number }) => `${note.id}:${number}:${note.collapsed}:${note.nth}:${note.quote.length}`).join("|");

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || message.role !== "assistant") return;
    body.innerHTML = html;
    const shown: Array<{ id: string; host: HTMLDivElement }> = [];
    const gone: string[] = [];
    // Draw every mark first: an open note's own text must not count as message text.
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
    <div className="row row-assistant">
      <div
        ref={bodyRef}
        className="md"
        data-msg-body={message.id}
        data-selectable={generating ? undefined : "true"}
        onClick={onBodyClick}
      />
      {generating && !message.text && <p className="thinking">Thinking…</p>}
      {message.error && <p className="error-line">{message.error}</p>}
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
    </div>
  );
});
