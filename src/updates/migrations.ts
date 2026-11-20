// Upgrade steps for stored data. design/updates.md, "Upgrade the data".
//
// When a release changes how data is stored, it raises DATA_VERSION (version.ts)
// and adds one step here: STEPS[n] turns data of version n into version n + 1.
// A step is a plain function on a whole snapshot (layout.ts): it must not
// touch anything outside it, must be safe to run on data that's already
// partly in the new shape, and gets a test in tests/updates.test.ts in the
// same pull request. The page and the nightly program run the same steps.
//
// Example, for when the first one is needed:
//
//   2: (s) => ({ ...s, masteryAttempts: mapDocs(s.masteryAttempts, (a) => ({ ...a, seconds: a.seconds ?? null })) }),

import { DATA_VERSION } from "./version";
import { toSnapshot, type Rec, type Snapshot } from "./layout";

export type Step = (s: Snapshot) => Snapshot;

/** STEPS[n]: version n → n + 1. Keep every step forever: a student may skip several releases. */
export const STEPS: Record<number, Step> = {};

/** A helper for steps: the same collection with each document changed. */
export function mapDocs(col: Record<string, Rec>, fn: (d: Rec, id: string) => Rec): Record<string, Rec> {
  return Object.fromEntries(Object.entries(col).map(([id, d]) => [id, fn(d, id)]));
}

export type UpgradeResult = { ok: true; snapshot: Snapshot; ran: number[] } | { ok: false; error: string };

/** Runs every step from `from` up to `to`, in order. Never changes its input. Pure. */
export function upgrade(snapshot: Snapshot, from: number, to = DATA_VERSION, steps: Record<number, Step> = STEPS): UpgradeResult {
  if (!Number.isInteger(from) || from < 1) return { ok: false, error: `The data version "${from}" isn't valid.` };
  if (from > to) return { ok: false, error: `Your data comes from a newer StudyDesk (data version ${from}); this one reads up to ${to}.` };
  let s = toSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const ran: number[] = [];
  for (let v = from; v < to; v++) {
    const step = steps[v];
    if (!step) return { ok: false, error: `StudyDesk has no upgrade step from data version ${v} to ${v + 1}.` };
    try {
      s = toSnapshot(step(s));
    } catch (e) {
      return { ok: false, error: `The upgrade from data version ${v} to ${v + 1} failed: ${(e as Error)?.message ?? String(e)}` };
    }
    ran.push(v);
  }
  return { ok: true, snapshot: s, ran };
}

/** The data version a snapshot says it has. Data from before updates existed has none and is version 1. */
export function dataVersionOf(s: Pick<Snapshot, "updates">): number {
  const v = Number((s.updates as { dataVersion?: unknown } | null)?.dataVersion);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}
