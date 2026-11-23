import type { Attachment } from "../chat/types";
import { uid } from "../chat/types";
import { classify, type FileClass } from "./intake";
import { officeText } from "./office";
import { asJpegIfHeic, isHeic } from "./heic";

export const MAX_TEXT_CHARS = 60_000;

export type PendingAttachment = Attachment & {
  blob?: Blob;
  /** The original file, for places that keep it (Start New Semester). */
  file?: File;
  status: "reading" | "ready" | "error";
  error?: string;
  /** A zip, video or other file that is only kept and opened by Start New Semester and Organize (src/lib/keep.ts). */
  deferred?: FileClass;
};

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|tsx|jsx|py|java|c|cpp|h|cs|go|rs|rb|php|sql|tex|bib|yaml|yml|ini|log)$/i;

export function kindOf(file: File): Attachment["kind"] | null {
  if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return "image";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("text/") || TEXT_EXT.test(file.name)) return "text";
  return null;
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "\n\n[…cut off: the file is longer than StudyDesk sends at once]" : text;
}

async function thumbnail(blob: Blob): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?raw")]).then(
      ([pdfjs, worker]) => {
        const url = URL.createObjectURL(new Blob([worker.default], { type: "text/javascript" }));
        pdfjs.GlobalWorkerOptions.workerSrc = url;
        return pdfjs;
      },
    );
  }
  return pdfjsPromise;
}

export type PdfRead = { text: string; pages: number; bookmarks: Array<{ title: string; page: number | null; depth: number }>; scan: boolean };

/** Reads a PDF: page-marked text up to `limit`, its bookmarks, and whether it is a scan (no text at all). */
export async function readPdf(file: Blob, limit = MAX_TEXT_CHARS): Promise<PdfRead> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  // Every PDF is let go when read: many PDFs in a row otherwise pile up in memory.
  try {
    return await readOpenPdf(doc, limit);
  } finally {
    void task.destroy();
  }
}

type PdfDoc = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>["getDocument"]>["promise"]>;

async function readOpenPdf(doc: PdfDoc, limit: number): Promise<PdfRead> {
  const pages: string[] = [];
  let total = 0;
  for (let p = 1; p <= doc.numPages && total < limit; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    page.cleanup();
    const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("");
    pages.push(`--- page ${p} ---\n${text.trim()}`);
    total += text.length;
    // A long PDF gives the page a breath every few pages.
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const text = pages.join("\n\n");
  const bookmarks: PdfRead["bookmarks"] = [];
  try {
    type Item = { title: string; dest: unknown; items: Item[] };
    const walk = async (items: Item[], depth: number) => {
      for (const it of items) {
        if (bookmarks.length >= 300) return;
        let page: number | null = null;
        try {
          const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : (it.dest as unknown[] | null);
          if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1;
        } catch {
          // A bookmark without a page still helps.
        }
        bookmarks.push({ title: it.title, page, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    await walk(((await doc.getOutline()) ?? []) as Item[], 0);
  } catch {
    // No bookmarks.
  }
  return { text, pages: doc.numPages, bookmarks, scan: !text.replace(/--- page \d+ ---/g, "").trim() };
}

async function pdfText(file: File, limit = MAX_TEXT_CHARS): Promise<string> {
  const pdf = await readPdf(file, limit);
  if (pdf.scan) throw new Error("This PDF has no selectable text (it may be a scan). Take a photo or screenshot of the page instead.");
  return pdf.text;
}

/**
 * Read a dropped, pasted or picked file into an attachment. With `keepAll`
 * (the boxes that keep course files), zips, videos and any other file are
 * accepted as they are and opened when the message is sent.
 */
export async function readAttachment(file: File, opts: { keepAll?: boolean } = {}): Promise<PendingAttachment> {
  // iPhone photos become JPEGs first, so Claude can see them (src/lib/heic.ts).
  if (isHeic(file.name, file.type)) {
    try {
      file = await asJpegIfHeic(file);
    } catch (e) {
      return { id: uid(), name: file.name || "photo", kind: "image", status: "error", error: e instanceof Error ? e.message : "This photo couldn't be opened." };
    }
  }
  const kind = kindOf(file);
  const cls = classify(file.name || "file", file.type);
  const base = { id: uid(), name: file.name || (kind === "image" ? "pasted image" : "file"), status: "ready" as const, file };
  if (cls === "office") {
    try {
      return { ...base, kind: "text", text: clip(officeText(file.name, new Uint8Array(await file.arrayBuffer()))) };
    } catch {
      return { ...base, kind: "text", status: "error", error: "This file couldn't be opened. Save it as PDF and try again." };
    }
  }
  // Boxes that keep course files read PDFs when the message is sent, one at a
  // time: reading dozens at once as they're dropped would freeze the page.
  if (opts.keepAll && kind === "pdf") return { ...base, kind, deferred: "pdf" };
  if (!kind) {
    if (opts.keepAll) return { ...base, kind: "text", deferred: cls };
    return {
      ...base,
      kind: "text",
      status: "error",
      error: cls === "zip" ? "Drop course zips in the StudyDesk chat (Tell StudyDesk): it unpacks and keeps them there." : cls === "video" ? "Claude can't watch or listen to videos. Describe what happens in it instead." : "StudyDesk can't read this kind of file here. Save it as PDF, or drop it in the StudyDesk chat (Tell StudyDesk).",
    };
  }
  try {
    if (kind === "image") return { ...base, kind, blob: file, thumb: await thumbnail(file) };
    if (kind === "pdf") return { ...base, kind, text: clip(await pdfText(file)) };
    return { ...base, kind, text: clip(await file.text()) };
  } catch (e) {
    // A scan has no text: the boxes that keep course files keep it for the agent.
    if (opts.keepAll && kind === "pdf") return { ...base, kind, deferred: "pdf" };
    return { ...base, kind, status: "error", error: e instanceof Error ? e.message : "The file couldn't be read." };
  }
}

/**
 * A file's full readable text for keeping (course materials): PDFs page by
 * page with "--- page N ---" markers, up to `limit` characters.
 */
export async function readFullText(file: File, limit: number): Promise<{ text: string; cut: boolean; pages: number | null }> {
  const kind = kindOf(file);
  let text = kind === "pdf" ? await pdfText(file, limit) : await file.text();
  const pages = kind === "pdf" ? (text.match(/^--- page \d+ ---$/gm) ?? []).length : null;
  const cut = text.length > limit;
  if (cut) text = text.slice(0, limit);
  return { text, cut, pages };
}
