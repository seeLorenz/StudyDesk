# Design guidelines

These rules apply to every part of StudyDesk. Each module's design file adds its own details, but none of them should break a rule here. When a rule and a module file disagree, fix the module file.

## 1. Hand hard or agentic work to Claude

If a task needs judgment, reading, research or several steps, Claude does it, not hand-written app logic. Reading a semester of course files, working out what a course requires, writing problems, judging an answer, and pulling events out of a calendar are all Claude's job.

StudyDesk is a carrier for Claude sessions. The page collects input, shows results, and launches Claude sessions with everything they need already filled in, so the student never retypes context. Heavy or connected work (reading many files, the web, a calendar, Drive) runs in those sessions, which write their results back. The page's own limits, such as no internet and nothing running while it's closed, therefore don't limit what StudyDesk can do.

## 2. Every chat box accepts everything

Any box where the student writes to Claude or hands in work accepts:

- typed text,
- files dragged and dropped onto it,
- files and images pasted from the clipboard, such as a PNG screenshot.

No box is text-only. A student should never have to save a screenshot to disk just to share it.

iPhone photos (HEIC/HEIF) work everywhere too, also inside course zips: the page turns each one into a JPEG before Claude sees it or it is kept, because Claude and the file store only take PNG, JPEG, WebP and GIF. Safari does this with its own decoder; other browsers use a bundled libheif decoder (src/lib/heic.ts). If a photo still can't be read, the box says how to send it as a JPEG instead.

## 3. Build it smart: Claude for what varies, code for the mechanics

Nothing about a student, a course or a school is hardcoded. Course names, grading scales, languages, subjects, materials and study habits all differ, so Claude reads and adapts to them instead of the app assuming one kind of student.

The exception is anything with one right answer. That stays plain, tested code:

- grading and stats rules: streaks, review dates, mastery, points, time estimates (**agents judge, code counts**, see [grading-and-mastery.md](grading-and-mastery.md)),
- dates and times,
- saving and loading data,
- checking input.

Letting Claude guess these would cost tokens and add small mistakes. The short version: if it varies by student, Claude handles it; if it's mechanics, code does.

## 4. The improved interface works everywhere

The Ask and select-to-reply interface is not one screen. It works on every screen and every piece of text in the app: chats, quests, explanations, problems, hints, feedback, reviews and setup.

- The student selects any passage and asks about it.
- The answer opens right under the marked passage, or in a pop-out beside it. It is never added to the bottom of the chat or page.
- A collapsed note disappears completely. Only the highlighted passage stays, and clicking it opens the note again.
- Notes are saved with whatever they belong to.

## 5. Build what was agreed, and make it real

Build exactly what the agreed design file says. If something seems better while building, propose it first instead of building something else. Features do what their name says: "Import from Google Calendar" really imports the events, not a placeholder.

## 6. One module at a time

Modules are designed and built one at a time. When a module needs something from another one, write it as a note in that module's design file instead of building it.

## 7. Small things that apply everywhere

- **Every student has their own StudyDesk.** Own data, own files, own Claude sessions. Nothing is shared between students.
- **Nothing typed is lost.** Inputs save automatically as the student works.
- **Text has room to breathe.** Use real spacing between paragraphs, steps and parts; cramped text is a bug.
- **The goal is learning.** Prefer short cycles of learning one idea and trying it right away over long separate blocks of reading and practice.
- **The repository is public.** No personal data, secrets or real student information in code, docs or sample data.
