// Keeping what the student dropped (design/course-files.md, "Taking files in").
//
// Used by the setup chat and by Organize. Zips are opened, every file is
// kept with its text and outline (or listed by name when it can't be read),
// and the student gets one short report per drop instead of a card per file.
// Claude gets the start of loose files and an inventory of zips, never the
// whole text: the organization agent opens what it needs later.

import { uid } from "../chat/types";
import type { IntakeReport, Upload, ZipRecord } from "../onboarding/types";
import type { StorageUsage, UploadContent } from "../platform/onboardingStore";
import { compressImage, dataUrlToBlob } from "../quests/images";
import type { PendingAttachment } from "./files";
import { readPdf } from "./files";
import { heicToJpeg, isHeic, jpegName } from "./heic";
import { breathe, buildOutline, classify, selectPart, walkZip, zipEntries, type FileClass, type IntakeFile, type ZipEntry } from "./intake";
import { officeText } from "./office";

export const MAX_FILE_CHARS = 240_000;
const PREVIEW_CHARS = 3_000;
/** With more loose files than this in one drop, Claude gets outlines instead of the start of each. */
const MANY = 8;

export type KeepStore = {
  saveUploadContent(id: string, c: UploadContent): Promise<void>;
  storeOriginal(file: Blob, type?: string | null): Promise<string | null>;
  storageUsage?(): Promise<StorageUsage | null>;
};

/** Room left in the file store while a drop is kept; null when the platform doesn't say. */
type Room = { files: number; bytes: number; skipped: number; skippedBytes: number } | null;

const MB = 1024 * 1024;
export const fmtMB = (b: number) => (b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(1)} GB` : `${Math.max(1, Math.round(b / MB))} MB`);

export type KeptDrop = {
  uploads: Upload[];
  zips: ZipRecord[];
  /** For Claude: the start of loose files, an inventory per zip. */
  previews: string[];
  images: Blob[];
  failed: string[];
  /** For the student: shown under their message. Null when there's nothing worth saying. */
  report: IntakeReport | null;
};

const ORIGINAL_TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", json: "application/json" };

/** The type the file store keeps an original under; null when it doesn't take that kind. Pure. */
export function originalType(name: string, cls: FileClass): string | null {
  const ext = /\.([^./]+)$/.exec(name.toLowerCase())?.[1] ?? "";
  if (ORIGINAL_TYPES[ext]) return ORIGINAL_TYPES[ext];
  return cls === "text" ? "text/plain" : null;
}

const clip = (t: string) => (t.length > MAX_FILE_CHARS ? t.slice(0, MAX_FILE_CHARS) : t);

type One = { upload: Upload; content: UploadContent | null; image: Blob | null; problem?: string };

/** Keeps one file: its readable content and outline in the student's data, the original in the file store. */
async function keepOne(f: IntakeFile, zipId: string | null, store: KeepStore, now: number, room: Room = null): Promise<One> {
  // An iPhone photo is kept as a JPEG: Claude and the file store can't take HEIC (src/lib/heic.ts).
  if (f.cls === "image" && f.blob && isHeic(f.name)) {
    const jpeg = await heicToJpeg(f.blob);
    f = { ...f, name: jpegName(f.name), blob: jpeg, size: jpeg.size };
  }
  const id = `up_${uid()}`;
  const upload: Upload = {
    id,
    courseId: null,
    fileName: f.name,
    type: f.cls === "pdf" || f.cls === "image" || f.cls === "text" || f.cls === "office" || f.cls === "video" ? f.cls : "other",
    studentNote: "",
    addedAt: now,
    cataloguedAt: null,
    assetId: null,
    pages: null,
    ...(zipId ? { path: f.path, zipId } : {}),
    state: "readable",
    sizeBytes: f.size,
  };
  if (!f.blob || f.cls === "video" || f.cls === "other" || f.cls === "zip" || f.cls === "junk") {
    return { upload: { ...upload, state: "listed" }, content: null, image: null };
  }
  const keepOriginal = async () => {
    const type = originalType(f.name, f.cls);
    if (!type) return null;
    const size = f.blob!.size;
    if (room && (room.files < 1 || room.bytes < size)) {
      room.skipped++;
      room.skippedBytes += size;
      return null;
    }
    const id = await store.storeOriginal(f.blob!, type);
    if (id && room) {
      room.files--;
      room.bytes -= size;
    }
    return id;
  };
  let content: UploadContent;
  let image: Blob | null = null;
  if (f.cls === "pdf") {
    const pdf = await readPdf(f.blob, MAX_FILE_CHARS);
    upload.pages = pdf.pages;
    if (pdf.scan) {
      upload.assetId = await keepOriginal();
      if (!upload.assetId) return { upload: { ...upload, state: "listed" }, content: null, image: null, problem: room && room.skipped ? "a scan without text; the file store is full, so it couldn't be kept for the agent" : "a scan without text, too big to keep for the agent" };
      await store.saveUploadContent(id, { outline: `(a scan: ${pdf.pages} pages without text)` });
      return { upload: { ...upload, state: "agent" }, content: null, image: null };
    }
    content = { text: clip(pdf.text), outline: buildOutline(pdf.text, pdf.bookmarks) };
  } else if (f.cls === "image") {
    const small = await compressImage(f.blob);
    if (!small) throw new Error("couldn't be read");
    content = { image: small, outline: "(an image)" };
    // Claude gets the shrunk JPEG it will also see in later turns, not the
    // original: a huge PNG or an odd format would make it refuse the question.
    image = dataUrlToBlob(small);
  } else if (f.cls === "office") {
    const text = officeText(f.name, new Uint8Array(await f.blob.arrayBuffer()));
    content = { text: clip(text), outline: buildOutline(text) };
    upload.pages = (text.match(/^--- (?:slide|sheet) \d+ ---$/gm) ?? []).length || null;
  } else {
    const text = await f.blob.text();
    content = { text: clip(text), outline: buildOutline(text) };
  }
  await store.saveUploadContent(id, content);
  if (f.cls !== "office") upload.assetId = await keepOriginal();
  return { upload, content, image };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "61 PDFs, 9 slide decks, 2 scans for the agent, 12 videos". Pure. */
export function describeCounts(us: Upload[]): string {
  const n = (p: (u: Upload) => boolean) => us.filter(p).length;
  const parts = [
    [n((u) => u.type === "pdf" && u.state !== "agent" && u.state !== "listed"), "PDF"],
    [n((u) => u.type === "office"), "Office file"],
    [n((u) => u.type === "image"), "image"],
    [n((u) => u.type === "text"), "text file"],
    [n((u) => u.state === "agent"), "scan for the agent"],
    [n((u) => u.type === "video"), "video"],
    [n((u) => u.type === "other"), "file StudyDesk can't open"],
  ] as const;
  return parts
    .filter(([c]) => c > 0)
    .map(([c, w]) => plural(c, w, w === "scan for the agent" ? "scans for the agent" : w === "file StudyDesk can't open" ? "files StudyDesk can't open" : `${w}s`))
    .join(", ");
}

/** The inventory of one zip, for Claude: folders and file paths, capped. Pure. */
export function zipInventory(z: ZipRecord, us: Upload[], maxLines = 80): string {
  const mine = us.filter((u) => u.zipId === z.id);
  const folders = new Map<string, number>();
  for (const u of mine) {
    const dir = (u.path ?? u.fileName).split("/").slice(0, -1).join("/") || "(top)";
    folders.set(dir, (folders.get(dir) ?? 0) + 1);
  }
  const lines = mine.slice(0, maxLines).map((u) => `- ${u.path ?? u.fileName}${u.pages ? ` (${u.pages} p.)` : ""}${u.state === "listed" ? " [name only]" : u.state === "agent" ? " [scan]" : ""}`);
  return `Zip ${z.id} "${z.fileName}": ${mine.length} files (${describeCounts(mine)}). Folders: ${[...folders].map(([d, c]) => `${d} (${c})`).join(", ")}.\n${lines.join("\n")}${mine.length > maxLines ? `\n…and ${mine.length - maxLines} more` : ""}`;
}

export type KeepOptions = {
  now?: number;
  /**
   * Called as soon as each zip is kept, to save its files at once. Its files
   * are then not in the returned `uploads` and `zips` (they're saved already).
   */
  onZipKept?: (uploads: Upload[], zip: ZipRecord) => Promise<void> | void;
  /** Called at every step with where each part of the drop stands, for a progress display. */
  onProgress?: (p: KeepProgress) => void;
};

/** One part of a drop: the loose files together, or one zip. */
export type KeepItem = {
  name: string;
  state: "waiting" | "working" | "done" | "failed";
  /** Files kept so far, and how many there are (about, for a zip). */
  done: number;
  total: number;
  /** Files in it that couldn't be kept completely. */
  problems: number;
  note?: string;
};
export type KeepProgress = { items: KeepItem[] };

/** How far a whole drop is, 0 to 1: every part counts the same. Pure. */
export function keepFraction(p: KeepProgress): number {
  if (!p.items.length) return 0;
  const one = (i: KeepItem) => (i.state === "done" || i.state === "failed" ? 1 : i.state === "waiting" || !i.total ? 0 : Math.min(i.done / i.total, 0.99));
  return p.items.reduce((n, i) => n + one(i), 0) / p.items.length;
}

let keeping = 0;
/** True while a drop is being kept in this page (leftover clean-up waits for it). */
export const keepingNow = () => keeping > 0;

/** Keeps everything in one drop. `onBusy` gets a short line per step. */
export async function keepDrop(files: PendingAttachment[], store: KeepStore, onBusy: (line: string) => void, opts: KeepOptions = {}): Promise<KeptDrop> {
  keeping++;
  try {
    return await keepDropNow(files, store, onBusy, opts);
  } finally {
    keeping--;
  }
}

async function keepDropNow(files: PendingAttachment[], store: KeepStore, onBusy: (line: string) => void, opts: KeepOptions): Promise<KeptDrop> {
  const now = opts.now ?? Date.now();
  const uploads: Upload[] = [];
  const zips: ZipRecord[] = [];
  const previews: string[] = [];
  const images: Blob[] = [];
  const failed: string[] = [];
  const lines: string[] = [];
  const handedOver: Upload[] = [];

  const zipFiles = files.filter((f) => f.deferred === "zip" && f.file).map((f) => f.file!);
  const usage = store.storageUsage ? await store.storageUsage().catch(() => null) : null;
  const room: Room = usage ? { files: usage.maxFiles - usage.files, bytes: usage.maxBytes - usage.bytes, skipped: 0, skippedBytes: 0 } : null;
  const loose: IntakeFile[] = files
    .filter((f) => f.deferred !== "zip")
    .map((f) => {
      const cls: FileClass = f.deferred ?? (f.kind === "image" ? "image" : f.kind === "pdf" ? "pdf" : /\.(docx|pptx|xlsx|odt|odp|ods)$/i.test(f.name) ? "office" : "text");
      const blob = f.kind === "image" ? (f.blob ?? f.file ?? null) : (f.file ?? (f.text !== undefined ? new Blob([f.text], { type: "text/plain" }) : null));
      return { name: f.name, path: f.name, cls, size: f.file?.size ?? 0, blob: cls === "video" || cls === "other" ? null : blob, zip: null };
    });

  // Where each part stands, for the progress display: the loose files as one part, then each zip.
  const items: KeepItem[] = [
    ...(loose.length ? [{ name: loose.length === 1 ? loose[0].name : `${loose.length} files`, state: "waiting" as const, done: 0, total: loose.length, problems: 0 }] : []),
    ...zipFiles.map((z) => ({ name: z.name, state: "waiting" as const, done: 0, total: 0, problems: 0 })),
  ];
  const show = (i: number, p: Partial<KeepItem>) => {
    items[i] = { ...items[i], ...p };
    opts.onProgress?.({ items: items.map((x) => ({ ...x })) });
  };
  const looseAt = 0;
  const zipAt = loose.length ? 1 : 0;

  // Loose files, as before: Claude sees the start of each (or its outline when there are many).
  for (const [k, f] of loose.entries()) {
    onBusy(`Keeping ${f.name} (${k + 1} of ${loose.length})…`);
    show(looseAt, { state: "working", done: k });
    const failedBefore = failed.length;
    try {
      const one = await keepOne(f, null, store, now, room);
      uploads.push(one.upload);
      if (one.problem) failed.push(`${f.name}: ${one.problem}`);
      const u = one.upload;
      if (one.image) {
        images.push(one.image);
        previews.push(`File ${u.id} "${u.fileName}": image ${images.length} of the attached images.`);
      } else if (u.state === "listed") {
        previews.push(`File ${u.id} "${u.fileName}": ${u.type === "video" ? "a video (Claude can't watch or listen; going by its title unless the student describes it)" : "a file StudyDesk can't open, known by name only"}.`);
      } else if (u.state === "agent") {
        previews.push(`File ${u.id} "${u.fileName}", ${u.pages} pages: a scan without text. A cloud session can read it.`);
      } else {
        const body = loose.length > MANY ? one.content?.outline ?? "" : (one.content?.text ?? "").slice(0, PREVIEW_CHARS);
        previews.push(`File ${u.id} "${u.fileName}"${u.pages ? `, ${u.pages} pages` : ""}. ${loose.length > MANY ? "Outline" : "Beginning"}:\n"""\n${body}\n"""`);
      }
    } catch (e) {
      failed.push(`${f.name}: ${e instanceof Error ? e.message : "couldn't be read"}`);
    }
    show(looseAt, { done: k + 1, problems: items[looseAt].problems + (failed.length - failedBefore) });
    await breathe();
  }
  if (loose.length) show(looseAt, { state: "done" });
  if (loose.length > 1) {
    const kept = uploads.filter((u) => !u.zipId);
    if (kept.length) lines.push(`${plural(kept.length, "file")} kept: ${describeCounts(kept)}.`);
  }

  // Zips: one record each, every file inside kept with its folder path. One
  // file is unpacked, kept and let go at a time, so memory stays flat however
  // big the zip is, and the page gets a breath between files.
  for (const [zi, zf] of zipFiles.entries()) {
    const which = zipFiles.length > 1 ? ` (zip ${zi + 1} of ${zipFiles.length})` : "";
    onBusy(`Opening ${zf.name}${which}…`);
    show(zipAt + zi, { state: "working" });
    let entries: ZipEntry[];
    try {
      entries = await zipEntries(zf);
    } catch (e) {
      failed.push(`${zf.name}: ${e instanceof Error ? e.message : "couldn't be opened"}`);
      show(zipAt + zi, { state: "failed", note: "couldn't be opened" });
      continue;
    }
    const z: ZipRecord = { id: `zip_${uid()}`, fileName: zf.name, courseId: null, addedAt: now, files: 0 };
    const listedFiles = entries.filter((e) => !e.name.endsWith("/") && classify(e.name) !== "junk");
    // Say before keeping when the originals won't all fit. The text of every file is kept anyway.
    const need = listedFiles.filter((e) => originalType(e.name, classify(e.name))).reduce((n, e) => n + e.usize, 0);
    if (room && need > room.bytes) lines.push(`${zf.name} needs about ${fmtMB(need)} for its original files, but your StudyDesk's file store has ${fmtMB(Math.max(0, room.bytes))} left. StudyDesk keeps the text of every file, and the originals that fit.`);
    const mine: Upload[] = [];
    const found = { name: zf.name, files: 0, skippedJunk: 0 };
    const failedBefore = failed.length;
    show(zipAt + zi, { total: listedFiles.length });
    try {
      for await (const f of walkZip(zf, zf.name, found)) {
        onBusy(`Keeping ${zf.name}${which}: ${mine.length + 1} of about ${listedFiles.length} files…`);
        show(zipAt + zi, { done: mine.length, problems: failed.length - failedBefore });
        try {
          const blob = f.read ? await f.read() : null;
          const one = await keepOne({ ...f, blob }, z.id, store, now, room);
          mine.push(one.upload);
          if (one.problem) failed.push(`${f.path}: ${one.problem}`);
        } catch (e) {
          mine.push({ id: `up_${uid()}`, courseId: null, fileName: f.name, type: "other", studentNote: "", addedAt: now, cataloguedAt: null, assetId: null, pages: null, path: f.path, zipId: z.id, state: "listed", sizeBytes: f.size });
          failed.push(`${f.path}: ${e instanceof Error ? e.message : "couldn't be read"}`);
        }
        await breathe();
      }
    } catch (e) {
      failed.push(`${zf.name}: ${e instanceof Error ? e.message : "couldn't be opened completely"}`);
    }
    z.files = mine.length;
    show(zipAt + zi, { state: "done", done: mine.length, total: Math.max(mine.length, items[zipAt + zi].total), problems: failed.length - failedBefore });
    previews.push(zipInventory(z, mine));
    lines.push(`${zf.name}: ${plural(mine.length, "file")}${mine.length ? `, ${describeCounts(mine)}` : ""}.`);
    handedOver.push(...(opts.onZipKept ? mine : []));
    if (opts.onZipKept) {
      // Saved right away, so closing the window later loses at most the zip being kept.
      await opts.onZipKept(mine, z);
    } else {
      zips.push(z);
      uploads.push(...mine);
    }
  }

  if (room && room.skipped) {
    lines.push(`${plural(room.skipped, "original")} (${fmtMB(room.skippedBytes)}) didn't fit in the file store; their text is kept.`);
    previews.push(`The file store is full: ${room.skipped} originals weren't kept (their text is). Tell the student once, and ask which courses matter most before they add more.`);
  }
  if (failed.length) lines.push(`${plural(failed.length, "file")} couldn't be kept completely: ${failed.slice(0, 5).join("; ")}${failed.length > 5 ? "; …" : ""}`);
  const videos = [...uploads, ...handedOver].filter((u) => u.type === "video").map((u) => ({ uploadId: u.id, name: u.fileName }));
  const report: IntakeReport | null = lines.length || videos.length ? { lines, ...(videos.length ? { videos } : {}) } : null;
  return { uploads, zips, previews, images, failed, report };
}

/** The upload ids a file reference means: one upload, or every file of a zip. Pure. */
export function filesOf(ref: string, uploads: Upload[]): string[] {
  if (ref.startsWith("zip_")) return uploads.filter((u) => u.zipId === ref).map((u) => u.id);
  return uploads.some((u) => u.id === ref) ? [ref] : [];
}

/** Video descriptions the student wrote, by upload id (kept as the upload's studentNote). Pure. */
export function describedVideos(uploads: Upload[]): Record<string, string> {
  return Object.fromEntries(uploads.filter((u) => u.type === "video" && u.studentNote).map((u) => [u.id, u.studentNote]));
}

/** Saves what the student says a video covers; the agent reads it in place of the video. Pure. */
export function describeVideo<D extends { uploads: Upload[] }>(d: D, uploadId: string, note: string): D {
  const u = d.uploads.find((x) => x.id === uploadId);
  if (!u) return d;
  return { ...d, uploads: d.uploads.map((x) => (x.id === uploadId ? { ...x, studentNote: note } : x)) };
}

/** A course's files for Claude's snapshot: loose files by name, zips as one line each. Pure. */
export function courseFileList(uploads: Upload[], zips: ZipRecord[] | undefined, courseId: string): string[] {
  const mine = uploads.filter((u) => u.courseId === courseId);
  const loose = mine.filter((u) => !u.zipId).map((u) => `${u.fileName}${u.studentNote ? ` (${u.studentNote})` : ""}`);
  const byZip = new Map<string, number>();
  for (const u of mine) if (u.zipId) byZip.set(u.zipId, (byZip.get(u.zipId) ?? 0) + 1);
  const zipLines = [...byZip].map(([id, n]) => `${zips?.find((z) => z.id === id)?.fileName ?? "a zip"} (${n} files)`);
  return [...loose, ...zipLines];
}

/** Files not yet given a course: loose ones each, a zip as one entry under its zip id. Pure. */
export function unsortedList(uploads: Upload[], zips: ZipRecord[] | undefined): Array<{ uploadId: string; name: string; type?: string; pages?: number | null; files?: number }> {
  const open = uploads.filter((u) => !u.courseId);
  const loose = open.filter((u) => !u.zipId).map((u) => ({ uploadId: u.id, name: u.fileName, type: u.type, pages: u.pages }));
  const byZip = new Map<string, number>();
  for (const u of open) if (u.zipId) byZip.set(u.zipId, (byZip.get(u.zipId) ?? 0) + 1);
  return [...loose, ...[...byZip].map(([id, n]) => ({ uploadId: id, name: zips?.find((z) => z.id === id)?.fileName ?? "zip", files: n }))];
}

/**
 * Images the student dropped in earlier messages, newest first, so Claude
 * still sees them in later turns (each turn only carries text otherwise).
 * Older messages without upload ids are matched by file name. Pure.
 */
export function earlierImageIds(messages: Array<{ role: string; files?: string[]; uploadIds?: string[] }>, uploads: Upload[], exclude: Set<string>, max = 4): string[] {
  const images = uploads.filter((u) => u.type === "image");
  const out: string[] = [];
  for (const m of [...messages].reverse()) {
    if (m.role !== "user") continue;
    const ids = m.uploadIds ?? (m.files ?? []).flatMap((name) => images.filter((u) => u.fileName === name).map((u) => u.id));
    for (const id of ids) {
      if (out.length >= max) return out;
      if (!exclude.has(id) && !out.includes(id) && images.some((u) => u.id === id)) out.push(id);
    }
  }
  return out;
}

/** The chat's read_file tool: any kept file's outline, or the pages or lines asked for. */
export const READ_FILE_TOOL = {
  name: "read_file",
  description:
    'Reads a file the student dropped earlier (any upload id from the sheet, unsortedFiles or a zip inventory): without "part" its outline, with "part" the text of pages "3-5", slides the same way, or lines "l. 40-80". Use it when you need what a file says (a timetable, a syllabus\'s dates) instead of asking the student. Images can\'t be read this way.',
  inputSchema: {
    type: "object",
    properties: { file: { type: "string", description: "Upload id (up_…)" }, part: { type: "string", description: 'Optional: "1-3", "l. 1-80" or "all"' } },
    required: ["file"],
  },
} as const;

/** Runs read_file against the kept content. */
export async function readKeptFile(input: Record<string, unknown>, uploads: Upload[], load: (id: string) => Promise<UploadContent | null>): Promise<string> {
  const id = String(input.file ?? "").trim();
  const u = uploads.find((x) => x.id === id);
  if (!u) return `No file ${id}.`;
  if (u.type === "image") return "An image: it's attached to the conversation when the student drops it; ask them if it isn't there.";
  if (u.state === "listed") return u.type === "video" ? `A video: Claude can't watch or listen. ${u.studentNote ? `The student says: "${u.studentNote}"` : "Go by its title, or ask the student."}` : "StudyDesk couldn't open this file; only its name is known.";
  const c = await load(id);
  if (!c?.text) return u.state === "agent" ? "A scan without text: a cloud session reads it during setup. Ask the student what it says if you need it now." : "Nothing readable is kept for this file.";
  const part = input.part ? String(input.part) : "";
  if (!part) return c.outline || selectPart(c.text, "1-2").text;
  return selectPart(c.text, part, 30_000).text;
}

/** Most images one question carries, this turn's and earlier ones together (fewer where the view allows fewer). */
export const RECALL_IMAGES = 5;

/**
 * Loads the earlier images to send again this turn, with a line telling
 * Claude which attached image is which file. Images sent this turn come first
 * (they're numbered by keepDrop), so earlier ones are numbered after them.
 */
export async function recallImages(
  messages: Array<{ role: string; files?: string[]; uploadIds?: string[] }>,
  uploads: Upload[],
  sentNow: number,
  exclude: Set<string>,
  load: (id: string) => Promise<UploadContent | null>,
  max = RECALL_IMAGES,
): Promise<{ images: Blob[]; note: string }> {
  const room = Math.max(0, max - sentNow);
  if (!room) return { images: [], note: "" };
  const images: Blob[] = [];
  const lines: string[] = [];
  for (const id of earlierImageIds(messages, uploads, exclude, room)) {
    try {
      const c = await load(id);
      if (!c?.image) continue;
      images.push(dataUrlToBlob(c.image));
      const u = uploads.find((x) => x.id === id);
      lines.push(`Image ${sentNow + images.length}: file ${id} "${u?.fileName ?? "image"}", dropped earlier.`);
    } catch {
      /* a missing image just isn't sent again */
    }
  }
  return { images, note: lines.length ? `Images the student dropped earlier, attached again so you can still see them:\n${lines.join("\n")}` : "" };
}
