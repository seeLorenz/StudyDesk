import { useCallback, useMemo, useRef, useState } from "react";
import type { Note } from "../chat/types";
import { uid } from "../chat/types";
import type { PendingAttachment } from "../lib/files";
import type { Anchor } from "../lib/highlight";
import { askClaude, errorCopy, type AskError, type Turn } from "../platform/claude";
import type { NoteEntry, NoteHandlers } from "./AnnotatedMarkdown";

// The state behind select-to-reply on any page: asking about a passage,
// follow-ups, opening, collapsing and deleting notes. The page owns where the
// notes are stored and how a note's prompt is built.

type Options = {
  notes: Note[];
  setNotes: (fn: (notes: Note[]) => Note[]) => void;
  /** Builds the prompt for a note from the page's own content. */
  turnsFor: (note: Note) => Turn[];
  /** Called after a change worth saving right away. */
  onSettled?: () => void;
};

const stored = (files: PendingAttachment[]) => files.map(({ id, name, kind, text, thumb }) => ({ id, name, kind, text, thumb }));
const blobs = (files: PendingAttachment[]) => files.filter((a) => a.kind === "image" && a.blob).map((a) => a.blob!);

export function useSideNotes({ notes, setNotes, turnsFor, onSettled }: Options) {
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const latest = useRef(notes);
  latest.current = notes;
  const turnsRef = useRef(turnsFor);
  turnsRef.current = turnsFor;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const patch = useCallback(
    (id: string, fn: (n: Note) => Note) => setNotes((all) => all.map((n) => (n.id === id ? fn(n) : n))),
    [setNotes],
  );
  const setLast = useCallback(
    (id: string, p: { text?: string; error?: string }) =>
      patch(id, (n) => ({ ...n, turns: n.turns.map((t, i) => (i === n.turns.length - 1 ? { ...t, ...p } : t)) })),
    [patch],
  );

  const run = useCallback(
    async (noteId: string, note: Note, images: Blob[]) => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      setBusyNoteId(noteId);
      try {
        const answer = await askClaude(turnsRef.current(note), { signal: c.signal, images, onText: (t) => setLast(noteId, { text: t }) });
        setLast(noteId, { text: answer });
      } catch (e) {
        const err = e as AskError;
        setLast(noteId, { ...(err.text !== undefined ? { text: err.text } : {}), error: errorCopy(err) });
      } finally {
        if (ctl.current === c) {
          ctl.current = null;
          setBusyNoteId(null);
        }
        setTimeout(() => settledRef.current?.(), 0);
      }
    },
    [setLast],
  );

  const ask = useCallback(
    (blockId: string, anchor: Anchor, question: string, files: PendingAttachment[]) => {
      const note: Note = {
        id: uid(),
        messageId: blockId,
        quote: anchor.quote,
        label: anchor.label,
        nth: anchor.nth,
        ...(anchor.context ? { context: anchor.context } : {}),
        collapsed: false,
        createdAt: Date.now(),
        turns: [{ role: "user", text: question || "Explain this passage.", attachments: stored(files) }, { role: "assistant", text: "" }],
      };
      // Asking about a new passage tucks the other open notes of that block away.
      setNotes((all) => [...all.map((n) => (n.messageId === blockId ? { ...n, collapsed: true } : n)), note]);
      void run(note.id, note, blobs(files));
    },
    [run, setNotes],
  );

  const onFollowUp = useCallback(
    (noteId: string, question: string, files: PendingAttachment[]) => {
      const n = latest.current.find((x) => x.id === noteId);
      if (!n) return;
      const next: Note = {
        ...n,
        collapsed: false,
        turns: [...n.turns, { role: "user", text: question, attachments: stored(files) }, { role: "assistant", text: "" }],
      };
      patch(noteId, () => next);
      void run(noteId, next, blobs(files));
    },
    [patch, run],
  );

  const onToggleNote = useCallback(
    (id: string, open?: boolean) => {
      patch(id, (n) => ({ ...n, collapsed: open === undefined ? !n.collapsed : !open }));
      setTimeout(() => settledRef.current?.(), 0);
    },
    [patch],
  );
  const onDeleteNote = useCallback(
    (id: string) => {
      if (busyNoteId === id) ctl.current?.abort();
      setNotes((all) => all.filter((n) => n.id !== id));
      setTimeout(() => settledRef.current?.(), 0);
    },
    [busyNoteId, setNotes],
  );
  const onStopNote = useCallback(() => ctl.current?.abort(), []);

  const byBlock = useMemo(() => {
    const map = new Map<string, NoteEntry[]>();
    [...notes]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((note, i) => map.set(note.messageId, [...(map.get(note.messageId) ?? []), { note, number: i + 1 }]));
    return map;
  }, [notes]);

  const handlers: NoteHandlers = useMemo(
    () => ({ busyNoteId, onToggleNote, onDeleteNote, onFollowUp, onStopNote }),
    [busyNoteId, onToggleNote, onDeleteNote, onFollowUp, onStopNote],
  );

  return { ask, handlers, byBlock };
}
