// Text out of Office and OpenDocument files (design/course-files.md).
//
// .docx, .pptx, .xlsx, .odt, .odp and .ods are zips of XML. The file store
// can't keep them, so StudyDesk keeps their text: slides and sheets get one
// "--- slide N ---" / "--- sheet N ---" marker each, so the agent can open
// and cite them like PDF pages. Plain mechanics, so it is code and tested.

import { unzipSync, strFromU8 } from "fflate";

export const OFFICE_EXT = /\.(docx|pptx|xlsx|odt|odp|ods)$/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Paragraph-ish text from one XML part: line breaks at paragraph ends, runs joined. Pure. */
export function xmlText(xml: string, paragraph: RegExp, run: RegExp): string {
  return xml
    .split(paragraph)
    .map((p) => [...p.matchAll(run)].map((m) => decode(m[1])).join(""))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** OpenDocument paragraphs: tags inside a paragraph (spans, spaces, tabs) are dropped. Pure. */
export function odfText(xml: string): string {
  return xml
    .split(/<\/text:(?:p|h)>/)
    .map((p) => p.slice(Math.max(p.lastIndexOf("<text:p"), p.lastIndexOf("<text:h"))))
    .map((p) => (/^<text:[ph]/.test(p) ? decode(p.replace(/<text:(?:s|tab|line-break)\b[^>]*\/>/g, " ").replace(/<[^>]+>/g, "")) : ""))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

/** Reads an Office or OpenDocument file into page-marked text. Throws on a broken file. */
export function officeText(name: string, bytes: Uint8Array): string {
  const ext = name.toLowerCase().split(".").pop();
  const files = unzipSync(bytes, { filter: (f) => f.name.endsWith(".xml") });
  const get = (n: string) => (files[n] ? strFromU8(files[n]) : "");
  if (ext === "docx") return xmlText(get("word/document.xml"), /<\/w:p>/, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g);
  if (ext === "pptx") {
    const slides = Object.keys(files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => num(a) - num(b));
    return slides.map((n, i) => `--- slide ${i + 1} ---\n${xmlText(get(n), /<\/a:p>/, /<a:t>([^<]*)<\/a:t>/g)}`).join("\n\n");
  }
  if (ext === "xlsx") {
    const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join(""));
    const sheets = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => num(a) - num(b));
    return sheets
      .map((n, i) => {
        const rows = [...get(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
          [...r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map((c) => {
              const attrs = c[1];
              const body = c[2] ?? "";
              const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
              if (/t="s"/.test(attrs) && v !== undefined) return shared[Number(v)] ?? "";
              if (/t="inlineStr"/.test(attrs)) return decode(body.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "");
              return v !== undefined ? decode(v) : "";
            })
            .join(" | ")
            .replace(/(\s\|\s)+$/, ""),
        );
        return `--- sheet ${i + 1} ---\n${rows.filter((r) => r.replace(/[\s|]/g, "")).join("\n")}`;
      })
      .join("\n\n");
  }
  // OpenDocument: one content.xml; presentations mark pages with draw:page.
  const content = get("content.xml");
  if (ext === "odp") {
    const pages = content.split(/<draw:page[\s>]/).slice(1);
    return pages.map((p, i) => `--- slide ${i + 1} ---\n${odfText(p)}`).join("\n\n");
  }
  if (ext === "ods") {
    const sheets = content.split(/<table:table[\s>]/).slice(1);
    return sheets.map((t, i) => `--- sheet ${i + 1} ---\n${t
          .split(/<\/table:table-row>/)
          .map((r) => odfText(r).split("\n").join(" | "))
          .filter(Boolean)
          .join("\n")}`).join("\n\n");
  }
  return odfText(content);
}
