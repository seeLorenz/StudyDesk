// The update flow's decisions, as plain functions. design/updates.md.
//
// Two small documents next to the student's data hold its state:
//   data/users/<uid>/updates   written by the page: data version, backups, an update in progress, the last update
//   data/users/<uid>/release   written by the nightly run: the newest release and its notes
// They're separate from the profile on purpose: the profile is saved whole
// from many screens, and update state must never be lost to a stale copy.

import { compareVersions, DATA_VERSION, isRelease, RELEASE_BRANCH, RELEASE_REPO } from "./version";

export type Backup = { assetId: string; appVersion: string; dataVersion: number; at: number; bytes: number };

export type Pending = {
  kind: "update" | "rollback";
  /** The version that was running when the student pressed the button. */
  from: string;
  to: string;
  jobId: string | null;
  startedAt: number;
  /** The backup made just before this update (or the one a rollback restores). */
  backupId: string | null;
  /** Rollback only: put the backup's data back once the old version runs. */
  restore?: boolean;
  notes?: string | null;
};

export type LastUpdate = {
  kind: "update" | "rollback";
  from: string;
  to: string;
  at: number;
  backupId: string | null;
  notes: string | null;
  /** The upgrade steps that ran (data versions they started from). */
  ran: number[];
  /** The Orchestrator has posted its what's-new note. */
  announced: boolean;
};

/** An upgrade that didn't work. `partial`: some upgraded documents were already saved, so going back must restore the backup. */
export type Failure = { from: string; to: string; at: number; error: string; partial: boolean; backupId: string | null };

export type UpdatesDoc = {
  dataVersion: number;
  backups: Backup[];
  pending: Pending | null;
  lastUpdate: LastUpdate | null;
  failure: Failure | null;
  updatedAt: number;
};

export type ReleaseDoc = { latest: string; notes: string | null; dataVersion: number | null; checkedAt: number };

export const KEEP_BACKUPS = 3;
/** An update whose session never published counts as failed after this. */
export const UPDATE_TIMEOUT_MS = 45 * 60_000;

export function emptyUpdates(): UpdatesDoc {
  return { dataVersion: 1, backups: [], pending: null, lastUpdate: null, failure: null, updatedAt: 0 };
}

/** A stored document → a complete UpdatesDoc (missing fields filled in). */
export function readUpdates(x: unknown): UpdatesDoc {
  const o = (x && typeof x === "object" ? x : {}) as Partial<UpdatesDoc>;
  const v = Number(o.dataVersion);
  return {
    dataVersion: Number.isInteger(v) && v >= 1 ? v : 1,
    backups: Array.isArray(o.backups) ? o.backups.filter((b) => b && typeof b.assetId === "string") : [],
    pending: o.pending && typeof o.pending === "object" ? o.pending : null,
    lastUpdate: o.lastUpdate && typeof o.lastUpdate === "object" ? o.lastUpdate : null,
    failure: o.failure && typeof o.failure === "object" ? o.failure : null,
    updatedAt: Number(o.updatedAt) || 0,
  };
}

export type LoadPlan =
  /** Nothing to do. */
  | { kind: "ok" }
  /** A rollback arrived: restore the backup if asked, then record it. */
  | { kind: "finish-rollback"; pending: Pending }
  /** A rollback was started but the old version isn't here yet: stay read-only meanwhile. */
  | { kind: "rolling-back"; pending: Pending }
  /** Upgrade the data (when older) and check it. `pending` is the update that just arrived, if any. */
  | { kind: "upgrade"; from: number; pending: Pending | null }
  /** The data is newer than this version can read: read-only. */
  | { kind: "newer-data"; dataVersion: number };

/** What the page does on load, before anything else opens. Pure. */
export function planLoad(appVersion: string, doc: UpdatesDoc, dataVersion = DATA_VERSION): LoadPlan {
  const p = doc.pending;
  if (p?.kind === "rollback") return appVersion !== p.from ? { kind: "finish-rollback", pending: p } : { kind: "rolling-back", pending: p };
  if (doc.dataVersion > dataVersion) return { kind: "newer-data", dataVersion: doc.dataVersion };
  const arrived = p?.kind === "update" && appVersion !== p.from ? p : null;
  // An upgrade that failed on this version is tried again on every load until it works or the student goes back.
  const retry = doc.failure && doc.failure.to === appVersion;
  if (doc.dataVersion < dataVersion || arrived || retry) return { kind: "upgrade", from: doc.dataVersion, pending: arrived };
  return { kind: "ok" };
}

/** The update to offer, or null: a newer release this desk's data can move to. Pure. */
export function offer(appVersion: string, release: ReleaseDoc | null, doc: UpdatesDoc): ReleaseDoc | null {
  if (!release || !isRelease(release.latest)) return null;
  if (compareVersions(release.latest, appVersion) <= 0) return null;
  // A release that can't read this data (only possible coming from a dev build) isn't offered.
  if (release.dataVersion !== null && release.dataVersion < doc.dataVersion) return null;
  return release;
}

/** Which version "Go back" returns to, or null when there's none (the update started from a dev build). */
export function goBackTarget(doc: UpdatesDoc): string | null {
  const from = doc.pending?.kind === "update" ? doc.pending.from : doc.failure?.from ?? (doc.lastUpdate?.kind === "update" ? doc.lastUpdate.from : null);
  return from && isRelease(from) ? from : null;
}

/** The backups list after adding one: newest last, at most KEEP_BACKUPS. Returns the ones to delete too. Pure. */
export function keepBackups(list: Backup[], add: Backup): { keep: Backup[]; drop: Backup[] } {
  const all = [...list.filter((b) => b.assetId !== add.assetId), add].sort((a, b) => a.at - b.at);
  const cut = Math.max(0, all.length - KEEP_BACKUPS);
  return { keep: all.slice(cut), drop: all.slice(0, cut) };
}

// ---------- the job a cloud session does ----------

/**
 * What the student's own cloud session does to publish a release onto their
 * StudyDesk. Sent through the hand-off job (src/platform/handoff.ts), which
 * adds how to find the StudyDesk and how to report. Pure, tested.
 */
export function publishJobBody(tag: string, why: "update" | "rollback", repo = RELEASE_REPO): string {
  const dir = `<your scratchpad directory>/studydesk-releases`;
  return `${why === "update" ? `The student pressed "Update to ${tag}".` : `The update didn't work, and the student pressed "Go back to ${tag}".`} Put StudyDesk ${tag} onto the student's own StudyDesk link. Their data stays where it is: publishing to the same link replaces only the page and its program.

For this job you may clone into your scratchpad directory (nowhere else). Don't change the student's data except your job document.

1. Clone the release: git clone --depth 1 --branch ${RELEASE_BRANCH} https://github.com/${repo}.git ${dir}
   The folder ${dir}/${tag}/ must hold index.html, routine.mjs and capabilities.json. If it doesn't, report failed with "Release ${tag} isn't built yet."
   Add a log line "Downloaded ${tag}".
2. Read the student's StudyDesk first, because claude.ai refuses a publish to a link this session hasn't read: Artifact action "read" with the StudyDesk url. Don't look through what comes back; it's only needed once.
3. Publish onto that same url: Artifact action "publish" with
   - url: the StudyDesk url (never publish without it: that would make a new, empty StudyDesk),
   - file_path: ${dir}/${tag}/index.html,
   - files: {"routine.mjs": "${dir}/${tag}/routine.mjs"},
   - capabilities: the JSON object in ${dir}/${tag}/capabilities.json, exactly as it is.
   Nothing else: no title, no icon, no other files. If the publish is refused because the page changed since you read it, read it again and publish again. Add a log line "Published ${tag}".
4. Report done with the answer "Published ${tag}". The student's page reloads by itself and finishes the ${why === "update" ? "update" : "rollback"} there.`;
}
