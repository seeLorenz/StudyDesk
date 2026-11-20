import { useEffect, useRef, useState } from "react";
import { Markdown } from "../chat/Markdown";
import { followUpdateCheck, startUpdateCheck } from "../platform/updateStore";
import { UpdateNotice, useUpdateState } from "./UpdateCards";
import { whatsNewList, type UpdateCheck } from "./plan";
import { APP_VERSION } from "./version";

// The small version label next to "StudyDesk" in the sidebar, and the panel it
// opens: check for updates right now (a quick cloud session instead of
// waiting for the nightly run), update, and read what's new.
// design/updates.md, "Checking by hand".

const label = APP_VERSION === "dev" ? "dev" : APP_VERSION;

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString("en", { day: "numeric", month: "short" });
}

export function VersionLabel() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="version" ref={box}>
      <button type="button" className="version-label" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Version, updates and what's new">
        {label}
      </button>
      {open && <VersionPanel />}
    </div>
  );
}

function VersionPanel() {
  const { doc, release } = useUpdateState();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // A check started earlier (or in another view) is followed here too.
  useEffect(() => {
    if (doc?.check && !check) setCheck(doc.check);
  }, [doc?.check]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!check) return;
    let stop = false;
    const tick = async () => {
      const r = await followUpdateCheck(check).catch((e) => ({ status: "failed" as const, line: null, release: null, error: (e as Error).message }));
      if (stop) return;
      if (r.status === "working") return setLine(r.line);
      setCheck(null);
      setLine(null);
      if (r.status === "failed") setError(`The check didn't work: ${r.error}`);
      else setResult(r.release ? null : "No release has been published yet.");
    };
    void tick();
    const t = setInterval(() => void tick(), 8_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [check]);

  const start = async () => {
    setError(null);
    setResult(null);
    try {
      setCheck(await startUpdateCheck(setLine));
    } catch (e) {
      setLine(null);
      setError((e as Error).message);
    }
  };

  const news = whatsNewList(APP_VERSION, release);
  const md = (_id: string, text: string) => <Markdown text={text} />;
  return (
    <div className="version-panel" role="dialog" aria-label="StudyDesk version">
      <p className="version-title">
        StudyDesk <strong>{label}</strong>
      </p>
      <UpdateNotice md={md} always notes={false} />
      <div className="version-check">
        <button type="button" className="mini-btn" disabled={!!check} onClick={() => void start()}>
          {check ? "Checking…" : "Check for updates"}
        </button>
        <span className="quest-muted">{line ?? (release?.checkedAt ? `Checked ${ago(release.checkedAt)}` : "Takes a minute or two")}</span>
      </div>
      {error && <p className="quest-error">{error}</p>}
      {result && <p className="quest-muted">{result}</p>}
      <h3 className="version-head">What's new</h3>
      {news.length === 0 ? (
        <p className="quest-muted">Check for updates to see the notes for this version and newer ones.</p>
      ) : (
        <ul className="version-news">
          {news.map((r) => (
            <li key={r.version}>
              <p className="version-news-title">
                {r.version}
                {r.installed && <span className="version-installed">installed</span>}
              </p>
              {r.notes ? <Markdown text={r.notes} /> : <p className="quest-muted">No notes for this version.</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
