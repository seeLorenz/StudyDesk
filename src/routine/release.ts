// The nightly run's check for a new StudyDesk release (design/updates.md,
// "How a student learns a new version exists"). Runs with Node in the cloud
// session, which can reach GitHub with git. Plain code: one right answer.
//
// The releases branch has latest.json, written by the GitHub Action once a
// tag is built: { version, notes, dataVersion }. Only built releases are
// offered, so the button never points at a release that isn't there yet. If
// that file can't be read, the tags alone still tell the newest version.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseDocFrom, type ReleaseDoc } from "../updates/plan";
import { newestRelease, RELEASE_BRANCH, RELEASE_REPO } from "../updates/version";

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "ignore"] });

/** latest.json → a ReleaseDoc, or null when it doesn't look right. Pure. */
export function parseLatest(text: string, now: number): ReleaseDoc | null {
  try {
    const j = JSON.parse(text) as { version?: unknown; notes?: unknown; dataVersion?: unknown };
    if (typeof j.version !== "string" || !/^v\d+(\.\d+)*$/.test(j.version)) return null;
    return { latest: j.version, notes: typeof j.notes === "string" && j.notes.trim() ? j.notes.trim().slice(0, 4000) : null, dataVersion: Number.isInteger(j.dataVersion) ? (j.dataVersion as number) : null, checkedAt: now };
  } catch {
    return null;
  }
}

/** `git ls-remote --tags` output → the newest release tag. Pure. */
export function tagsFromLsRemote(out: string): string | null {
  return newestRelease(out.split("\n").map((l) => l.split("refs/tags/")[1]?.replace(/\^\{\}$/, "") ?? "").filter(Boolean));
}

/** Tonight's answer, once per night (kept in the work folder). Null when GitHub can't be reached. */
export function checkRelease(dir: string, now: number, repo = RELEASE_REPO): ReleaseDoc | null {
  const cache = join(dir, "release.json");
  if (existsSync(cache)) {
    try {
      return JSON.parse(readFileSync(cache, "utf8")) as ReleaseDoc | null;
    } catch {
      /* check again */
    }
  }
  const url = `https://github.com/${repo}.git`;
  let found: ReleaseDoc | null = null;
  try {
    const into = join(dir, "releases-check");
    if (!existsSync(into)) git(["clone", "--quiet", "--depth", "1", "--branch", RELEASE_BRANCH, "--filter=blob:none", "--no-checkout", url, into]);
    // Every release with its notes (for "What's new"), and latest.json as the newest when the folders can't be read.
    const list: unknown[] = [];
    for (const d of git(["-C", into, "ls-tree", "-d", "--name-only", "HEAD"]).split("\n").filter(Boolean)) {
      try {
        list.push(JSON.parse(git(["-C", into, "show", `HEAD:${d}/release.json`])));
      } catch {
        /* not a release folder */
      }
    }
    found = releaseDocFrom(list, now) ?? parseLatest(git(["-C", into, "show", "HEAD:latest.json"]), now);
  } catch {
    try {
      const tag = tagsFromLsRemote(git(["ls-remote", "--tags", url]));
      found = tag ? { latest: tag, notes: null, dataVersion: null, checkedAt: now } : null;
    } catch {
      found = null;
    }
  }
  writeFileSync(cache, JSON.stringify(found));
  return found;
}
