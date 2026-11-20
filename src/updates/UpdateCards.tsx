import { useCallback, useEffect, useState } from "react";
import { checkPublishJob, loadRelease, loadUpdates, RELEASE_EVENT, startGoBack, startUpdate, updateEnv } from "../platform/updateStore";
import { goBackTarget, offer, type Pending, type ReleaseDoc, type UpdatesDoc } from "./plan";
import { APP_VERSION } from "./version";

// The update notice in the StudyDesk chat (Organize) and the "go back" card.
// design/updates.md: nothing updates until the student presses the button.

type Md = (id: string, text: string) => JSX.Element;

/** Update state, re-read every few minutes (the nightly run writes the release note). */
export function useUpdateState(): { doc: UpdatesDoc | null; release: ReleaseDoc | null; reload: () => Promise<void> } {
  const [doc, setDoc] = useState<UpdatesDoc | null>(null);
  const [release, setRelease] = useState<ReleaseDoc | null>(null);
  const reload = useCallback(async () => {
    const e = await updateEnv();
    if (!e) return;
    const [d, r] = await Promise.all([loadUpdates(e), loadRelease(e)]);
    setDoc(d);
    setRelease(r);
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
    const t = setInterval(() => void reload().catch(() => undefined), 5 * 60_000);
    // A "Check for updates" just saved a new release note.
    const now = () => void reload().catch(() => undefined);
    window.addEventListener(RELEASE_EVENT, now);
    return () => {
      clearInterval(t);
      window.removeEventListener(RELEASE_EVENT, now);
    };
  }, [reload]);
  return { doc, release, reload };
}

/** "StudyDesk v1.1 is out" with its notes and the button, or the running update's progress. */
export function UpdateNotice({ md, always = false, notes = true }: { md: Md; always?: boolean; notes?: boolean }) {
  const { doc, release, reload } = useUpdateState();
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState(false);
  const pending = doc?.pending?.kind === "update" && doc.pending.from === APP_VERSION ? doc.pending : null;
  const next = doc ? offer(APP_VERSION, release, doc) : null;

  // Follow the session that publishes the update.
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const tick = async () => {
      const p = await checkPublishJob(pending).catch(() => null);
      if (stop || !p) return;
      if (p.status === "failed") {
        setError(`The update didn't go through, and nothing changed: ${p.error} You can try again.`);
        setLine(null);
        void reload();
      } else if (p.status === "done") {
        setPublished(true);
        setLine(null);
      } else setLine(p.log[p.log.length - 1] ?? "Waiting for the Claude session to start…");
    };
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pending?.startedAt, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const press = async (r: ReleaseDoc) => {
    setBusy(true);
    setError(null);
    try {
      await startUpdate(r, setLine);
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setLine(null);
    } finally {
      setBusy(false);
    }
  };

  if (pending)
    return (
      <div className="update-card" role="status">
        <p>
          <strong>Updating to {pending.to}.</strong> {published ? "It's published. StudyDesk reloads by itself; if it doesn't, reload now." : "Your data stays as it is, and a backup was saved first. StudyDesk reloads by itself when the new version is there."}
        </p>
        {line && <p className="quest-muted">{line}</p>}
        {published && (
          <button type="button" className="mini-btn primary" onClick={() => location.reload()}>
            Reload now
          </button>
        )}
      </div>
    );
  if (!next) return always && doc ? <p className="quest-muted">You have the newest StudyDesk ({APP_VERSION}).</p> : null;
  return (
    <div className="update-card">
      <p>
        <strong>StudyDesk {next.latest} is out.</strong> You have {APP_VERSION === "dev" ? "a development version" : APP_VERSION}.
      </p>
      {notes && next.notes && <div className="update-notes">{md(`update-${next.latest}`, next.notes)}</div>}
      <p className="quest-muted">Your data stays: StudyDesk saves a backup first, and you can go back if anything goes wrong. A Claude session does the update; it takes a few minutes.</p>
      {line && <p className="quest-muted">{line}</p>}
      {error && <p className="quest-error">{error}</p>}
      <button type="button" className="mini-btn primary" disabled={busy} onClick={() => void press(next)}>
        Update to {next.latest}
      </button>
    </div>
  );
}

/** "Go back to v1.0": only after a warning, because anything done since the update is lost. */
export function GoBackCard() {
  const { doc } = useUpdateState();
  const [armed, setArmed] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<Pending | null>(null);
  if (!doc) return null;
  const to = goBackTarget(doc);
  const last = doc.lastUpdate;
  if (!to || !last || last.kind !== "update" || last.to !== APP_VERSION)
    return (
      <div className="update-card">
        <p>There's no earlier StudyDesk version to go back to from here.</p>
      </div>
    );
  const go = async () => {
    setError(null);
    try {
      setStarted(await startGoBack(to, true, last.backupId, setLine));
    } catch (e) {
      setError((e as Error).message);
      setLine(null);
    }
  };
  return (
    <div className="update-card is-confirm">
      <p>
        <strong>Go back to {to}?</strong> Your data goes back to how it was just before the update on {new Date(last.at).toLocaleDateString("en", { day: "numeric", month: "short" })}. Anything you did since then (answers, grades, chats, changes) is lost.
      </p>
      {line && <p className="quest-muted">{line}</p>}
      {error && <p className="quest-error">{error}</p>}
      {started ? (
        <p className="quest-muted">Going back. StudyDesk reloads by itself when it's done.</p>
      ) : (
        <button type="button" className={`mini-btn danger${armed ? " is-armed" : ""}`} onClick={() => (armed ? void go() : setArmed(true))}>
          {armed ? "Click again to go back for good" : `Go back to ${to}`}
        </button>
      )}
    </div>
  );
}
