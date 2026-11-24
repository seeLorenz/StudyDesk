# Courses

A new sidebar tab (**Courses**) where the student sees each course on its own: how far along they are, what's due, which skills it needs, and which files StudyDesk linked to it. It also takes everything "look and check" off the Organize page, so Organize is only for organizing. Agreed 2026-11-24; first version built.

## Why

Today a course is one card on Organize's right side. You can't click it, and nothing shows which files, topics or skills StudyDesk thinks belong to it. That makes the most important question hard to answer: **did StudyDesk understand my course right?** A wrong skill map or a file sorted into the wrong course quietly spoils every quest after it, so the student needs one place per course to check it.

At the same time Organize does two jobs: the chat where you change things, and a long page of semester data. The To do list, which is the part that actually needs the student, sits on a third screen (the setup page). Splitting by job fixes both:

| Place | Job | What's on it |
| --- | --- | --- |
| **Today** | Do the work | Unchanged |
| **Ask** | Understand something | Unchanged |
| **Courses** (new) | See what StudyDesk knows, and check it | The semester, one card per course, and a page per course |
| **Organize** | Change things, answer what StudyDesk needs | The Orchestrator chat on the left, **To do** on the right |

The rule that keeps this simple: **Courses only shows, Organize changes.** Nothing on Courses is edited in place. Every "this is wrong" goes to the Orchestrator, which stays the one agent that changes the desk (see [orchestrator.md](orchestrator.md)). Editing fields on the course page was the simpler-looking option and was rejected: it would give the desk a second way to change data that skips the Orchestrator's checks, its undo and its jobs for the organization agent (a new date may need new skills or a re-read).

## Courses tab (the list)

Top to bottom, the same page pattern as every screen (kicker, serif title, one line of context):

1. **Header.** Semester name, dates, number of courses, hours a week. The "Setup sheet" button moves here from Organize.
2. **Course cards**, one per course, as today: name, mastery bar and %, "x of y skills mastered · aiming for 2", open mistakes, the next exam or hand-in. **The whole card is clickable** and opens that course's page.
3. **All dates** (moved from Organize), each with "Wrong?".
4. **Study time** per weekday (moved from Organize).
5. **Files not sorted to a course**, if any, and the file store meter (moved from Organize). Files that belong to a course are listed on that course's page, not here.

## A course's page

Opened from its card; "← Courses" goes back. The header: kicker "Course", the name, then one line: credits · target grade · teaching language · mastery %.

The sections, in the order a student checks them:

**Progress.** The mastery bar against the target grade, open mistakes (a link to the mistake review on Today), and real results the student entered (assessments), if any.

**Dates.** This course's exams, quizzes and hand-ins: upcoming ones with a countdown, past ones folded away under "Earlier". Each hand-in shows how many tasks it has. Every date has "Wrong?".

**Topics and skills.** One line per topic with a small bar (skills mastered of skills needed), folded. Opening a topic lists its skills, each with a plain state:

- *Not started*, *Learning* (with its streak, "2 of 3 clean solves"), *Mastered*, *Due for review*, *Slipped* (a mastered skill that was missed and is being relearned).
- Skills the target grade doesn't need are greyed with "not needed for a 2". The student sees why StudyDesk doesn't practise them.
- Topics already taught when the semester was set up carry a small "taught" mark.
- Under each skill, where it's covered: "Blatt 3.pdf, p. 2". This comes from the material catalog the setup run already writes, so it costs nothing and shows the student that StudyDesk read the right material.

States come from the same replay the rest of the app uses ([grading-and-mastery.md](grading-and-mastery.md)); the page only names them. Agents judge, code counts.

**Timetable.** This course's weekly lectures and exercise classes.

**Files.** Every file StudyDesk linked to this course, grouped by the folder it had in its zip (folders start folded once there are more than a few files). One line per file: name, pages, and what StudyDesk did with it:

- *Read*, with "used for 12 skills" when the catalog points to it,
- *Not read yet* (in the course but not opened, often on purpose: old versions, solutions),
- *Scan, read by the agent*, or *Listed only* (videos, unknown formats).

**Files StudyDesk isn't sure about** come first, under "Not sure these belong here": files Claude put in this course with low confidence (an ambiguous name, a loose file without a folder, a zip that mixes courses). Each says why in a few words ("name fits Analysis and Linear Algebra") and has two buttons: "Belongs here" and "Wrong course?". "Belongs here" is one tap: the Orchestrator records it without a chat turn. "Wrong course?" opens the Organize chat with the file quoted. The same files are asked about in Organize too, as one To do item ("3 files StudyDesk isn't sure about"), so the student sees them whichever place they open first; answering in one place ticks off the other. Asking about every file was rejected: most files are obvious, and the student should only see the doubtful ones.

What the student said about a file ("last year's exam") shows under it. Clicking a file opens the original in a pop-out when it's kept, or its kept text otherwise. Each file has "Wrong course?". Showing *why* the agent skipped a file was considered and left out: those reasons live in the setup run's log, not on the file, and storing them per file would grow every course record for a rare question. The Orchestrator can answer "why didn't you read X?" from the log.

**What you told StudyDesk.** The facts the student gave about this course, word for word ("homework counts 20%"), so they can see they were heard.

## Fixing something

Every "Wrong?" and "Wrong course?" opens the Organize quick panel (Ctrl/⌘ J) with the item quoted, like Coming up does today. The student says what's right; the Orchestrator changes it.

The tab also follows the app-wide rules:

- **Docked box at the bottom**, like every screen: it's the Orchestrator's box, with a hint that names the course on a course page ("Tell StudyDesk what's wrong or new in Analysis 1"). Its answer opens in the quick panel. An Ask box was the other option; rejected because questions about the content are already covered by select-to-reply on every line, while this page's real follow-up is "that's wrong".
- **Select-to-reply** works on every line of both pages, as everywhere.
- **Phones**: Courses joins the bottom tab bar (Today, Ask, Courses, Organize). A course's page fills the screen with a back button; long sections fold.

## Organize after the change

- **Left:** the Orchestrator chat, unchanged.
- **Right:** the **To do** list, moved from the setup page. It already starts its items in the StudyDesk chat, so having the list right beside that chat removes a screen switch. Phones get a "Chat | To do" switch.
- The setup page keeps its chat and sheet for setting up a semester and for watching a course being read again ("Watch it live"). After setup it no longer has its own "To do | Semester" switch; "Setup sheet" on Courses still opens it.
- The badge rules don't change.

## What it needs

Everything shown already exists: courses, targets, skills, catalog, assignments, key dates, timetable and uploads in the semester; credits, facts, assessments and the to-do list in the setup record; skill states from the mastery replay. The only new thing saved is the doubt about a file: an optional `courseUnsure` on an upload, holding the short reason, cleared when the student answers. Optional fields need no data upgrade.

Code, roughly: `src/courses/CoursesPage.tsx` (the list, built from today's `DeskPanel`, which goes away) and `src/courses/CoursePage.tsx`; `App.tsx` gets the new place and tab; the To do list is lifted out of `OnboardingPage.tsx` so Organize can show it. `app-layout.md` is updated when this is built.

## Decided with Lorenz (2026-11-24)

- **Name:** "Courses" for every student, school or university, matching the rest of the app.
- **Sidebar order:** Today, Ask, Courses, with Organize staying apart at the bottom.

## Built with it (2026-11-24)

- **Setting the doubt:** the setup reading's file assignment (`update_sheet` files) takes an optional `unsure` reason and stores it as `courseUnsure`.
- **One Orchestrator change for files:** `set_file_course` moves a file or a whole zip to a course, or confirms it in the same one, and clears `courseUnsure`. "Belongs here" sends it without a chat turn; after a real move the Orchestrator starts a `new_material` job for the new course.

## Notes for other modules

- **Organization agent:** jobs and sweeps that assign files should set `courseUnsure` the same way when they aren't sure.
- **Date sources:** the note in [app-layout.md](app-layout.md) applies here too; once dates carry their source, the course page shows it next to each date.
