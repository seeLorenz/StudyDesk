// Storage for Start New Semester. Inside a claude.ai artifact it uses the
// artifact database, in each user's private area:
//   data/users/<uid>/profile                    who the student is (kept across semesters)
//   data/users/<uid>/onboarding                 the semester being set up (resumes where it stopped)
//   data/users/<uid>/files/uploads/<id>         the readable content of one uploaded file
//   data/users/<uid>/archive/semesters/<id>     a finished semester, kept when a new one starts
// Original files go to the artifact's file store (assets) when this view may
// store files; their ids are kept on the upload records.
// Elsewhere it falls back to this browser's localStorage.

import type { Semester } from "../quests/types";
import type { Profile, SemesterDraft } from "../onboarding/types";

/** What StudyDesk can read from a file later: page-marked text, or a compressed image. */
export type UploadContent = { text?: string; image?: string };

export interface OnboardingStore {
  mode: "cloud" | "local";
  loadProfile(): Promise<Profile | null>;
  saveProfile(p: Profile): Promise<void>;
  loadDraft(): Promise<SemesterDraft | null>;
  saveDraft(d: SemesterDraft): Promise<void>;
  saveUploadContent(id: string, c: UploadContent): Promise<void>;
  loadUploadContent(id: string): Promise<UploadContent | null>;
  /** Keeps the original file; resolves with its asset id, or null when this view can't store files. */
  storeOriginal(file: Blob): Promise<string | null>;
  archiveSemester(s: Semester): Promise<void>;
}

const plain = <T>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;

// One store per page, so every screen shares the same write queue.
let shared: Promise<OnboardingStore> | null = null;

export function openOnboardingStore(): Promise<OnboardingStore> {
  if (!shared) shared = openStoreOnce().catch((e) => {
    shared = null;
    throw e;
  });
  return shared;
}

async function openStoreOnce(): Promise<OnboardingStore> {
  const c = (window as Window & { claude?: Claude }).claude;
  if (c?.use) {
    const [db, user, assets] = await Promise.all([
      c.use("db").catch(() => null),
      c.use("user").catch(() => null),
      c.use("assets").catch(() => null),
    ]);
    const uid = user ? await user.id().catch(() => null) : null;
    if (db && uid) return cloudStore(db, uid, assets);
  }
  return localStore();
}

function cloudStore(db: DB, uid: string, assets: Claude.Assets | null): OnboardingStore {
  const profile = db.doc(`data/users/${uid}/profile`);
  const draft = db.doc(`data/users/${uid}/onboarding`);
  const uploads = db.doc(`data/users/${uid}/files`).collection("uploads");
  const archive = db.doc(`data/users/${uid}/archive`).collection("semesters");
  // One draft write at a time; only the newest pending version is written.
  let running = false;
  let next: SemesterDraft | null = null;
  let waiters: Array<(e?: unknown) => void> = [];
  async function drain() {
    if (running) return;
    running = true;
    while (next) {
      const d = next;
      const w = waiters;
      next = null;
      waiters = [];
      let err: unknown;
      try {
        await draft.set(plain(d));
      } catch (e) {
        err = e;
      }
      w.forEach((f) => f(err));
    }
    running = false;
  }
  return {
    mode: "cloud",
    async loadProfile() {
      const s = await profile.get();
      return s.exists ? (s.data() as unknown as Profile) : null;
    },
    async saveProfile(p) {
      await profile.set(plain(p));
    },
    async loadDraft() {
      const s = await draft.get();
      return s.exists ? (s.data() as unknown as SemesterDraft) : null;
    },
    saveDraft(d) {
      next = d;
      const done = new Promise<void>((res, rej) => waiters.push((e) => (e ? rej(e) : res())));
      void drain();
      return done;
    },
    async saveUploadContent(id, c) {
      await uploads.doc(id).set(plain(c));
    },
    async loadUploadContent(id) {
      const s = await uploads.doc(id).get();
      return s.exists ? (s.data() as UploadContent) : null;
    },
    async storeOriginal(file) {
      if (!assets) return null;
      try {
        return (await assets.upload(file)).id;
      } catch {
        return null; // too large or an unsupported type: the readable copy is still kept
      }
    },
    async archiveSemester(s) {
      await archive.doc(s.id).set(plain(s));
    },
  };
}

function localStore(): OnboardingStore {
  const KEY = "studydesk.onboarding.v1";
  const mem = new Map<string, string>();
  const get = (k: string) => {
    try {
      return localStorage.getItem(`${KEY}.${k}`) ?? mem.get(k) ?? null;
    } catch {
      return mem.get(k) ?? null;
    }
  };
  const set = (k: string, v: unknown) => {
    const s = JSON.stringify(v);
    try {
      localStorage.setItem(`${KEY}.${k}`, s);
    } catch {
      mem.set(k, s);
    }
  };
  const read = <T>(k: string): T | null => {
    const s = get(k);
    return s ? (JSON.parse(s) as T) : null;
  };
  return {
    mode: "local",
    async loadProfile() {
      return read<Profile>("profile");
    },
    async saveProfile(p) {
      set("profile", p);
    },
    async loadDraft() {
      return read<SemesterDraft>("draft");
    },
    async saveDraft(d) {
      set("draft", d);
    },
    async saveUploadContent(id, c) {
      set(`upload.${id}`, c);
    },
    async loadUploadContent(id) {
      return read<UploadContent>(`upload.${id}`);
    },
    async storeOriginal() {
      return null;
    },
    async archiveSemester(s) {
      set(`archive.${s.id}`, s);
    },
  };
}

/** Offers a file to save: through the artifact's downloads capability, or a plain browser download. */
export async function offerDownload(filename: string, data: string): Promise<"saved" | "declined"> {
  const c = (window as Window & { claude?: Claude }).claude;
  const dl = c?.use ? await c.use("downloads").catch(() => null) : null;
  if (dl) {
    try {
      await dl.save({ filename, data });
      return "saved";
    } catch (e) {
      if ((e as { code?: string })?.code === "declined") return "declined";
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return "saved";
}
