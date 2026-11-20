import { useEffect, useState } from "react";
import type { Note } from "./types";
import { Markdown } from "./Markdown";
import { InputBox } from "./InputBox";
import { FileIcon } from "./FileIcon";
import type { PendingAttachment } from "../lib/files";

type Props = {
  note: Note;
  number: number;
  busy: boolean;
  missing: boolean;
  onCollapse: () => void;
  onDelete: () => void;
  onFollowUp: (text: string, attachments: PendingAttachment[]) => void;
  onStop: () => void;
};

/** An open side note. Collapsing it hides it completely; its highlight brings it back. */
export function NoteCard({ note, number, busy, missing, onCollapse, onDelete, onFollowUp, onStop }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const first = note.turns[0];

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  return (
    <article className="note" aria-label={`Side note ${number}`} contentEditable={false}>
      <header className="note-head">
        <span className="note-num" aria-hidden="true">
          {number}
        </span>
        <span className="note-q">{first?.text || "Your question"}</span>
        {confirmDelete ? (
          <button type="button" className="note-btn confirm" onClick={onDelete}>
            Delete note
          </button>
        ) : (
          <button type="button" className="note-btn" onClick={() => setConfirmDelete(true)} aria-label="Delete side note" title="Delete side note">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button type="button" className="note-btn" onClick={onCollapse} aria-label="Collapse side note" title="Collapse (click the highlight to open it again)">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>

      <div className="note-body">
        {missing && <p className="note-missing">The highlighted passage is no longer in this answer: “{note.label}”</p>}
        {note.turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className={i === 0 ? "note-files-first" : "note-ask"}>
              {i > 0 && t.text && <p>{t.text}</p>}
              {t.attachments?.length ? (
                <div className="bubble-files">
                  {t.attachments.map((a) =>
                    a.thumb ? (
                      <img key={a.id} src={a.thumb} alt={a.name} className="bubble-thumb small" />
                    ) : (
                      <span key={a.id} className="file-chip static" title={a.name}>
                        <FileIcon kind={a.kind} />
                        <span className="file-name">{a.name}</span>
                      </span>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div key={i} className="note-answer">
              {t.text ? <Markdown text={t.text} /> : busy && i === note.turns.length - 1 ? <p className="thinking">Thinking…</p> : null}
              {t.error && <p className="error-line">{t.error}</p>}
            </div>
          ),
        )}
        <InputBox id={`follow-${note.id}`} placeholder="Ask a follow-up" compact busy={busy} onStop={onStop} onSend={onFollowUp} sendLabel="Ask" />
      </div>
    </article>
  );
}
