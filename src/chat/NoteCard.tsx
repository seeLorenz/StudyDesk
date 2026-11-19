import { useEffect, useRef, useState } from "react";
import type { Note } from "./types";
import { Markdown } from "./Markdown";

type Props = {
  note: Note;
  number: number;
  busy: boolean;
  missing: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onFollowUp: (question: string) => void;
  onStop: () => void;
  onLocate: () => void;
};

export function NoteCard({ note, number, busy, missing, onToggle, onDelete, onFollowUp, onStop, onLocate }: Props) {
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const answersEnd = useRef<HTMLDivElement>(null);
  const open = !note.collapsed;
  const firstQuestion = note.turns.find((t) => t.role === "user")?.text ?? "";

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const send = () => {
    const q = draft.trim();
    if (!q || busy) return;
    onFollowUp(q);
    setDraft("");
  };

  return (
    <article className={"note" + (open ? " is-open" : "")} aria-label={`Side note ${number}`}>
      <header className="note-head">
        <button type="button" className="note-num" onClick={onLocate} title="Show the highlighted passage">
          {number}
        </button>
        <button type="button" className="note-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="note-q">{firstQuestion || note.label}</span>
          <svg className="chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {confirmDelete ? (
          <button type="button" className="note-del confirm" onClick={onDelete}>
            Delete
          </button>
        ) : (
          <button type="button" className="note-del" onClick={() => setConfirmDelete(true)} aria-label="Delete side note" title="Delete side note">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </header>

      {open && (
        <div className="note-body">
          <blockquote className={"note-quote" + (missing ? " is-missing" : "")}>
            {note.label}
            {missing && <span className="note-missing">This passage is no longer in the message.</span>}
          </blockquote>
          {note.turns.map((t, i) =>
            t.role === "user" ? (
              i === 0 ? null : (
                <p key={i} className="note-ask">
                  {t.text}
                </p>
              )
            ) : (
              <div key={i} className="note-answer">
                {t.text ? <Markdown text={t.text} /> : busy && i === note.turns.length - 1 ? <p className="thinking">Thinking…</p> : null}
                {t.error && <p className="error-line">{t.error}</p>}
              </div>
            ),
          )}
          <div ref={answersEnd} />
          <form
            className="note-follow"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              id={`follow-${note.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask a follow-up"
              aria-label="Ask a follow-up about this passage"
              autoComplete="off"
            />
            {busy ? (
              <button type="button" className="mini-btn" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="mini-btn primary" disabled={!draft.trim()}>
                Ask
              </button>
            )}
          </form>
        </div>
      )}
    </article>
  );
}
