// Reading an "Export everything" zip back in (design/updates.md, "Import").
// Everything here is pure; src/platform/updateStore.ts#importBackup writes it.
//
// A newer StudyDesk always reads an older zip (the same upgrade steps as an
// update run on it); an older one refuses a newer zip.

import { unzipSync, strFromU8 } from "fflate";
import { originalsIn, zipPaths } from "../platform/backup";
import { toSnapshot, type Rec, type Snapshot } from "./layout";
import { upgrade } from "./migrations";
import { validateSnapshot } from "./validate";
import { DATA_VERSION } from "./version";

export type ParsedZip =
  | { mode: "cloud"; snapshot: Snapshot; dataVersion: number; appVersion: string | null; exportedAt: string | null; files: Array<{ path: string; oldAssetId: string; bytes: Uint8Array }> }
  | { mode: "local"; data: Record<string, unknown>; dataVersion: number; appVersion: string | null; exportedAt: string | null };

export class ImportError extends Error {}

/** Opens the zip and reads studydesk-data.json and the files. Throws ImportError with a plain sentence. */
export function parseBackupZip(zip: Uint8Array): ParsedZip {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new ImportError("That file isn't a zip StudyDesk can open.");
  }
  const dataFile = entries["studydesk-data.json"];
  if (!dataFile) throw new ImportError("That zip isn't a StudyDesk backup (it has no studydesk-data.json).");
  let data: Rec;
  try {
    data = JSON.parse(strFromU8(dataFile));
  } catch {
    throw new ImportError("The backup's data file is damaged.");
  }
  const v = Number(data.dataVersion ?? (data.updates as Rec | null)?.dataVersion);
  const dataVersion = Number.isInteger(v) && v >= 1 ? v : 1;
  const appVersion = typeof data.appVersion === "string" ? data.appVersion : null;
  const exportedAt = typeof data.exportedAt === "string" ? data.exportedAt : null;
  if (data.mode === "local") return { mode: "local", data: (data.data as Record<string, unknown>) ?? {}, dataVersion, appVersion, exportedAt };

  const snapshot = toSnapshot(data);
  // Which zip path holds which original: files.json in newer zips; older ones are worked out the same way the export named them.
  let manifest: Record<string, string>;
  if (entries["files.json"]) {
    try {
      manifest = JSON.parse(strFromU8(entries["files.json"]));
    } catch {
      manifest = {};
    }
  } else manifest = Object.fromEntries([...zipPaths(originalsIn(snapshot)).entries()].map(([id, path]) => [path, id]));
  const files = Object.entries(manifest)
    .filter(([path]) => entries[path])
    .map(([path, oldAssetId]) => ({ path, oldAssetId, bytes: entries[path] }));
  return { mode: "cloud", snapshot, dataVersion, appVersion, exportedAt, files };
}

/** Upgrades and checks the zip's data for this version. Pure. */
export function prepareImport(p: Extract<ParsedZip, { mode: "cloud" }>, dataVersion = DATA_VERSION): { ok: true; snapshot: Snapshot } | { ok: false; error: string } {
  if (p.dataVersion > dataVersion)
    return { ok: false, error: `This backup comes from a newer StudyDesk${p.appVersion ? ` (${p.appVersion})` : ""}. Update this StudyDesk first, then restore it.` };
  const up = upgrade(p.snapshot, p.dataVersion, dataVersion);
  if (!up.ok) return { ok: false, error: up.error };
  const check = validateSnapshot(up.snapshot);
  if (!check.ok) return { ok: false, error: `Some of the backup's data doesn't fit: ${check.problems.slice(0, 3).join("; ")}.` };
  return { ok: true, snapshot: up.snapshot };
}

/**
 * Points the upload records at the re-uploaded files (old id → new id) and
 * drops what belonged to the old StudyDesk only: its nightly task (a new one
 * is made for this desk) and its link. Files that couldn't be restored lose
 * their id; their readable copy is still there. Pure.
 */
export function relink(s: Snapshot, newIds: Map<string, string>): Snapshot {
  const fix = (holder: Rec | null): Rec | null => {
    if (!holder || !Array.isArray(holder.uploads)) return holder;
    return { ...holder, uploads: (holder.uploads as Rec[]).map((u) => (typeof u.assetId === "string" ? { ...u, assetId: newIds.get(u.assetId) ?? null } : u)) };
  };
  const profile = s.profile ? { ...s.profile } : null;
  if (profile) {
    delete profile.schedule;
    if (profile.handoff && typeof profile.handoff === "object") {
      const { artifactUrl: _old, ...rest } = profile.handoff as Rec;
      void _old;
      profile.handoff = rest;
    }
  }
  return {
    ...s,
    profile,
    setup: fix(s.setup),
    semester: fix(s.semester),
    archivedSemesters: Object.fromEntries(Object.entries(s.archivedSemesters).map(([id, a]) => [id, fix(a)!])),
    // Results waiting for the old desk's page, and its update state, don't carry over.
    routineOutbox: {},
    updates: null,
  };
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** The type to store a file with, by its name; null when the file store doesn't take it. */
export function contentTypeOf(name: string): string | null {
  const ext = /\.([^./]+)$/.exec(name.toLowerCase())?.[1] ?? "";
  return TYPES[ext] ?? null;
}
