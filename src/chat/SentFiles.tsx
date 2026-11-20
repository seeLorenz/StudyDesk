import { useState } from "react";
import { FileIcon } from "./FileIcon";

// The files a message carried, as compact chips inside the bubble: long names
// are cut short (the full name shows on hover), and a long list folds after a
// few chips so a big drop doesn't fill the screen.

const SHOWN = 6;

export function SentFiles({ names }: { names: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all || names.length <= SHOWN + 1 ? names : names.slice(0, SHOWN);
  return (
    <div className="bubble-files">
      {shown.map((n, i) => (
        <span key={`${i}-${n}`} className="file-chip static" title={n}>
          <FileIcon kind={/\.pdf$/i.test(n) ? "pdf" : "file"} />
          <span className="file-name">{n}</span>
        </span>
      ))}
      {shown.length < names.length && (
        <button type="button" className="file-chip static file-more" onClick={() => setAll(true)}>
          {names.length - shown.length} more
        </button>
      )}
    </div>
  );
}
