import { useRef, useState } from "react";
import { importBackup, type ImportSummary } from "../platform/updateStore";

// "Restore from a backup" on a new StudyDesk's setup page (design/updates.md,
// "Import"): drop or pick the zip that "Export everything" saved.

export function RestoreBackup() {
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportSummary | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setLine("Opening the backup…");
    try {
      setDone(await importBackup(new Uint8Array(await file.arrayBuffer()), setLine));
      setLine(null);
    } catch (e) {
      setLine(null);
      setError((e as Error).message);
    }
  };

  if (done)
    return (
      <div className="update-card update-restore" role="status">
        <p>
          <strong>Your backup is restored</strong>
          {done.files ? `, with ${done.files} ${done.files === 1 ? "file" : "files"}` : ""}.
          {done.notRestored.length ? ` These files couldn't be put back, but what StudyDesk read from them is kept: ${done.notRestored.join(", ")}.` : ""}
        </p>
        <button type="button" className="mini-btn primary" onClick={() => location.reload()}>
          Open my StudyDesk
        </button>
      </div>
    );

  if (!open)
    return (
      <p className="quest-muted update-restore">
        Had StudyDesk before?{" "}
        <button type="button" className="link-btn" onClick={() => setOpen(true)}>
          Restore from a backup
        </button>
      </p>
    );

  return (
    <div
      className={"update-card update-restore" + (over ? " is-over" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void run(e.dataTransfer.files[0]);
      }}
    >
      <p>
        <strong>Restore from a backup.</strong> Drop the zip that "Export everything" saved, or pick it. Everything in it comes back: your semester, quests and answers, mastery and stats, chats and your files. What's in this StudyDesk now is replaced.
      </p>
      {line && <p className="quest-muted">{line}</p>}
      {error && <p className="quest-error">{error}</p>}
      <div className="update-actions">
        <button type="button" className="mini-btn primary" disabled={!!line} onClick={() => input.current?.click()}>
          Choose the zip
        </button>
        <button type="button" className="mini-btn" disabled={!!line} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => void run(e.target.files?.[0])} />
    </div>
  );
}
