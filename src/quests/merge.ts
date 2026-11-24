// Two devices working on the same quest. Each save is a three-way merge: what
// this copy changed since the saved version it started from (`base`) wins,
// everything else comes from the stored copy. So a stale tab or a second device
// only ever writes its own edits and can't put older work back.

import type { QuestProgress } from "./types";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Field by field down to `depth` levels: mine where I changed it, theirs otherwise. */
function merge3(b: unknown, m: unknown, t: unknown, depth: number): unknown {
  if (same(m, b)) return t;
  if (same(t, b) || depth === 0 || !isObj(m) || !isObj(t)) return m;
  const base = isObj(b) ? b : {};
  const out: Obj = {};
  for (const k of new Set([...Object.keys(m), ...Object.keys(t)])) {
    const v = merge3(base[k], m[k], t[k], depth - 1);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Lists merged by member: hand-ins and cleared gates as sets, notes by id.
const asSet = (xs?: string[]) => Object.fromEntries((xs ?? []).map((x) => [x, true]));
const keyed = (p: QuestProgress) => ({ ...p, handedIn: asSet(p.handedIn), gatesCleared: asSet(p.gatesCleared), notes: Object.fromEntries((p.notes ?? []).map((n) => [n.id, n])) });

/** `mine` (built on `base`) merged onto `theirs`, the newer stored copy. Returns `theirs` itself when mine changed nothing. */
export function mergeProgress(base: QuestProgress, mine: QuestProgress, theirs: QuestProgress): QuestProgress {
  if (same(mine, base)) return theirs;
  // Levels: progress → work → one problem's fields.
  const r = merge3(keyed(base), keyed(mine), keyed(theirs), 3) as ReturnType<typeof keyed>;
  return { ...r, handedIn: Object.keys(r.handedIn), gatesCleared: Object.keys(r.gatesCleared), notes: Object.values(r.notes) };
}
