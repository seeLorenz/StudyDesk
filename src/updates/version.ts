// Which StudyDesk this is, and which shape of data it expects. design/updates.md.
//
// APP_VERSION is the release tag the page was built from ("v1", "v1.1"). The
// GitHub Action that builds a tag sets it (VITE_STUDYDESK_VERSION); any other
// build is "dev".
//
// DATA_VERSION is the shape of the student's stored data. It only goes up when
// a release changes how data is stored, and every step up needs an upgrade
// step in migrations.ts with a test. Data saved before updates existed is 1.

export const APP_VERSION: string = (import.meta.env?.VITE_STUDYDESK_VERSION as string | undefined) || "dev";
export const DATA_VERSION = 1;

/** The full commit the page was built from (set by the GitHub Action), or "" for a local build. The nightly run builds this one. */
export const BUILD_SHA: string = (import.meta.env?.VITE_STUDYDESK_COMMIT as string | undefined) || "";
/** Its short form, for showing. */
export const BUILD_COMMIT = BUILD_SHA.slice(0, 7);
/** The branch a dev build was built from (set by the GitHub Action), or "". */
export const BUILD_BRANCH: string = (import.meta.env?.VITE_STUDYDESK_BRANCH as string | undefined) || "";
/** One exact build: the version plus its commit. Two dev builds differ only here. */
export const BUILD_ID = BUILD_COMMIT ? `${APP_VERSION}@${BUILD_COMMIT}` : APP_VERSION;
/** The folder on the releases branch with the newest build of main, for developers. */
export const DEV_CHANNEL = "main";

/** The public repository releases come from. A fork can build with its own (VITE_STUDYDESK_REPO). */
export const RELEASE_REPO: string = (import.meta.env?.VITE_STUDYDESK_REPO as string | undefined) || "seeLorenz/studydesk";
export const RELEASE_BRANCH = "releases";

/** "v1.10.2" → [1, 10, 2]; anything else (like "dev") → null. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = /^v(\d+(?:\.\d+)*)$/.exec(String(v ?? "").trim());
  return m ? m[1].split(".").map(Number) : null;
}

export const isRelease = (v: string | null | undefined) => parseVersion(v) !== null;

/** Negative when a is older than b. A dev build counts as older than every release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest release among some tag names (others are ignored), or null. */
export function newestRelease(tags: string[]): string | null {
  return tags.filter(isRelease).sort(compareVersions).pop() ?? null;
}
