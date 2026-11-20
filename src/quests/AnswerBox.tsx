import { useRef, useState } from "react";
import { FileIcon } from "../chat/FileIcon";
import { readAttachment } from "../lib/files";
import type { AnswerFile } from "./types";

// The answer box of one quest problem. Like every input in StudyDesk it takes
// typed text, pasted or dropped images, PDFs and text files. Unlike the chat
// box it keeps what was written until the part is handed in.

type Props = {
  id: string;
  text: string;
  files: AnswerFile[];
  disabled?: boolean;
  onText: (text: string) => void;
  /** New files, with the image bytes (kept in memory only, for grading). */
  onAddFile: (file: AnswerFile, blob?: Blob) => void;
  onRemoveFile: (id: string) => void;
  onActivity: () => void;
};

export function AnswerBox({ id, text, files, disabled, onText, onAddFile, onRemoveFile, onActivity }: Props) {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  const add = (list: File[]) => {
    onActivity();
    for (const file of list) {
      const tmp = Math.random().toString(36).slice(2);
      setReading((r) => [...r, tmp]);
      readAttachment(file).then((a) => {
        setReading((r) => r.filter((x) => x !== tmp));
        if (a.status === "error") {
          setError(a.error ?? "That file couldn't be read.");
          return;
        }
        setError(null);
        onAddFile({ id: a.id, name: a.name, kind: a.kind, text: a.text, thumb: a.thumb }, a.blob);
      });
    }
  };

  return (
    <div
      className={"answer" + (over ? " is-over" : "") + (disabled ? " is-disabled" : "")}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (disabled || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        add(Array.from(e.dataTransfer.files));
      }}
    >
      <textarea
        id={id}
        value={text}
        disabled={disabled}
        rows={4}
        placeholder="Write your answer, or paste or drop a photo of your work"
        aria-label="Your answer"
        onFocus={onActivity}
        onChange={(e) => {
          onActivity();
          onText(e.target.value);
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            add(pasted);
          }
        }}
      />
      <div className="answer-foot">
        {files.map((f) => (
          <span key={f.id} className="file-chip" title={f.name}>
            {f.thumb ? <img src={f.thumb} alt="" /> : <FileIcon kind={f.kind} />}
            <span className="file-name">{f.name}</span>
            {!disabled && (
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onRemoveFile(f.id)}>
                ×
              </button>
            )}
          </span>
        ))}
        {reading.length > 0 && <span className="answer-note">Reading file…</span>}
        {error && <span className="answer-note is-error">{error}</span>}
        {!disabled && (
          <button type="button" className="mini-btn" onClick={() => pickRef.current?.click()}>
            Attach photo or file
          </button>
        )}
        <input
          ref={pickRef}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.md,.tex"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
