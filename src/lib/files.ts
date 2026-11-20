import type { Attachment } from "../chat/types";
import { uid } from "../chat/types";

export const MAX_TEXT_CHARS = 60_000;

export type PendingAttachment = Attachment & {
  blob?: Blob;
  /** The original file, for places that keep it (Start New Semester). */
  file?: File;
  status: "reading" | "ready" | "error";
  error?: string;
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

async function pdfText(file: File, limit = MAX_TEXT_CHARS): Promise<string> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  let total = 0;
  for (let p = 1; p <= doc.numPages && total < limit; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("");
    pages.push(`--- page ${p} ---\n${text.trim()}`);
    total += text.length;
  }
  const out = pages.join("\n\n");
  if (!out.replace(/--- page \d+ ---/g, "").trim()) {
    throw new Error("This PDF has no selectable text (it may be a scan). Take a photo or screenshot of the page instead.");
  }
  return out;
}

/** Read a dropped, pasted or picked file into an attachment. */
export async function readAttachment(file: File): Promise<PendingAttachment> {
  const kind = kindOf(file);
  const base = { id: uid(), name: file.name || (kind === "image" ? "pasted image" : "file"), status: "ready" as const, file };
  if (!kind) {
    return { ...base, kind: "text", status: "error", error: "StudyDesk can read images, PDFs and text files. This file type isn't supported yet." };
  }
  try {
    if (kind === "image") return { ...base, kind, blob: file, thumb: await thumbnail(file) };
    if (kind === "pdf") return { ...base, kind, text: clip(await pdfText(file)) };
    return { ...base, kind, text: clip(await file.text()) };
  } catch (e) {
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
