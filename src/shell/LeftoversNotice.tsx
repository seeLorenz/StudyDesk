import { useEffect, useState } from "react";
import { fmtMB, keepingNow } from "../lib/keep";
import { findLeftovers, removeLeftovers, type Leftovers } from "../platform/backup";

/**
 * Files left over from an import that didn't finish (the window closed or
 * crashed): nothing in the desk uses them, but they take up the file store.
 * Removed only when the student says so (design/course-files.md).
 */
export function LeftoversNotice({ onRemoved }: { onRemoved?: () => void }) {
  const [leftovers, setLeftovers] = useState<Leftovers | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    findLeftovers()
      .then((l) => live && setLeftovers(l && l.assetIds.length ? l : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!leftovers) return null;
  const n = leftovers.assetIds.length;
  return (
    <div className="leftovers">
      <p>
        {n} {n === 1 ? "file" : "files"} ({fmtMB(leftovers.bytes)}) are left over from an import that didn't finish. Nothing in your StudyDesk uses them.
      </p>
      <button
        type="button"
        className="mini-btn"
        disabled={!!status && status !== "Wait until the files you dropped are kept, then try again."}
        onClick={async () => {
          if (keepingNow()) {
            setStatus("Wait until the files you dropped are kept, then try again.");
            return;
          }
          setStatus("Removing…");
          try {
            await removeLeftovers(leftovers, setStatus);
            setLeftovers(null);
            setStatus(null);
            onRemoved?.();
          } catch {
            setStatus("They couldn't all be removed. Try again in a moment.");
          }
        }}
      >
        Remove them
      </button>
      {status && <p className="quest-muted">{status}</p>}
    </div>
  );
}
