// Turns dist/index.html (a full document) into artifact/index.html: page
// content only, because the claude.ai artifact host wraps the page in its own
// <!doctype html><html><head>…<body> skeleton at publish time.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const html = readFileSync("dist/index.html", "utf8");
// The inlined JS can itself contain strings like "</head>", so find the real
// tags from the end: the body (only #root) comes last.
const bodyOpen = html.lastIndexOf("<body>");
const bodyClose = html.lastIndexOf("</body>");
const headOpen = html.indexOf("<head>");
const headClose = html.lastIndexOf("</head>", bodyOpen);
if ([bodyOpen, bodyClose, headOpen, headClose].includes(-1)) throw new Error("unexpected dist/index.html shape");
const head = html.slice(headOpen + 6, headClose);
const body = html.slice(bodyOpen + 6, bodyClose);
const keepHead = head
  .replace(/<meta charset[^>]*>/i, "")
  .replace(/<meta name="viewport"[^>]*>/i, "")
  .trim();
// <title> must come first: the host only scans the first 8KB for it.
const title = keepHead.match(/<title>[\s\S]*?<\/title>/i)?.[0] ?? "<title>StudyDesk</title>";
const rest = keepHead.replace(title, "");
mkdirSync("artifact", { recursive: true });
writeFileSync("artifact/index.html", `${title}\n${rest}\n${body.trim()}\n`);
console.log("artifact/index.html", (Buffer.byteLength(readFileSync("artifact/index.html")) / 1024).toFixed(0) + " KB");
