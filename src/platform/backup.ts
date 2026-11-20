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

import { zipSync, strToU8 } from "fflate";

/** Paths under data/users/<uid>/: single documents and collections. */
const DOCS = { profile: "profile", setup: "onboarding", semester: "semester", orchestrator: "orchestrator" } as const;
const COLLECTIONS = {
  askChats: ["profile", "chats"],
  uploadContents: ["files", "uploads"],
  archivedSemesters: ["archive", "semesters"],
  questRecords: ["quests", "records"],
  questReviews: ["quests", "reviews"],
  answerPhotos: ["quests", "images"],
  masterySkills: ["mastery", "skills"],
  masteryTargets: ["mastery", "targets"],
  masteryAttempts: ["mastery", "attempts"],
  masteryReviews: ["mastery", "reviews"],
  orchestratorChat: ["orchestrator", "days"],
} as const;
type CollectionKey = keyof typeof COLLECTIONS;

/** What a fresh start removes. Everything else stays. */
export const FRESH_START_REMOVES: CollectionKey[] = ["uploadContents", "archivedSemesters", "questRecords", "questReviews", "answerPhotos"];
export const FRESH_START_KEEPS = ["profile", "mastery", "stats"] as const;

const LOCAL_PREFIX = "studydesk.";

type Original = { assetId: string; fileName: string; courseName: string | null };

async function use<K extends string>(name: K) {
  const c = (window as Window & { claude?: Claude }).claude;
  return c?.use ? await c.use(name as never).catch(() => null) : null;
}

async function cloud(): Promise<{ db: DB; uid: string; assets: Claude.Assets | null } | null> {
  const [db, user, assets] = await Promise.all([use("db"), use("user"), use("assets")]);
  const uid = user ? await (user as { id(): Promise<string> }).id().catch(() => null) : null;
  return db && uid ? { db: db as DB, uid, assets: assets as Claude.Assets | null } : null;
}

/** Every document StudyDesk keeps for this student, by kind. */
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
  const base = `data/users/${c.uid}`;
  const out: Record<string, unknown> = { mode: "cloud" };
  for (const [key, path] of Object.entries(DOCS)) {
    const s = await c.db.doc(`${base}/${path}`).get();
    out[key] = s.exists ? s.data() : null;
  }
  for (const [key, [doc, col]] of Object.entries(COLLECTIONS)) {
    const snap = await c.db.doc(`${base}/${doc}`).collection(col).get();
    out[key] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  }
  return out;
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

/** Builds the backup zip. `onProgress` gets a short line per step. */
export async function buildBackup(onProgress?: (line: string) => void): Promise<{ zip: Uint8Array; files: number; missing: string[] }> {
  onProgress?.("Collecting your data…");
  const data = await collectData();
  const originals = originalsIn(data);
  const entries: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  const used = new Set<string>();
  for (const [i, o] of originals.entries()) {
    onProgress?.(`Adding your files (${i + 1} of ${originals.length})…`);
    try {
      const res = await fetch(`/_blob/${o.assetId}`);
      if (!res.ok) throw new Error(String(res.status));
      let path = `files/${o.courseName ? `${safe(o.courseName)}/` : ""}${safe(o.fileName)}`;
      for (let n = 2; used.has(path); n++) path = path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
      used.add(path);
      entries[path] = new Uint8Array(await res.arrayBuffer());
    } catch {
      missing.push(o.fileName);
    }
  }
  entries["studydesk-data.json"] = strToU8(JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2));
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
    const [doc, col] = COLLECTIONS[key];
    const snap = await c.db.doc(`${base}/${doc}`).collection(col).get();
    onProgress?.(`Removing ${key.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`)}…`);
    for (const d of snap.docs) await c.db.doc(`${base}/${doc}`).collection(col).doc(d.id).delete();
  }
  await c.db.doc(`${base}/${DOCS.semester}`).delete().catch(() => undefined);
  await c.db.doc(`${base}/${DOCS.setup}`).delete().catch(() => undefined);
}
