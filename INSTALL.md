# Installing StudyDesk (instructions for Claude)

This file is for **Claude**, not for students. A student opens [claude.ai/code](https://claude.ai/code) and asks something like "Set up StudyDesk for me from github.com/seeLorenz/studydesk". The session then follows the steps below. Students don't need to read or understand any of it.

## What you're making

A claude.ai artifact that belongs to the student: their own StudyDesk, with its own database and file store. Nothing is shared with anyone else, and nothing about the student goes into the code.

## Steps

1. **Get the newest release.** Clone the `releases` branch of `https://github.com/seeLorenz/studydesk`:

   ```sh
   git clone --depth 1 --branch releases https://github.com/seeLorenz/studydesk studydesk-releases
   ```

   `latest.json` at the top names the newest version (`"version": "v1.1"`). Its folder (`v1.1/`) holds everything, already built: `index.html` (the page), `routine.mjs` (the nightly program), `capabilities.json` (the capabilities to publish with) and `release.json`. You don't need a fork, npm, or a build, and you don't push anything.

2. **Only if there's no `releases` branch or no `latest.json` yet** (no version has been released), build from `main` instead:

   ```sh
   git clone --depth 1 https://github.com/seeLorenz/studydesk
   cd studydesk && npm ci && npm run build
   ```

   This writes `artifact/index.html`, `artifact/routine.mjs` and `artifact/capabilities.json` (if the repo has `release/capabilities.json`). Tell the student this is an unreleased development version.

3. **Check for an existing StudyDesk.** List the student's artifacts. If one is already called StudyDesk, ask the student whether this is an **update** of that desk or a **second, separate** desk.
   - **Update:** read that artifact first, then publish to its link (step 4 with its `url`). The student's data stays, because it belongs to the link.
   - **New desk:** publish without a `url`.
   - Never delete an artifact. Deleting one deletes the student's data for good.

4. **Publish.** Load the `artifact-capabilities` skill first so you pass each capability in its current format. Then publish:
   - the page: `index.html` from the version folder (or `artifact/`)
   - one extra file: `routine.mjs` from the same folder, published as `routine.mjs` next to the page
   - capabilities: exactly what `capabilities.json` lists. If there is no such file, use:
     - `sample`, with images
     - `db`
     - `user`
     - `assets` (the student's course files)
     - `downloads` (backup export)
     - `mcp` with two servers: `Google Calendar` with only `list_events` (read-only calendar import), and `Claude Code Remote` with `list_environments`, `create_trigger` and `fire_trigger` (cloud sessions and the nightly run)
   - icon: `book`

5. **Hand it over.** Give the student the link and tell them, in plain words:
   - "Open it and bookmark it. Everything you do in StudyDesk is saved there."
   - "Go to **Organize** to set up your semester. When it asks to allow cloud sessions, say yes: that's what grades your work at night and writes tomorrow's quest."
   - "Don't delete it: that deletes your data. To keep a copy, use **Export everything**."

## If something goes wrong

- **Cloning fails:** tell the student what failed. Don't publish anything half-finished.
- **`npm ci` fails or is blocked** (only when building from `main`): tell the student what failed. Don't publish a half-built page.
- **The build fails:** report the error. Don't change the code to make it pass; the student can report it at `https://github.com/seeLorenz/studydesk/issues`.
- **A capability is refused:** publish without it only if it's `mcp` (StudyDesk then works without the calendar import, cloud sessions and the nightly run), and tell the student. Any other refused capability means StudyDesk won't work; stop and explain.
