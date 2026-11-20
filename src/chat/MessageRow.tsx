import { memo } from "react";
import type { Message, Note } from "./types";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
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
  if (message.role === "user") {
    return (
      <div className="row row-user" data-msg={message.id}>
        <div className="bubble">
          {message.attachments?.length ? (
            <div className="bubble-files">
              {message.attachments.map((a) =>
                a.thumb ? (
                  <img key={a.id} src={a.thumb} alt={a.name} className="bubble-thumb" />
                ) : (
                  <span key={a.id} className="file-chip static" title={a.name}>
                    <FileIcon kind={a.kind} />
                    <span className="file-name">{a.name}</span>
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
      <AnnotatedMarkdown
        blockId={message.id}
        text={message.text}
        notes={notes}
        selectable={!generating}
        busyNoteId={busyNoteId}
        onToggleNote={onToggleNote}
        onDeleteNote={onDeleteNote}
        onFollowUp={onFollowUp}
        onStopNote={onStopNote}
      />
      {generating && !message.text && <p className="thinking">Thinking…</p>}
      {message.error && <p className="error-line">{message.error}</p>}
    </div>
  );
});
