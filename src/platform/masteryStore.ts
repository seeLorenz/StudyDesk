// Storage for the grading and mastery module. Inside a claude.ai artifact it
// uses the artifact database, in each user's private area:
//   data/users/<uid>/mastery/{skills,targets,attempts,reviews}/<id>
// One document per record keeps every document far below the 256 KiB limit.
// Elsewhere it falls back to this browser's localStorage.
//
// Attempts are append-only: there is no way to change or delete one here.

import type { Attempt, CourseTarget, ReviewItem, Skill } from "../mastery/types";

export type MasteryData = {
  skills: Skill[];
  targets: CourseTarget[];
  attempts: Attempt[];
  reviews: ReviewItem[];
};

export interface MasteryStore {
  mode: "cloud" | "local";
  load(): Promise<MasteryData>;
  putSkills(skills: Skill[]): Promise<void>;
  putTarget(target: CourseTarget): Promise<void>;
  /** Adds attempts to the log. An id that already exists is left as it is. */
  appendAttempts(attempts: Attempt[]): Promise<void>;
  putReview(item: ReviewItem): Promise<void>;
}

const plain = <T>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;

export async function openMasteryStore(): Promise<MasteryStore> {
  const c = (window as Window & { claude?: Claude }).claude;
  if (c?.use) {
    const [db, user] = await Promise.all([c.use("db").catch(() => null), c.use("user").catch(() => null)]);
    const uid = user ? await user.id().catch(() => null) : null;
    if (db && uid) return cloudMasteryStore(db, uid);
  }
  return localMasteryStore(memoryOrLocalStorage());
}

export function cloudMasteryStore(db: DB, uid: string): MasteryStore {
  const root = db.doc(`data/users/${uid}/mastery`);
  const col = (name: keyof MasteryData) => root.collection(name);
  const all = async <T>(name: keyof MasteryData) =>
    (await col(name).get()).docs.filter((d) => d.exists).map((d) => d.data() as unknown as T);

  return {
    mode: "cloud",
    async load() {
      const [skills, targets, attempts, reviews] = await Promise.all([
        all<Skill>("skills"),
        all<CourseTarget>("targets"),
        all<Attempt>("attempts"),
        all<ReviewItem>("reviews"),
      ]);
      return { skills, targets, attempts, reviews };
    },
    async putSkills(skills) {
      await Promise.all(skills.map((s) => col("skills").doc(s.id).set(plain(s))));
    },
    async putTarget(t) {
      await col("targets").doc(t.courseId).set(plain(t));
    },
    async appendAttempts(attempts) {
      for (const a of attempts) {
        const ref = col("attempts").doc(a.id);
        if ((await ref.get()).exists) continue;
        await ref.set(plain(a));
      }
    },
    async putReview(item) {
      await col("reviews").doc(item.attemptId).set(plain(item));
    },
  };
}

type KV = { get(key: string): string | null; set(key: string, value: string): void };

function memoryOrLocalStorage(): KV {
  const mem = new Map<string, string>();
  return {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return mem.get(k) ?? null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        mem.set(k, v);
      }
    },
  };
}

export function localMasteryStore(kv: KV): MasteryStore {
  const KEY = "studydesk.mastery.v1";
  const read = (): MasteryData => {
    try {
      return { skills: [], targets: [], attempts: [], reviews: [], ...JSON.parse(kv.get(KEY) || "{}") };
    } catch {
      return { skills: [], targets: [], attempts: [], reviews: [] };
    }
  };
  const write = (d: MasteryData) => kv.set(KEY, JSON.stringify(d));
  const upsert = <T>(list: T[], item: T, same: (x: T) => boolean) => [...list.filter((x) => !same(x)), item];

  return {
    mode: "local",
    async load() {
      return read();
    },
    async putSkills(skills) {
      const d = read();
      for (const s of skills) d.skills = upsert(d.skills, s, (x) => x.id === s.id);
      write(d);
    },
    async putTarget(t) {
      const d = read();
      d.targets = upsert(d.targets, t, (x) => x.courseId === t.courseId);
      write(d);
    },
    async appendAttempts(attempts) {
      const d = read();
      const have = new Set(d.attempts.map((a) => a.id));
      d.attempts.push(...attempts.filter((a) => !have.has(a.id)));
      write(d);
    },
    async putReview(item) {
      const d = read();
      d.reviews = upsert(d.reviews, item, (x) => x.attemptId === item.attemptId);
      write(d);
    },
  };
}
