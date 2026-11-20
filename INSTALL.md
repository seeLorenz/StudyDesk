# Installing StudyDesk (instructions for Claude)

This file is for **Claude**, not for students. A student opens [claude.ai/code](https://claude.ai/code) and asks something like "Set up StudyDesk for me from github.com/seeLorenz/studydesk". The session then follows the steps below. Students don't need to read or understand any of it.

## What you're making

A claude.ai artifact that belongs to the student: their own StudyDesk, with its own database and file store. Nothing is shared with anyone else, and nothing about the student goes into the code.

## Steps

1. **Get the code.** Clone `https://github.com/seeLorenz/studydesk`. If the repo has release tags (`v1`, `v1.1`, …), check out the newest one; otherwise use `main`. You don't need a fork, and you don't push anything.

2. **Build it.**

   ```sh
   npm ci
   npm run build
   ```

   This writes two files: `artifact/index.html` (the page) and `artifact/routine.mjs` (the nightly program).

3. **Check for an existing StudyDesk.** List the student's artifacts. If one is already called StudyDesk, ask the student whether this is an **update** of that desk or a **second, separate** desk.
   - **Update:** read that artifact first, then publish to its link (step 4 with its `url`). The student's data stays, because it belongs to the link.
   - **New desk:** publish without a `url`.
   - Never delete an artifact. Deleting one deletes the student's data for good.

4. **Publish.** Load the `artifact-capabilities` skill first so you pass each capability in its current format. Then publish:
   - the page: `artifact/index.html`
   - one extra file: `artifact/routine.mjs`, published as `routine.mjs` next to the page
   - capabilities:
     - `sample`, with images
     - `db`
     - `user`
     - `assets` (the student's course files)
     - `downloads` (backup export)
     - `mcp`: the `Google Calendar` server, tool `list_events` only (read-only calendar import)
   - icon: `book`

5. **Hand it over.** Give the student the link and tell them, in plain words:
   - "Open it and bookmark it. Everything you do in StudyDesk is saved there."
   - "Go to **Organize** to set up your semester. When it asks to allow cloud sessions, say yes: that's what grades your work at night and writes tomorrow's quest."
   - "Don't delete it: that deletes your data. To keep a copy, use **Export everything**."

## If something goes wrong

- **`npm ci` fails or is blocked:** tell the student what failed. Don't publish a half-built page.
- **The build fails:** report the error. Don't change the code to make it pass; the student can report it at `https://github.com/seeLorenz/studydesk/issues`.
- **A capability is refused:** publish without it only if it's `mcp` (StudyDesk then works without the calendar import), and tell the student. Any other refused capability means StudyDesk won't work; stop and explain.
