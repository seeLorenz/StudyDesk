# Start New Semester (onboarding)

How a student sets up a semester in StudyDesk: what they're asked, what happens behind the scenes, and what data comes out. The records it produces are the ones [grading-and-mastery.md](grading-and-mastery.md) expects.

## The idea in short

Setting up a semester is one chat with the Orchestrator. The student talks, pastes and drops files. A semester sheet beside the chat fills in as they go, and they can correct it at any time. At the end the heavy work goes to a setup session, and the student gets a first quest that shows where they stand.

- **The student** gives three things: who they are (asked once, kept across semesters), their courses with a target grade each, and how much time they want to study. Course materials are welcome but optional.
- **The Orchestrator** asks, reads whatever is dropped in, and fills the semester sheet.
- **The organization agent** runs in a setup session. It reads the raw course files carefully once, maps which pages cover which topics, and writes skills, grade rules, key dates and the material catalog.
- **App code** builds the first quest, a placement check.

Setup counts as done when there is at least one course with a target grade and a daily study goal. Everything else can be added later through the Orchestrator, so nobody gets stuck in setup.

## Two rules behind the design

**StudyDesk is a carrier for Claude sessions.** The page collects input, shows results, and launches Claude sessions with everything they need already filled in, so the student never retypes context. Heavy or connected work (reading a semester of files, searching the web, reading a calendar or Drive) happens in those sessions, which write their results back into StudyDesk. This is how the first prototype worked too. The page's own limits (no internet, nothing runs while it's closed, small records) don't limit what StudyDesk can do.

**Every student has their own StudyDesk.** Each student runs a fully independent copy: their own data, their own files, their own Claude sessions on their own account. Nothing is shared and there's no communication between students' desks.

## The flow, as the student sees it

Every step has "skip, add later", and progress is saved after each answer, so the student can close the page and come back.

1. **Welcome.** A new student sees clearly that StudyDesk needs a short setup before it can do anything, and the Orchestrator starts it. A returning student sees a "Start New Semester" button (or just tells the Orchestrator), plus an option to export and save last semester's data first.
2. **About you** (first time only, then prefilled). School or university, country (sets the grade scale, for example Austrian 1 to 5), program or school type and year. Program and year tell the organization agent which fundamentals matter.
3. **Your courses.** "Drop your timetable, a screenshot of your course list, or just type them." The Orchestrator pulls out course names, lecture times and credits and lists them in the sheet. The student fixes names, removes what they don't want tracked, and adds what's missing.
4. **Each course, one at a time.** Target grade (required). Then optional: how the course is graded, known exam and hand-in dates, and materials. Materials are asked for in order of value: the syllabus or course overview first, then homework sheets, past exams and slides. Dropping many files at once is fine.
5. **Your time.** A first study goal per weekday (for example 3 h Monday to Friday, 4 h Saturday, Sunday off), with lectures from step 3 already subtracted and shown. Other fixed commitments (job, sport) can come as a screenshot, typed, or from the calendar. This goal is a starting point; step 7 recommends a real one.
6. **Check and start.** The sheet shows everything in one view. The student confirms, and the page launches the setup session, which reports progress per course ("Analysis 1: read the syllabus, found 9 topics and 41 skills"). The student can close the page meanwhile. When it's done, StudyDesk shows the important dates it found and recommends double-checking them, with a note: "If anything turns out different later, just tell me and I'll fix it."
7. **First quest: a placement check.** It covers the fundamentals plus the topics already taught (a student often starts mid-semester), so it finds out how far the student actually is. From the results, the Orchestrator recommends a daily workload for reaching each target grade, and the student accepts it or changes it.

A returning student goes through the same steps with step 2 prefilled. Last semester is archived, and every skill they mastered is kept as prior knowledge.

## The setup session

The setup session is a Claude session the page launches with the confirmed semester sheet and the uploaded files. It has none of the page's limits.

- **Reads raw files carefully, once.** For each file it records which pages or lines cover which topic and skill. That map is the material catalog. Later, quests and grading read only the lines they need from the real file, not a summary, so everything stays grounded in the actual course material. Because everything later depends on this map, the first pass must be thorough.
- **Keeps the original files** in the student's own StudyDesk. Reading is cheap afterwards because only the referenced pages are opened.
- **Fills gaps.** If a course has no material, it searches the web for the course (syllabus, module description, typical content for that program) and asks the student whatever it still can't find, through the Orchestrator.
- **Writes back** topics, skills (with fundamentals, tiers and difficulty), grade rules, key dates and the material catalog, the records the grading spec defines.
- **Reports progress** per course, so the page can show it whenever it's open.

If a fact the student said and a file disagree, the student's word wins and the conflict is shown in step 6.

## What onboarding hands over

Onboarding writes the raw facts the student gave. The setup session turns them into the records the grading spec already defines. Onboarding never writes skills or grade rules itself.

**Written during onboarding**

| Record | Key fields | Notes |
| --- | --- | --- |
| Profile (kept across semesters) | `level` (school, university), `country`, `gradeScale`, `program`, `year` | Asked once, editable later through the Orchestrator |
| Semester | `id`, `name` ("WS 2026/27"), `startDate`, `endDate`, `status` (setting up, active, archived), `setupStep` | `setupStep` lets the flow resume where it stopped |
| Course | `id`, `semesterId`, `name`, `short`, `credits`, `teachingLanguage`, `setupStatus` (waiting, reading, ready, needs check) | One per tracked course |
| Course target | `courseId`, `targetGrade`, `gradeScale` | Same record as in the grading spec |
| Weekly timetable | `weekday`, `start`, `end`, `kind` (lecture, exercise, fixed), `title`, `courseId` or none | Lectures and fixed commitments; feeds "free time" in quest sizing |
| Study goal | minutes per weekday, `source` (student, recommended) | Quest budget = goal minus timetable, as the grading spec says |
| Upload | `id`, `courseId` or unsorted, `fileName`, `type`, `studentNote`, `addedAt`, `cataloguedAt` | The original file. `studentNote` keeps what the student said about it ("last year's exam") |
| Student facts | `courseId`, `text`, `addedAt` | Things said in chat, such as "the exam is on 28 Jan" or "homework counts 40%". Passed on word for word |

**Written by the setup session** (the organization agent's own design comes later): topics, skills, grade rules, key dates, and the material catalog, which points each skill to a file and its pages or lines.

## The placement check

App code builds the first quest from what the setup session wrote.

- It includes the fundamentals the organization agent tagged for the student's program and courses, minus those mastered in earlier semesters, and a few problems from each topic already taught.
- One short problem per skill, no gate, so a gap doesn't stop the check.
- A skill solved in the check counts as mastered at once. This is the one exception to the streak rule, as the grading spec's "Fundamentals" decision says. A miss starts the skill as learning and puts it near the front of the next quests.
- The results give a starting mastery per course. Together with the student's measured speed, that drives the recommended daily workload in step 7.

## Language

The app itself stays in English. Explanations and quests use each course's teaching language, because learning a course in a different language than its exam is a disadvantage. The setup session guesses it from the materials, and the student can change it by telling the Orchestrator.

## Notes for the other modules

- **Orchestrator:** handles every later change: new courses, corrected dates or grade rules, a different study goal, a course's teaching language. It launches the setup session again for a course when new material arrives.
- **Organization agent:** its full design (how it builds skills, how carefully it maps pages, how it searches the web) is its own module. Onboarding only depends on the records listed above.
- **Grading and quests:** the placement check is a normal quest record with `part: check` problems, so grading needs nothing new.

## First version (built)

The flow lives in `src/onboarding/`. A new student lands in it automatically; a returning student opens it from **Start New Semester** in the sidebar.

**How it works now**

- **One chat with the Orchestrator, the semester sheet beside it.** The chat opens with a short welcome and asks the questions itself (`agent.ts`). Claude keeps the sheet up to date with one page tool, `update_sheet`, in the same reply it answers in: profile, semester name and dates, courses and target grades, weekly slots, facts said word for word, which file belongs to which course, and the study goal. The student can edit every field of the sheet by hand, and Claude sees the current sheet with every message. Nothing is a built-in list: the grade scale and the semester's name and dates come from the conversation.
- **Every message takes anything.** Typed text, pasted screenshots (a timetable, a course list) and any number of files. Dropped files are kept at once (see below); Claude sees the start of each one and assigns it to its course with a note on what it is.
- **Google Calendar.** When the student agrees or asks, Claude calls `read_calendar`, which reads the student's own Google Calendar through their claude.ai connector (the artifact's `mcp` capability): repeating events of the next two weeks become weekly slots (lectures and exercises linked to their course, or fixed commitments), and exams in the next four months become facts of their course. After a calendar import, every quest is sized from that day's real calendar (`calendarSync`), with the weekly timetable as a floor for lectures not in the calendar.
- **Files are kept.** Each upload's readable content is saved in the student's own data (PDF text page by page with page markers, up to about 240,000 characters; images as a compressed copy), and the original file goes to the artifact's file store.
- **Starting.** When one course has a target grade and there's a study goal, Claude summarizes and asks; only on the student's yes it calls `start_setup`.
- **The setup run** (`setup.ts`) goes course by course: one careful read of all the course's files, and back come topics (taught or upcoming), skills with tiers, difficulty, time guesses and prerequisites, grade rules, exam dates, open homework with the task text word for word, and the material catalog (skill, file, pages or lines). Each course is saved as soon as it's done and the run resumes after a reload. Fundamentals mastered in earlier semesters keep their ids and history.
- **Live view of the run.** The agent writes a short work log first ("Reading F1 (Skript.pdf), p. 1-40: limits and sequences"), and the page shows it line by line as it streams, followed by what it is writing now and the topics and skills counted so far. The card shows only the course being read, the courses up next in one line, and the finished ones folded away. A course without files says plainly that it is an estimate from the course name, not the syllabus, and not looked up online.
- **After the run: a to-do list, not a wall of questions.** Each course asks at most 3 questions (only ones that change the skill map, dates or grading). Every request for files is merged into one item, "Add materials for N courses". The student works through the list one item at a time: "Answer in the chat" puts that item's questions into the setup chat, which stays open after setup and records answers as facts. Items are ticked off by hand. When answers or files changed a course, one button (or the chat, on the student's yes) re-reads just those courses; the placement check is kept. Dates, disagreements and per-course summaries sit folded under Details. Everything on this screen supports select-to-reply, including the live log.
- **Hand-off to cloud sessions** (`src/platform/handoff.ts`). When the student has Claude Code on the web, the setup run hands each course to its own Claude Code cloud session, all at once, started through the student's "Claude Code Remote" connector. Pages may only list environments, create a saved task and fire it; they can't read, tag or archive sessions. So the session reports back by itself: StudyDesk writes a job document into the student's own private data (`data/users/<uid>/job-<id>`), fires its saved task ("StudyDesk agent", one per student) with the course's full instructions plus the reporting rules, and the session writes its progress lines and its final answer (the same sections as the in-page run) into that document with its ArtifactData tool. The first session finds the student's StudyDesk by the job document and reports its address, which StudyDesk saves for later jobs. The page checks the document every 10 seconds, shows the log, saves the result and deletes the document. Sessions started by a saved task don't show up in the student's regular session list. A job nobody picks up within 15 minutes, or that stops reporting for 40, falls back to the page, as do courses with images or more file text than one job holds (about 45,000 characters).
- **Turning it on.** Above the setup chat a card explains why cloud sessions help and walks through turning on Claude Code on the web (open claude.ai/code, then "Check again" and allow the connector), or says plainly when the plan doesn't allow it. "Not now" sets up in the page. The chat reminds once before starting.
- **Models.** Every Claude call in StudyDesk asks for Opus (`MODEL` in `src/platform/claude.ts`); where the viewer's plan or app can't run it, the most capable tier answers instead and the setup card says so.
- **Pacing.** Claude in the page runs only a couple of calls at once and refuses a flood, so quests (and the placement check) are written at most two parts at a time; when one part fails, the parts already written are kept and a retry carries on from there.
- **Placement check** (`placement.ts`): per course, up to 6 fundamentals (those most skills build on first) and 2 skills per taught topic, at most 30 problems, written in each course's language. Answers count as "check" attempts; a clean solve masters the skill at once (solve points, no mastery bonus). Misses aren't put into the mistake review: the next quests teach them.
- **Recommended workload:** once the placement check is graded, the quest page shows skills left per course, until when, and the quest minutes per study day that takes (remaining clean solves at the measured speed, a short lesson per new skill, plus 25% for reviews), turned into a study goal per weekday. The student accepts, edits or keeps their own.
- **A returning student** gets a welcome back, the profile kept, an export of last semester in the sheet, and the old semester archived when the new one is saved.

**Not in this version (next steps)**

- Without Claude Code on the web, the setup run happens inside the page (it must stay open; it resumes if closed) and can't search the web.
- Not yet tested end to end in claude.ai: whether a page may start sessions is checked by the probe page first.
- A PDF without selectable text (a scan) can't be read; the student is asked for photos instead.

## Notes for other modules (from the build)

- **Organization agent:** replace the prompt in `src/onboarding/setup.ts` with its own design and run it in a launched Claude session that writes back the same records (`CourseSetup` in `src/onboarding/types.ts`), with web search for courses without materials and files longer than one reading.
- **Orchestrator:** the setup chat (`src/onboarding/agent.ts`) is its first part. The same page-tool pattern (sheet in the prompt, one tool to change it) should carry over to later changes: new course, corrected date, teaching language, study goal.
- **Quests:** should read the material catalog to open only the referenced pages of the original file when writing lessons and practice. Not used yet.

## Starting the next semester (built)

Opening Start New Semester while a semester is active asks "Are you sure?" first (and says so when the semester's end date is still ahead). Then:

1. **Backup.** StudyDesk saves one zip: every original file the student imported, by course, plus `studydesk-data.json` with everything it keeps for them (profile, semester and setup with chat and to-do list, archived semesters, quests with answers and reviews, Ask chats, mastery and stats). `src/platform/backup.ts`.
2. **Keep or start fresh.** Only once the zip is saved, the student chooses. "Keep old data" (the default) starts the new setup and archives the old semester when the new one is saved; current quests keep working until then. "Delete old data and start fresh" (two clicks) deletes courses and semester, setup chat and to-do list, quests, imported files and archived semesters, and keeps mastery, stats and profile; Ask chats only if the student ticks the box. If the download is declined, nothing can be deleted.
