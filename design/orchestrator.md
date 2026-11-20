# The Orchestrator

The Orchestrator is the only agent the student talks to about their desk. The one exception is the tutor: when the student asks about a problem, an explanation or any passage through the improved interface (Ask and select-to-reply), a separate Claude instance answers there. Everything else goes through the Orchestrator. It answers questions about their StudyDesk, takes every change to their semester, and passes the heavy work on to the organization agent, which the student never sees. This file covers what the Orchestrator does after setup. Setting up a semester ([onboarding.md](onboarding.md)) is its first job and stays as designed there.

Status: design draft, nothing built yet beyond the setup chat.

## The idea in short

- **One chat, reachable from every screen.** The student opens it from anywhere, types, pastes or drops files, and the Orchestrator knows which screen they're on and what they selected.
- **It talks; others do the work.** Small changes (a new date, a different target grade, a new study goal) it makes itself through page tools, checked by code. Big changes (new material to read, a new course, a course to re-map) it hands to the organization agent as a job, and reports back when the job is done.
- **It's the organization agent's only voice.** When the organization agent needs something from the student (a missing date, a question about grading), the question reaches the student through the Orchestrator, never on its own.
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
- **Reachable everywhere.** A button in the sidebar and a keyboard shortcut open it as a side panel over the current screen. When the student has text selected, "Ask StudyDesk about this" puts the selection in the message (a quest problem, a date on the overview).
- **Knows where the student is.** Each message carries the current screen and, when there is one, the quest part or course on it, so "this is too long" or "move this to Friday" needs no explanation.
- **Accepts everything** (guideline 2): typed text, dropped files, pasted images.
- **Select-to-reply works on its messages and cards** (guideline 4), including change cards, job cards and job logs.
- **Short by default.** Answers are a few sentences. Lists of what changed sit in the change card, not in the text.
- **Speaks first only when something needs the student.** When the page opens and a job finished, a question from the organization agent is waiting, or a date the student should check is near, the Orchestrator shows one short line with what it is. Nothing otherwise, and no daily messages.

## What the Orchestrator sees and can do

The same pattern as the setup chat: a compact summary of the desk in the prompt, a few page tools to look things up and change them. Every model call uses Opus, like everywhere in StudyDesk.

**In every message (the desk snapshot)**

- Profile, semester, courses with target grade, teaching language and setup status.
- The next 14 days: exams, homework due, quests planned, days off, study goal.
- Per course: mastery and on-track status as code computed them, and a count of open review items.
- Open jobs and their status, open to-do items.
- The last few changes from the change log.
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
| Orchestrator chat | `semesterId`, messages with attachments, change and job cards inline | Continues the setup chat |

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

- **Organization agent:** must accept the job kinds above (new material, new course, re-map, drop course, look-up), read the `changesSince` it's given, write the same records as the setup run, return at most 3 questions per job as to-do items, and never talk to the student directly.
- **Quest creation / morning routine:** read days off and the change log; respect "started quests are never rewritten"; offer a `rebuild_quest` entry point for an unstarted quest.
- **Grading and mastery:** assessment results now arrive through `change`. Nothing else changes. The Orchestrator needs one code function that answers "on track for the target grade?" with the numbers, so it never computes them itself.
- **Ask interface:** needs an "open with this question" entry point for `open_ask`.
- **Onboarding:** the setup chat becomes the first part of the Orchestrator chat; its prompt switches to the everyday prompt once setup is done. `update_sheet` stays the setup-time tool.

## Open questions

Each has a recommendation; nothing is built until these are settled.

1. **Should the Orchestrator also teach, or send learning questions to Ask?** Recommendation: send them to Ask (`open_ask`). One place to learn keeps notes and history together, and the Orchestrator's prompt stays about organizing.
2. **Apply small changes at once with Undo, or confirm every change first?** Recommendation: at once with Undo; confirm only deletes, dropping a course and full re-reads. Confirming every date change makes the chat slow and teaches the student to click yes without reading.
3. **What does the student call it?** "Orchestrator" is the internal name. Recommendation: the student just sees "StudyDesk" on the chat button and messages ("Ask StudyDesk about this"), so there's no agent to learn about.
4. **Should it ever message first?** Recommendation: only on page open, one line, and only when something needs the student (job done, question waiting, date to check). No daily summaries; the quest overview already does that job.
5. **Where does the chat live on screen?** Recommendation: a side panel opened from the sidebar or a shortcut, over any screen, rather than its own page, so the student never loses their place in a quest.
6. **Should new files start a job automatically?** Recommendation: yes for new files (the student dropped them for a reason), with the job card showing at once; ask first only before re-reading everything a course already has.
7. **How much chat history goes into each call?** Recommendation for the MVP: the snapshot plus the last 30 messages and all student facts; older messages fold away and aren't sent. Smarter trimming belongs to the token optimization after the MVP.
