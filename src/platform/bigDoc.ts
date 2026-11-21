// Documents bigger than the artifact database allows (256 KiB each).
//
// The semester setup and the semester itself grow with the student: eleven
// courses with hundreds of skills and a 3 GB import's file list don't fit in
// one document. So when a document gets big, its largest lists are moved into
// "part" documents (data/users/<uid>/parts/docs/<id>), and the main document
// keeps only their ids under `__parts`. Readers join them back; everything
// above the storage layer sees the whole document as before.
//
// Part ids carry a hash of their content, so an unchanged part is never
// written again, and a part is only ever replaced by writing a new id. Old
// parts are removed later (sweepParts), never while a reader could still need
// them.

export type Rec = Record<string, unknown>;

/** Where the parts live, below data/users/<uid>/. */
export const PARTS_DOC = "parts";
export const PARTS_COL = "docs";
/** Documents above this size are split (the database's cap is 262,144 bytes). */
export const SPLIT_BYTES = 200_000;
/** Unreferenced parts younger than this are kept: a write may be about to reference them. */
export const SWEEP_AFTER_MS = 60 * 60_000;

type PartRef = { field: string; kind: "array" | "object"; ids: string[] };
type PartDoc = { doc: string; field: string; createdAt: number; items?: unknown[]; entries?: Rec };

const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;

/** FNV-1a, 52 bits, as base 36: short and stable, enough to tell parts apart. */
function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(36) + (h2 & 0xfffff).toString(36)).slice(0, 12);
}

/** Groups items into chunks that each stay under the limit. */
function chunk<T>(items: T[], size: (x: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const it of items) {
    const s = size(it) + 1;
    if (cur.length && n + s > SPLIT_BYTES) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(it);
    n += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Splits one document when it's too big. Pure. `parts` are keyed by id; the
 * main document lists them under `__parts`. A small document comes back as it is.
 */
export function splitDoc(name: string, doc: Rec, now = Date.now()): { main: Rec; parts: Record<string, Rec> } {
  const plain = JSON.parse(JSON.stringify(doc)) as Rec;
  delete plain.__parts;
  if (bytes(plain) <= SPLIT_BYTES) return { main: plain, parts: {} };
  const main: Rec = { ...plain };
  const refs: PartRef[] = [];
  const parts: Record<string, Rec> = {};
  const fields = Object.keys(plain)
    .filter((k) => plain[k] && typeof plain[k] === "object")
    .sort((a, b) => bytes(plain[b]) - bytes(plain[a]));
  for (const field of fields) {
    if (bytes(main) <= SPLIT_BYTES) break;
    const v = plain[field];
    const kind: PartRef["kind"] = Array.isArray(v) ? "array" : "object";
    const groups: unknown[] = kind === "array" ? chunk(v as unknown[], bytes) : chunk(Object.entries(v as Rec), bytes);
    const ids: string[] = [];
    for (const g of groups) {
      const body = kind === "array" ? { items: g as unknown[] } : { entries: Object.fromEntries(g as Array<[string, unknown]>) };
      const id = `${name}.${field}.${hash(JSON.stringify(body))}`;
      parts[id] = { doc: name, field, createdAt: now, ...body } satisfies PartDoc;
      ids.push(id);
    }
    refs.push({ field, kind, ids });
    delete main[field];
  }
  main.__parts = refs;
  return { main, parts };
}

/** The part ids a main document refers to. */
export function partIdsOf(main: Rec | null | undefined): string[] {
  const refs = (main?.__parts ?? []) as PartRef[];
  return Array.isArray(refs) ? refs.flatMap((r) => r.ids ?? []) : [];
}

/** Joins a main document with its parts. Throws when a part is missing (never a half document). */
export function joinDoc(main: Rec, part: (id: string) => Rec | null | undefined): Rec {
  const refs = main.__parts as PartRef[] | undefined;
  if (!Array.isArray(refs)) return main;
  const out: Rec = { ...main };
  delete out.__parts;
  for (const r of refs) {
    if (r.kind === "array") {
      const items: unknown[] = [];
      for (const id of r.ids) {
        const p = part(id) as PartDoc | null | undefined;
        if (!p || !Array.isArray(p.items)) throw new Error(`A part of your saved data is missing (${id}).`);
        items.push(...p.items);
      }
      out[r.field] = items;
    } else {
      const entries: Rec = {};
      for (const id of r.ids) {
        const p = part(id) as PartDoc | null | undefined;
        if (!p || !p.entries) throw new Error(`A part of your saved data is missing (${id}).`);
        Object.assign(entries, p.entries);
      }
      out[r.field] = entries;
    }
  }
  return out;
}

/** Parts no main document refers to and older than SWEEP_AFTER_MS. Pure. */
export function staleParts(parts: Record<string, Rec>, mains: Array<Rec | null | undefined>, now = Date.now()): string[] {
  const used = new Set(mains.flatMap((m) => partIdsOf(m)));
  return Object.entries(parts)
    .filter(([id, p]) => !used.has(id) && now - Number(p.createdAt ?? 0) > SWEEP_AFTER_MS)
    .map(([id]) => id);
}

// ---------- the page's database ----------

type DocRef = { get(): Promise<{ exists: boolean; data(): unknown }>; set(d: Rec): Promise<unknown>; delete(): Promise<unknown> };
type ColRef = { doc(id: string): DocRef; get(): Promise<{ docs: Array<{ id: string; exists: boolean; data(): unknown }> }> };

/** Reads a document that may be split. */
export async function readBig(ref: DocRef, parts: ColRef): Promise<Rec | null> {
  const s = await ref.get();
  if (!s.exists) return null;
  const main = s.data() as Rec;
  const ids = partIdsOf(main);
  if (!ids.length) return main;
  const got = new Map<string, Rec>();
  await Promise.all(
    ids.map(async (id) => {
      const p = await parts.doc(id).get();
      if (p.exists) got.set(id, p.data() as Rec);
    }),
  );
  return joinDoc(main, (id) => got.get(id));
}

/** Parts this page wrote or read for one document recently: id → when. */
export type Written = Map<string, number>;

/**
 * Writes a document, split when it's big: new parts first, then the main
 * document. A part from this document's last version (less than half the
 * sweep time ago) isn't sent again; anything older is rewritten with a fresh
 * date, so a sweep can never take a part the new version still needs.
 */
export async function writeBig(name: string, doc: Rec, ref: DocRef, parts: ColRef, written: Written): Promise<void> {
  const { main, parts: ps } = splitDoc(name, doc);
  const now = Date.now();
  const fresh = new Map<string, number>();
  for (const [id, p] of Object.entries(ps)) {
    const at = written.get(id);
    if (at !== undefined && now - at < SWEEP_AFTER_MS / 2) {
      fresh.set(id, at);
      continue;
    }
    await parts.doc(id).set({ ...p, createdAt: now });
    fresh.set(id, now);
  }
  await ref.set(main);
  written.clear();
  for (const [id, at] of fresh) written.set(id, at);
}

/** Removes parts nobody needs any more. `mains` reads every document that may have parts. Best effort; never throws. */
export async function sweepParts(parts: ColRef, mains: () => Promise<Array<Rec | null>>): Promise<void> {
  try {
    const all = await parts.get();
    const docs = Object.fromEntries(all.docs.filter((d) => d.exists).map((d) => [d.id, d.data() as Rec]));
    if (!Object.keys(docs).length) return;
    for (const id of staleParts(docs, await mains())) await parts.doc(id).delete().catch(() => undefined);
  } catch {
    // Tried again next time.
  }
}

/** Joins every split document in a set of loaded documents. Pure. */
export function joinAll<T extends Rec | null>(doc: T, parts: Record<string, Rec>): T {
  return doc && partIdsOf(doc).length ? (joinDoc(doc, (id) => parts[id]) as T) : doc;
}
