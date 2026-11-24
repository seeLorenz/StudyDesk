# Subjects

A new sidebar tab where the student sees each subject on its own: how far along they are, what's due, which skills it needs, and which files StudyDesk linked to it. It also takes everything "look and check" off the Organize page, so Organize is only for organizing. Proposed 2026-11-24; nothing here is built yet.

## Why

Today a course is one card on Organize's right side. You can't click it, and nothing shows which files, topics or skills StudyDesk thinks belong to it. That makes the most important question hard to answer: **did StudyDesk understand my course right?** A wrong skill map or a file sorted into the wrong course quietly spoils every quest after it, so the student needs one place per course to check it.

At the same time Organize does two jobs: the chat where you change things, and a long page of semester data. The To do list, which is the part that actually needs the student, sits on a third screen (the setup page). Splitting by job fixes both:

| Place | Job | What's on it |
| --- | --- | --- |
| **Today** | Do the work | Unchanged |
| **Ask** | Understand something | Unchanged |
| **Subjects** (new) | See what StudyDesk knows, and check it | The semester, one card per subject, and a page per subject |
| **Organize** | Change things, answer what StudyDesk needs | The Orchestrator chat on the left, **To do** on the right |

The rule that keeps this simple: **Subjects only shows, Organize changes.** Nothing on Subjects is edited in place. Every "this is wrong" goes to the Orchestrator, which stays the one agent that changes the desk (see [orchestrator.md](orchestrator.md)). Editing fields on the subject page was the simpler-looking option and was rejected: it would give the desk a second way to change data that skips the Orchestrator's checks, its undo and its jobs for the organization agent (a new date may need new skills or a re-read).

## Subjects tab (the list)

Top to bottom, the same page pattern as every screen (kicker, serif title, one line of context):

1. **Header.** Semester name, dates, number of subjects, hours a week. The "Setup sheet" button moves here from Organize.
2. **Subject cards**, one per course, as today: name, mastery bar and %, "x of y skills mastered · aiming for 2", open mistakes, the next exam or hand-in. **The whole card is clickable** and opens that subject's page.
3. **All dates** (moved from Organize), each with "Wrong?".
4. **Study time** per weekday (moved from Organize).
5. **Files not sorted to a subject**, if any, and the file store meter (moved from Organize). Files that belong to a course are listed on that course's page, not here.

## A subject's page

Opened from its card; "← Subjects" goes back. The header: kicker "Subject", the name, then one line: credits · target grade · teaching language · mastery %.

The sections, in the order a student checks them:

**Progress.** The mastery bar against the target grade, open mistakes (a link to the mistake review on Today), and real results the student entered (assessments), if any.

**Dates.** This subject's exams, quizzes and hand-ins: upcoming ones with a countdown, past ones folded away under "Earlier". Each hand-in shows how many tasks it has. Every date has "Wrong?".

**Topics and skills.** One line per topic with a small bar (skills mastered of skills needed), folded. Opening a topic lists its skills, each with a plain state:

- *Not started*, *Learning* (with its streak, "2 of 3 clean solves"), *Mastered*, *Due for review*, *Slipped* (a mastered skill that was missed and is being relearned).
- Skills the target grade doesn't need are greyed with "not needed for a 2". The student sees why StudyDesk doesn't practise them.
- Topics already taught when the semester was set up carry a small "taught" mark.
- Under each skill, where it's covered: "Blatt 3.pdf, p. 2". This comes from the material catalog the setup run already writes, so it costs nothing and shows the student that StudyDesk read the right material.

States come from the same replay the rest of the app uses ([grading-and-mastery.md](grading-and-mastery.md)); the page only names them. Agents judge, code counts.

**Timetable.** This subject's weekly lectures and exercise classes.

**Files.** Every file StudyDesk linked to this subject, grouped by the folder it had in its zip (folders start folded once there are more than a few files). One line per file: name, pages, and what StudyDesk did with it:

- *Read*, with "used for 12 skills" when the catalog points to it,
- *Not read yet* (in the course but not opened, often on purpose: old versions, solutions),
- *Scan, read by the agent*, or *Listed only* (videos, unknown formats).

What the student said about a file ("last year's exam") shows under it. Clicking a file opens the original in a pop-out when it's kept, or its kept text otherwise. Each file has "Wrong subject?". Showing *why* the agent skipped a file was considered and left out: those reasons live in the setup run's log, not on the file, and storing them per file would grow every course record for a rare question. The Orchestrator can answer "why didn't you read X?" from the log.

**What you told StudyDesk.** The facts the student gave about this subject, word for word ("homework counts 20%"), so they can see they were heard.

## Fixing something

Every "Wrong?" and "Wrong subject?" opens the Organize quick panel (Ctrl/⌘ J) with the item quoted, like Coming up does today. The student says what's right; the Orchestrator changes it.

The tab also follows the app-wide rules:

- **Docked box at the bottom**, like every screen: it's the Orchestrator's box, with a hint that names the subject on a subject page ("Tell StudyDesk what's wrong or new in Analysis 1"). Its answer opens in the quick panel. An Ask box was the other option; rejected because questions about the content are already covered by select-to-reply on every line, while this page's real follow-up is "that's wrong".
- **Select-to-reply** works on every line of both pages, as everywhere.
- **Phones**: Subjects joins the bottom tab bar (Today, Ask, Subjects, Organize). A subject's page fills the screen with a back button; long sections fold.

## Organize after the change

- **Left:** the Orchestrator chat, unchanged.
- **Right:** the **To do** list, moved from the setup page. It already starts its items in the StudyDesk chat, so having the list right beside that chat removes a screen switch. Phones get a "Chat | To do" switch.
- The setup page keeps its chat and sheet for setting up a semester and for watching a course being read again ("Watch it live"). After setup it no longer has its own "To do | Semester" switch; "Setup sheet" on Subjects still opens it.
- The badge rules don't change.

## What it needs (no new data)

Everything shown already exists: courses, targets, skills, catalog, assignments, key dates, timetable and uploads in the semester; credits, facts, assessments and the to-do list in the setup record; skill states from the mastery replay. Nothing new is saved, so there's no data upgrade.

Code, roughly: `src/subjects/SubjectsPage.tsx` (the list, built from today's `DeskPanel`, which goes away) and `src/subjects/CoursePage.tsx`; `App.tsx` gets the new place and tab; the To do list is lifted out of `OnboardingPage.tsx` so Organize can show it. `app-layout.md` is updated when this is built.

## Questions for Lorenz

1. **Name.** "Subjects" as you said, or follow the student's level: "Subjects" for school students, "Courses" for university ones? The rest of the app says "courses", and your desk is a university one. I lean towards following the level; it's one line of code and fits "nothing hardcoded".
2. **Order in the sidebar.** Today, Ask, Subjects, with Organize staying apart at the bottom? (Proposed.)

## Notes for other modules

- **Orchestrator:** "Wrong subject?" needs a `move_file` change (move an upload, or a whole zip, to another course, then start a job so the organization agent reads it for the new course). It doesn't exist yet.
- **Organization agent:** the date-source note in [app-layout.md](app-layout.md) applies here too; once dates carry their source, the subject page shows it next to each date.
