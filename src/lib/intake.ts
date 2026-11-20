// Taking course files in (design/course-files.md, "Taking files in").
//
// Every dropped file, and every file inside a dropped zip, ends up as one of:
// readable now, kept for the agent (a scan), or skipped with a reason. Which
// one is mechanics with one right answer, so it is plain, tested code.

import { Unzip, UnzipInflate } from "fflate";
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

/** One file to keep: a loose file, or one taken out of a zip (with its folder path inside the zip). */
export type IntakeFile = { name: string; path: string; cls: FileClass; size: number; blob: Blob | null; zip: string | null };

/** The zips of one drop, with what was in them. */
export type ZipFound = { name: string; files: number; skippedJunk: number };

const MAX_NESTED = 3;

/**
 * Opens a drop: loose files stay as they are, zips are opened (streamed, so a
 * large zip doesn't load whole) and zips inside zips too. Videos are listed
 * but not taken out; junk is left out. `onProgress` gets a short line now and then.
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
    await openZip(f, f.name, "", 0, out, found, onProgress);
  }
  return { files: out, zips };
}

async function openZip(blob: Blob, zipName: string, prefix: string, depth: number, out: IntakeFile[], found: ZipFound, onProgress?: (line: string) => void) {
  const entries = await unzipStream(blob, (name) => {
    const cls = classify(name);
    return cls !== "junk" && cls !== "video" && !(cls === "zip" && depth >= MAX_NESTED);
  });
  for (const e of entries) {
    const path = prefix + e.name;
    const cls = classify(e.name);
    if (cls === "junk") {
      found.skippedJunk++;
      continue;
    }
    if (cls === "zip") {
      if (e.data && depth < MAX_NESTED) await openZip(new Blob([e.data]), zipName, path.replace(/\.zip$/i, "") + "/", depth + 1, out, found, onProgress);
      else out.push({ name: base(e.name), path, cls: "other", size: e.size, blob: null, zip: zipName });
      continue;
    }
    found.files++;
    out.push({ name: base(e.name), path, cls, size: e.size, blob: e.data ? new Blob([e.data]) : null, zip: zipName });
    if (found.files % 10 === 0) onProgress?.(`Opening ${zipName}: ${found.files} files so far…`);
  }
}

const base = (p: string) => p.split("/").pop() || p;

/** Streams a zip and takes out only the entries `want` accepts. Entries it skips are listed with no data. */
export async function unzipStream(blob: Blob, want: (name: string) => boolean): Promise<Array<{ name: string; size: number; data: Uint8Array | null }>> {
  const found: Array<{ name: string; size: number; data: Uint8Array | null }> = [];
  const pending: Promise<void>[] = [];
  let failure: unknown = null;
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (f) => {
    const entry = { name: f.name, size: f.originalSize ?? f.size ?? 0, data: null as Uint8Array | null };
    found.push(entry);
    if (f.name.endsWith("/") || !want(f.name)) return;
    const chunks: Uint8Array[] = [];
    pending.push(
      new Promise<void>((resolve) => {
        f.ondata = (err, chunk, final) => {
          if (err) {
            failure = err;
            resolve();
            return;
          }
          chunks.push(chunk);
          if (final) {
            entry.data = concat(chunks);
            entry.size = entry.data.length;
            resolve();
          }
        };
        f.start();
      }),
    );
  };
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      uz.push(new Uint8Array(0), true);
      break;
    }
    uz.push(value);
  }
  await Promise.all(pending);
  if (failure) throw new Error(`The zip couldn't be opened (${(failure as Error).message ?? "broken file"}).`);
  return found.filter((e) => !e.name.endsWith("/"));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

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
