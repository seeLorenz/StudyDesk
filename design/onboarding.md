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
