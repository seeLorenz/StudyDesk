// Used by .github/workflows/release.yml after a tag is built (design/updates.md, "Releases").
//
//   node scripts/release-info.mjs <tag> <notes file> <releases folder>
//
// Writes <releases folder>/<tag>/release.json and, when this tag is the newest
// release, <releases folder>/latest.json, which the nightly run reads to offer
// "Update to <tag>".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, notesFile, root] = process.argv.slice(2);
if (!/^v\d+(\.\d+)*$/.test(tag ?? "")) throw new Error(`Not a release tag: ${tag}`);
const parse = (v) => v.slice(1).split(".").map(Number);
const newer = (a, b) => {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};
const dataVersion = Number(/export const DATA_VERSION = (\d+)/.exec(readFileSync("src/updates/version.ts", "utf8"))?.[1]);
if (!Number.isInteger(dataVersion)) throw new Error("DATA_VERSION not found in src/updates/version.ts");
const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";
const info = { version: tag, notes, dataVersion, builtAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null };
writeFileSync(join(root, tag, "release.json"), JSON.stringify(info, null, 2) + "\n");
const latestFile = join(root, "latest.json");
const latest = existsSync(latestFile) ? JSON.parse(readFileSync(latestFile, "utf8")) : null;
if (!latest?.version || latest.version === tag || newer(tag, latest.version)) {
  writeFileSync(latestFile, JSON.stringify(info, null, 2) + "\n");
  console.log(`latest.json → ${tag}`);
} else console.log(`${tag} built; latest stays ${latest.version}`);
