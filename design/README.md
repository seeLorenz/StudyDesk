# StudyDesk system design

This folder explains how StudyDesk works, in plain English. It's meant for anyone who wants to understand the idea before reading code. Each file covers one module, and modules are designed one at a time.

Start with [guidelines.md](guidelines.md): the design rules that apply to the whole app.

| File | Module | Status |
| --- | --- | --- |
| [grading-and-mastery.md](grading-and-mastery.md) | How answers are judged, how mastery is measured, reviews, timing, points | Spec drafted |
| [quest-creation.md](quest-creation.md) | What a daily quest looks like and how it's stored | First version built |
| [onboarding.md](onboarding.md) | Start New Semester: what the student is asked, the setup session, the placement check | First version built |
| [course-files.md](course-files.md) | Taking in course files and zips, and how the organization agent reads them by reason | First version built |
| [orchestrator.md](orchestrator.md) | The one agent the student talks to: questions, changes, jobs for the organization agent | First version built |
| [app-layout.md](app-layout.md) | How the screens fit together: Today, Ask, Organize, phone layout, notifications | First version built |
| [scheduled-runs.md](scheduled-runs.md) | The nightly run: grading at 22:00, the organization agent's checks and sweeps, tomorrow's quest | First version built |
| [updates.md](updates.md) | New versions without losing data: releases as tags, the Update button, backup, data upgrades, going back, import | Design drafted |

The organization agent's own work (setup reading, jobs, nightly checks and sweeps) is covered in onboarding.md, orchestrator.md and scheduled-runs.md.

## The big picture

StudyDesk gives each student a daily **quest**: a short, timed set of explanations and problems chosen around their upcoming exams and real homework. Three agents work behind it:

- **The Orchestrator** is the only agent the student talks to. It passes changes such as new homework, exams or classes on to the others.
- **The organization agent** works in the background. It reads course materials, works out what each course requires, keeps key dates, and sets targets.
- **The grading agent** judges each handed-in quest. It has no memory and only returns a verdict per problem.

The rule that ties them together: **agents judge, code counts.** Claude writes problems and decides whether an answer shows understanding. Plain app code keeps every streak, review date, mastery number and time estimate, so the same attempts always give the same result and the logic can be tested.
