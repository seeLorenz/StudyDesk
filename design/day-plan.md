# The day plan: what to do, and when

How StudyDesk turns a student's courses, exams, homework and free time into a plan that always says what to do next and at what time. It changes the screens from [app-layout.md](app-layout.md) and how a day's work is chosen in [quest-creation.md](quest-creation.md); grading and mastery ([grading-and-mastery.md](grading-and-mastery.md)) stay as they are.

Status: first version built (see the end of this file).

## Why this changed

Testing with a full school semester (a dozen subjects, several exams within a few weeks) showed where the old Today page fell short:

1. **One course a day.** The day's quest went to the course with the most urgent homework, otherwise simply to the first course in the list. With exams coming up in many subjects, every quest was for the same subject.
2. **What, but never when.** StudyDesk knew the timetable and the calendar, yet Today only said "about 30 min", with no time of day. That number was the study goal minus the lessons, which the student never saw.
3. **A first step too big to start.** The placement check was one quest of up to 30 problems across all courses, often over two hours: easy to open, hard to start.
4. **Organizing crowded out studying.** After setup the chat had raised dozens of questions, one message each, and the same to-do message could be posted several times.
5. **Too many places to look.** Today, Coming up, the mistake review, Ask, Organize, the setup sheet and its to-do list each held part of the answer to "what now?".

## The idea in short

- **A day is a few short blocks, one course each**, placed on the clock in the student's free time. Each block is a normal quest for its course, so writing, grading, mastery and select-to-reply work as before.
- **Code plans the day** (which course, how long, when); Claude writes each block's content. Agents judge, code counts: the plan is plain, tested code, so the same desk always gives the same plan.
- **Every block says why it's there**: "Due tomorrow 08:00", "Klausur Wed 2 Dec · in 9 days", "3 skills come back".
- **Exams drive the plan.** Prep for every exam in the next four weeks is spread backwards from its date, spaced, never crammed the night before.
- **The plan heals itself.** A block that wasn't started moves to the next free time; one the student moves or skips is planned again, and the student sees what that does to the exam it was for.
- **Three places**: Now, Week, Courses. Plus "Tell StudyDesk" on every screen, and Ask for learning questions.

## What goes into a day

The day's study time is the same budget as before (the grading spec's "How much fits in a day": study goal minus lessons and calendar, at most 80% of it, at most 1.2 × the recent pace, half of it for a new student). The plan fills it in this order (`src/plan/day.ts`):

1. **Mistakes to understand** from the last grading: a short block first thing (about 4 minutes per mistake, at most 20). It opens the mistake review.
2. **Homework**: on the day before it's due when it's due before 14:00, otherwise on the due day itself. Homework due within two days always gets its block, even over the budget.
3. **The placement check**: two courses a day, the one with the nearest exam first, one part each. The student can move a part to tomorrow.
4. **Exam prep**: every exam or quiz in the next 28 days wants a few prep blocks, more the less of it is mastered: from 2 to 6 for an exam (1 to 3 for a quiz), placed 1, 2, 4, 6, 9 and 13 days before it, nearest first. Mastery counts only the skills the target grade needs; when the exam lists its skills, only those. A block that doesn't fit on its day moves to an earlier day with room. An exam whose course has no skills yet (no material) asks the student instead.
5. **Reviews**: skills coming back that day, for a course that has no block yet (it would get them inside its block anyway).
6. **Something new** while time is left, taking turns between courses, the nearest exam first. For a course with an exam ahead, that counts as prep for it.

Two blocks of one course on one day become one block (at most 50 minutes). A day has at most four blocks. A study day always gets at least one block, however little time it has. Days off have none.

**Each block becomes a quest.** `planQuest` plans it for its course, sized to the block (`src/plan/build.ts`), and records where it sits in the plan (`Quest.block`: kind, exams it prepares for, the hand-in time). Started blocks are never rewritten.

**How each exam stands**: the prep blocks it wants against those the plan has before its date: on track, tight (at least half, or all that still fit), or behind. When prep and homework need clearly more time than the study goal leaves, Now says so in one line, with the minutes per day it would take, and a button that asks StudyDesk's chat to raise the study goal (a normal change with Undo).

## On the clock

Plain code (`src/plan/clock.ts`), the same on Now, on Week and at night:

- **Busy time**: lessons from the weekly timetable (lessons less than 30 minutes apart count as one stretch of school), fixed weekly slots, and the calendar's timed events for that day. A calendar event inside school counts as school.
- **Free time**: from an hour after school ends (lunch, getting home), or from 10:00 on a day without school, until 21:30, so work can be handed in before the nightly run at 22:00. Ten minutes after every appointment.
- **Blocks** go in order of importance, each into the first window it fits, with a ten-minute break between two blocks.
- **Today, live**: blocks still to do are placed from now on. One that was planned earlier but not started moves to the next free time and says where it was. The block being worked on is "now" whatever its slot.

The calendar's last read now keeps each day's timed events, not only their minutes (`CalendarAhead.spans`), so blocks go around them.

## Now

The home screen.

- **A header that answers "what now?"**: "School until 13:10. Your first block is at 15:45.", "3 blocks left today. You're done by 17:05.", "Done for today. The evening is yours."
- **The now card**: the block to do now (or next), its time and length, why it's there, why now, its steps, and one button: Start (or Continue). "Later…" offers Later today (after the other blocks), Tomorrow, or Skip today, each with what it does to the exam the block is for ("Erdkunde stays on track", "goes from on track to tight"). Homework due tomorrow morning can't move to tomorrow.
- **Today on the clock**: school, the free hour after it, each block at its time, breaks, "Done for today", and the nightly run.
- **Beside it**: the exams ahead (how ready, prep blocks planned), quick answers, and last night's grading in one line.
- **Opening a block** shows its quest, as before. When every part is handed in, it offers the next block.
- Earlier blocks are below, folded, with their grades and feedback.

**Quick answers** (`src/plan/questions.ts`): the organization agent's open questions about courses, those of the course with the nearest exam first. Now shows two, each with its own box; an answer goes to the StudyDesk chat as the student's message, which records it and ticks the to-do item. "N more can wait" links to the full list. The chat itself only brings up the two most important questions by itself, not every one.

## Week

Four weeks of exams, from the same plan:

- **This week** in numbers (minutes planned against what the study goal leaves), whether all exams fit, and the tightest spot (two exams on one day, or the exam that's furthest behind).
- **The run-up per course**: one row per course with an exam, a column per day, a mark for each block (exam prep, homework, placement check) and for the exam day, how ready the student is, and the minutes planned per day.
- **This week, day by day**: school and appointments, each block at its time, and the days off.

## Courses and Tell StudyDesk

- **Courses** is the semester, a card per course, all dates (each with "Wrong?"), study time and files, as the right side of the old Organize page showed them. The setup sheet and the to-do list open from there.
- **Tell StudyDesk** opens the StudyDesk chat (the Orchestrator) as a panel over every screen (Ctrl/⌘ J), expandable to a full window. Its badge counts what needs the student. The Organize page is gone: the chat and the data each have their own place.

## Moving and skipping blocks

| The student picks | What's stored | What happens |
| --- | --- | --- |
| Later today | In this browser only, for today | The block goes after the others today |
| Tomorrow | `deferredTo` on the block's quest (placement parts: `partsNotBefore`) | It shows tomorrow; today's plan doesn't give its course another block |
| Skip today | `skippedOn` on the quest | It's gone from today; its exam is planned again from the remaining days |

Every block also records the day each part was handed in (`handedInOn`), so today's plan keeps what's done today, with its tick.

## At night

The nightly run plans tomorrow with the same code and writes every block's quest in one round ([scheduled-runs.md](scheduled-runs.md)). Placement parts need no writing. When tomorrow already has blocks, nothing is written again.

## Not in this version (next steps)

- Dragging a block to another time or day on Week.
- A reminder a few minutes before a block (Now shows the time; nothing notifies yet).
- Learning when the student actually starts in the afternoon, instead of a fixed free hour after school.
- A block shorter than planned ("I only have 10 minutes").

## Code

- `src/plan/day.ts`: the day plan (which course, how long, why), the exams' status. Tests: `tests/dayplan.test.ts`.
- `src/plan/clock.ts`: busy and free time, placing blocks. `src/plan/today.ts`: today on the clock, what's now, what moved.
- `src/plan/build.ts`: a block to a quest. `src/plan/questions.ts`: which open questions come first.
- `src/now/parts.tsx`: the pieces of Now. `src/now/WeekPage.tsx`: Week. `src/quests/QuestPage.tsx`: Now's data, writing the blocks, an opened block.
- Tunable numbers: `DAY_PLAN` (day.ts), `CLOCK` (clock.ts), `QUESTIONS` (questions.ts).
