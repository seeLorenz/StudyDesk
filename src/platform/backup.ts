// Backing up a student's StudyDesk and clearing it for a fresh semester.
//
// The backup is one zip: every original file the student imported (from the
// artifact's file store) in files/, plus studydesk-data.json with everything
// StudyDesk keeps for them: profile, the semester and its setup (sheet,
// chat, to-do list), archived semesters, quests with answers and reviews,
// Ask chats, mastery and stats.
//
// A fresh start deletes the semester data but keeps what describes the
// student across semesters: profile, mastery and stats (attempts, timings,
// reviews), and optionally the Ask chats. It's only offered after a backup
// was saved.

import { host } from "./host";
import { zipSync, strToU8 } from "fflate";

import { COLLECTION_KINDS, COLLECTION_KIND_LIST, DOC_KINDS, DOC_KIND_LIST, emptySnapshot, type CollectionKind, type Snapshot } from "../updates/layout";
import { APP_VERSION } from "../updates/version";
import { dataVersionOf } from "../updates/migrations";

type CollectionKey = CollectionKind;

/** What a fresh start removes. Everything else stays. */
export const FRESH_START_REMOVES: CollectionKey[] = ["uploadContents", "archivedSemesters", "questRecords", "questReviews", "answerPhotos"];
export const FRESH_START_KEEPS = ["profile", "mastery", "stats"] as const;

const LOCAL_PREFIX = "studydesk.";

type Original = { assetId: string; fileName: string; courseName: string | null };

async function use<K extends string>(name: K) {
  const c = host();
  return c?.use ? await c.use(name as never).catch(() => null) : null;
}

async function cloud(): Promise<{ db: DB; uid: string; assets: Claude.Assets | null } | null> {
  const [db, user, assets] = await Promise.all([use("db"), use("user"), use("assets")]);
  const uid = user ? await (user as { id(): Promise<string> }).id().catch(() => null) : null;
  return db && uid ? { db: db as DB, uid, assets: assets as Claude.Assets | null } : null;
}

/** Every document StudyDesk keeps for this student, by kind (design/updates.md: the same set the update backup holds). */
export async function collectData(): Promise<Record<string, unknown>> {
  const c = await cloud();
  if (!c) {
    const out: Record<string, unknown> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith(LOCAL_PREFIX)) out[k] = JSON.parse(localStorage.getItem(k) ?? "null");
      }
    } catch {
      // nothing stored in this browser
    }
    return { mode: "local", data: out };
  }
  return { mode: "cloud", ...(await readSnapshot(c.db, c.uid)) };
}

/** Reads every kind in layout.ts for one student. */
export async function readSnapshot(db: DB, uid: string): Promise<Snapshot> {
  const base = `data/users/${uid}`;
  const out = emptySnapshot() as Record<string, unknown>;
  for (const key of DOC_KIND_LIST) {
    const s = await db.doc(`${base}/${DOC_KINDS[key]}`).get();
    out[key] = s.exists ? s.data() ?? null : null;
  }
  for (const key of COLLECTION_KIND_LIST) {
    const [doc, col] = COLLECTION_KINDS[key];
    const snap = await db.doc(`${base}/${doc}`).collection(col).get();
    out[key] = Object.fromEntries(snap.docs.filter((d) => d.exists).map((d) => [d.id, d.data()]));
  }
  return out as Snapshot;
}

/** The original files referenced by the setup, the semester and archived semesters. */
export function originalsIn(data: Record<string, unknown>): Original[] {
  const seen = new Map<string, Original>();
  const add = (uploads: unknown, courses: unknown) => {
    const names = new Map<string, string>();
    for (const c of (courses as Array<{ id: string; name: string }>) ?? []) names.set(c.id, c.name);
    for (const u of (uploads as Array<{ assetId?: string | null; fileName: string; courseId: string | null }>) ?? []) {
      if (u.assetId && !seen.has(u.assetId)) seen.set(u.assetId, { assetId: u.assetId, fileName: u.fileName, courseName: u.courseId ? names.get(u.courseId) ?? null : null });
    }
  };
  const setup = data.setup as { uploads?: unknown; courses?: unknown } | null;
  const semester = data.semester as { uploads?: unknown; courses?: unknown } | null;
  add(setup?.uploads, setup?.courses);
  add(semester?.uploads, semester?.courses);
  for (const s of Object.values((data.archivedSemesters as Record<string, { uploads?: unknown; courses?: unknown }>) ?? {})) add(s.uploads, s.courses);
  return [...seen.values()];
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "file";

/** Where each original file goes in the zip: files/<course>/<name>, numbered when two share a name. Pure. */
export function zipPaths(originals: Original[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const o of originals) {
    let path = `files/${o.courseName ? `${safe(o.courseName)}/` : ""}${safe(o.fileName)}`;
    for (let n = 2; used.has(path); n++) path = path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
    used.add(path);
    out.set(o.assetId, path);
  }
  return out;
}

/** Builds the backup zip. `onProgress` gets a short line per step. */
export async function buildBackup(onProgress?: (line: string) => void): Promise<{ zip: Uint8Array; files: number; missing: string[] }> {
  onProgress?.("Collecting your data…");
  const data = await collectData();
  const originals = originalsIn(data);
  const entries: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  const paths = zipPaths(originals);
  const manifest: Record<string, string> = {};
  for (const [i, o] of originals.entries()) {
    onProgress?.(`Adding your files (${i + 1} of ${originals.length})…`);
    try {
      const res = await fetch(`/_blob/${o.assetId}`);
      if (!res.ok) throw new Error(String(res.status));
      const path = paths.get(o.assetId)!;
      entries[path] = new Uint8Array(await res.arrayBuffer());
      manifest[path] = o.assetId;
    } catch {
      missing.push(o.fileName);
    }
  }
  // Which file was which, so an import can link the files back to their records.
  entries["files.json"] = strToU8(JSON.stringify(manifest, null, 2));
  entries["studydesk-data.json"] = strToU8(JSON.stringify({ exportedAt: new Date().toISOString(), appVersion: APP_VERSION, dataVersion: data.mode === "cloud" ? dataVersionOf(data as Snapshot) : 1, ...data }, null, 2));
  entries["README.txt"] = strToU8(
    `StudyDesk backup, ${new Date().toLocaleString("en")}\n\nfiles/  the original files you imported, by course\nstudydesk-data.json  everything StudyDesk kept for you: profile, semester and setup, archived semesters, quests with your answers, Ask chats, the StudyDesk chat and its memory, mastery and stats\n${missing.length ? `\nThese files couldn't be included: ${missing.join(", ")}\n` : ""}`,
  );
  onProgress?.("Packing the zip…");
  return { zip: zipSync(entries, { level: 6 }), files: originals.length - missing.length, missing };
}

/** Offers the zip to save. Resolves false when the student declined. */
export async function saveBackup(zip: Uint8Array, filename: string): Promise<boolean> {
  const blob = new Blob([zip], { type: "application/zip" });
  const dl = await use("downloads");
  if (dl) {
    try {
      await (dl as { save(o: { filename: string; data: Blob }): Promise<unknown> }).save({ filename, data: blob });
      return true;
    } catch (e) {
      if ((e as { code?: string })?.code === "declined") return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/**
 * Deletes the semester data for a fresh start: the semester, its setup,
 * uploaded files (readable copies and originals), archived semesters and
 * quests. Keeps profile, mastery and stats; Ask chats only when `keepChats`.
 * Can't be undone: call only after the student saved a backup and confirmed.
 */
export async function freshStart(keepChats: boolean, onProgress?: (line: string) => void): Promise<void> {
  const c = await cloud();
  if (!c) {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      const keep = k === "studydesk.onboarding.v1.profile" || k === "studydesk.orchestrator.v1.state" || k.startsWith("studydesk.mastery.") || (keepChats && k.startsWith("studydesk.chats."));
      if (k.startsWith(LOCAL_PREFIX) && !keep) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
    return;
  }
  const data = await collectData();
  const base = `data/users/${c.uid}`;
  const originals = originalsIn(data);
  if (c.assets) {
    for (const [i, o] of originals.entries()) {
      onProgress?.(`Removing files (${i + 1} of ${originals.length})…`);
      await c.assets.delete(o.assetId).catch(() => undefined);
    }
  }
  const remove: CollectionKey[] = keepChats ? FRESH_START_REMOVES : [...FRESH_START_REMOVES, "askChats"];
  for (const key of remove) {
    const [doc, col] = COLLECTION_KINDS[key];
    const snap = await c.db.doc(`${base}/${doc}`).collection(col).get();
    onProgress?.(`Removing ${key.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`)}…`);
    for (const d of snap.docs) await c.db.doc(`${base}/${doc}`).collection(col).doc(d.id).delete();
  }
  await c.db.doc(`${base}/${DOC_KINDS.semester}`).delete().catch(() => undefined);
  await c.db.doc(`${base}/${DOC_KINDS.setup}`).delete().catch(() => undefined);
}

// ---------- leftovers from an import that didn't finish ----------
//
// Files are stored one by one while a drop is kept, and listed in the desk
// when a zip (or the drop) is done. If the window closes or crashes before
// that, the stored files are referenced by nothing. These are found by what
// the desk does reference, and removed only when the student says so.

export type Leftovers = { assetIds: string[]; bytes: number; contentIds: string[] };

/** Only assets older than this count as left over, so a drop still being kept in another tab is never touched. */
export const LEFTOVER_MIN_AGE_MS = 15 * 60_000;

/** Which stored files nothing references. Pure, tested. */
export function leftoversOf(
  referencedUploads: Set<string>,
  referencedAssets: Set<string>,
  assets: Array<{ id: string; sizeBytes: number; contentType: string; createdAt: string }>,
  contentIds: string[],
  now: number,
): Leftovers {
  const old = (a: { createdAt: string }) => now - Date.parse(a.createdAt) > LEFTOVER_MIN_AGE_MS;
  // JSON files are update backups (listed in their own record); they're never counted as leftovers.
  const lost = assets.filter((a) => !referencedAssets.has(a.id) && a.contentType !== "application/json" && old(a));
  return { assetIds: lost.map((a) => a.id), bytes: lost.reduce((n, a) => n + a.sizeBytes, 0), contentIds: contentIds.filter((id) => id.startsWith("up_") && !referencedUploads.has(id)) };
}

async function references(c: { db: DB; uid: string }) {
  const base = `data/users/${c.uid}`;
  const get = async (p: string) => {
    const s = await c.db.doc(`${base}/${p}`).get();
    return s.exists ? (s.data() as Record<string, unknown>) : null;
  };
  const [setup, semester, updates] = await Promise.all([get(DOC_KINDS.setup), get(DOC_KINDS.semester), get(DOC_KINDS.updates)]);
  const [adoc, acol] = COLLECTION_KINDS.archivedSemesters;
  const archived = Object.fromEntries((await c.db.doc(`${base}/${adoc}`).collection(acol).get()).docs.map((d) => [d.id, d.data()]));
  const data = { setup, semester, archivedSemesters: archived };
  const uploads = new Set<string>();
  for (const s of [setup, semester, ...Object.values(archived)] as Array<{ uploads?: Array<{ id: string }> } | null>) for (const u of s?.uploads ?? []) uploads.add(u.id);
  const assets = new Set(originalsIn(data).map((o) => o.assetId));
  for (const b of ((updates?.backups as Array<{ assetId?: string }>) ?? [])) if (b.assetId) assets.add(b.assetId);
  return { uploads, assets };
}

/** Finds stored original files nothing references (null when this view can't tell). */
export async function findLeftovers(now = Date.now()): Promise<Leftovers | null> {
  const c = await cloud();
  if (!c?.assets) return null;
  const refs = await references(c);
  const listed = await c.assets.list();
  // Kept text is only looked through when the student removes leftovers (reading it all is heavy).
  return leftoversOf(refs.uploads, refs.assets, listed.assets, [], now);
}

/** Removes the originals findLeftovers found and any kept text nothing references, checking the references once more first. */
export async function removeLeftovers(found: Leftovers, onProgress?: (line: string) => void): Promise<number> {
  const c = await cloud();
  if (!c?.assets) return 0;
  const refs = await references(c);
  const assets = found.assetIds.filter((id) => !refs.assets.has(id));
  const [doc, col] = COLLECTION_KINDS.uploadContents;
  onProgress?.("Looking for leftover text…");
  const ids = (await c.db.doc(`data/users/${c.uid}/${doc}`).collection(col).get()).docs.map((d) => d.id);
  const contents = leftoversOf(refs.uploads, refs.assets, [], ids, Date.now()).contentIds;
  let n = 0;
  for (const id of assets) {
    if (++n % 10 === 0) onProgress?.(`Removing leftover files (${n} of ${assets.length + contents.length})…`);
    await c.assets.delete(id).catch(() => undefined);
  }
  for (const id of contents) {
    if (++n % 10 === 0) onProgress?.(`Removing leftover files (${n} of ${assets.length + contents.length})…`);
    await c.db.doc(`data/users/${c.uid}/${doc}`).collection(col).doc(id).delete().catch(() => undefined);
  }
  return assets.length + contents.length;
}
