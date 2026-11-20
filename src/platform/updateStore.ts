// Storage side of updates: the update state, backups in the artifact's file
// store, and writing a whole snapshot back. design/updates.md.
//
// Uses the runtime directly (host({ raw: true })), because it must still work
// while the rest of the page is read-only.

import { host } from "./host";
import { checkHandoff, jobProgress, readJobDoc, removeJob, startJob, type HandoffSetup, type JobProgress } from "./handoff";
import { readSnapshot } from "./backup";
import { contentTypeOf, ImportError, parseBackupZip, prepareImport, relink } from "../updates/importZip";
import { countDocs, diffSnapshots, toSnapshot, type Snapshot, type SnapshotWrite } from "../updates/layout";
import { dataVersionOf, upgrade } from "../updates/migrations";
import { validateSnapshot } from "../updates/validate";
import { emptyUpdates, keepBackups, planLoad, publishJobBody, UPDATE_TIMEOUT_MS, readUpdates, type Backup, type Failure, type Pending, type ReleaseDoc, type UpdatesDoc } from "../updates/plan";
import { APP_VERSION, DATA_VERSION } from "../updates/version";

export type UpdateEnv = { db: DB; uid: string; assets: Claude.Assets | null };

let envPromise: Promise<UpdateEnv | null> | null = null;

/** The student's database and file store, or null outside claude.ai (local preview: no updates). */
export function updateEnv(): Promise<UpdateEnv | null> {
  if (!envPromise)
    envPromise = (async () => {
      const c = host({ raw: true });
      if (!c) return null;
      const [db, user, assets] = await Promise.all([c.use("db").catch(() => null), c.use("user").catch(() => null), c.use("assets").catch(() => null)]);
      const uid = user ? await user.id().catch(() => null) : null;
      return db && uid ? { db, uid, assets } : null;
    })();
  return envPromise;
}

const plain = <T>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;
const ref = (e: UpdateEnv, path: string) => e.db.doc(`data/users/${e.uid}/${path}`);

export async function loadUpdates(e: UpdateEnv): Promise<UpdatesDoc> {
  const s = await ref(e, "updates").get();
  return s.exists ? readUpdates(s.data()) : emptyUpdates();
}

/** Changes the update state (read, change, write). */
export async function changeUpdates(e: UpdateEnv, fn: (d: UpdatesDoc) => UpdatesDoc): Promise<UpdatesDoc> {
  const next = { ...fn(await loadUpdates(e)), updatedAt: Date.now() };
  await ref(e, "updates").set(plain(next));
  return next;
}

export async function loadRelease(e: UpdateEnv): Promise<ReleaseDoc | null> {
  const s = await ref(e, "release").get();
  const d = s.exists ? (s.data() as Partial<ReleaseDoc>) : null;
  return d && typeof d.latest === "string" ? { latest: d.latest, notes: typeof d.notes === "string" ? d.notes : null, dataVersion: typeof d.dataVersion === "number" ? d.dataVersion : null, checkedAt: Number(d.checkedAt) || 0 } : null;
}

// ---------- backups ----------

/**
 * Saves a full copy of the student's data as a JSON file in the artifact's
 * file store, keeps the newest three and removes older ones. Course files
 * aren't copied: they're already in the store and updates never touch them.
 */
export async function makeBackup(e: UpdateEnv, onProgress?: (line: string) => void): Promise<Backup> {
  if (!e.assets) throw new Error("This view can't store files, so no backup can be made. Open StudyDesk on claude.ai to update.");
  onProgress?.("Saving a backup of your data…");
  const snapshot = await readSnapshot(e.db, e.uid);
  const dataVersion = dataVersionOf(snapshot);
  const text = JSON.stringify({ kind: "studydesk-backup", appVersion: APP_VERSION, dataVersion, at: new Date().toISOString(), ...snapshot });
  const blob = new Blob([text], { type: "application/json" });
  let up: Claude.assets.UploadResult;
  try {
    up = await e.assets.upload(blob, { type: "application/json" });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    throw new Error(code === "too_large" ? "Your data is too large for one backup file (over 20 MB). Export everything from Setup first." : `The backup couldn't be saved (${(err as Error)?.message ?? code}).`);
  }
  const backup: Backup = { assetId: up.id, appVersion: APP_VERSION, dataVersion, at: Date.now(), bytes: up.sizeBytes };
  let drop: Backup[] = [];
  await changeUpdates(e, (d) => {
    const k = keepBackups(d.backups, backup);
    drop = k.drop;
    return { ...d, backups: k.keep };
  });
  for (const b of drop) await e.assets.delete(b.assetId).catch(() => undefined);
  return backup;
}

export async function loadBackup(assetId: string): Promise<Snapshot> {
  const res = await fetch(`/_blob/${assetId}`);
  if (!res.ok) throw new Error(`The backup couldn't be read (${res.status}).`);
  return toSnapshot(await res.json());
}

// ---------- writing ----------

/** Applies writes one by one. On a failure it throws with how many were already saved. */
export async function applyWrites(e: UpdateEnv, writes: SnapshotWrite[], onProgress?: (line: string) => void): Promise<void> {
  let done = 0;
  try {
    for (const w of writes) {
      const r = ref(e, w.path.join("/"));
      if (w.data) await r.set(plain(w.data));
      else await r.delete();
      done++;
      if (onProgress && (done % 25 === 0 || done === writes.length)) onProgress(`Saving (${done} of ${writes.length})…`);
    }
  } catch (err) {
    throw Object.assign(new Error((err as Error)?.message ?? String(err)), { saved: done });
  }
}

/** Every write that turns the stored data into `target`, leaving the update state itself alone. */
export function writesTo(current: Snapshot, target: Snapshot): SnapshotWrite[] {
  return diffSnapshots({ ...current, updates: null }, { ...target, updates: null });
}

// ---------- on load ----------

export type GateResult =
  | { kind: "ok" }
  | { kind: "read-only"; reason: "failed" | "rolling-back" | "newer-data" | "restore-failed"; message: string; goBack: string | null; pending: Pending | null; restoreFrom?: string | null };

/**
 * Runs before the app opens: finishes an update or a rollback that just
 * arrived, upgrades older data, and decides whether the page must stay
 * read-only. `onProgress` shows what's happening.
 */
export async function prepareOnLoad(onProgress: (line: string) => void): Promise<GateResult> {
  const e = await updateEnv();
  if (!e) return { kind: "ok" };
  const doc = await loadUpdates(e);
  const plan = planLoad(APP_VERSION, doc);
  if (plan.kind === "ok") return { kind: "ok" };

  if (plan.kind === "rolling-back")
    return { kind: "read-only", reason: "rolling-back", message: `Going back to ${plan.pending.to}. Your StudyDesk reloads by itself when it's there.`, goBack: plan.pending.to, pending: plan.pending };

  if (plan.kind === "newer-data")
    return { kind: "read-only", reason: "newer-data", message: `Your data was saved by a newer StudyDesk (data version ${plan.dataVersion}) than this one (${APP_VERSION}). You can look around, but nothing is saved until StudyDesk is updated again.`, goBack: null, pending: null };

  if (plan.kind === "finish-rollback") {
    const p = plan.pending;
    try {
      let dataVersion = doc.dataVersion;
      if (p.restore && p.backupId) {
        onProgress("Putting your data back as it was before the update…");
        const backup = await loadBackup(p.backupId);
        await applyWrites(e, writesTo(await readSnapshot(e.db, e.uid), backup), onProgress);
        dataVersion = dataVersionOf(backup);
      }
      await changeUpdates(e, (d) => ({
        ...d,
        dataVersion,
        pending: null,
        failure: null,
        lastUpdate: { kind: "rollback", from: p.from, to: APP_VERSION, at: Date.now(), backupId: p.backupId, notes: null, ran: [], announced: false },
      }));
      if (p.jobId) await removeJob(p.jobId);
      return { kind: "ok" };
    } catch (err) {
      return { kind: "read-only", reason: "restore-failed", message: `StudyDesk is back on ${APP_VERSION}, but your data couldn't be put back: ${(err as Error).message} Nothing else was changed; reload to try again.`, goBack: null, pending: p };
    }
  }

  // Upgrade (or just check, right after a new version arrived).
  const p = plan.pending;
  const target = p?.to ?? APP_VERSION;
  let saved = 0;
  let backupId = p?.backupId ?? null;
  try {
    onProgress(p ? `Finishing the update to ${APP_VERSION}…` : "Upgrading your data…");
    if (plan.from < DATA_VERSION && !backupId) backupId = (await makeBackup(e, onProgress)).assetId;
    const before = await readSnapshot(e.db, e.uid);
    const up = upgrade(before, plan.from);
    if (!up.ok) throw new Error(up.error);
    onProgress("Checking your data…");
    const check = validateSnapshot(up.snapshot);
    if (!check.ok) throw new Error(`Some data doesn't fit this version: ${check.problems.slice(0, 5).join("; ")}${check.problems.length > 5 ? "; …" : ""}.`);
    const writes = writesTo(before, up.snapshot);
    try {
      await applyWrites(e, writes, onProgress);
    } catch (err) {
      saved = (err as { saved?: number }).saved ?? 0;
      throw err;
    }
    await changeUpdates(e, (d) => ({
      ...d,
      dataVersion: DATA_VERSION,
      pending: null,
      failure: null,
      lastUpdate: p
        ? { kind: "update", from: p.from, to: APP_VERSION, at: Date.now(), backupId, notes: p.notes ?? null, ran: up.ran, announced: false }
        : d.lastUpdate,
    }));
    if (p?.jobId) await removeJob(p.jobId);
    return { kind: "ok" };
  } catch (err) {
    const failure: Failure = { from: p?.from ?? doc.lastUpdate?.from ?? "", to: target, at: Date.now(), error: (err as Error)?.message ?? String(err), partial: saved > 0 || !!doc.failure?.partial, backupId };
    await changeUpdates(e, (d) => ({ ...d, pending: null, failure })).catch(() => undefined);
    const back = failure.from && failure.from !== APP_VERSION ? failure.from : null;
    return {
      kind: "read-only",
      reason: "failed",
      message: `This update didn't work: ${failure.error} Nothing was lost${failure.partial ? " (a backup from just before the update is kept)" : ""}. You can look around, but nothing is saved for now.`,
      goBack: back && /^v\d/.test(back) ? back : null,
      pending: null,
      restoreFrom: failure.partial ? failure.backupId : null,
    };
  }
}

// ---------- pressing the button ----------

const HANDOFF_COPY: Record<string, string> = {
  ask: "Allow StudyDesk to start Claude sessions first (the Connect button in Setup).",
  off: "Updates need Claude Code on the web: connect it in Setup first.",
  declined: "StudyDesk wasn't allowed to start a Claude session, so it can't update itself.",
  unavailable: "Claude sessions can't be started from this view. Open StudyDesk on claude.ai in a browser or the desktop app.",
};

async function readyHandoff(e: UpdateEnv): Promise<HandoffSetup> {
  const p = await ref(e, "profile").get();
  const saved = p.exists ? ((p.data() as { handoff?: HandoffSetup }).handoff ?? undefined) : undefined;
  const h = await checkHandoff(saved, true);
  if (h.kind !== "ready") throw new Error(HANDOFF_COPY[h.kind] ?? "Claude sessions aren't available.");
  return h.setup;
}

/**
 * "Update to vX": backup, then the student's own cloud session publishes the
 * release onto this same link. The page reloads by itself when it's there.
 */
export async function startUpdate(release: ReleaseDoc, onProgress: (line: string) => void): Promise<Pending> {
  const e = await updateEnv();
  if (!e) throw new Error("Updates only work inside StudyDesk on claude.ai.");
  onProgress("Checking that Claude sessions can start…");
  const setup = await readyHandoff(e);
  const backup = await makeBackup(e, onProgress);
  return fire(e, setup, { kind: "update", from: APP_VERSION, to: release.latest, jobId: null, startedAt: Date.now(), backupId: backup.assetId, notes: release.notes }, onProgress);
}

/**
 * "Go back to vX": the same hand-off with the older release. With `restore`,
 * the old version puts the backup's data back when it arrives (anything done
 * since the update is lost; the caller warns first).
 */
export async function startGoBack(to: string, restore: boolean, backupId: string | null, onProgress: (line: string) => void): Promise<Pending> {
  const e = await updateEnv();
  if (!e) throw new Error("Updates only work inside StudyDesk on claude.ai.");
  if (restore && !backupId) throw new Error("There's no backup from before the update, so going back would lose data.");
  onProgress("Checking that Claude sessions can start…");
  const setup = await readyHandoff(e);
  return fire(e, setup, { kind: "rollback", from: APP_VERSION, to, jobId: null, startedAt: Date.now(), backupId, restore }, onProgress);
}

async function fire(e: UpdateEnv, setup: HandoffSetup, pending: Pending, onProgress: (line: string) => void): Promise<Pending> {
  await changeUpdates(e, (d) => ({ ...d, pending }));
  onProgress("Starting a Claude session for the update…");
  try {
    const job = await startJob(setup, pending.kind === "update" ? `Update StudyDesk to ${pending.to}` : `Put StudyDesk back to ${pending.to}`, publishJobBody(pending.to, pending.kind));
    const next = { ...pending, jobId: job.jobId };
    await changeUpdates(e, (d) => ({ ...d, pending: next }));
    return next;
  } catch (err) {
    await changeUpdates(e, (d) => ({ ...d, pending: null })).catch(() => undefined);
    throw err;
  }
}

/** Where the publishing session stands. Clears the pending update when it failed, so the button comes back. */
export async function checkPublishJob(pending: Pending): Promise<JobProgress> {
  const doc = pending.jobId ? await readJobDoc(pending.jobId).catch(() => null) : null;
  const at = Number((doc?.updatedAt as number) ?? 0) || pending.startedAt;
  const p = pending.jobId ? jobProgress(doc, { startedAt: pending.startedAt, changedAt: at }, Date.now()) : { status: "failed" as const, log: [], answer: null, error: "The update never started.", artifactUrl: null };
  const stale = p.status !== "done" && p.status !== "failed" && Date.now() - pending.startedAt > UPDATE_TIMEOUT_MS;
  if (p.status === "failed" || stale) {
    const e = await updateEnv();
    if (e) await changeUpdates(e, (d) => (d.pending?.startedAt === pending.startedAt ? { ...d, pending: null } : d)).catch(() => undefined);
    if (pending.jobId) await removeJob(pending.jobId);
    return stale ? { ...p, status: "failed", error: "The update session stopped without publishing." } : p;
  }
  return p;
}

/** After the what's-new note is posted. */
export async function markAnnounced(): Promise<void> {
  const e = await updateEnv();
  if (e) await changeUpdates(e, (d) => (d.lastUpdate ? { ...d, lastUpdate: { ...d.lastUpdate, announced: true } } : d));
}

// ---------- restoring an exported zip ----------

export type ImportSummary = { documents: number; files: number; notRestored: string[] };

/**
 * Restores an "Export everything" zip into this StudyDesk, replacing what's
 * here (a backup of what's here is saved first). The page reloads afterwards.
 */
export async function importBackup(zip: Uint8Array, onProgress: (line: string) => void): Promise<ImportSummary> {
  onProgress("Opening the backup…");
  const parsed = parseBackupZip(zip);
  const e = await updateEnv();
  if (parsed.mode === "local") {
    if (e) throw new ImportError("This backup was made in a local preview, not on claude.ai, so it can't be restored here.");
    if (parsed.dataVersion > DATA_VERSION) throw new ImportError("This backup comes from a newer StudyDesk. Update this one first.");
    for (const [k, v] of Object.entries(parsed.data)) if (k.startsWith("studydesk.")) localStorage.setItem(k, JSON.stringify(v));
    return { documents: Object.keys(parsed.data).length, files: 0, notRestored: [] };
  }
  if (!e) throw new ImportError("Restoring needs StudyDesk on claude.ai.");
  const ready = prepareImport(parsed);
  if (!ready.ok) throw new ImportError(ready.error);
  // What's here now is kept as a backup first, in case this wasn't the right zip.
  await makeBackup(e, onProgress);

  const newIds = new Map<string, string>();
  const notRestored: string[] = [];
  for (const [i, f] of parsed.files.entries()) {
    onProgress(`Putting your files back (${i + 1} of ${parsed.files.length})…`);
    const name = f.path.split("/").pop() ?? f.path;
    const type = contentTypeOf(name);
    if (!type || !e.assets) {
      notRestored.push(name);
      continue;
    }
    try {
      const up = await e.assets.upload(new Blob([f.bytes], { type }), { type });
      newIds.set(f.oldAssetId, up.id);
    } catch {
      notRestored.push(name);
    }
  }
  const target = relink(ready.snapshot, newIds);
  onProgress("Restoring your data…");
  const current = await readSnapshot(e.db, e.uid);
  const writes = writesTo(current, target);
  await applyWrites(e, writes, onProgress);
  await changeUpdates(e, (d) => ({ ...d, dataVersion: DATA_VERSION, pending: null, failure: null, lastUpdate: null }));
  return { documents: countDocs(target), files: newIds.size, notRestored };
}
