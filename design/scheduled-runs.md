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

The page can only create and fire scheduled tasks, not change or delete them. So the task's own instructions are short and never need to change: find the student's StudyDesk, download its nightly program, run it, do what it says. Everything that may change lives in that program, which is published together with the page.

Each task carries a key, and the profile keeps the key of the current one. If a new task is ever made (the student moved to another time zone), the old one still fires but finds a different key and stops at once without doing anything.

### Agents judge, code counts, also at night

The nightly program (`routine.mjs`) is StudyDesk's own code: the same planning, grading rules, mastery counting and checks as the page, built into one file. The cloud session runs it with Node. Whenever the code needs Claude (to judge an answer, write a lesson, check a course), the program writes that request down and stops; the session, which is itself Claude, answers it; then the program runs again and continues. So Claude only does what Claude should do, and every number is still computed by code.

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
- at most 3 questions per course for what it couldn't find; they join the course's open questions and the Orchestrator asks them one at a time, as after setup.

Applied changes show up in the StudyDesk chat as change cards marked as found overnight, each with **Undo**.

**Deep sweeps.** The check also picks, per course, the date of the next deep sweep: sooner before an exam phase or a new block of material, later in quiet weeks, always between 3 and 28 days ahead. The first one is a week after setup unless the check picks earlier. On that night the course is read again completely, like at setup, with the web; the result replaces the course's map, and questions it raises go to the student the same way.

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

## Limits, for now

- **No calendar at night.** Scheduled tasks can't use connectors, so the nightly quest is sized from the weekly timetable, not today's Google Calendar. (The page still uses the calendar when it writes a quest itself.)
- **Images in course files** aren't read in deep sweeps, as with cloud setup runs; text and PDFs are.
- **A new semester** creates no new task: the same one keeps running and reads whatever semester is current.
- **Cost:** one Opus session a night on the student's own plan, longer on nights with a deep sweep.

## Code

- `src/routine/nightly.ts`: the run itself (grade, check, write), pure apart from the Claude calls.
- `src/routine/org.ts`: the organization agent's check prompt, its parsing and the sweep calendar.
- `src/routine/apply.ts`: merging the outbox into the desk, shared by the page and the run.
- `src/routine/deferred.ts`: Claude calls answered by the session itself.
- `src/routine/cli.ts`: the program the session runs (`routine.mjs`, built by `vite.routine.config.ts`).
- `src/platform/schedule.ts`: creating the scheduled task; `src/platform/routineStore.ts`: the outbox in the page.
- Tests: `tests/routine.test.ts` plays whole nights with a stand-in session.
