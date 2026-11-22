# Course files: taking them in and reading them by reason

How StudyDesk takes in a student's course files (single files or whole course zips) and how the organization agent reads them: by navigating like a person would, not by reading everything. It replaces the "files are read at drop time and pasted into the reading" part of [onboarding.md](onboarding.md) and the file part of jobs in [orchestrator.md](orchestrator.md).

Status: design agreed with Lorenz (2026-11-20, see Decisions); first version built (see the end of this file).

## Why this changes

The first real install showed three problems:

1. **Course zips are refused.** A student who downloads each course from their school's learning platform gets one zip per course. Every zip got a red "This file type isn't supported yet" card, so the student had to unpack and re-drop hundreds of files by hand.
2. **Everything is read, nothing is chosen.** Today every dropped file's text is extracted at once and pasted into one big reading, up to a fixed size. With a semester of files that means either a huge, wasteful reading or files silently cut off. A person doesn't work like that: they list the files, open the syllabus, see that it points to the exercise sheets and chapters 1 to 6 of the script, and open those next.
3. **A limit is a dead end.** When the page can't do something (a file type, a scan, a file that's too big), the student just sees an error. The page should hand that work to someone who can do it.

## The idea in short

- **Take everything in, refuse nothing.** Zips are unpacked in the page. Each file ends up as one of: *readable now*, *kept for the agent* (a scan, an unusual format), or *skipped, with the reason* (a lecture video, system junk). The student sees one short summary per zip, never a wall of red cards.
- **Keep originals, make an inventory, send nothing yet.** At drop time the page stores the files and their text and builds a small **inventory**: path, type, size, page count, and an **outline** per file (its bookmarks, or the first line of each page or slide). That's cheap, mechanical work.
- **The agent navigates.** The organization agent gets the inventory, not the text. It decides what to open first, opens only the pages it needs, follows what the files point to, and stops when it can write the course map with confidence. Its live log shows its reasoning ("Opening Syllabus.pdf: should list topics, grading and dates").
- **Blocks route, they don't stop.** Anything the page can't do goes to the agent automatically. If the agent can't do it either, the student gets one plain ask with the one action that unblocks it.

## 1. Taking files in (page, plain code)

This part has one right answer, so it is code (guideline 3).

**Zips.** Dropping a zip into any chat box opens it in the page one file at a time: StudyDesk reads the zip's file list from its end, then unpacks, keeps and lets go of one file before the next, in a background worker, with a pause between files. However big the zips, the page holds about one file at a time (files over 80 MB are listed by name, not opened), so it stays responsive on laptops with little memory. Each zip is saved to the desk as soon as it's kept, so a closed or crashed window loses at most the zip in progress. Zips inside zips are opened too. The folder path inside the zip is kept with each file (`Übungen/Blatt 3.pdf`), because folder names carry meaning the agent uses.

**What happens to each file:**

| File | What StudyDesk does |
| --- | --- |
| PDF with text, image, text or code file | Original kept in the file store; outline built |
| iPhone photo (HEIC/HEIF) | Turned into a JPEG in the page (`IMG_5334.HEIC` becomes `IMG_5334.jpg`), then kept like any image |
| Word, PowerPoint, Excel, OpenDocument | Text pulled out in the page (they are zips of text inside), one marker per slide or sheet, stored as text; outline built. The file store can't keep these originals, so the text version is what's kept |
| PDF without text (a scan), handwritten notes | Original kept; marked "needs reading by the agent" (see section 3) |
| Video and audio | Listed in the inventory by name, not stored (too big for the file store, and Claude can't watch or hear them). The agent goes by the title, or by the student's description (see "Videos" below) |
| System junk (`__MACOSX`, `.DS_Store`, `Thumbs.db`, empty files) | Dropped silently |
| Anything else | Listed in the inventory as "unknown format, not read"; the agent decides whether it matters |
| A single file over the file store's limit (20 MB) | Text and outline kept, original not; said once in the summary |

**Room.** Before storing, the page checks how much room the file store has left (the platform reports its caps and use). If a drop doesn't fit, it says so first, keeps every file's text, stores the originals that fit (PDFs first), and the Orchestrator asks which courses come first before more is added.

**Which course.** A zip from a learning platform is almost always one course, and its name or top folder says which. So the Orchestrator assigns **the whole zip** to a course in one decision (that's judgment, so Claude does it), not file by file. Loose files are assigned one by one, as today.

**What the student sees.** One line per zip in the chat while it's unpacked ("Opening Mathematik A.zip: 34 of 84 files"), then one summary card: *Mathematik A: 84 files. 61 PDFs, 9 slide decks, 2 scans for the agent, 12 recordings listed but not stored.* The chat stays usable while it works.

**What the Orchestrator sees.** For a zip, the inventory summary (folders, file names, counts), not the start of every file. For a loose file, the start of the file, as today.

**Later turns.** Images and files stay visible after the turn they were dropped in. Each chat message remembers its kept files; every turn sends the most recent earlier images again (up to 5 images per turn, the newest first, with a line saying which image is which file), and both chats (setup and Organize) have a `read_file` tool that opens any kept file's outline or the pages it needs. Before this, a later turn only carried the file's name, so Claude said it couldn't see an image the student had dropped a minute earlier.

## 2. Reading by reason (the organization agent)

This part is judgment, so Claude does it (guideline 1).

**What the agent gets.** For its course: the inventory tree with each file's outline, what the student said about the course and its files, the semester sheet, and everything else the setup run gets today. No file text up front.

**How it opens files.** The agent opens files itself:

- *In a cloud session* it downloads the originals from the student's StudyDesk and reads them with its own tools (it can also search across all of them, render a scanned page and read it, or run a quick script).
- *In the page* (no cloud sessions) it gets two page tools: `outline(file)` and `open(file, pages)`, which returns the text of just those pages or lines.

**How it navigates.** The prompt asks it to work like a careful student would on the first day:

1. Read the inventory and say what it expects where ("`Organisatorisches/` probably holds the rules; `Übungen/` the sheets").
2. Open the course overview first: syllabus, module description, first lecture's organizational slides.
3. Follow what that points to: grading and exam rules, the exercise sheets with a hand-in date still ahead, the chapters of the script the exam covers.
4. Use outlines for the rest: the script's and slides' outlines are usually enough to map skills to pages. Open pages only where the outline is unclear or where a skill needs checking.
5. Skip with a reason: older versions of the same file, duplicates, solutions it doesn't need yet, admin files. Each skipped file gets one line in the log.
6. Stop when every section of the course map can be written with confidence.

The live log shows each step and why, so the student sees it reason rather than churn.

**The catalog stays page-exact.** Every skill still points to a file and its pages or lines. Entries the agent built from an outline without opening the pages are marked as such, and quests open the real pages later anyway, so a slightly coarse entry costs nothing.

**No limit on opens, but every open has a reason.** There is no cap on how many files the agent may open: a hard number would be arbitrary and could make it stop before the map is right. Instead, every file it opens gets a log line saying why, and every file it skips gets one saying why not. "Read everything" stays possible when the course really needs it, but it has to be argued file by file.

**Later reads use the same inventory.** New files for a course (a new sheet, a new zip) are added to the inventory and the agent is told what's new since its last read, so it opens the new files and only re-opens old ones when something points back to them.

## 3. When the page hits a limit

The rule: **a limit routes the work; it never just ends it.**

| Block | Where it goes |
| --- | --- |
| A scan, handwriting, a file in an unusual format | Kept and marked for the agent. A cloud session reads it (it can see the pages) and saves the text back, so later quests can use it too |
| A course too big for one reading in the page | Doesn't happen anymore: the agent opens pages as it goes |
| No cloud sessions and the page can't read it | The student gets one line per drop, with the one thing that unblocks it: "2 scanned PDFs need cloud sessions to be read. Turn them on, or send photos of the pages you need." |
| The file store is full | The Orchestrator asks which courses come first (section 1) |

### Should a cheaper model decide whether to hand off? (pushback)

Lorenz's idea: when the page hits a block, ask a cheap model (Sonnet) "is this error intended, or should I launch an agent?", and let it launch one.

My recommendation is **not to put a model in front of that decision**, because it has one right answer: if the page can't read a file and a cloud session can, the session should read it. A model call there adds a wait and a cost for every block and can only ever add wrong "no"s. The real fix is that no block is a dead end, which the routing table above does in plain code.

Where judgment *is* needed (which of 300 files matter, whether two files are versions of the same thing, what "see chapter 4" refers to), it belongs to the agent that's already reading, as part of navigating.

### Which model reads?

- **The navigating agent stays on Opus.** The course map is read once per course and every quest and grade depends on it; a wrong skill map costs far more than the reading. This keeps the "every agent uses Opus" decision from 2026-11-20.
- **Bulk mechanical reading can go to Sonnet.** Inside a cloud session, the Opus agent may hand pure grunt work to a Sonnet helper: reading every page of a 200-page scan into text, or outlining a long slide deck with no bookmarks. That's transcription, not judgment, and it's where most of the reading cost is.
- Sorting the inventory doesn't need its own model: a file list is small, and the agent reads it as its first step.

## Videos

Claude can't watch or listen to videos, so by default the agent uses the video's title and where it sits in the folders.

When a drop holds videos, its summary card says so once, for all of them together (never one question per video):

> We found 12 videos, such as "VO 04 Integralrechnung.mp4". Claude can't watch or listen to videos, so it goes by the title unless you describe what happens in them.
> **Use the titles** (default) · **I'll describe them**

"I'll describe them" opens one short box per video. What the student writes becomes that video's readable text, and the agent reads it like any other file. A video left empty keeps going by its title. The card also says: "If you have the slides or a transcript, drop those instead."

## Data

| Record | Fields | Notes |
| --- | --- | --- |
| Upload (existing, extended) | add `path` (folder inside the zip), `zipId`, `state` (readable, for agent, skipped), `skipReason`, `sizeBytes` | `pages` already exists |
| Zip | `id`, `fileName`, `courseId` or unsorted, `addedAt`, counts per state | One per dropped zip; lets the Orchestrator assign or move all its files at once |
| Outline | `uploadId`, lines (`p. 3: 2.1 Grenzwerte`), capped at a few KB per file | Built at drop time; what the agent navigates by |
| Readable text (existing) | unchanged, plus `outline` | Still made by page code at drop time (cheap; it's how the outline is built), but never sent to Claude whole: the agent opens pages from it |

## What changes in the existing code

- `src/lib/files.ts`: zips, Office files, the three file states, outlines.
- Onboarding and Organize chats: keep files with path and state; one summary per zip.
- `src/onboarding/setup.ts`: the reading prompt gets the inventory and the navigation steps instead of the files' text; the page run gets the `outline` and `open` tools.
- `src/platform/handoff.ts` and the job text: the session is told how to download its course's files and save text back. The job no longer has to fit the files into its instructions, so the 45,000-character limit and the "too big for a cloud session" fallback go away.

## Decisions (Lorenz, 2026-11-20)

1. No model decides whether to hand off; code routes. Sonnet only for bulk transcription inside a cloud session; Opus keeps the navigation.
2. No limit on file opens; every open and every skip has a reason in the log.
3. Videos: Claude can't watch or hear them. The card says so once per drop; titles by default, or the student describes each video and that text is read instead.

## To check while building

- Whether a cloud session can download the page's stored files (the Artifact tool's asset read) for a student's own StudyDesk. If not, the page saves each file's text where the session can read it (the student's data), and scans still need photos.
- The file store's real per-artifact limits (count and bytes) on a student's plan, to size the room check.

## First version (built)

- **Taking in** (`src/lib/intake.ts`, `src/lib/office.ts`, `src/lib/keep.ts`): the setup chat and Organize accept any file (`InputBox keepAll`). Zips are streamed open with their folder paths, nested zips too (3 levels), junk left out, videos listed without being unpacked. Word, PowerPoint, Excel and OpenDocument text is pulled out with slide and sheet markers (in every chat box, not only these two). PDFs keep their text, page count and bookmarks; a PDF without text is kept as a scan for the agent. Each file gets an outline. Other chat boxes refuse a zip with "Drop course zips in Organize".
- **Report**: one card under the student's message, one line per zip ("Mathe.zip: 84 files, 61 PDFs, 9 Office files, 12 videos") and the video question. "I'll describe them" opens a box per video; the description is kept as the video's `studentNote`, which the agent reads.
- **Claude in the chat** sees the start of loose files (their outline when there are more than 8), and an inventory per zip. It assigns a whole zip with its zip id; the snapshot lists a course's zips as one line each.
- **Page run**: the setup prompt holds the inventory (with outlines while they add up to under 20,000 characters) and the navigation steps; Claude reads through `outline` and `open` (`fileTools` in `src/onboarding/setup.ts`). Every call adds a line to the live log, which shows the newest 14 steps. Files new since a course was last read are marked NEW.
- **Cloud run**: the job holds only the inventory with upload and asset ids. The session reads kept text and outlines from the student's data and originals from the file store, and may write back the text of scans it transcribed (the one extra write its instructions allow), handing long transcriptions to a Sonnet helper. The old 45,000-character limit and "has images" fallback are gone.

- **Room** (`keepDrop`): before storing, StudyDesk reads the file store's real limits and use from the platform. When a zip's originals won't all fit, the report says so first, PDFs are stored first (a scan can only be read from its original), the text of every file is kept anyway, and Claude is told to ask which courses matter most before more is added. Organize shows a meter ("File store: 120 MB of 1 GB used · 300 of 1000 files") and lists files per course with counts instead of every name.
- **Deep sweeps** in the nightly run read by reason too: the session answering the sweep gets the inventory and opens files itself (it already has the student's data downloaded).

- **Big imports** (after the first real import, 3 GB in 11 zips, froze and crashed the page): the first version unpacked each whole zip into memory and never let go of read PDFs. Now one file at a time (above), PDFs are freed after reading, and PDFs dropped loose in setup or Organize are read when the message is sent, one by one. Measured on 630 MB of zips (120 PDFs, 6 videos): the browser's memory rose by 88 MB instead of 1.9 GB, and the page never stalled. While files are kept, the chat says it takes a few minutes and that the window must stay open.
- **Leftovers**: files stored by an import that didn't finish are referenced by nothing. Setup and Organize show "N files (X MB) are left over from an import that didn't finish" with **Remove them**; only originals older than 15 minutes that no upload record or backup uses count, and the references are checked again before removing.

**Not in this version**

- Not yet tried in claude.ai: whether a session may read `data/users/me/files/uploads` and download assets, and the file store's real limits (the meter will show them).
- The database (text, outlines) has its own caps that the platform doesn't report ahead; StudyDesk only learns of them when a write is refused.
