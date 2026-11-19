import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Message, Note } from "./types";
import { uid } from "./types";
import { MessageRow } from "./MessageRow";
import { InputBox } from "./InputBox";
import { SelectionReply } from "./SelectionReply";
import { askClaude, errorCopy, type AskError } from "../platform/claude";
import { mainTurns, noteTurns, titleFrom } from "./prompts";
import type { PendingAttachment } from "../lib/files";
import type { Anchor } from "../lib/highlight";

type Props = {
  initial: Chat;
  save: (chat: Chat) => Promise<void>;
  onSaveError: (message: string) => void;
};

const STARTERS = [
  "Explain the difference between mitosis and meiosis",
  "Walk me through solving 2x² − 8x + 6 = 0",
  "What caused the French Revolution? Keep it to the main causes",
];

export function ChatView({ initial, save, onSaveError }: Props) {
  const [chat, setChat] = useState<Chat>(initial);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const mainCtl = useRef<AbortController | null>(null);
  const noteCtl = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropped, setDropped] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const stickToBottom = useRef(true);

  const persist = useCallback(() => {
    const c = chatRef.current;
    if (!c.messages.length) return;
    save(c).catch((e) => onSaveError(e instanceof Error ? e.message : "Your chat couldn't be saved."));
  }, [save, onSaveError]);

  const update = (fn: (c: Chat) => Chat) => {
    setChat((c) => {
      const next = fn(c);
      chatRef.current = next;
      return next;
    });
  };
  const patchMessage = (id: string, patch: Partial<Message>) =>
    update((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const patchNote = (id: string, fn: (n: Note) => Note) => update((c) => ({ ...c, notes: c.notes.map((n) => (n.id === id ? fn(n) : n)) }));
  const setLastNoteTurn = (id: string, patch: { text?: string; error?: string }) =>
    patchNote(id, (n) => ({ ...n, turns: n.turns.map((t, i) => (i === n.turns.length - 1 ? { ...t, ...patch } : t)) }));

  // Keep the newest text in view while Claude writes, unless the student scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current && generatingId) el.scrollTop = el.scrollHeight;
  }, [chat.messages, generatingId]);

  async function sendMain(text: string, attachments: PendingAttachment[]) {
    const now = Date.now();
    const userMsg: Message = {
      id: uid(),
      role: "user",
      text,
      createdAt: now,
      attachments: stored(attachments),
    };
    const reply: Message = { id: uid(), role: "assistant", text: "", createdAt: now + 1 };
    update((c) => ({
      ...c,
      title: c.messages.length ? c.title : titleFrom(text || attachments[0]?.name || "New chat"),
      updatedAt: now,
      messages: [...c.messages, userMsg, reply],
    }));
    stickToBottom.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
    setGeneratingId(reply.id);
    const ctl = new AbortController();
    mainCtl.current = ctl;
    const images = blobs(attachments);
    try {
      const turns = mainTurns(chatRef.current.messages.filter((m) => m.id !== reply.id));
      const answer = await askClaude(turns, { signal: ctl.signal, images, onText: (t) => patchMessage(reply.id, { text: t }) });
      patchMessage(reply.id, { text: answer });
    } catch (e) {
      const err = e as AskError;
      patchMessage(reply.id, { text: err.text ?? chatRef.current.messages.find((m) => m.id === reply.id)?.text ?? "", error: errorCopy(err) });
    } finally {
      setGeneratingId(null);
      mainCtl.current = null;
      update((c) => ({ ...c, updatedAt: Date.now() }));
      persist();
    }
  }

  async function runNote(noteId: string, images: Blob[] = []) {
    const note = chatRef.current.notes.find((n) => n.id === noteId);
    if (!note) return;
    noteCtl.current?.abort();
    const ctl = new AbortController();
    noteCtl.current = ctl;
    setBusyNoteId(noteId);
    try {
      const turns = noteTurns(chatRef.current, note);
      const answer = await askClaude(turns, { signal: ctl.signal, images, onText: (t) => setLastNoteTurn(noteId, { text: t }) });
      setLastNoteTurn(noteId, { text: answer });
    } catch (e) {
      const err = e as AskError;
      setLastNoteTurn(noteId, { ...(err.text !== undefined ? { text: err.text } : {}), error: errorCopy(err) });
    } finally {
      if (noteCtl.current === ctl) {
        noteCtl.current = null;
        setBusyNoteId(null);
      }
      update((c) => ({ ...c, updatedAt: Date.now() }));
      persist();
    }
  }

  const stored = (files: PendingAttachment[]) => files.map(({ id, name, kind, text, thumb }) => ({ id, name, kind, text, thumb }));
  const blobs = (files: PendingAttachment[]) => files.filter((a) => a.kind === "image" && a.blob).map((a) => a.blob!);

  function askAboutPassage(messageId: string, anchor: Anchor, question: string, files: PendingAttachment[]) {
    const note: Note = {
      id: uid(),
      messageId,
      quote: anchor.quote,
      label: anchor.label,
      nth: anchor.nth,
      ...(anchor.context ? { context: anchor.context } : {}),
      collapsed: false,
      createdAt: Date.now(),
      turns: [{ role: "user", text: question || "Explain this passage.", attachments: stored(files) }, { role: "assistant", text: "" }],
    };
    // Asking about a new passage tucks the other open notes of that message away.
    update((c) => ({ ...c, notes: [...c.notes.map((n) => (n.messageId === messageId ? { ...n, collapsed: true } : n)), note] }));
    void runNote(note.id, blobs(files));
  }

  const followUp = useCallback((noteId: string, question: string, files: PendingAttachment[]) => {
    patchNote(noteId, (n) => ({
      ...n,
      collapsed: false,
      turns: [...n.turns, { role: "user", text: question, attachments: stored(files) }, { role: "assistant", text: "" }],
    }));
    void runNote(noteId, blobs(files));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleNote = useCallback(
    (id: string, open?: boolean) => {
      patchNote(id, (n) => ({ ...n, collapsed: open === undefined ? !n.collapsed : !open }));
      persist();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist],
  );
  const deleteNote = useCallback(
    (id: string) => {
      if (busyNoteId === id) noteCtl.current?.abort();
      update((c) => ({ ...c, notes: c.notes.filter((n) => n.id !== id) }));
      persist();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist, busyNoteId],
  );
  const stopNote = useCallback(() => noteCtl.current?.abort(), []);

  // Number notes in the order they were made, per chat.
  const notesByMessage = useMemo(() => {
    const map = new Map<string, Array<{ note: Note; number: number }>>();
    [...chat.notes]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((note, i) => {
        const list = map.get(note.messageId) ?? [];
        list.push({ note, number: i + 1 });
        map.set(note.messageId, list);
      });
    return map;
  }, [chat.notes]);
  const empty: Array<{ note: Note; number: number }> = useMemo(() => [], []);

  return (
    <div
      className={"chat" + (dragging ? " is-dragging" : "")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        setDropped(Array.from(e.dataTransfer.files));
      }}
    >
      <div
        className="scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {chat.messages.length === 0 ? (
          <div className="empty">
            <h1>What are you studying?</h1>
            <p>
              Ask a question, or paste a screenshot, PDF or your notes. When something in an answer is unclear,
              <strong> select it and press Reply</strong>. The answer opens in a side note, so the main chat stays clean.
            </p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => sendMain(s, [])}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {chat.messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                notes={notesByMessage.get(m.id) ?? empty}
                generating={generatingId === m.id}
                busyNoteId={busyNoteId}
                onToggleNote={toggleNote}
                onDeleteNote={deleteNote}
                onFollowUp={followUp}
                onStopNote={stopNote}
              />
            ))}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <InputBox
            id="composer-text"
            placeholder="Ask anything, or paste a screenshot or notes"
            busy={generatingId !== null}
            onSend={sendMain}
            onStop={() => mainCtl.current?.abort()}
            dropped={dropped}
            onDroppedHandled={() => setDropped(null)}
            autoFocus={chat.messages.length === 0}
          />
        </div>
        <p className="hint">Select text in an answer to ask about it in a side note.</p>
      </div>
      <SelectionReply scope={scrollRef} disabled={false} onAsk={askAboutPassage} />
      {dragging && <div className="drop-overlay">Drop files to attach them</div>}
    </div>
  );
}
