import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";

const md = new Marked({ gfm: true, breaks: false });
// nonStandard lets $x$ work without spaces around it (supported at runtime, missing from the types).
md.use(markedKatex({ throwOnError: false, nonStandard: true, output: "htmlAndMathml" } as Parameters<typeof markedKatex>[0]));

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Claude often writes \( \) and \[ \] for math; KaTeX here reads $ and $$. */
export function normalizeMath(src: string): string {
  const parts = src.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`),
    )
    .join("");
}

export function renderMarkdown(src: string): string {
  const html = md.parse(normalizeMath(src), { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
}
