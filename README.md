# StudyDesk

**Spend your time studying, not organizing.**

StudyDesk is an open-source study app that runs on your own [claude.ai](https://claude.ai) plan. It takes the organizing off your hands: what's due when, what to study today, and where in your course files to find it. You set up your semester once by chatting with it. After that, StudyDesk keeps track of dates, plans each day's work, grades it, and remembers what you've mastered.

It's built for high school and university students, for any subject and any school.

> **Status:** experimental. It's being tested by a small group of students. Expect rough edges, and keep a backup of your data (see [Your data](#your-data)).

<br>

## What it does

### Today

Your home screen.

- **A daily quest.** A short, timed set of explanations and problems, picked around your next exams and the homework that's actually due. It's sized to the study time you have that day, so nothing piles up.
- **Coming up.** Your exams, deadlines and homework for the next weeks, in one row. Something looks wrong? Press "Wrong?" and fix it in a sentence.
- **Mistake review.** After grading, the mistakes you made sit at the top, with a chat that walks you through them from first principles.

### Ask

A chat with Claude for anything you're stuck on. Paste or drop screenshots, PDFs and text files straight into it.

- **Select to reply.** Select any passage, press Reply, and ask about just that part. The answer opens right under it as a note, instead of making the chat longer. This works everywhere in StudyDesk: in chats, quests, hints and feedback.

### Organize

The one place to set things up and change them. It's a chat with StudyDesk's Orchestrator, with your semester beside it: courses, dates, study time and files.

- **Start a new semester** by talking: your courses, target grades, course files and timetable.
- **Import from Google Calendar**, through your own claude.ai Google Calendar connector.
- **Change anything later** in plain words: "the Calculus exam moved to the 14th", "here's the new homework sheet", "run grading at 21:30".

### Mastery

StudyDesk measures how well you know each skill, not just how much you've done.

- A skill counts as **mastered** when you've solved it correctly more than once, spread over several days.
- Mastered skills **come back later** (spaced repetition), harder ones more often.
- Wrong answers earn no points. Points only come from progress that's been checked.

### The nightly run

Every night at 22:00 (your time), StudyDesk does its work while you're away:

1. **Grades** what you handed in that day.
2. **Checks your courses** for moved dates and new material, and reads a course again completely every few weeks.
3. **Writes tomorrow's quest**, already knowing tonight's mistakes.

This needs Claude Code on the web (see [Setup](#setup)). Without it, StudyDesk still works: grading and quests happen the next time you open it.

<br>

## How it works

StudyDesk is a page that launches Claude for you, so you never have to retype context.

- **Claude does the thinking.** Reading your course files, working out what each course requires, writing problems and judging answers.
- **Code does the counting.** Streaks, review dates, mastery, points and time estimates are plain, tested code, so the same work always gives the same result.
- **Everything runs on your own Claude plan.** No API key, no server, no account with anyone but Anthropic. Every agent uses Claude Opus.
- **Your StudyDesk is yours alone.** Each student has their own copy, with their own data, files and Claude sessions. Nothing is shared between students.

The full design, in plain English, is in [`design/`](design/README.md).

<br>

## Setup

### What you need

- A paid Claude plan (Pro or higher).
- **Claude Code on the web** turned on, at [claude.ai/code](https://claude.ai/code). This is what runs the nightly run and reads your course files in the background.
- Optional: the **Google Calendar** connector in claude.ai, to import your timetable and exams.

### 1. Turn on Claude Code on the web

1. Open [claude.ai/code](https://claude.ai/code).
2. Finish its short first-time setup. StudyDesk needs one cloud environment there; the default one is fine.

### 2. Ask Claude to set up your StudyDesk

1. At [claude.ai/code](https://claude.ai/code), start a new session and paste:

   > Set up StudyDesk for me from github.com/seeLorenz/studydesk. Follow its INSTALL.md.

2. Claude builds StudyDesk and gives you a link. Say yes if it asks for permission to run its steps.
3. Open the link. That's your StudyDesk. Bookmark it, because it's where all your data lives.

You don't need to know any code. Claude reads the technical steps from [`INSTALL.md`](INSTALL.md).

### 3. Set up your semester

1. Open **Organize**. With no semester yet, it starts the setup chat.
2. When StudyDesk asks to **allow cloud sessions**, press the button and allow the "Claude Code Remote" connector when claude.ai asks. If it says Claude Code on the web isn't set up yet, finish step 1 and press "Check again".
3. Tell it about your courses and drop in your course files. If you like, let it import your Google Calendar.
4. StudyDesk reads every course in the background, then starts with a short **placement check** to see what you already know. Your first daily quest follows.

The nightly run is set up on its own once cloud sessions are allowed and the semester is ready. The sidebar shows whether it's on and at what time.

<br>

## Your data

- Your data lives **inside your StudyDesk artifact**: profile, semesters, quests, answers, mastery, chats and uploaded files.
- **Deleting the artifact deletes your data, for good.** If you delete it and set StudyDesk up again, you start with an empty desk. Only a backup brings your data back.
- **Back it up.** "Start a new semester" (in the ⋯ menu) first offers **Export everything**: one zip with all your files and data. You can cancel after exporting. Reading a zip back in isn't built yet, but it's planned.

<br>

## Updates

Releases are git tags (`v1`, `v1.1`, …). Changes on `main` never reach anyone's StudyDesk on their own.

**Planned, not built yet:** when a new release is out, StudyDesk will show "Update to v1.1" in Organize. Pressing it has your own Claude session put the new version onto your StudyDesk link, so your data stays, then checks and upgrades your data in code, with a way back if anything fails. The full plan is in [`design/updates.md`](design/updates.md).

Until then, you can update by asking Claude the same way as in setup: "Update my StudyDesk from github.com/seeLorenz/studydesk. Follow its INSTALL.md." Claude puts the new version onto your existing StudyDesk link, so your data stays.

<br>

## Problems and ideas

StudyDesk gets better with every student who uses it, so please tell us what you run into.

You'll need a free GitHub account to post.

- **Something broke or felt wrong?** [Report a problem](https://github.com/seeLorenz/studydesk/issues/new?template=bug.yml). A short form asks what you did and what happened. A screenshot helps a lot.
- **An idea to make it better?** [Share it](https://github.com/seeLorenz/studydesk/issues/new?template=idea.yml), even a small one. What would save you time?
- **Want to see what's already known?** Look through the [open issues](https://github.com/seeLorenz/studydesk/issues) and add a 👍 or a comment to the ones you care about.

Please leave out personal details (names, grades, school accounts). Everything posted there is public.

<br>

---

# For developers

Everything below is about the code. You don't need it to use StudyDesk.

Contributions are welcome: bug fixes, new ideas, or picking up an open issue. Open an issue first for anything big, so we can agree on the design before you build it.

## Develop

```sh
npm install
npm run dev        # local preview, with a stand-in for Claude
npm test           # unit tests
npm run build      # writes artifact/index.html and artifact/routine.mjs
```

`npm run build` bundles the app into one HTML file and strips the document skeleton, because the artifact host adds its own. It also builds `routine.mjs`, the dependency-free program the nightly run downloads and runs.

### Where things are

| Folder | What's in it |
| --- | --- |
| `design/` | How StudyDesk works, in plain English, one file per module. Start here. |
| `src/chat/` | Ask: the chat, select-to-reply notes and the composer |
| `src/quests/` | Daily quests: planning (code), writing (Claude), hand-in and the quest page |
| `src/mastery/` | Grading and mastery rules: streaks, review ladder, timing, points |
| `src/onboarding/` | Start New Semester: setup chat, course reading, placement check |
| `src/orchestrator/` | Organize: the Orchestrator chat and its tools |
| `src/routine/` | The nightly run: grading, course checks, tomorrow's quest |
| `src/platform/` | The only code that talks to claude.ai: Claude calls, storage, calendar, cloud sessions |
| `src/lib/` | Markdown and math rendering, highlights, file reading |
| `tests/` | Unit tests, including whole nights played with a stand-in session |
| `types/claude/` | Type definitions for the artifact runtime |

### Contributing

1. Read [`design/guidelines.md`](design/guidelines.md) and the design file of the module you're touching.
2. Fork the repo, make your change on a branch, and run `npm test`.
3. Open a pull request that says what changed and why. If it changes how a module works, update its file in `design/` in the same pull request.

The guidelines in short: Claude handles whatever varies by student, code handles the mechanics, every chat box accepts files and images, and modules are designed and built one at a time.

This repository is public. Never commit personal data, secrets or real student information.

## License

StudyDesk is open source under the [MIT License](LICENSE).
