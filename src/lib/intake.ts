// Taking course files in (design/course-files.md, "Taking files in").
//
// Every dropped file, and every file inside a dropped zip, ends up as one of:
// readable now, kept for the agent (a scan), or skipped with a reason. Which
// one is mechanics with one right answer, so it is plain, tested code.

import { inflate, inflateSync } from "fflate";
import { OFFICE_EXT } from "./office";

export type FileClass = "pdf" | "image" | "text" | "office" | "zip" | "video" | "junk" | "other";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|tsx|jsx|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|sql|tex|bib|yaml|yml|ini|log|m|r|jl|ipynb|sh|bat|vhd|vhdl|v|sv|asm|s|kt|swift|scala|lua|pl|toml|cfg|conf|rst|org|srt|vtt)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|avi|mkv|webm|wmv|flv|mpe?g|3gp|mp3|m4a|wav|ogg|oga|flac|aac|wma|opus)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** What kind of file this is, from its name (and type when there is one). Pure. */
export function classify(name: string, type = ""): FileClass {
  const base = name.split("/").pop() ?? name;
  if (!base || base.startsWith("._") || /^(\.ds_store|thumbs\.db|desktop\.ini)$/i.test(base) || /(^|\/)__MACOSX\//.test(name) || name.endsWith("/")) return "junk";
  if (/\.zip$/i.test(base) || type === "application/zip" || type === "application/x-zip-compressed") return "zip";
  if (/\.pdf$/i.test(base) || type === "application/pdf") return "pdf";
  if (OFFICE_EXT.test(base)) return "office";
  if (IMAGE_EXT.test(base) || /^image\/(png|jpe?g|webp|gif)$/.test(type)) return "image";
  if (VIDEO_EXT.test(base) || type.startsWith("video/") || type.startsWith("audio/")) return "video";
  if (TEXT_EXT.test(base) || type.startsWith("text/")) return "text";
  return "other";
}

/**
 * One file to keep: a loose file, or one inside a zip (with its folder path
 * inside the zip). `blob` is null for files that are only listed (videos); a
 * zip entry's bytes are read only when `read()` is called, one file at a time.
 */
export type IntakeFile = { name: string; path: string; cls: FileClass; size: number; blob: Blob | null; zip: string | null; read?: () => Promise<Blob> };

/** The zips of one drop, with what was in them. */
export type ZipFound = { name: string; files: number; skippedJunk: number };

const MAX_NESTED = 3;
/** Files bigger than this are listed by name, not opened: one file this size is the most the page holds at once, which keeps imports safe on laptops with little memory. */
export const MAX_ENTRY_BYTES = 80 * 1024 * 1024;

// ---------- reading zips one file at a time ----------
//
// A zip lists all its files at the end (the central directory). Reading that
// list first, then each file's own bytes only when it's kept, means the page
// never holds more than one file at a time and never unpacks a video. The
// unpacking itself runs in a background worker (fflate's async inflate), so
// the page stays responsive. Plain mechanics, tested.

export type ZipEntry = { name: string; method: number; flags: number; csize: number; usize: number; offset: number };

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);
const u64 = (d: DataView, o: number) => Number(d.getBigUint64(o, true));
const bytes = async (b: Blob, start: number, end: number) => new Uint8Array(await b.slice(start, end).arrayBuffer());

function decodeName(raw: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return new TextDecoder("windows-1252").decode(raw);
    }
  }
  return new TextDecoder().decode(raw);
}

/** Reads a zip's file list from its end, without reading the files. Throws a plain sentence on a broken zip. */
export async function zipEntries(blob: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(blob.size, 65_557);
  const tailStart = blob.size - tailLen;
  const tail = await bytes(blob, tailStart, blob.size);
  const td = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(td, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This zip couldn't be opened (it may be broken or not a zip).");
  let count = u16(td, eocd + 10);
  let cdSize = u32(td, eocd + 12);
  let cdOffset = u32(td, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the real numbers sit in a record the locator points to.
    const loc = eocd - 20;
    if (loc < 0 || u32(td, loc) !== 0x07064b50) throw new Error("This zip couldn't be opened (its file list is damaged).");
    const z64At = u64(td, loc + 8);
    const z = await bytes(blob, z64At, z64At + 56);
    const zd = new DataView(z.buffer, z.byteOffset, z.byteLength);
    if (u32(zd, 0) !== 0x06064b50) throw new Error("This zip couldn't be opened (its file list is damaged).");
    count = u64(zd, 32);
    cdSize = u64(zd, 40);
    cdOffset = u64(zd, 48);
  }
  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const d = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(d, p) !== 0x02014b50) break;
    const flags = u16(d, p + 8);
    const method = u16(d, p + 10);
    let csize = u32(d, p + 20);
    let usize = u32(d, p + 24);
    const nameLen = u16(d, p + 28);
    const extraLen = u16(d, p + 30);
    const commentLen = u16(d, p + 32);
    let offset = u32(d, p + 42);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    // ZIP64 sizes and offset live in an extra field when the plain ones are full.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = u16(d, e);
      const len = u16(d, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) (usize = u64(d, q)), (q += 8);
        if (csize === 0xffffffff) (csize = u64(d, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(d, q);
      }
      e += 4 + len;
    }
    out.push({ name, method, flags, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Unpacks one entry's bytes. Deflate runs in a worker when the browser allows it. */
export async function readZipEntry(blob: Blob, e: ZipEntry): Promise<Uint8Array> {
  if (e.flags & 1) throw new Error("password protected");
  const head = await bytes(blob, e.offset, e.offset + 30);
  const hd = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (u32(hd, 0) !== 0x04034b50) throw new Error("damaged inside the zip");
  const start = e.offset + 30 + u16(hd, 26) + u16(hd, 28);
  const comp = await bytes(blob, start, start + e.csize);
  if (e.method === 0) return comp;
  if (e.method !== 8) throw new Error("packed in a way StudyDesk can't open");
  try {
    return await new Promise<Uint8Array>((resolve, reject) => inflate(comp, { size: e.usize }, (err, data) => (err ? reject(err) : resolve(data))));
  } catch {
    // No workers here: unpack it in the page, then let the page breathe.
    const out = inflateSync(comp, { out: new Uint8Array(e.usize) });
    await breathe();
    return out;
  }
}

/** Lets the browser draw and handle input between heavy steps. */
export const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Walks a zip one file at a time, nested zips included. Each kept file comes
 * with `read()`, which unpacks only that file. Junk is counted and left out.
 */
export async function* walkZip(blob: Blob, zipName: string, found: ZipFound, prefix = "", depth = 0): AsyncGenerator<IntakeFile> {
  const entries = await zipEntries(blob);
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const cls = classify(e.name);
    if (cls === "junk") {
      found.skippedJunk++;
      continue;
    }
    const path = prefix + e.name;
    if (cls === "zip" && depth < MAX_NESTED && e.usize <= MAX_ENTRY_BYTES) {
      let inner: Uint8Array | null = null;
      try {
        inner = await readZipEntry(blob, e);
      } catch {
        inner = null;
      }
      if (inner) {
        yield* walkZip(new Blob([inner]), zipName, found, path.replace(/\.zip$/i, "") + "/", depth + 1);
        continue;
      }
    }
    found.files++;
    const listed = cls === "video" || cls === "zip" || cls === "other" || e.usize > MAX_ENTRY_BYTES;
    yield {
      name: base(e.name),
      path,
      cls: cls === "zip" ? "other" : cls,
      size: e.usize,
      blob: null,
      zip: zipName,
      ...(listed ? {} : { read: async () => new Blob([await readZipEntry(blob, e)]) }),
    };
  }
}

/**
 * Opens a drop into a plain list (zips walked, every file unpacked). Kept for
 * small drops and tests; keepDrop walks zips itself so only one file is in
 * memory at a time.
 */
export async function expandDrop(files: File[], onProgress?: (line: string) => void): Promise<{ files: IntakeFile[]; zips: ZipFound[] }> {
  const out: IntakeFile[] = [];
  const zips: ZipFound[] = [];
  for (const f of files) {
    const cls = classify(f.name, f.type);
    if (cls === "junk") continue;
    if (cls !== "zip") {
      out.push({ name: f.name || "file", path: f.name || "file", cls, size: f.size, blob: cls === "video" ? null : f, zip: null });
      continue;
    }
    const found: ZipFound = { name: f.name, files: 0, skippedJunk: 0 };
    zips.push(found);
    for await (const e of walkZip(f, f.name, found)) {
      out.push(e.read ? { ...e, blob: await e.read() } : e);
      if (found.files % 10 === 0) onProgress?.(`Opening ${f.name}: ${found.files} files so far…`);
    }
  }
  return { files: out, zips };
}

const base = (p: string) => p.split("/").pop() || p;

// ---------- outlines ----------

export const OUTLINE_CHARS = 4000;
const LINE = 90;

const cut = (s: string, n = LINE) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/**
 * A file's outline: what the agent navigates by. For page-marked text, the
 * first real line of each page or slide ("p. 3: 2.1 Grenzwerte"); bookmarks
 * win when the PDF has them. For plain text, its headings with line numbers,
 * or a line every so often. Capped at OUTLINE_CHARS. Pure.
 */
export function buildOutline(text: string, bookmarks: Array<{ title: string; page: number | null; depth: number }> = []): string {
  const lines: string[] = [];
  if (bookmarks.length) {
    for (const b of bookmarks) lines.push(`${"  ".repeat(Math.min(b.depth, 3))}${b.page ? `p. ${b.page}: ` : ""}${cut(b.title.trim())}`);
  } else if (/^--- (page|slide|sheet) \d+ ---$/m.test(text)) {
    const parts = text.split(/^--- (page|slide|sheet) (\d+) ---$/m);
    // parts: [before, kind, n, body, kind, n, body, ...]
    for (let i = 1; i < parts.length; i += 3) {
      const kind = parts[i];
      const n = parts[i + 1];
      const body = parts[i + 2] ?? "";
      const first = body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 2 && /[A-Za-zÀ-ÿ]/.test(l));
      const short = kind === "page" ? "p." : kind === "slide" ? "slide" : "sheet";
      lines.push(`${short} ${n}: ${first ? cut(first) : "(no text)"}`);
    }
  } else {
    const all = text.split("\n");
    const heading = /^(#{1,4}\s+\S|\\(part|chapter|section|subsection)\*?\{|[0-9]+(\.[0-9]+)*\.?\s+[A-ZÄÖÜ]|[A-ZÄÖÜ][A-ZÄÖÜ0-9 ,:-]{6,}$)/;
    all.forEach((l, i) => {
      const t = l.trim();
      if (t && t.length < 120 && heading.test(t)) lines.push(`l. ${i + 1}: ${cut(t)}`);
    });
    if (lines.length < 3) {
      lines.length = 0;
      const step = Math.max(1, Math.ceil(all.length / 40));
      for (let i = 0; i < all.length; i += step) {
        const t = all.slice(i, i + step).map((x) => x.trim()).find((x) => x.length > 2);
        if (t) lines.push(`l. ${i + 1}: ${cut(t)}`);
      }
    }
  }
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > OUTLINE_CHARS) {
      out += `…(${lines.length} lines in all; open the file for the rest)`;
      break;
    }
    out += (out ? "\n" : "") + l;
  }
  return out;
}

/**
 * The part of a file's text the agent asked for: pages or slides "3-5", "3",
 * "3,7-9", or lines "l. 40-80". Pure.
 */
export function selectPart(text: string, which: string, maxChars = 40_000): { text: string; cut: boolean } {
  const w = which.trim().toLowerCase();
  let out: string;
  const lineM = w.match(/^l(?:ines?)?\.?\s*(\d+)\s*(?:-|–|to)\s*(\d+)$/);
  if (lineM) {
    const all = text.split("\n");
    const a = Math.max(1, Number(lineM[1]));
    const b = Math.min(all.length, Number(lineM[2]));
    out = all
      .slice(a - 1, b)
      .map((l, i) => `${a + i}: ${l}`)
      .join("\n");
  } else if (!w || w === "all") {
    out = text;
  } else {
    const wanted = new Set<number>();
    for (const part of w.replace(/^(p(?:ages?)?|slides?|sheets?)\.?\s*/, "").split(",")) {
      const m = part.trim().match(/^(\d+)(?:\s*(?:-|–|to)\s*(\d+))?$/);
      if (!m) continue;
      const a = Number(m[1]);
      const b = Math.min(Number(m[2] ?? m[1]), a + 500);
      for (let n = a; n <= b; n++) wanted.add(n);
    }
    const parts = text.split(/^(?=--- (?:page|slide|sheet) \d+ ---$)/m);
    const picked = parts.filter((p) => {
      const n = Number(p.match(/^--- (?:page|slide|sheet) (\d+) ---$/m)?.[1]);
      return wanted.has(n);
    });
    out = picked.length ? picked.join("").trim() : wanted.size ? "(No such pages in this file.)" : text;
  }
  return out.length > maxChars ? { text: out.slice(0, maxChars) + "\n[…cut: ask for fewer pages at a time]", cut: true } : { text: out, cut: false };
}
