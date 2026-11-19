# StudyDesk system design

This folder explains how StudyDesk works, in plain English. It's meant for anyone who wants to understand the idea before reading code. Each file covers one module, and modules are designed one at a time.

| File | Module | Status |
| --- | --- | --- |
| [grading-and-mastery.md](grading-and-mastery.md) | How answers are judged, how mastery is measured, reviews, timing, points | Spec drafted |
| [quest-creation.md](quest-creation.md) | What a daily quest looks like and how it's stored | Example drafted |

Modules still to come: Start New Semester onboarding, the Orchestrator agent, and the organization agent. Notes for them are collected at the end of the grading file.

## The big picture

StudyDesk gives each student a daily **quest**: a short, timed set of explanations and problems chosen around their upcoming exams and real homework. Three agents work behind it:

- **The Orchestrator** is the only agent the student talks to. It passes changes such as new homework, exams or classes on to the others.
- **The organization agent** works in the background. It reads course materials, works out what each course requires, keeps key dates, and sets targets.
- **The grading agent** judges each handed-in quest. It has no memory and only returns a verdict per problem.

The rule that ties them together: **agents judge, code counts.** Claude writes problems and decides whether an answer shows understanding. Plain app code keeps every streak, review date, mastery number and time estimate, so the same attempts always give the same result and the logic can be tested.
