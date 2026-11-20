import { useEffect, useState, type ReactNode } from "react";
import { setReadOnly } from "../platform/host";
import { checkPublishJob, prepareOnLoad, startGoBack, type GateResult } from "../platform/updateStore";
import type { Pending } from "./plan";

// Runs before StudyDesk opens (design/updates.md): finishes an update or a
// rollback that just arrived, upgrades older data and checks it. When that
// fails, StudyDesk still opens, but read-only, under a bar that explains what
// happened and offers to go back.

export function UpdateGate({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<GateResult | null>(null);
  const [line, setLine] = useState("Opening StudyDesk…");

  useEffect(() => {
    prepareOnLoad(setLine)
      .catch((e): GateResult => {
        // The check itself couldn't run (offline, a refused read): open normally; it runs again next time.
        console.warn("StudyDesk update check failed", e);
        return { kind: "ok" };
      })
      .then((r) => {
        setReadOnly(r.kind === "read-only" ? "StudyDesk is read-only until the update is sorted out." : null);
        setResult(r);
      });
  }, []);

  if (!result)
    return (
      <div className="update-gate">
        <span className="brand-mark" aria-hidden="true" />
        <p className="quest-muted">{line}</p>
      </div>
    );
  return (
    <>
      {result.kind === "read-only" && <ReadOnlyBar result={result} />}
      {children}
    </>
  );
}

function ReadOnlyBar({ result }: { result: Extract<GateResult, { kind: "read-only" }> }) {
  const [pending, setPending] = useState<Pending | null>(result.pending);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // While going back, follow the session; the page reloads by itself when it's done.
  useEffect(() => {
    if (!pending || pending.kind !== "rollback") return;
    let stop = false;
    const tick = async () => {
      const p = await checkPublishJob(pending).catch(() => null);
      if (stop || !p) return;
      if (p.status === "failed") {
        setPending(null);
        setLine(null);
        setError(`Going back didn't work: ${p.error}`);
      } else setLine(p.status === "done" ? "Done. Reload StudyDesk if it doesn't reload by itself." : p.log[p.log.length - 1] ?? "Waiting for the Claude session to start…");
    };
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [pending]);

  const goBack = async () => {
    if (!result.goBack) return;
    setError(null);
    try {
      // Only a failure that already saved some upgraded data needs the backup put back.
      const p = await startGoBack(result.goBack, !!result.restoreFrom, result.restoreFrom ?? null, setLine);
      setPending(p);
    } catch (e) {
      setLine(null);
      setError((e as Error).message);
    }
  };

  return (
    <div className="update-bar" role="alert">
      <p>
        <strong>{result.reason === "rolling-back" || pending?.kind === "rollback" ? "Going back" : "Read-only"}</strong> {pending?.kind === "rollback" && result.reason !== "rolling-back" ? `Going back to ${pending.to}. StudyDesk reloads by itself when it's there.` : result.message}
      </p>
      {line && <p className="quest-muted">{line}</p>}
      {error && <p className="quest-error">{error}</p>}
      <div className="update-actions">
        {result.goBack && !pending && (
          <button type="button" className="mini-btn primary" onClick={() => void goBack()}>
            Go back to {result.goBack}
          </button>
        )}
        <button type="button" className="mini-btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
