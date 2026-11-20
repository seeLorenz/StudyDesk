import { keepFraction, type KeepProgress } from "../lib/keep";

// Progress while a drop is kept in the page (zips opened file by file): one
// bar for the whole drop, and a row per part (the loose files, each zip) that
// says whether it's waiting, being read, done or failed.

export function ImportProgress({ progress }: { progress: KeepProgress }) {
  const pct = Math.round(keepFraction(progress) * 100);
  const done = progress.items.filter((i) => i.state === "done" || i.state === "failed").length;
  return (
    <div className="import" role="status" aria-live="polite">
      <div className="import-head">
        <strong>Reading your files</strong>
        <span>
          {progress.items.length > 1 ? `${done} of ${progress.items.length} · ` : ""}
          {pct}%
        </span>
      </div>
      <div className="import-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ul className="import-list">
        {progress.items.map((i, k) => (
          <li key={k} className={`is-${i.state}`} title={i.name}>
            <span className="import-icon" aria-hidden="true">
              {i.state === "done" ? "✓" : i.state === "failed" ? "!" : i.state === "working" ? <span className="import-spin" /> : "·"}
            </span>
            <span className="import-name">{i.name}</span>
            <span className="import-count">
              {i.state === "failed"
                ? i.note ?? "couldn't be read"
                : i.state === "waiting"
                  ? "waiting"
                  : i.state === "done"
                    ? `${i.done} ${i.done === 1 ? "file" : "files"}${i.problems ? `, ${i.problems} with problems` : ""}`
                    : i.total
                      ? `${i.done} of ${i.total}`
                      : "opening…"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
