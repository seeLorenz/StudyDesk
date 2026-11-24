// Storage for quests and the semester they're built from. Inside a claude.ai
// artifact it uses the artifact database, in each user's private area:
//   data/users/<uid>/semester              the semester (sample data until onboarding exists)
//   data/users/<uid>/quests/records/<id>   one quest plus the student's work on it
//   data/users/<uid>/quests/reviews/<id>   the mistake-review chat for that quest
//   data/users/<uid>/quests/images/<id>    one answer photo
//   data/users/<uid>/calendar              the latest read of the coming days' calendar
//   data/users/<uid>/calendarWant          tomorrow's study times, as the nightly run planned them
//   data/users/<uid>/calendarWritten       the study entries already in the calendar (src/quests/times.ts)
// Elsewhere it falls back to this browser's localStorage.

import { host } from "./host";
import { PARTS_COL, PARTS_DOC, readBig, writeBig, type Written } from "./bigDoc";
import type { Chat } from "../chat/types";
import type { CalendarAhead } from "./calendar";
import type { QuestProgress, QuestRecord, Semester } from "../quests/types";
import { mergeProgress } from "../quests/merge";
import type { CalendarWant, CalendarWritten } from "../quests/times";

export interface QuestStore {
  mode: "cloud" | "local";
  loadSemester(): Promise<Semester | null>;
  saveSemester(s: Semester): Promise<void>;
  loadRecords(): Promise<QuestRecord[]>;
  /**
   * Saves a quest's work. `base` is the saved version the caller's copy was built on (none for a
   * new quest): if another tab or device saved since, only the caller's own changes are written
   * over it (src/quests/merge.ts). Resolves with what was saved.
   */
  saveRecord(r: QuestRecord, base?: QuestProgress): Promise<QuestRecord>;
  /** Mistake-review chats, one per graded quest, keyed by quest id. */
  loadReviewChats(): Promise<Record<string, Chat>>;
  saveReviewChat(questId: string, chat: Chat): Promise<void>;
  /** Answer photos, as compressed JPEG data URLs, one per document. */
  saveImage(id: string, dataUrl: string): Promise<void>;
  loadImage(id: string): Promise<string | null>;
  /** The latest read of the student's calendar for the coming days. */
  loadCalendar(): Promise<CalendarAhead | null>;
  saveCalendar(c: CalendarAhead): Promise<void>;
  /** The planned study entries and those already written (cloud only: the nightly run plans them). */
  loadEntries(): Promise<{ want: CalendarWant | null; written: CalendarWritten | null }>;
  saveWritten(w: CalendarWritten): Promise<void>;
  saveWant(w: CalendarWant): Promise<void>;
}

const plain = <T>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;

export async function openQuestStore(): Promise<QuestStore> {
  const c = host();
  if (c?.use) {
    const [db, user] = await Promise.all([c.use("db").catch(() => null), c.use("user").catch(() => null)]);
    const uid = user ? await user.id().catch(() => null) : null;
    if (db && uid) return cloudQuestStore(db, uid);
  }
  return localQuestStore();
}

function cloudQuestStore(db: DB, uid: string): QuestStore {
  const semester = db.doc(`data/users/${uid}/semester`);
  const calendar = db.doc(`data/users/${uid}/calendar`);
  // A big semester is split into parts (src/platform/bigDoc.ts); one write at a time.
  const parts = db.doc(`data/users/${uid}/${PARTS_DOC}`).collection(PARTS_COL);
  const written: Written = new Map();
  let semWrites: Promise<unknown> = Promise.resolve();
  const records = db.doc(`data/users/${uid}/quests`).collection("records");
  const reviews = db.doc(`data/users/${uid}/quests`).collection("reviews");
  const images = db.doc(`data/users/${uid}/quests`).collection("images");
  // One save at a time per record, so each one merges onto the one before.
  const chains = new Map<string, Promise<unknown>>();
  return {
    mode: "cloud",
    async loadSemester() {
      return (await readBig(semester, parts)) as unknown as Semester | null;
    },
    saveSemester(s) {
      const next = semWrites
        .catch(() => undefined)
        .then(async () => {
          // Another tab or device may have saved what only the semester knows (the placement check, the workload decision): keep it.
          const stored = (await readBig(semester, parts).catch(() => null)) as unknown as Semester | null;
          return writeBig("semester", plain(keepSemesterOnly(s, stored)), semester, parts, written);
        });
      semWrites = next;
      return next;
    },
    async loadCalendar() {
      const snap = await calendar.get();
      return snap.exists ? (snap.data() as unknown as CalendarAhead) : null;
    },
    async saveCalendar(c) {
      await calendar.set(plain(c));
    },
    async loadEntries() {
      const [w, d] = await Promise.all([db.doc(`data/users/${uid}/calendarWant`).get(), db.doc(`data/users/${uid}/calendarWritten`).get()]);
      return { want: w.exists ? (w.data() as unknown as CalendarWant) : null, written: d.exists ? (d.data() as unknown as CalendarWritten) : null };
    },
    async saveWritten(w) {
      await db.doc(`data/users/${uid}/calendarWritten`).set(plain(w));
    },
    async saveWant(w) {
      await db.doc(`data/users/${uid}/calendarWant`).set(plain(w));
    },
    async loadRecords() {
      return (await records.get()).docs.filter((d) => d.exists).map((d) => d.data() as unknown as QuestRecord);
    },
    async loadReviewChats() {
      const out: Record<string, Chat> = {};
      for (const d of (await reviews.get()).docs) if (d.exists) out[d.id] = d.data() as unknown as Chat;
      return out;
    },
    async saveReviewChat(questId, chat) {
      await reviews.doc(questId).set(plain(chat));
    },
    async saveImage(id, dataUrl) {
      await images.doc(id).set({ dataUrl });
    },
    async loadImage(id) {
      const snap = await images.doc(id).get();
      return snap.exists ? ((snap.data() as { dataUrl?: string }).dataUrl ?? null) : null;
    },
    saveRecord(r, base) {
      const id = r.quest.id;
      const next = (chains.get(id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const snap = base ? await records.doc(id).get() : null;
          const out = withMerge(r, base, snap?.exists ? (snap.data() as unknown as QuestRecord) : undefined);
          await records.doc(id).set(plain(out));
          return out;
        });
      chains.set(id, next);
      return next;
    },
  };
}

/** The record to write: the caller's copy, or only its changes over a newer stored one; stamped now. */
export function withMerge(r: QuestRecord, base: QuestProgress | undefined, stored: QuestRecord | undefined): QuestRecord {
  const p = base && stored && stored.progress.updatedAt !== base.updatedAt ? mergeProgress(base, r.progress, stored.progress) : r.progress;
  return { quest: r.quest, progress: { ...p, updatedAt: Date.now() } };
}

/**
 * The semester to save, with what only the semester knows taken from the
 * stored one when that is newer: the placement check's id and the student's
 * answer to the workload recommendation. Everything else is rebuilt from the
 * semester setup, which has its own version check. Pure, so it is tested.
 */
export function keepSemesterOnly(s: Semester, stored: Semester | null): Semester {
  if (!stored || stored.id !== s.id) return s;
  let out = s;
  if (!out.placementQuestId && stored.placementQuestId) out = { ...out, placementQuestId: stored.placementQuestId };
  if ((stored.studyGoalDecidedAt ?? 0) > (out.studyGoalDecidedAt ?? 0))
    out = { ...out, studyGoal: [...stored.studyGoal], studyGoalSource: stored.studyGoalSource, studyGoalDecidedAt: stored.studyGoalDecidedAt };
  return out;
}

function localQuestStore(): QuestStore {
  const KEY = "studydesk.quests.v1";
  const mem: { semester: Semester | null; records: QuestRecord[]; reviews?: Record<string, Chat>; calendar?: CalendarAhead | null; images: Map<string, string> } = {
    semester: null,
    records: [],
    images: new Map(),
  };
  const read = (): typeof mem => {
    try {
      return { ...mem, ...JSON.parse(localStorage.getItem(KEY) || "{}"), images: mem.images };
    } catch {
      return mem;
    }
  };
  const write = (d: typeof mem) => {
    const { images: _skip, ...rest } = d;
    mem.semester = d.semester;
    mem.records = d.records;
    mem.reviews = d.reviews;
    mem.calendar = d.calendar;
    try {
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable: keep in memory */
    }
  };
  return {
    mode: "local",
    async loadSemester() {
      return read().semester;
    },
    async saveSemester(s) {
      write({ ...read(), semester: s });
    },
    async loadRecords() {
      return read().records;
    },
    async loadCalendar() {
      return read().calendar ?? null;
    },
    async saveCalendar(c) {
      write({ ...read(), calendar: c });
    },
    async loadEntries() {
      return { want: null, written: null };
    },
    async saveWritten() {},
    async saveWant() {},
    async loadReviewChats() {
      return read().reviews ?? {};
    },
    async saveReviewChat(questId, chat) {
      const d = read();
      write({ ...d, reviews: { ...(d.reviews ?? {}), [questId]: chat } });
    },
    async saveImage(id, dataUrl) {
      try {
        localStorage.setItem(`${KEY}.img.${id}`, dataUrl);
      } catch {
        mem.images.set(id, dataUrl);
      }
    },
    async loadImage(id) {
      try {
        return localStorage.getItem(`${KEY}.img.${id}`) ?? mem.images.get(id) ?? null;
      } catch {
        return mem.images.get(id) ?? null;
      }
    },
    async saveRecord(r, base) {
      const d = read();
      const out = withMerge(r, base, d.records.find((x) => x.quest.id === r.quest.id));
      write({ ...d, records: [...d.records.filter((x) => x.quest.id !== r.quest.id), out] });
      return out;
    },
  };
}
