# Updates

How a student gets a new version of StudyDesk without re-entering anything or losing history, progress or stats. Data rules come from [guidelines.md](guidelines.md); the sessions that do the work are the same hand-off sessions as in [orchestrator.md](orchestrator.md) and [scheduled-runs.md](scheduled-runs.md).

## What was agreed

- **Every student owns their own StudyDesk** (their own artifact), as in the guidelines. Updates don't come from a shared artifact.
- **A release is a git tag** such as `v1`, `v1.1`. Only a tag is a new version; pushes to `main` never reach students.
- **The update comes from GitHub.** The student's own Claude session publishes the new release onto the student's own StudyDesk.
- **"Did the update work" is checked by code, not by an agent.** It has one right answer (guideline 3). Claude's only part is telling the student what's new.

## Two kinds of files

A StudyDesk is made of two things that claude.ai already keeps apart:

| | What it is | Where it lives | What an update does |
| --- | --- | --- | --- |
| **StudyDesk files** | The page and the nightly program (`routine.mjs`) | The artifact's published files | Replaced |
| **Personal files** | Profile, semesters, quests, answers, mastery, stats, chats, uploaded course files | The artifact's database and file store | Never touched |

Publishing a new version to the **same artifact link** replaces only the StudyDesk files. The database and file store belong to the link, so they stay. (Tested 2026-11-20: a cloud session published a page, saved data, republished to the same link, and the data was still there; the page's capabilities carried over too.)

Two rules keep this clean:

1. **Nothing personal is ever built into the page.** The page is built from the public repo only; everything about the student is in the database.
2. **The nightly task's own prompt stays thin.** It only points at the student's link and says "download and run the program". Everything that changes ships inside `routine.mjs`, so it updates with the page.

**What doesn't survive:** deleting the artifact. The database and file store go with it, for good. Publishing the code again makes a new, empty StudyDesk. The only way back from that is a backup zip (see Import below).

## Releases

1. Lorenz tags a commit on `main` (`v1.1`), with a few lines of release notes in plain English.
2. A GitHub Action builds that tag (`npm run build`) and puts the result, `index.html`, `routine.mjs` and `capabilities.json`, in a `releases` branch under `v1.1/`. A plain branch, because cloud sessions can `git clone` the public repo but can't run `npm ci`.
3. That's all. Nothing reaches students until they update.

## How a student learns a new version exists

The page has no internet, so it can't look. The **nightly run** already starts a cloud session every night: its program checks the latest tag with `git ls-remote --tags` and writes `{ latest: "v1.1", notes }` into the student's data. The page compares that with its own built-in version and shows **"Update to v1.1"** in the Orchestrator panel, with the release notes. Nothing updates on its own: the student presses the button.

## The update, step by step

1. **Backup.** The page saves a full copy of the student's data as a JSON file in the artifact's own file store (the same data the export zip holds, without the course files, which are already in the store and untouched). The profile keeps the backup's id and the version it was made on. Old backups beyond the last three are removed.
2. **Hand-off.** The page fires the student's "StudyDesk agent" task (already set up for jobs) with the job: clone the `releases` branch, take `v1.1/`, read the student's StudyDesk link first (claude.ai refuses a publish to a link the session hasn't read), then publish `index.html` with `routine.mjs` next to it and the capabilities from `capabilities.json` to that same link. The job reports progress through its job document like any other job.
3. **Reload.** Every open view of the page reloads to the new version by itself.
4. **Upgrade the data (code).** On load, the page reads `profile.dataVersion`. If it's older than the page's, it runs the numbered upgrade steps in order (`1 → 2`, `2 → 3`, …). Each step is a plain function with tests in the repo, written whenever a release changes how data is stored. Most releases need none.
5. **Check (code).** After upgrading, the page validates every kind of record against what the new version expects. Only if all of it passes are the upgraded records saved and `dataVersion` raised.
6. **If anything fails,** nothing is saved, the old data stays as it was, and the student sees "This update didn't work. Go back to v1.0", which fires the same hand-off with the previous tag. The page also keeps working read-only meanwhile.
7. **What's new.** After a successful update, the Orchestrator posts a short note in its own words from the release notes ("Grading now shows…").

### The nightly program after an update

`routine.mjs` ships with the same upgrade steps. If the student hasn't opened the page since updating, the nightly run upgrades the data itself before grading. If the data is *newer* than the program (should never happen), it stops without changing anything.

### Going back

"Go back to v1.0" republishes the old tag and restores the backup from step 1. Anything done after the update is lost in that case, so it's offered right after an update fails, and otherwise only through the Orchestrator with a clear warning.

## Import (fallback)

The export zip exists already (`src/platform/backup.ts`); reading one back in doesn't. Import is for the cases updates can't fix: a deleted StudyDesk, a broken one, or moving to a fresh one. A new StudyDesk offers "Restore from a backup" in setup: the student drops the zip, the page checks it, runs the same upgrade steps on it, writes the data and re-uploads the course files. A newer StudyDesk can always read an older zip; an older one refuses a newer zip.

## New students

Installing is the same as updating, without a link: the student's own session clones the latest release and publishes it as a new artifact owned by the student. How a new student gets that first session started is part of the install flow, not designed yet.

## Notes for other modules

- **Orchestrator:** the "Update to vX" notice, the what's-new note, and "go back" with its warning. One new page tool: `update_studydesk`.
- **Scheduled runs:** the nightly program adds the tag check and runs the upgrade steps before anything else.
- **Every module that stores data:** a change to what's stored needs an upgrade step and a test, in the same pull request.
- **Hand-off prompts** that search for the student's StudyDesk use Artifact `list` with the default scope ("mine"). That's right for a desk the student owns; keep it that way.

## Open questions

- Fetching the `releases` branch from inside a hand-off session is expected to work (sessions already clone the repo) but hasn't been tried with this branch yet.
- The size of a full JSON backup for a long semester: the file store allows 20 MiB per file, which should be plenty, but it's not measured.
