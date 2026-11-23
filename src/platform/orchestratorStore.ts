// Storage for the Orchestrator. Inside a claude.ai artifact it uses the
// artifact database, in each user's private area:
//   data/users/<uid>/orchestrator                    memory, change log, jobs, check-ins
//   data/users/<uid>/orchestrator/days/<sem>_<day>   the chat, one document per semester day
// Elsewhere it falls back to this browser's localStorage.

import { host } from "./host";
import type { Day } from "../mastery/types";
import { emptyState, type OrchMessage, type OrchState } from "../orchestrator/types";

export interface OrchestratorStore {
  mode: "cloud" | "local";
  loadState(): Promise<OrchState>;
  saveState(s: OrchState): Promise<void>;
  /** The chat of one semester, oldest first. */
  loadMessages(semesterId: string): Promise<OrchMessage[]>;
  saveDay(semesterId: string, day: Day, messages: OrchMessage[]): Promise<void>;
}

const plain = <T>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;
const LIMIT = 230_000; // one database document holds 256 KiB

/**
 * Keeps the state document under the size limit: the oldest changes lose
 * their before/after first (they can't be undone anymore anyway), then go.
 */
export function trimState(s: OrchState): OrchState {
  let out = { ...s, changes: s.changes.slice(-80), notifications: s.notifications.slice(-300), jobs: s.jobs.slice(-60), confirms: s.confirms.slice(-30) };
  let i = 0;
  while (JSON.stringify(out).length > LIMIT && i < out.changes.length) {
    out = { ...out, changes: out.changes.map((c, n) => (n === i ? { ...c, before: {}, after: {}, undoable: false } : c)) };
    i++;
  }
  while (JSON.stringify(out).length > LIMIT && out.changes.length) out = { ...out, changes: out.changes.slice(1) };
  return out;
}

type Keyed = { id?: string; key?: string };
const keyOf = (x: Keyed) => x.id ?? x.key ?? JSON.stringify(x);

/** One list merged three ways: ours wins for items both have; the other device's new items are kept; items we removed stay removed. */
function mergeList<T extends Keyed>(base: T[], ours: T[], theirs: T[]): T[] {
  const mine = new Set(ours.map(keyOf));
  const known = new Set(base.map(keyOf));
  const added = theirs.filter((x) => !mine.has(keyOf(x)) && !known.has(keyOf(x)));
  if (!added.length) return ours;
  return [...ours, ...added].sort((a, b) => stamp(a) - stamp(b));
}
const stamp = (x: unknown) => {
  const r = x as { at?: number; startedAt?: number; createdAt?: number };
  return r.at ?? r.startedAt ?? r.createdAt ?? 0;
};

/**
 * The state to save when another tab or device may have saved in the
 * meantime: `base` is what this screen last loaded or saved, `ours` what it
 * wants to save now, `theirs` what is stored now. Nothing the other one added
 * (a change card, a job, a notification) is lost. Pure, so it is tested.
 */
export function mergeState(base: OrchState, ours: OrchState, theirs: OrchState): OrchState {
  if (theirs.updatedAt === base.updatedAt) return ours;
  return {
    ...ours,
    memory: (theirs.memory?.updatedAt ?? 0) > (ours.memory?.updatedAt ?? 0) ? theirs.memory : ours.memory,
    changes: mergeList(base.changes, ours.changes, theirs.changes ?? []),
    confirms: mergeList(base.confirms, ours.confirms, theirs.confirms ?? []),
    jobs: mergeList(base.jobs, ours.jobs, theirs.jobs ?? []),
    notifications: mergeList(base.notifications, ours.notifications, theirs.notifications ?? []),
    notes: mergeList(base.notes ?? [], ours.notes ?? [], theirs.notes ?? []),
    updatedAt: Math.max(ours.updatedAt, theirs.updatedAt),
  };
}

let shared: Promise<OrchestratorStore> | null = null;

export function openOrchestratorStore(): Promise<OrchestratorStore> {
  if (!shared)
    shared = (async () => {
      const c = host();
      if (c?.use) {
        const [db, user] = await Promise.all([c.use("db").catch(() => null), c.use("user").catch(() => null)]);
        const uid = user ? await user.id().catch(() => null) : null;
        if (db && uid) return cloudStore(db, uid);
      }
      return localStore();
    })();
  return shared;
}

function queue<T>(write: (v: T) => Promise<void>) {
  let running = false;
  let next: T | null = null;
  let waiters: Array<(e?: unknown) => void> = [];
  async function drain() {
    if (running) return;
    running = true;
    while (next !== null) {
      const v = next;
      const w = waiters;
      next = null;
      waiters = [];
      let err: unknown;
      try {
        await write(v);
      } catch (e) {
        err = e;
      }
      w.forEach((f) => f(err));
    }
    running = false;
  }
  return (v: T) => {
    next = v;
    const done = new Promise<void>((res, rej) => waiters.push((e) => (e ? rej(e) : res())));
    void drain();
    return done;
  };
}

function cloudStore(db: DB, uid: string): OrchestratorStore {
  const root = db.doc(`data/users/${uid}/orchestrator`);
  const days = root.collection("days");
  const read = async () => {
    const s = await root.get();
    return s.exists ? { ...emptyState(), ...(s.data() as unknown as OrchState) } : emptyState();
  };
  // What this page last loaded or saved: the base for merging with what another tab or device saved since.
  let base: OrchState | null = null;
  const writeState = queue<OrchState>(async (s) => {
    const merged = base ? mergeState(base, s, await read()) : s;
    await root.set(plain(trimState(merged)));
    base = s;
  });
  const dayWriters = new Map<string, (m: OrchMessage[]) => Promise<void>>();
  return {
    mode: "cloud",
    async loadState() {
      const s = await read();
      base = s;
      return s;
    },
    saveState: writeState,
    async loadMessages(semesterId) {
      const snap = await days.get();
      return snap.docs
        .filter((d) => d.exists && d.id.startsWith(`${semesterId}_`))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .flatMap((d) => ((d.data() as { messages?: OrchMessage[] }).messages ?? []));
    },
    saveDay(semesterId, day, messages) {
      const id = `${semesterId}_${day}`;
      if (!dayWriters.has(id)) dayWriters.set(id, queue<OrchMessage[]>((m) => days.doc(id).set(plain({ semesterId, day, messages: m }))));
      return dayWriters.get(id)!(messages);
    },
  };
}

function localStore(): OrchestratorStore {
  const KEY = "studydesk.orchestrator.v1";
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
  return {
    mode: "local",
    async loadState() {
      const s = get("state");
      return s ? { ...emptyState(), ...JSON.parse(s) } : emptyState();
    },
    async saveState(s) {
      set("state", trimState(s));
    },
    async loadMessages(semesterId) {
      const index: string[] = JSON.parse(get(`days.${semesterId}`) ?? "[]");
      return index.sort().flatMap((day) => JSON.parse(get(`day.${semesterId}.${day}`) ?? "[]") as OrchMessage[]);
    },
    async saveDay(semesterId, day, messages) {
      const index: string[] = JSON.parse(get(`days.${semesterId}`) ?? "[]");
      if (!index.includes(day)) set(`days.${semesterId}`, [...index, day]);
      set(`day.${semesterId}.${day}`, messages);
    },
  };
}
