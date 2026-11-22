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
2. A GitHub Action (`.github/workflows/release.yml`) tests and builds that tag (`npm run build`, with the tag as the built-in version) and puts the result, `index.html`, `routine.mjs`, `capabilities.json` and `release.json`, in a `releases` branch under `v1.1/`. A plain branch, because cloud sessions can `git clone` the public repo but can't run `npm ci`. It also writes `latest.json` at the top of the branch (version, notes, data version) when the tag is the newest release, so an older fix-up tag never replaces it.
3. That's all. Nothing reaches students until they update.

Release notes are the tag's message: `git tag -a v1.1 -m "Grading now shows the first wrong step."` then `git push origin v1.1`. The capabilities the page is published with live in `release/capabilities.json`.

## How a student learns a new version exists

The page has no internet, so it can't look. The **nightly run** already starts a cloud session every night: its program reads `latest.json` from the `releases` branch with git (falling back to the tags with `git ls-remote --tags`) and writes `{ latest: "v1.1", notes, dataVersion }` into the student's `release` document. Only built releases are in `latest.json`, so the button never points at a release that isn't there yet. The page compares that with its own built-in version and shows **"Update to v1.1"** at the top of the Orchestrator panel, with the release notes. Nothing updates on its own: the student presses the button. A release whose data version is older than the student's data (only possible coming from a development build) isn't offered.

### Checking by hand

The version shows as a small grey label next to "StudyDesk" in the sidebar (`v1.1.1`, or `dev · 1a2b3c4` for a branch build; the panel names the branch). Clicking it opens a small panel that works any time, also during setup:

- **Check for updates** starts a quick cloud session (the same "StudyDesk agent" task) that reads every `release.json` on the `releases` branch and answers with the list. Code reads the answer and saves it as the `release` document, so "Update to vX" shows within a minute or two instead of after the next nightly run.
- **Update to vX** (the same button as in Organize) when a newer release can read the data.
- **What's new**: the notes of the installed release and every newer one, newest first, from the tags' messages. The nightly run saves the same list.
- **For developers** (folded away): switch to any build, up or down.
  - Every push to a branch is built too: main into `main/`, any other branch into `branch-<name>/` (characters other than letters, digits, `.`, `_`, `-` become `-`). Each gets a `release.json` with the branch, commit, build time and the commit's first line as its note. Deleting a branch removes its folder. These never change `latest.json`, so students are never offered them.
  - The panel lists the branch builds (main first, then the most recently built, at most 20) and every tagged release, each with "Load". The running one is marked.
  - Every switch saves a backup first and uses the same hand-off as an update, onto the same link.
  - Going to a build that can read the data as it is (its data version is the data's or higher) just publishes it; the upgrade steps run on arrival.
  - Going to a build that expects older data puts back the newest backup old enough for it, the same way "Go back" does. Anything done since that backup is lost, so the button asks twice and says from which day the data comes. Without a backup that old, the switch isn't offered.
  - Builds are told apart by their commit (`fromBuild`, version@commit), so the page knows the new build has arrived even when both are "dev".

### Where the update state lives

Two small documents next to the student's data, not the profile (the profile is saved whole from many screens, and update state must never be lost to a stale copy):

- `updates`, written by the page: the data version, the last three backups, an update or rollback in progress, the last update (and whether the Orchestrator announced it), and a failed upgrade.
- `release`, written by the nightly run: the newest release and its notes.

## The update, step by step

1. **Backup.** The page saves a full copy of the student's data as a JSON file in the artifact's own file store (the same data the export zip holds, without the course files, which are already in the store and untouched). The `updates` document keeps the backup's id and the version it was made on. Old backups beyond the last three are removed. If no backup can be saved, the update doesn't start.
2. **Hand-off.** The page fires the student's "StudyDesk agent" task (already set up for jobs) with the job: clone the `releases` branch, take `v1.1/`, read the student's StudyDesk link first (claude.ai refuses a publish to a link the session hasn't read), then publish `index.html` with `routine.mjs` next to it and the capabilities from `capabilities.json` to that same link. The job reports progress through its job document like any other job.
3. **Reload.** Every open view of the page reloads to the new version by itself.
4. **Upgrade the data (code).** On load, before anything else opens, the page reads the `updates` document's `dataVersion` (data from before updates existed is version 1). If it's older than the page's, it runs the numbered upgrade steps in order (`1 → 2`, `2 → 3`, …). Each step is a plain function with tests in the repo, written whenever a release changes how data is stored. Most releases need none.
5. **Check (code).** After upgrading (and on the first load of every new version, even when no step ran), the page validates every kind of record against what the new version expects (`src/updates/validate.ts`). Only if all of it passes are the upgraded records saved and `dataVersion` raised.
6. **If anything fails,** nothing is saved, the old data stays as it was, and the student sees "This update didn't work. Go back to v1.0", which fires the same hand-off with the previous tag. The page keeps working read-only meanwhile: every save is refused at one place (`src/platform/host.ts`), so the new version can't write half-understood data. The upgrade is tried again on every load of that version. If saving failed halfway, going back also restores the backup.
7. **What's new.** After a successful update, the Orchestrator posts a short note in its own words from the release notes ("Grading now shows…").

### The nightly program after an update

`routine.mjs` ships with the same upgrade steps and checks. It downloads everything StudyDesk stores, and if the student hasn't opened the page since updating, it upgrades and checks the data itself, saves it, downloads it again and only then grades. If the upgrade or the check fails, it stops without writing; the page tries again (with a backup) when the student opens it. If the data is *newer* than the program (should never happen), it stops without changing anything.

### Going back

"Go back to v1.0" republishes the old tag and restores the backup from step 1. Anything done after the update is lost in that case, so it's offered right after an update fails, and otherwise only through the Orchestrator with a clear warning (a card that needs two clicks). The backup is put back by the old version once it's there, so the new version never runs on old data. While going back, the page is read-only. There's no going back from an update that started on a development build: there's no release to go back to.

## Import (fallback)

Import is for the cases updates can't fix: a deleted StudyDesk, a broken one, or moving to a fresh one. A new StudyDesk offers "Restore from a backup" in setup: the student drops or picks the zip, the page checks it, runs the same upgrade steps on it, saves a backup of what's there, writes the data and re-uploads the course files (`src/updates/importZip.ts`). A newer StudyDesk can always read an older zip; an older one refuses a newer zip.

The export zip now also holds `files.json` (which zip file was which original) and its app and data version; older zips without them are read by naming the files the way the export did. The old desk's nightly task and link aren't carried over, so the restored desk makes its own.

## New students

Installing is the same as updating, without a link: the student's own session clones the latest release and publishes it as a new artifact owned by the student. How a new student gets that first session started is part of the install flow, not designed yet.

## Big documents

The artifact database holds at most 256 KiB per document. A real semester outgrows that: Lorenz's first setup (11 courses, about 600 skills, a 3 GB import's file list) reached 385 KB for the setup and 324 KB for the semester, and the final save failed. So every place that reads or writes the student's data goes through `src/platform/bigDoc.ts`. A document over 200 KB has its largest lists moved into part documents (`parts/docs/<id>`), and the main document lists them under `__parts`. Readers join them back, so everything above storage sees whole documents, and backups and exports hold the joined form.

- Part ids carry a hash of their content: an unchanged part is never written again, and a changed one always gets a new id. Parts are written before the main document, so a reader never meets a main document whose parts aren't there yet.
- Old parts are removed by the page (once per load) only when no main document refers to them and they are over an hour old. The nightly program and updates never delete parts.
- No data version change: documents without `__parts` read as before.

## Notes for other modules

- **Orchestrator:** the "Update to vX" notice, the what's-new note, and "go back" with its warning. One new page tool: `update_studydesk`.
- **Scheduled runs:** the nightly program adds the tag check and runs the upgrade steps before anything else.
- **Every module that stores data:** a change to what's stored needs an upgrade step (raise `DATA_VERSION`), a matching rule in `validate.ts` and a test, in the same pull request. A new kind of document goes into `src/updates/layout.ts`, or backups, import and upgrades won't see it.
- **Hand-off prompts** that search for the student's StudyDesk use Artifact `list` with the default scope ("mine"). That's right for a desk the student owns; keep it that way.

## Code

- `src/updates/version.ts`: the built-in version (`APP_VERSION`, from the tag) and data version (`DATA_VERSION`).
- `src/updates/layout.ts`: every kind of stored data in one table, snapshots and diffs, shared by backups, upgrades, import and the nightly program.
- `src/updates/migrations.ts`: the upgrade steps (none yet); `src/updates/validate.ts`: the checks.
- `src/updates/plan.ts`: the decisions (what to do on load, what to offer, where to go back) and the publish job's instructions.
- `src/platform/updateStore.ts`: backups, writing, the update and go-back buttons, import. `src/platform/host.ts`: read-only mode.
- `src/updates/UpdateGate.tsx` (runs before the app), `UpdateCards.tsx` (the notice and the go-back card), `RestoreBackup.tsx`, `whatsNew.ts`.
- `src/routine/release.ts`: the nightly release check. `.github/workflows/release.yml` and `scripts/release-info.mjs`: building releases.
- Tests: `tests/updates.test.ts`.

## Open questions

- The whole loop (button, session publishes, page reloads, data checked) can only be tried live on claude.ai, after the first tag is built.
- The size of a full JSON backup for a long semester: the file store allows 20 MiB per file, which should be plenty, but it's not measured.
