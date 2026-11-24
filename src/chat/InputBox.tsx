import { useEffect, useRef, useState } from "react";
import { readAttachment, type PendingAttachment } from "../lib/files";
import { FileIcon } from "./FileIcon";

// The one input used everywhere in StudyDesk (main chat, Reply popover,
// follow-ups in side notes): type, paste, drop or attach anything.

type Props = {
  id: string;
  placeholder: string;
  busy?: boolean;
  onSend: (text: string, attachments: PendingAttachment[]) => void;
  onStop?: () => void;
  /** Files dropped somewhere else (e.g. anywhere on the chat) to add to this box. */
  dropped?: File[] | null;
  onDroppedHandled?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
  /** "dark" for the floating Reply popover. */
  tone?: "default" | "dark";
  sendLabel?: string;
  /** Accept zips, videos and any other file as they are (boxes that keep course files). */
  keepAll?: boolean;
};

export function InputBox({
  id,
  placeholder,
  busy = false,
  onSend,
  onStop,
  dropped,
  onDroppedHandled,
  autoFocus,
  compact,
  tone = "default",
  sendLabel = "Send",
  keepAll = false,
}: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [over, setOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const maxH = compact ? 140 : 240;

  const addFiles = (list: File[]) => {
    for (const file of list) {
      const placeholderFile: PendingAttachment = { id: Math.random().toString(36).slice(2), name: file.name || "pasted file", kind: "text", status: "reading" };
      setFiles((f) => [...f, placeholderFile]);
      readAttachment(file, { keepAll }).then((a) => setFiles((f) => f.map((x) => (x.id === placeholderFile.id ? a : x))));
    }
  };

  useEffect(() => {
    if (dropped?.length) {
      addFiles(dropped);
      onDroppedHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, maxH) + "px";
  }, [text, maxH]);

  const reading = files.some((f) => f.status === "reading");
  const ready = files.filter((f) => f.status === "ready");
  const canSend = !busy && !reading && (text.trim().length > 0 || ready.length > 0);

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), ready);
    setText("");
    setFiles([]);
  };

  return (
    <form
      className={"inputbox" + (compact ? " is-compact" : "") + (tone === "dark" ? " is-dark" : "") + (over ? " is-over" : "")}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {files.length > 0 && (
        <div className="inputbox-files">
          {files.map((f) => (
            <span key={f.id} className={"file-chip" + (f.status === "error" ? " is-error" : "")} title={f.error || f.name}>
              {f.thumb ? <img src={f.thumb} alt="" /> : <FileIcon kind={f.kind} />}
              <span className="file-name">{f.status === "reading" ? `Reading ${f.name}…` : f.name}</span>
              {f.status === "error" && <span className="file-err">{f.error}</span>}
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="inputbox-row">
        <label className="icon-btn" aria-label="Attach files" title={keepAll ? "Attach files or course zips" : "Attach images, PDFs, Office or text files"}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M14.5 9.5l-5.3 5.3a3.2 3.2 0 01-4.5-4.5l6-6a2.1 2.1 0 013 3l-6 6a1 1 0 01-1.5-1.5l5.3-5.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <input
            id={`${id}-files`}
            className="file-pick"
            type="file"
            multiple
            accept={keepAll ? undefined : "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif,application/pdf,text/*,.md,.csv,.json,.tex,.py,.js,.ts,.java,.c,.cpp,.docx,.pptx,.xlsx,.odt,.odp,.ods"}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </label>
        <textarea
          id={id}
          ref={taRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(pasted);
            }
          }}
        />
        {busy && onStop ? (
          <button type="button" className="send-btn stop" onClick={onStop} aria-label="Stop answering">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button type="submit" className="send-btn" disabled={!canSend} aria-label={sendLabel}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
