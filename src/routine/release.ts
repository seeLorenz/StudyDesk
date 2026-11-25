// The nightly run's check for a new StudyDesk release (design/updates.md,
// "How a student learns a new version exists"). The program itself never uses
// the network or starts other programs: it prints a plain git command and the
// session runs it, where it's visible and checked like any other command.
// Plain code: one right answer.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseDocFrom, type ReleaseDoc } from "../updates/plan";
import { RELEASE_BRANCH, RELEASE_REPO } from "../updates/version";

const folder = (dir: string) => join(dir, "releases");

/** The session's step: fetch only the release.json files of the public releases branch. */
export function releaseStepLines(dir: string, repo = RELEASE_REPO): string[] {
  const d = folder(dir);
  return [
    "NEXT STEP: check whether a newer StudyDesk release exists (this only reads the public releases branch).",
    "",
    `Run: (git clone --quiet --depth 1 --branch ${RELEASE_BRANCH} --filter=blob:none --sparse https://github.com/${repo}.git ${d} && git -C ${d} sparse-checkout set --no-cone '/*/release.json') || mkdir -p ${d}`,
    "Then run this program again with the same arguments.",
  ];
}

/** Undefined until the session ran the step; then tonight's answer (null when nothing could be read). */
export function readReleases(dir: string, now: number): ReleaseDoc | null | undefined {
  const d = folder(dir);
  if (!existsSync(d)) return undefined;
  const list: unknown[] = [];
  for (const name of readdirSync(d)) {
    try {
      list.push(JSON.parse(readFileSync(join(d, name, "release.json"), "utf8")));
    } catch {
      /* not a release folder */
    }
  }
  return releaseDocFrom(list, now);
}
