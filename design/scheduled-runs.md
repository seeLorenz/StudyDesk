# Scheduled runs

What StudyDesk does on its own, without the page being open: grading at 22:00, the organization agent's checks, and writing the next day's quest. Grading rules come from [grading-and-mastery.md](grading-and-mastery.md), quests from [quest-creation.md](quest-creation.md), changes and questions from [orchestrator.md](orchestrator.md).

## What was agreed

- **Grading runs once a day, automatically at 22:00** in the student's own time. "Grade me early" stays in the quest overview as the manual way.
- **The next day's quest is ready before morning.**
- **The organization agent** does a short check every day before the morning quest. It schedules its own deep sweeps: the first one after setup, and each sweep sets the date of the next. New material from the student doesn't wait: the Orchestrator starts a job for it at once (already built).

## How it works: one nightly run

Every night at 22:00 one Claude cloud session does all three, in this order:

1. **Grade** everything handed in that isn't graded yet.
2. **Check the courses** (the organization agent's short check), plus a **deep sweep** of any course whose sweep date has come.
3. **Write tomorrow's quest**, planned from tonight's grades and whatever the check found.

One run instead of three separate ones, because each step needs the one before: tomorrow's quest should already know tonight's mistakes and a moved deadline. It also starts one session a night instead of several.

### Where it runs

The page creates one **scheduled task** in the student's own Claude account ("StudyDesk nightly run"), once, when cloud sessions are turned on and the semester is set up. Its schedule is 22:00 every day in the student's time zone; daylight saving is handled by the schedule itself. The task starts a fresh cloud session each night, so it works with the page closed. These sessions don't appear in the student's regular session list.

The page can only create and fire scheduled tasks, not change or delete them. So the task's own instructions are short and never need to change: find the student's StudyDesk, build its nightly program from the StudyDesk repository attached to the task, run it, do what it says. Everything that may change lives in that program.

**The program is built, never downloaded.** Auto mode's safety check refuses to run a program the session fetched itself (from the page or with a fresh git clone): an unwatched session obeying a downloaded program reads as escaping review. It does accept StudyDesk's own code from the repository attached to the task, built with `npm ci && npm run build:routine` (all tested 2026-11-25). So:

- **One-time setup:** the student adds the repository (`seeLorenz/studydesk`) to the "StudyDesk nightly run" scheduled task. The page can't attach it, since creating a task takes no repository. Until it's added, each run stops at once and says exactly that. The page reminds them (2026-11-25): while no night has ever run (the routine doc has no logs), Organize's To do list leads with **"Turn on the nightly run"**, four short steps with a link to claude.ai/code/routines, and it counts toward the red badge. It has no checkbox: it clears itself once the first night has run, because a night that wrote a log is the only proof the repository is attached (a run without it stops before writing anything). The Orchestrator sees the same state, so it can help when the student asks.
- **Same version as the page:** the page saves the commit it was built from on the profile (`schedule.build`) whenever it opens, so after an update the next night builds the new version. A page built without a commit (local build) makes the night use `main`.
- Each student still runs it in their own account on their own plan; the repository is public and read-only to them, and their data only ever goes to their own StudyDesk.

Each task carries a key, and the profile keeps the key of the current one. If a new task is ever made (the student moved to another time zone), the old one still fires but finds a different key and stops at once without doing anything.

### Agents judge, code counts, also at night

The nightly program (`routine.mjs`) is StudyDesk's own code: the same planning, grading rules, mastery counting and checks as the page, built into one file. The cloud session runs it with Node. Whenever the code needs Claude (to judge an answer, write a lesson, check a course), the program writes that request down and stops; the session, which is itself Claude, answers it; then the program runs again and continues. So Claude only does what Claude should do, and every number is still computed by code.

The program itself never uses the network or starts other programs: it only reads and writes files in its work folder. Every download, upload and git command is a step it prints and the session runs, so each one is visible and goes through the session's normal safety check. The task's prompt tells the session to refuse any step outside download, answer, check releases and save.

In practice a night takes three rounds: grading and the course check together, then all parts of tomorrow's quest at once, then a last pass that saves.

### Nothing the student is working on is overwritten

The nightly run never replaces a document the page may have open. It writes:

- **straight to the student's data:** new attempts and review items (new records only) and tomorrow's quest (a new record);
- **into an outbox:** the grades for each quest (only the grading fields: verdict, points, feedback), the course check's changes and questions, and deep-sweep results.

The page takes the outbox in when it opens, and every few minutes while it's open, so a student still on the page at 22:00 sees the grades arrive. A quest that's open on screen merges the grades into its own copy, so nothing typed is lost. If the page isn't opened before the next night, the next run folds the outbox in itself first. Grades given in the meantime with "Grade me early" are kept.

## The organization agent's nightly check

**Short check (every night, all courses in one call).** The agent gets everything StudyDesk knows per course (homework and due dates, exams, the student's own words, file names, skill names) and may search the web for course pages. It answers in the same typed operations the Orchestrator uses, so code checks each one:

- it may apply on its own: an exam date moved or announced, a deadline moved, a new homework sheet, a fact it found (always with its source), the course's language;
- everything else (dropping a course, a new study goal, results) is left for the student;
- at most 3 questions per course for what it couldn't find; they join the course's open questions and, as after setup, come a few a day, nearest exam first.

Applied changes show up in the StudyDesk chat as change cards marked as found overnight, each with **Undo**.

**Deep sweeps.** The check also picks, per course, the date of the next deep sweep: sooner before an exam phase or a new block of material, later in quiet weeks, always between 3 and 28 days ahead. The first one is a week after setup unless the check picks earlier. On that night the course is read again like at setup: by reason from its file inventory (design/course-files.md), re-opening what matters for the exams ahead, and with the web; the result replaces the course's map, and questions it raises go to the student the same way.

## Changing it through StudyDesk's chat

Everything about the nightly run is changed by talking to StudyDesk (the Orchestrator), like any other setting. Each change gets a card with Undo:

- **The time** ("run it at 21:30"): a new scheduled task is made at the new time; the old one finds a different key and does nothing.
- **Pause and resume** ("stop the nightly run during the holidays"): the program reads the setting and stops at once, so no new task is needed.
- **Each part on or off**: grading at night, the courses' check, writing tomorrow's quest. A part that's off is done the old way (the "Grade me early" button, the quest written on first open).
- **A course's deep sweep date** ("read Calculus again completely on Thursday"): the student's date wins over the agent's own; "none" hands it back to the agent.
- **Run it now** ("grade everything now and write tomorrow's quest"): starts the run at once; results arrive within about 15 minutes. A run started by hand doesn't stop that night's regular run.

The Orchestrator sees the run's status, its settings, each course's next sweep and the last night's log, so it can answer "when is Calculus read again?" or "what happened last night?".

## What the student sees

- **Quest overview:** "Grading runs on its own tonight at 22:00, or press the button to grade now." Without cloud sessions: "anything left is graded the next time you open StudyDesk".
- **In the morning:** tomorrow's quest is simply there. Graded quests move to "Done quests", and the mistake review sits at the top as usual.
- **StudyDesk chat:** one message per run, "StudyDesk's nightly run", with what was graded, what the check found (with change cards), and the quest it wrote.

## When something fails

- **No cloud sessions** (or the run didn't happen): on the next open, handed-in work from earlier days is graded in the page, and today's quest is written in the page on first open, as before.
- **One part fails** (a grading answer that can't be read, a course reading that breaks off): that part is skipped and logged, the rest of the night goes on. Ungraded work stays for "Grade me early" or the next night; a failed sweep is tried again the next night.
- **The run is fired twice** within a few hours: the second finds the night already done and stops.

## Study times in the calendar

After writing tomorrow's quest, the nightly run asks Claude **when** the student should do it: Claude gets tomorrow's events from the page's latest calendar read, the quest's length and parts, and the StudyDesk chat's memory of the student (so "I study best in the evening" counts), and answers one to three blocks. Claude also gets the weekly timetable's slots for that weekday, so a lecture missing from the calendar still counts. Code then checks the times: a block that overlaps anything fixed (or, for today, starts in the past) is dropped, whatever Claude said. The plan is saved as `data/users/<uid>/calendarWant`. Only when the student follows their calendar (`calendarSync`).

Writing the entries needs the calendar, and a scheduled task the page creates can't have connectors (tested 2026-11-23: claude.ai refuses connectors on tasks a page or its sessions create, and a task can't be given them later). So whoever can reach the calendar first writes them:

- **The page**, whenever StudyDesk is open (it checks with every calendar refresh). This always works once the student has allowed StudyDesk to create and delete calendar events.
- **The student's own "StudyDesk calendar" task**, if they set it up: a task created by a normal Claude Code session may use the student's Google Calendar. The Orchestrator posts the text to paste once the first plan exists (design/orchestrator.md). The task runs 90 minutes after the nightly run, so tomorrow's entries are there by morning even if StudyDesk stays closed. Its prompt only says "read calendarWant and do what its instructions say"; the steps themselves are written into `calendarWant` each night by the program, so an update never needs the task changed.

**Quests the page writes.** When today's quest wasn't planned at night (the nightly run was off or failed, or the student asked the Orchestrator for a new quest), the page asks Claude for times for the rest of today the same way, with the current time as the earliest start, and saves that plan. It reads today's calendar fresh for this, never an older copy (24 Nov 2026: a read saved before the update had no event times, Claude saw an empty day, and a block landed on a lecture). The quest page nudges this within a minute of writing a quest; otherwise it happens with the next calendar refresh. Tomorrow's plan, once the nightly run made it, is never replaced this way.

**Finished early.** Once every part of today's quest is handed in, the entries still ahead are dropped from the plan, so they disappear from the calendar; entries that already started stay as a record.

Both record what they wrote in `data/users/<uid>/calendarWritten` (the plan's key, and each entry's event id). A plan whose key is already written is skipped. A changed plan keeps the events of entries that didn't change, deletes the rest by id and creates the new ones, so entries move instead of piling up. Every entry is titled "Study · <course>", its description starts with "[StudyDesk]", and it has a 10-minute reminder. Calendar reads drop entries marked "[StudyDesk]", so they never count as busy time. The calendar task also stamps `taskSeenAt` on every run; three quiet days count as "gone" and the Orchestrator says so once.

**If-then plans (2026-11-25).** Deciding ahead when, where and what to start takes the decision away from mood (Gollwitzer's implementation intentions). So each entry is a plan, not just a block: "Study · Calculus · part 2" at the library, and its note starts "18:00, library: open part 2, "Two tests that compare with a geometric series"."
- **Where:** Claude names a place after each block, from what the student told StudyDesk (the chat's memory keeps where they study). It goes into the event's location, so it shows in the reminder. Nothing said, no place.
- **What to open:** code, not Claude: the part the quest reaches after the earlier blocks' minutes (part times from the timing rules, parts already handed in skipped).
- **Asking:** "Where do you study?" is pinned on To do for every student, like "Do you use Anki?", outside the daily limit. The StudyDesk chat ticks it off once answered.
- *Rejected:* a fixed place field on the profile. Places change by day and by what's before ("library after lectures, home on Sundays"), which Claude reads from the student's own words; a field would need a form and still miss that. Also rejected: Claude choosing the part, since splitting minutes over blocks has one right answer.

## Limits, for now

- **Calendar data is live, read by the page.** Scheduled tasks the page creates can't use connectors, so the nightly run can't read Google Calendar itself. Instead, whenever StudyDesk is open the page reads the next 14 days of the calendar again (at most every 3 hours, and on each new day) and saves the busy minutes and timed events per day in `data/users/<uid>/calendar`. The nightly run sizes tomorrow's quest from that latest read, with the weekly timetable as a floor, and its log says how old the read is. Only if tomorrow isn't covered by any read does it fall back to the weekly timetable alone. The page also reads today's calendar when it writes a quest itself.
- **Files in deep sweeps** are opened by the session itself from the student's data and file store, like cloud setup runs (images and scans included).
- **A new semester** creates no new task: the same one keeps running and reads whatever semester is current.
- **Cost:** one Opus session a night on the student's own plan, longer on nights with a deep sweep.

## Code

- `src/routine/nightly.ts`: the run itself (grade, check, write), pure apart from the Claude calls.
- `src/routine/org.ts`: the organization agent's check prompt, its parsing and the sweep calendar.
- `src/routine/apply.ts`: merging the outbox into the desk, shared by the page and the run.
- `src/routine/deferred.ts`: Claude calls answered by the session itself.
- `src/routine/cli.ts`: the program the session runs (`routine.mjs`, built by `vite.routine.config.ts`).
- `src/quests/times.ts`: study times (Claude's pick, the saved plan, what today's quest needs, writing it, the calendar task's setup text); `src/platform/studyEntries.ts`: the page's side of it.
- `src/platform/schedule.ts`: creating the scheduled task; `src/platform/routineStore.ts`: the outbox in the page.
- Tests: `tests/routine.test.ts` plays whole nights with a stand-in session.
