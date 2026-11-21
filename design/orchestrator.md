# The Orchestrator

The Orchestrator is the only agent the student talks to about their desk. The one exception is the tutor: when the student asks about a problem, an explanation or any passage through the improved interface (Ask and select-to-reply), or works through the mistake review after grading, a separate Claude instance answers there. Everything else goes through the Orchestrator. It answers questions about their StudyDesk, takes every change to their semester, and passes the heavy work on to the organization agent, which the student never sees. This file covers what the Orchestrator does after setup. Setting up a semester ([onboarding.md](onboarding.md)) is its first job and stays as designed there.

Status: design agreed (see Decisions); first version built (see the end of this file).

## The idea in short

- **One chat, reachable from every screen.** The student opens it from anywhere, types, pastes or drops files, and the Orchestrator knows which screen they're on and what they selected.
- **It talks; others do the work.** Small changes (a new date, a different target grade, a new study goal) it makes itself through page tools, checked by code. Big changes (new material to read, a new course, a course to re-map) it hands to the organization agent as a job, and reports back when the job is done.
- **It's the organization agent's only voice.** When the organization agent needs something from the student (a missing date, a question about grading), a notification appears and the question reaches the student through the Orchestrator, never on its own.
- **It acts like a teacher.** Grading only produces numbers. The Orchestrator turns them into words: it tells the student how they're doing, notices when they're slow or stuck, and says so when they're doing exceptionally well.
- **It's the only agent with a lasting memory.** It keeps a running summary of what matters about the student and throws out what doesn't.
- **It never makes up a number.** Mastery, streaks, points, time estimates and due dates come from code. The Orchestrator reads and explains them; it doesn't compute or guess them (**agents judge, code counts**).
- **Everything it changes is logged and can be undone.** Each change keeps the student's words, what changed, and who did it, so the organization agent, the quest routine and the student all see the same history.

## What the student can do with it

Grouped by what happens behind the scenes. The lists are examples, not a fixed menu: the student just talks, and Claude works out which of these it is.

**Ask about their desk** (answered at once, nothing changes)

- "What's due this week?" "When is the Analysis exam?"
- "How am I doing in Linear Algebra?" "Will I reach a 2 at this pace?"
- "Why is today's quest so long?" "Why do I keep getting chain rule problems?"
- "What did I get wrong yesterday?"

**Small changes** (the Orchestrator applies them itself, code checks them)

- Study goal per weekday, a day off ("I'm sick tomorrow", "no studying on the 24th").
- Target grade of a course.
- A date: exam moved, homework deadline, a new hand-in.
- New homework, typed or as a photo of the sheet (the task text is kept word for word).
- A result: "I got 18 of 24 on sheet 3" (an assessment result, as the grading spec defines it).
- Weekly timetable and fixed commitments, or a fresh calendar import.
- Whether the calendar is followed live (it is by default; only turned off when the student explicitly asks, `set_calendar_live`).
- Quest settings: hints per task, lesson length, daily budget (`src/quests/config.ts`).
- A course's teaching language. Profile details.
- A fact to remember: "the professor said proofs from chapter 4 won't be in the exam" (kept word for word for the organization agent, and starts a job, see below).

**Big changes** (handed to the organization agent as a job)

- New material: slides, an exercise sheet, a past exam. The files are read and added to the material catalog, and skills are added or adjusted.
- A new course mid-semester: the same setup run as in onboarding, for one course.
- A change that needs re-mapping: "chapter 7 is not exam relevant", "the exam is now oral", "homework counts 40% now".
- Dropping a course: its quests stop, its data is archived, never deleted silently.
- A question the page can't answer alone: "find the old exams for this course online".

**Not the Orchestrator's job**

- Explaining course content. Learning questions go to the Ask and select-to-reply interface, where the tutor (its own Claude instance) answers them. If a student asks the Orchestrator "how does the chain rule work?", it opens an Ask note with the question already in it instead of teaching in the organization chat (see open question 1).

**The tutor passes organizing remarks on.** Students say organizing things to the tutor in passing: "this sheet is actually due tomorrow", "I'm sick, can we stop here", "we skipped this chapter in the lecture". The tutor never changes anything itself. It answers the learning part, and hands the remark to the Orchestrator word for word with where it was said. The Orchestrator handles it like any other message and shows the change card in its own chat, with a one-line pointer in the tutor conversation ("Passed on to StudyDesk: due date of sheet 5"). This covers Ask chats, select-to-reply notes and the mistake review.
- Grading. The grading agent judges quests on its own, at 22:00 or on "Grade me early".
- Writing quests. The morning quest routine does that from the records the Orchestrator and the organization agent keep.

## How a change works

Every change follows the same path, small or big.

1. **The student says it.** In any form: typed, a screenshot of an email from the professor, a dropped PDF.
2. **The Orchestrator understands it** and writes a change: the student's words, what it means in records (for example "Analysis 1, final exam: 28 Jan → 4 Feb"), and whether it's small or needs the organization agent.
3. **Code checks it.** Is the date real, is the grade on the course's scale, does the course exist. A change that fails the check goes back to the Orchestrator, which asks the student instead of guessing.
4. **It's applied.**
   - A small change is applied at once and shown as a change card in the chat: before → after, with an **Undo** button. No "are you sure?" for small things.
   - Anything that deletes, drops a course, or re-reads all of a course's material asks first, in one line, with yes and no buttons.
   - A big change starts a job (next section) and shows a job card.
5. **Everyone is up to date.** The change goes into the change log. The next quest is written from the new records. The organization agent gets every change since its last run with each job.

**Started quests are never rewritten.** A change applies from the next quest. If today's quest hasn't been started yet and the change affects it (an exam moved closer, homework due tomorrow), the change card offers "Rebuild today's quest".

**The student's word wins.** If what the student says disagrees with a file or with what the organization agent found, the Orchestrator applies the student's version and mentions the disagreement once ("Your syllabus says 28 Jan; I've used 4 Feb as you said.").

## Jobs for the organization agent

A job is a piece of work the organization agent does in the background. The Orchestrator writes it, the student sees its progress, and the Orchestrator reports the result.

- **Where it runs.** In a Claude Code cloud session through the existing hand-off (`src/platform/handoff.ts`) when the student has it turned on, otherwise in the page as in onboarding (the page has to stay open, and resumes after a reload).
- **What a job carries.** The kind of job, the course, the student's words, any files, and every change since the organization agent last saw that course. The session doesn't need to ask anything the desk already knows.
- **Job card.** Shows a live log the same way the setup run does ("Reading Blatt 5.pdf, p. 1-3: three tasks on integration by parts"), then a short result: "Added 3 skills, homework due Thu 27 Nov". Details stay folded.
- **Questions from the organization agent** come back as at most 3 to-do items per job, like after setup. The Orchestrator puts them in the chat one at a time, the student answers in the chat, and the answers become facts for the next run.
- **Closing the page is fine.** A job in a cloud session keeps running. Its result waits in the student's data and the Orchestrator reports it the next time the page opens.
- **One job per course at a time.** A second change to the same course while a job runs is queued and sent with the next job, so two runs never overwrite each other.

The organization agent's own design (how it reads, maps and decides) is its own module. The Orchestrator only depends on the job kinds and the records listed below.

## The chat itself

- **One chat per semester.** The setup chat simply continues as the Orchestrator chat when setup is done; nothing new to learn. Old messages fold away by day, and a new semester starts a fresh chat (the old one is kept in the archive).
- **Reachable everywhere.** A button in the sidebar and a keyboard shortcut open it as a side panel over the current screen, and the panel can be expanded to a full window for longer talks (to be tuned once it's used in production). When the student has text selected, "Ask StudyDesk about this" puts the selection in the message (a quest problem, a date on the overview).
- **Knows where the student is.** Each message carries the current screen and, when there is one, the quest part or course on it, so "this is too long" or "move this to Friday" needs no explanation.
- **Accepts everything** (guideline 2): typed text, dropped files, pasted images.
- **Select-to-reply works on its messages and cards** (guideline 4), including change cards, job cards and job logs.
- **Short by default.** Answers are a few sentences. Lists of what changed sit in the change card, not in the text.
- **Speaks first when there's a reason.** See "Notifications and check-ins" below.

## Notifications and check-ins

The Orchestrator speaks first, like a good teacher or assistant would. **Code decides when** there's a reason (each trigger is a plain rule on the stats, so it's testable and never guessed); **Claude writes what to say**, short and personal.

| Trigger (checked by code) | Example of what the Orchestrator says |
| --- | --- |
| The organization agent needs something (a to-do item from a job or a scheduled run) | "Your Analysis syllabus doesn't say how homework counts. Do you know?" |
| A job finished | "I've read sheet 5: 4 tasks, due Thursday." |
| Too slow: actual time over planned time by a set margin over the last few quests | "Your last three quests took about 40% longer than planned. Integration problems are where the time goes. Want me to plan a bit less per day, or should we train speed on those?" |
| Stats bad: a course falls off track for its target grade, or lapses pile up | "Linear Algebra is slipping behind what a 2 needs. Two eigenvalue skills lapsed this week. I'd put more of them into the next quests." |
| Stats exceptionally good: ahead of plan, long clean streak, a topic fully mastered | "All of chapter 3 mastered, a week before plan. Nice work." |
| A date the student should check is near | "The Analysis exam is in 14 days. Is 4 Feb still right?" |
| After each grading run | One short note on the day: what went well, what to look at in the mistake review. |

- **Where it shows.** A badge on the Orchestrator button on every screen, and the message waiting in the chat. A question from the organization agent stays marked until it's answered.
- **Not nagging.** At most one unprompted message per kind per day, the post-grading note included. Needs (questions, finished jobs) always show.
- **The margins** (how slow is "too slow", what counts as "exceptionally good") are tunable numbers in code, like the other mastery settings.

## Memory

The Orchestrator is the only agent with a lasting memory. Everyone else (grading agent, tutor, organization agent jobs) starts fresh each time and reads records.

- **What goes into each call:** the desk snapshot, the memory summary, and the last 30 messages.
- **The memory summary** is a short document the Orchestrator keeps about the student: preferences ("prefers short evening sessions"), what's been agreed ("no studying on Sundays during exam weeks"), how they're doing and feeling, open threads ("waiting for the professor's answer on the oral exam"), and anything the student asked it to remember.
- **When it's refreshed:** once the messages not yet summarized pass a set size (about 6,000 words), and at the end of each day the chat was used. Claude rewrites the summary from the old summary plus those messages.
- **What it throws out:** questions that led nowhere, small talk, and explanations it gave because the student asked a learning question in the wrong place (those belong to the tutor). Changes don't need to stay in the summary either: they're in the change log and the records.
- **What's never lost:** student facts are stored word for word as their own records, and the full chat stays in the student's data (folded away), so the summary can be rebuilt or checked.
- **The student can see it.** "What do you remember about me?" shows the summary, and the student can correct it by talking.

## What the Orchestrator sees and can do

The same pattern as the setup chat: a compact summary of the desk in the prompt, a few page tools to look things up and change them. Every model call uses Opus, like everywhere in StudyDesk.

**In every message (the desk snapshot)**

- Profile, semester, courses with target grade, teaching language and setup status.
- The next 14 days: exams, homework due, quests planned, days off, study goal.
- Per course: mastery and on-track status as code computed them, and a count of open review items.
- Open jobs and their status, open to-do items.
- The last few changes from the change log.
- Signals code computed for check-ins: planned against actual time, on-track status, recent lapses and streaks.
- The current screen and selection.

This stays small. Anything detailed is fetched with a look-up tool only when the question needs it.

**Page tools**

| Tool | What it does | Checked by code |
| --- | --- | --- |
| `look_up` | Reads details not in the snapshot: a course's skills and their state, a quest and its results, the attempt history of a skill, a file's catalog entry, the full change log | Read only |
| `change` | Applies one or more small changes (dates, homework, grade targets, study goal, days off, timetable, quest settings, language, profile, assessment results, facts) | Each change: valid date, grade on scale, course exists. Returns the change card or a reason it failed |
| `undo` | Reverts a change from the log | Only the student's own undo button or a clear request |
| `start_job` | Starts an organization agent job (new material, new course, re-map, drop course, look-up online) with the student's words and files | One job per course at a time; queues otherwise |
| `read_calendar` | Imports from the student's Google Calendar, as in onboarding | Same rules as onboarding |
| `open_ask` | Opens an Ask note or chat with a learning question already filled in | None |
| `rebuild_quest` | Asks the quest code to write today's quest again from the new records | Only when today's quest hasn't been started |

`change` takes typed operations (for example `set_target_grade`, `move_date`, `add_homework`, `set_day_off`), not free text. Claude decides what the student meant; code decides whether it's valid and saves it.

## Records

**New**

| Record | Key fields | Notes |
| --- | --- | --- |
| Change | `id`, `at`, `by` (student, orchestrator, organization agent), `studentWords`, `operations[]`, `before`, `after`, `status` (applied, undone, failed), `jobId` or none | The change log. Undo reverts `after` → `before`. |
| Job | `id`, `kind` (new material, new course, re-map, drop course, look-up), `courseId`, `studentWords`, `uploadIds[]`, `changesSince`, `status` (queued, running, done, failed), `log[]`, `result`, `runsIn` (cloud, page) | Uses the existing job document for cloud hand-off |
| To-do item | already exists from onboarding | Gains `jobId`, so questions from later jobs use the same list |
| Day off | `date`, `reason` | Quest budget for that day is 0; reviews move to the next study day |
| Orchestrator chat | `semesterId`, messages with attachments, change and job cards inline, `summarizedUpTo` | Continues the setup chat |
| Orchestrator memory | `text`, `updatedAt`, `coversUpTo` | The running summary, one per student, carried across semesters |
| Notification | `id`, `kind` (needs answer, job done, too slow, off track, doing great, check date, day note), `at`, `courseId` or none, `seenAt`, `answeredAt` | Code writes the trigger; the Orchestrator writes the text |

**Used as they are:** profile, semester, course, course target, weekly timetable, study goal, upload, student facts (onboarding); assessment result, skill state (grading spec); quest settings (quest creation).

## Examples

**A moved exam**

> Student: The Analysis exam got moved, see screenshot. *(pastes an email)*
>
> Orchestrator: Moved the Analysis 1 final from 28 Jan to 4 Feb. Your quests will spread the remaining topics over the extra week.
>
> *Change card: Analysis 1, final exam: 28 Jan → 4 Feb · Undo*

**New homework sheet**

> Student: *(drops Blatt5.pdf)* new sheet, due Thursday
>
> Orchestrator: Got it. I'm reading the sheet now and will add the tasks to your quests.
>
> *Job card: Reading Blatt5.pdf … Done: 4 tasks, due Thu 27 Nov, 2 new skills (integration by parts, substitution).*

**A question that needs a number**

> Student: Will I get a 2 in Linear Algebra at this rate?
>
> Orchestrator: You're on track: 41% of the skills a 2 needs are mastered, and at your current pace the rest fit before the exam on 12 Feb with about 50 minutes a day. Eigenvalues is the topic slowing you down the most.

(All numbers come from the snapshot; Claude only phrases them.)

**A learning question**

> Student: wait how does the chain rule work again
>
> Orchestrator: That's one for Ask. I opened it with your question. *(Ask panel opens)*

## Notes for the other modules

- **Organization agent:** needs regular runs, not only jobs started by changes, so the student and the system stay up to date. Agreed with Lorenz: a shallow run every day before the morning quest routine (dates, open homework, anything that changed). Deep sweeps per course are scheduled by the organization agent itself: after setup, and after each sweep, it decides when the next one is due (for example before an exam phase). New material from the student doesn't wait for a sweep: the Orchestrator starts a job for it at once. Questions from these runs reach the student as notifications through the Orchestrator. It also must accept the job kinds above (new material, new course, re-map, drop course, look-up), read the `changesSince` it's given, write the same records as the setup run, return at most 3 questions per job as to-do items, and never talk to the student directly.
- **Quest creation / morning routine:** read days off and the change log; respect "started quests are never rewritten"; offer a `rebuild_quest` entry point for an unstarted quest.
- **Grading and mastery:** assessment results now arrive through `change`. Nothing else changes. The Orchestrator needs one code function that answers "on track for the target grade?" with the numbers, so it never computes them itself.
- **Ask interface and tutor (including the mistake review):** needs an "open with this question" entry point for `open_ask`, and one tool, `pass_to_orchestrator`, that hands an organizing remark on word for word with where it was said.
- **Onboarding:** the setup chat becomes the first part of the Orchestrator chat; its prompt switches to the everyday prompt once setup is done. `update_sheet` stays the setup-time tool.

## Decisions

Settled with Lorenz on 2026-11-20.

1. **Learning questions go to the tutor.** The Orchestrator sends them to Ask (`open_ask`) and doesn't teach. The tutor is the only other agent the student talks to, and it passes organizing remarks on to the Orchestrator.
2. **Small changes apply at once with Undo.** Only deletes, dropping a course and full re-reads ask first.
3. **The student sees it as "StudyDesk".** "Orchestrator" is only the internal name.
4. **It speaks first like a teacher:** when it needs something, when the student is too slow, when stats are bad or exceptionally good, and with a short note after each grading run. See "Notifications and check-ins".
5. **Side panel, expandable to a full window.** The exact layout is decided once it's used in production.
6. **New files start a job automatically.** Re-reading everything a course already has asks first.
7. **Each call gets the snapshot, the memory summary and the last 30 messages.** See "Memory".
8. **Organization agent runs:** a shallow run daily; deep sweeps scheduled by the organization agent itself after setup and after each sweep; new material from the student starts a job at once. Details belong to its own design.
9. **Check-in margin:** "too slow" starts at 30% over planned time across the last 3 quests, tunable in code.

## First version (built)

The code lives in `src/orchestrator/`, storage in `src/platform/orchestratorStore.ts`, tests in `tests/orchestrator.test.ts`.

**How it works now**

- **Organize.** The student sees the Orchestrator as **Organize** (see [app-layout.md](app-layout.md)). It is a full page (the chat beside the student's semester data), and the same chat opens as a quick panel over any other screen with Ctrl/⌘ J. Selecting text anywhere shows "Organize" next to "Reply", which opens the chat with that passage quoted. The chat accepts typed text, dropped and pasted files, and supports select-to-reply on its messages and cards.
- **Changes** (`changes.ts`): Claude calls one tool, `change`, with typed operations (target grade, exam dates, homework and due dates, study goal, days off, weekly slots, teaching language, facts, profile, results, new course, drop course). Code checks each one and applies it to the semester draft, then rebuilds the quests' semester from it (keeping the placement check and the workload decision). Every change shows a card with its lines and **Undo**; undo is refused when something changed the same part since, so it never throws away newer work. Results can't be undone (they add to the attempt log). Dropping a course shows a Yes/No card and is applied only on yes.
- **Days off** really empty that day's quest budget (`planQuest`).
- **Jobs** (`jobs.ts`): `start_job` assigns dropped files to their course, records the student's words as facts, and marks the course for reading. The reading is the setup run itself (cloud session when hand-off is on, the page otherwise), which keeps running hidden while the student is on any screen. A second job for a course that's still being read waits its turn. When the course is read, the job card shows what changed ("2 new skills, 1 question for you"). Re-reading everything a course has asks first.
- **Check-ins** (`signals.ts`): every 10 minutes and when a job ends, code checks: open questions from the organization agent, finished jobs, too slow (30% over planned across the last 3 quests), off track or slipping per course, doing great (ahead of plan, a topic fully mastered), an exam within 14 days to double-check, and a note after each grading. Each reason is sent once (same kind and course at most every few days). Claude writes one short message from the facts; a badge shows unseen ones.
- **Memory** (`agent.ts`): a running summary rewritten after about 6,000 new words or on a new day, seeded once from the setup chat. Each call gets the summary, the last 30 messages and the desk snapshot (every number computed by code). The chat is stored per semester day; the summary carries across semesters.
- **Look-ups**: skills, homework, dates, facts, files, timetable, recent quests, results, the change log and the memory, read only.
- **Learning questions** go to Ask: `open_ask` opens a new Ask chat with the question already sent.
- **One version everywhere** (`src/platform/deskBus.ts`): the setup screen, the quest page and the panel publish every change they make, and the others take it over, so no screen saves an older copy on top.

- **Rebuild today's quest** (`rebuild_quest`, and a button on change cards): while today's quest isn't started, it's marked replaced and the quest page writes a new one from the current desk. A started quest is never rewritten.
- **Quest settings by talking** (`set_quest_settings`): hints per homework task (0 to 5), lesson reading minutes (2 to 15) and new skills per quest (0 to 4), stored per student and used from the next quest (`applyQuestSettings` in `src/quests/config.ts`).
- **The tutor passes remarks on** (`src/orchestrator/passOn.ts`): every tutor call (Ask chats, side notes, the mistake review) has a `pass_to_studydesk` tool. The remark arrives in the StudyDesk chat word for word, marked "Passed on by the tutor", with where it was said; it's handled one at a time and shows on the badge.

**Not in this version (next steps)**

- The organization agent's daily check and deep sweeps now run in the nightly run ([scheduled-runs.md](scheduled-runs.md)); their changes arrive as change cards in a "Last night's run" message.
- The live reading log stays on the setup screen ("Watch it live" on the job card).
