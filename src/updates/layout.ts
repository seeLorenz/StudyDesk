// Where StudyDesk keeps a student's data, as one table shared by the backup
// zip, the update backup, the upgrade steps, the zip import and the nightly
// program. Paths are under data/users/<uid>/.
//
// A snapshot holds every one of these: single documents by kind (null when
// missing) and collections by kind ({ id: document }). It is also the shape of
// studydesk-data.json in the export zip, so old zips read the same way.

import { joinAll, PARTS_COL, PARTS_DOC, splitDoc } from "../platform/bigDoc";

export const DOC_KINDS = {
  profile: "profile",
  setup: "onboarding",
  semester: "semester",
  orchestrator: "orchestrator",
  routine: "routine",
  updates: "updates",
} as const;

export const COLLECTION_KINDS = {
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
  routineOutbox: ["routine", "outbox"],
} as const;

export type DocKind = keyof typeof DOC_KINDS;
export type CollectionKind = keyof typeof COLLECTION_KINDS;
export type Rec = Record<string, unknown>;

export type Snapshot = { [K in DocKind]: Rec | null } & { [K in CollectionKind]: Record<string, Rec> };

export const DOC_KIND_LIST = Object.keys(DOC_KINDS) as DocKind[];
export const COLLECTION_KIND_LIST = Object.keys(COLLECTION_KINDS) as CollectionKind[];

export function emptySnapshot(): Snapshot {
  const s = {} as Record<string, unknown>;
  for (const k of DOC_KIND_LIST) s[k] = null;
  for (const k of COLLECTION_KIND_LIST) s[k] = {};
  return s as Snapshot;
}

const isRec = (x: unknown): x is Rec => !!x && typeof x === "object" && !Array.isArray(x);

/** Any object with some of the kinds (an export file, an older zip) → a full snapshot. Unknown keys are dropped. */
export function toSnapshot(x: unknown): Snapshot {
  const src = isRec(x) ? x : {};
  const s = emptySnapshot() as Record<string, unknown>;
  for (const k of DOC_KIND_LIST) s[k] = isRec(src[k]) ? src[k] : null;
  for (const k of COLLECTION_KIND_LIST) {
    const col = src[k];
    s[k] = isRec(col) ? Object.fromEntries(Object.entries(col).filter(([, v]) => isRec(v))) : {};
  }
  return s as Snapshot;
}

/** One document's path below data/users/<uid>/, as segments. */
export function docPath(kind: DocKind): string[];
export function docPath(kind: CollectionKind, id: string): string[];
export function docPath(kind: DocKind | CollectionKind, id?: string): string[] {
  if (kind in DOC_KINDS) return [DOC_KINDS[kind as DocKind]];
  const [doc, col] = COLLECTION_KINDS[kind as CollectionKind];
  return [doc, col, id!];
}

/** Which kind a path below data/users/<uid>/ belongs to, or null for anything else (job documents, the release note). */
export function kindOf(path: string[]): { kind: DocKind; id: null } | { kind: CollectionKind; id: string } | null {
  if (path.length === 1) {
    const k = DOC_KIND_LIST.find((d) => DOC_KINDS[d] === path[0]);
    return k ? { kind: k, id: null } : null;
  }
  if (path.length === 3) {
    const k = COLLECTION_KIND_LIST.find((c) => COLLECTION_KINDS[c][0] === path[0] && COLLECTION_KINDS[c][1] === path[1]);
    return k ? { kind: k, id: path[2] } : null;
  }
  return null;
}

/** A write that turns one snapshot into another: set a document, or delete it. */
export type SnapshotWrite = { path: string[]; data: Rec | null };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every write needed to turn `before` into `after`, documents first, deletions last. Pure. */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotWrite[] {
  const sets: SnapshotWrite[] = [];
  const deletes: SnapshotWrite[] = [];
  for (const k of DOC_KIND_LIST) {
    const a = before[k];
    const b = after[k];
    if (same(a, b)) continue;
    if (b) sets.push({ path: docPath(k), data: b });
    else deletes.push({ path: docPath(k), data: null });
  }
  for (const k of COLLECTION_KIND_LIST) {
    const a = before[k];
    const b = after[k];
    for (const [id, d] of Object.entries(b)) if (!same(a[id], d)) sets.push({ path: docPath(k, id), data: d });
    for (const id of Object.keys(a)) if (!(id in b)) deletes.push({ path: docPath(k, id), data: null });
  }
  return [...sets, ...deletes];
}

/** A snapshot read straight from storage, with its split documents joined (src/platform/bigDoc.ts). */
export function joinSnapshot(s: Snapshot, parts: Record<string, Rec>): Snapshot {
  const out = { ...s } as Record<string, unknown>;
  for (const k of DOC_KIND_LIST) out[k] = joinAll(s[k], parts);
  for (const k of COLLECTION_KIND_LIST) out[k] = Object.fromEntries(Object.entries(s[k]).map(([id, d]) => [id, joinAll(d, parts)]));
  return out as Snapshot;
}

/**
 * Writes turned into what storage can hold: a big document becomes its parts
 * (written first) and a main document. `have` holds part ids already stored,
 * which aren't written again. Parts are never deleted here (the page sweeps them).
 */
export function splitWrites(writes: SnapshotWrite[], have: Set<string> = new Set()): SnapshotWrite[] {
  const parts: SnapshotWrite[] = [];
  const rest: SnapshotWrite[] = [];
  for (const w of writes) {
    if (!w.data) {
      rest.push(w);
      continue;
    }
    const { main, parts: ps } = splitDoc(w.path.join("."), w.data);
    for (const [id, p] of Object.entries(ps)) if (!have.has(id)) parts.push({ path: [PARTS_DOC, PARTS_COL, id], data: p });
    rest.push({ path: w.path, data: main });
  }
  return [...parts, ...rest];
}

/** How many documents a snapshot holds. */
export function countDocs(s: Snapshot): number {
  return DOC_KIND_LIST.filter((k) => s[k]).length + COLLECTION_KIND_LIST.reduce((n, k) => n + Object.keys(s[k]).length, 0);
}
