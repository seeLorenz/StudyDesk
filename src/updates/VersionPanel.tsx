import { useEffect, useRef, useState } from "react";
import { Markdown } from "../chat/Markdown";
import { followUpdateCheck, startSwitch, startUpdateCheck, type SwitchTarget } from "../platform/updateStore";
import { UpdateNotice, useUpdateState } from "./UpdateCards";
import { devBuilds, switchPlan, whatsNewList, type ReleaseDoc, type UpdateCheck, type UpdatesDoc } from "./plan";
import { APP_VERSION, BUILD_BRANCH, BUILD_COMMIT } from "./version";

// The small version label next to "StudyDesk" in the sidebar, and the panel it
// opens: check for updates right now (a quick cloud session instead of
// waiting for the nightly run), update, and read what's new.
// design/updates.md, "Checking by hand".

const label = APP_VERSION === "dev" ? (BUILD_COMMIT ? `dev · ${BUILD_COMMIT}` : "dev") : APP_VERSION;

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
  const { doc, release, reload } = useUpdateState();
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
        {BUILD_BRANCH && <span className="quest-muted"> from {BUILD_BRANCH}</span>}
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
      {doc && <DevSection doc={doc} release={release} reload={reload} />}
    </div>
  );
}

/**
 * For developers (folded away so students don't trip over it): switch to any
 * release, higher or lower, or to the newest build of any branch. Every push
 * to a branch is built into the releases branch (design/updates.md). The same
 * hand-off as an update: a backup first, the same link. A target that expects
 * older data puts back an old enough backup, after a warning (switchPlan).
 */
function DevSection({ doc, release, reload }: { doc: UpdatesDoc; release: ReleaseDoc | null; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const builds = devBuilds(release);
  const releases = release?.releases ?? [];
  const going = doc.pending ? (doc.pending.label ?? doc.pending.to) : null;

  const press = async (t: SwitchTarget) => {
    setBusy(t.folder);
    setArmed(null);
    setError(null);
    try {
      await startSwitch(t, setLine);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLine(null);
      setBusy(null);
    }
  };

  const row = (t: SwitchTarget, name: JSX.Element, meta: string | null, current: boolean) => {
    const plan = switchPlan(t.dataVersion, doc);
    const restoreDay = plan.kind === "restore" ? new Date(plan.backup.at).toLocaleDateString("en", { day: "numeric", month: "short" }) : null;
    return (
      <li key={t.folder} className="version-dev-row">
        <div className="version-dev-name">
          {name}
          {meta && <span className="quest-muted"> {meta}</span>}
          {plan.kind === "restore" && !current && armed === t.folder && (
            <p className="quest-error">This expects older data: your data goes back to the backup from {restoreDay}. Anything done since is lost.</p>
          )}
          {plan.kind === "blocked" && !current && <p className="quest-muted">{plan.reason}</p>}
        </div>
        {current ? (
          <span className="version-installed">running</span>
        ) : plan.kind === "blocked" ? null : (
          <button
            type="button"
            className={`mini-btn${plan.kind === "restore" ? " danger" : ""}${armed === t.folder ? " is-armed" : ""}`}
            disabled={!!busy || !!going}
            onClick={() => (plan.kind === "restore" && armed !== t.folder ? setArmed(t.folder) : void press(t))}
          >
            {busy === t.folder ? "Starting…" : armed === t.folder ? "Click again to load" : "Load"}
          </button>
        )}
      </li>
    );
  };

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null);
  return (
    <details className="version-dev">
      <summary>For developers</summary>
      <p className="quest-muted">Switch to any version or branch, up or down. A backup is saved first every time.</p>
      {going && <p className="quest-muted">Loading {going}. StudyDesk reloads by itself when it's there.</p>}
      <h4 className="version-dev-head">Branches</h4>
      <p className="version-caution" role="note">
        <strong>Caution:</strong> branch builds are work in progress. They haven't been reviewed or released, may be broken, and may change how your data is saved. Use them to try a change, not for real studying. If something goes wrong, load a release again. A backup of your data is saved before every switch.
      </p>
      {builds.length === 0 ? (
        <p className="quest-muted">No branch builds known yet. Check for updates to look for them.</p>
      ) : (
        <ul className="version-dev-list">
          {builds.map((b) =>
            row(
              { folder: b.folder, branch: b.branch, dataVersion: b.dataVersion, notes: b.notes },
              <>
                <strong>{b.branch}</strong> <code>{b.commit}</code>
              </>,
              [when(b.builtAt), b.notes?.split("\n")[0]].filter(Boolean).join(" · ") || null,
              !!BUILD_COMMIT && BUILD_COMMIT === b.commit,
            ),
          )}
        </ul>
      )}
      <h4 className="version-dev-head">Releases</h4>
      {releases.length === 0 ? (
        <p className="quest-muted">No releases known yet. Check for updates to look for them.</p>
      ) : (
        <ul className="version-dev-list">
          {releases.map((r) => row({ folder: r.version, dataVersion: r.dataVersion, notes: r.notes }, <strong>{r.version}</strong>, null, APP_VERSION === r.version))}
        </ul>
      )}
      {line && <p className="quest-muted">{line}</p>}
      {error && <p className="quest-error">{error}</p>}
    </details>
  );
}
