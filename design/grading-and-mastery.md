# Grading and mastery

How StudyDesk decides what a student knows, when a skill comes back for review, how long work takes, and what points mean.

## The idea in short

Mastery means being able to solve a kind of problem consistently, measured against what the course requires for the grade the student is aiming for. Students build it through daily quests, and each quest is checked by a grading agent.

- **Quests** are StudyDesk's own daily assignments, chosen by what matters now: upcoming exams, real homework that is due, weak spots and reviews.
- **The grading agent** scores each handed-in quest and records the result per kind of problem. It has no memory.
- **A streak** of correct solves on one kind of problem means it's mastered. After that it comes back less and less often, and harder kinds come back more often.
- **The organization agent** works out what each course requires and how results turn into grades. The student never talks to it directly.
- **The Orchestrator** is the only agent the student talks to.

## Lessons from the first version

An earlier prototype had strong teaching (first-principles explanations, a Socratic tutor, a mistake log) but the planning around it failed:

- Daily plans were sized to fill a fixed number of hours, not to what the student actually finished, so unfinished work piled up and testers stopped using it.
- Time per task was guessed and never measured, so estimates never improved and were often 3 to 4 times too short.
- One huge prompt did organizing, planning and the mastery math at once, so nothing was predictable or testable.

| Keep | Change |
| --- | --- |
| The explanation style: beginner questions as headings, numbers first, the tricky step done slowly, a checklist at the end | One giant prompt: split into organization agent, quest builder, problem writer and grading agent |
| Self-contained tasks at three difficulty levels | Mastery math done by Claude: move it into code |
| The mistake log, where two correct in a row closes a mistake (the seed of the streak idea) | Guessed minutes: add a timer and learn from real times |
| Re-checks with fresh numbers, so they test understanding and not memory | Plans sized to fill fixed hours: size them to what was actually finished recently |
| A tutor chat that ends with one check question | Personal details hard-coded in prompts: get them from onboarding |
| No full solutions to graded homework; facts only from sources it has read | Reorganizing every morning: only when something changes |

## Words we use

| Word | Meaning | Example |
| --- | --- | --- |
| Course | One class the student takes this semester | Analysis 1 |
| Topic | A chapter or unit of a course; groups skills for display | Derivatives |
| Skill | One kind of problem. The unit of mastery, the thing a streak counts | Differentiate with the chain rule |
| Fundamental | A skill from earlier schooling that other skills depend on; tested early and fixed first | Quadratic formula, binomial formulas |
| Requirement | What the course expects: the skills, the level for each, the grade rules | Chain rule needed for exam 1, worth 20% |
| Quest | One day's set of work that StudyDesk assigns, sized to the student's time | 6 problems, about 40 minutes |
| Problem | One item inside a quest, tied to one skill, with a difficulty and an expected time | Differentiate sin(x²) |
| Attempt | One submitted answer: verdict, points, time taken. Never edited afterwards | Correct, 4 of 5 points, 7 min |
| Streak | Correct attempts in a row on one skill | 3 in a row |
| Review | A later return of a mastered skill to check it stuck | Comes back in 7 days |
| Mastery | Share of the required skills the student has mastered, per topic and per course | 12 of 20 skills, 60% |
| Grade | The real result from school, kept apart from mastery | 2.3 on exam 1 |

## Main design choices

1. **Agents judge, code counts.** The grading agent marks each problem and names the likely blocker. Streaks, review dates, mastery and time estimates are computed by app code from stored attempts.
2. **Skills are the unit of mastery.** The organization agent turns course materials into a list of skills per topic, each with a required level, a streak target and links to the fundamentals it depends on.
3. **A fixed review ladder first, tuned later.** A smarter scheduler (for example FSRS) can replace it later without touching anything else.
4. **Measure time instead of guessing it.** Every problem is timed, and estimates come from the student's own past times.
5. **Size quests to a daily budget and never let them go overdue.** Unfinished problems go quietly back into the pool.
6. **Fundamentals first.** The first quest after onboarding checks fundamentals. When a wrong answer points to a fundamental, it goes into the next quest ahead of everything else.
7. **Code chooses quest content, Claude writes it.** Each candidate skill is scored for being due for review, an exam on it soon, real homework due on it, being a blocker, or being new. The quest takes the top skills until the time budget is full.
8. **Quests are generated by a scheduled routine, with an in-page fallback.** A routine outside the page builds each day's quest from the schedule settings the organization agent writes. If no routine has run, the first open of the day builds it in the page.
9. **Points, grades and mastery stay separate.** Points motivate, grades are real school results, and mastery only counts streaks and reviews on skills.

## Decisions

| Topic | Decision | What it means for the design |
| --- | --- | --- |
| Streak success | Aim for 100%, but the grading agent judges whether the student understood. A slip (typo, input error) is not a real mistake | Three verdicts per problem: **solved**, **slip** (understood, small execution error) or **not understood**. Solved adds 1 to the streak, not understood resets it, a slip keeps it where it is |
| What "should know" means | Measured against the student's target grade | Each course stores a target grade. The organization agent maps each grade to the skills it needs |
| Daily time | Built from the student's calendar (if allowed) and a daily study goal | Quest time = daily goal minus lectures and fixed events. An 8 h goal with 3 lectures leaves about 2 h |
| Course materials | Read once by the organization agent | Two records per course: **key dates** (exams, usual due days) and a **material catalog** that points other agents to the right file and page. Expensive at the start of a semester, cheap afterwards |
| Real homework | Quests prepare the student and then work through the actual homework with them | A quest is a sequence of parts: **learn**, **practice** and **assignment** (the real homework task), for example learn, practice, learn, assignment |
| Points | Addictive, but honest | Points only come from verified progress and are always shown next to progress toward the target grade |
| Fundamentals | Specific to each student and major | The first quest after onboarding is a fundamentals check. Fundamentals the student already knows are marked mastered and skipped |
| Harder problems | Come back more often | A hard skill uses a ladder with shorter gaps and one extra early step |
| Reviewing errors | Slips aren't punished, but every error is reviewed with the student, right after hand-in or the next morning | A slip only counts once the student confirms it ("You wrote the formula right and entered a wrong number. Am I right?"). If they say no, it becomes a real error. Real errors go to a review chat that breaks them down to first principles. A "Review mistakes" slot in the calendar links straight to it |
| Help on real homework | Claude guides, the student writes every answer | After 2 or 3 hints, Claude fully solves a similar problem with different numbers (no streak credit). Before the homework is handed in to school, the correction shows only the first wrong step. The full answer comes once it's handed in or the due date has passed |

# Spec

## Records

The attempt log is the only source of truth. Every other number (streaks, review dates, mastery, time estimates, points) is computed from it by code and can be rebuilt at any time.

| Record | Written by | Key fields |
| --- | --- | --- |
| Skill | Organization agent | `id`, `courseId`, `topicId`, `name`, `difficulty` (normal or hard), `isFundamental`, `prereqSkillIds[]`, `tier` (lowest target grade that needs it), `weight` (how much it counts for the exam), `streakTarget` (default 3), `estMinutes` (first guess per problem) |
| Course target | Onboarding or Orchestrator | `courseId`, `targetGrade`, `gradeScale` |
| Attempt | App code, from the grading agent's verdict | `id`, `skillId`, `questId`, `part` (practice, assignment, review, check, assessment), `day`, `verdict` (solved, slip, not understood), `points`, `maxPoints`, `hintsUsed`, `sawWorkedExample`, `activeSeconds`, `startedAt`, `gradedAt` |
| Review item | App code | `attemptId`, `kind` (slip or real error), `status` (open, answered, talked through, resolved), `slipAnswer` (confirmed, disputed, or not answered yet), `slipQuestion`, `chatId` |
| Skill state | App code (a cache, rebuilt from attempts) | `skillId`, `stage` (new, learning, mastered, lapsed), `streak`, `ladderStep`, `dueAt`, `lapses`, `fastTrackFrom` (day of a first-sight clean solve while every attempt since was clean), `medianSeconds` |
| Assessment result | Student, through the Orchestrator | `assessmentId`, `courseId`, `component`, `points`, `maxPoints`, `date` |

Attempts are never edited. The student's answer to a slip question is stored on the review item, and the skill state is recomputed.

Code: the rules live in `src/mastery/` (tunable numbers in `config.ts`), storage in `src/platform/masteryStore.ts`, and the worked example below is the first test in `tests/mastery.test.ts`.

## Grading agent

The grading agent judges one handed-in quest and returns plain data. It has no memory, so everything it needs is in the call, and it never sees streaks or mastery.

**It receives**, per problem: the prompt, the answer key or rubric, the skill name and its fundamentals, the student's answer (text, photos or files), how many hints they used, and whether this is real homework not yet handed in to school.

**Every photo reaches the grader.** One question to Claude can carry only so many images (the view says how many). A hand-in with more photos than that is graded in several calls, problems kept together with their photos. Photos are never left out to make a call fit: a problem graded without its photo could be marked wrong. A single answer with more photos than one call allows fails visibly, so the student can hand in fewer.

**It returns**, per problem:

```json
{
  "problemId": "q_81",
  "verdict": "solved | slip | not_understood",
  "points": 4,
  "maxPoints": 5,
  "firstWrongStep": "Line 3: chain rule applied, but 2·3 written as 5",
  "errorKind": "none | slip | concept | missing_fundamental",
  "fundamentalSkillId": null,
  "slipQuestion": "You set up the chain rule correctly but wrote 2·3 = 5. Was that just a typo?",
  "feedback": "2 to 5 sentences: what is right, the first wrong step, the principle behind it"
}
```

- **slip** means the method is right and only an execution detail is wrong. It always comes with a `slipQuestion` for the student to confirm.
- **missing_fundamental** names the fundamental skill that caused the error, so the next quest can fix it first.
- For real homework not yet handed in, `feedback` points to the first wrong step and leaves out the full answer.
- The app checks the output before storing it. An unknown verdict, points above the maximum, or a slip without `slipQuestion` is rejected and the call is retried once.

## Streaks and the review ladder

A skill is mastered after `streakTarget` clean solves (default 3) on different days. After that it climbs a review ladder, and a real miss sends it back to learning.

**Fast track for skills the student already knows.** Solving a skill clean on first sight does not count as mastered on its own: it could be luck or short-term memory. But if the very first attempt is a clean solve, the skill comes back after 3 days instead of the next day, and a second clean solve then masters it (with the usual mastery bonus). The track closes for good on anything that isn't a clean solve (hints, a worked example, a slip, a miss); from then on the normal streak target applies. Extra clean solves in between don't break it, and two clean solves less than 3 days apart simply count toward the normal streak. A skill relearned after a lapse never takes the fast track. The 2 solves and the 3-day gap live in the config (`fastTrack`).

**Placement check exception.** In the fundamentals check right after onboarding, a skill solved on first sight counts as mastered at once (no mastery bonus, only its solve points).

Skill stages: **new → learning → mastered → retained**, with **lapsed** as the one way back (a mastered skill that was not understood on review returns to learning).

**How each result changes the streak**

| Result | Streak | Review ladder |
| --- | --- | --- |
| Solved, no hints | +1, at most once per skill per day | Mastered skill: up one step |
| Solved with hints or after a worked example | Unchanged | Unchanged, comes back at the same step |
| Slip, confirmed by the student | Unchanged | Unchanged |
| Slip, disputed by the student | Treated as not understood | Treated as not understood |
| Not understood | Back to 0 | Mastered skill lapses: back to learning, and after it's mastered again it restarts 2 steps lower (never below step 1) |

The once-per-day limit makes sure a streak means "can still do it tomorrow", not "remembered the last problem".

**Review ladder** (days until the next review). Gaps roughly double each step, as in standard spaced repetition: forgetting is fastest right after learning, so the first gap is short. Hard skills get shorter gaps and one extra step. A semester is about 15 weeks, so the ladder stops at 35 days and exams take over from there.

| Difficulty | Step 1 | Step 2 | Step 3 | Step 4 | Step 5 | After that |
| --- | --- | --- | --- | --- | --- | --- |
| Normal | 3 | 7 | 16 | 35 | | Retained: one check before its exam |
| Hard | 2 | 4 | 8 | 16 | 35 | Retained: one check before its exam |

- While a skill is still learning, it comes back the next study day until the streak target is reached. The one exception is a first-sight clean solve, which comes back after 3 days (the fast track).
- A retained skill gets one check in the 7 days before any exam that covers it.
- The ladder values live in one config table, so they can be tuned after testing without touching anything else.

## Mastery toward the target grade

Course mastery is the weighted share of the skills the target grade needs that the student can do right now. Skills the target grade doesn't need are shown but don't count.

```
mastery = sum(weight × credit) / sum(weight)    over skills whose tier is at or below the target grade
```

| Skill state | Credit |
| --- | --- |
| New | 0 |
| Learning or lapsed | 0.5 × streak ÷ streakTarget |
| Mastered, review not overdue | 1 |
| Mastered, review overdue | 0.75 |
| Retained | 1 |

- The screen shows the percentage, the count ("14 of 20 skills for a 2") and the next exam's skills that aren't mastered yet.
- Topic mastery uses the same formula over that topic's skills.
- Changing the target grade only changes which skills count, so the number moves at once.
- An overdue review lowers the credit a little instead of to zero, so missing one day doesn't wipe out progress.

## Measuring time and sizing quests

Every problem is timed, and every estimate comes from the student's own times. Quests are sized to what the student actually finished recently, so they can't pile up.

**Timing.** A problem's timer runs while it is the problem in view of the open part (or the one being typed in) and stops when the part is handed in or closed. It has a pause button, and time the tab spends hidden beyond 2 minutes isn't counted. Only active time is stored (`activeSeconds`). Lesson reading is timed the same way; see quest-creation.md, "Realistic part times".

**Expected time per problem**

1. The student has done 3 or more problems on this skill: the median of their last 5.
2. Otherwise: the skill's `estMinutes` × the student's slowness factor.
3. Slowness factor = median of (actual ÷ estimate) over their last 20 problems. It starts at 2.0 and stays between 1 and 4.

**How much fits in a day**

1. Free time = daily study goal − lectures and fixed calendar events.
2. Recent pace = average active minutes (problems and reading) per day over the last 3 study days.
3. Quest budget = the smaller of 80% of free time and 1.2 × recent pace. A brand-new student has no pace yet, so it starts at 50% of free time.
4. Unfinished problems go back into the pool at the end of the day. Nothing is ever overdue.

**Getting faster.** Once a skill is mastered, its target time is `estMinutes`. Reviews show the student's median beside the target ("chain rule: 9 min, target 5 min"). Speed never affects the streak, so being slow is shown, never punished.

## Points and real grades

Points reward only verified progress, and they always sit next to the real picture: mastery toward the target grade and actual results.

| Event | Points |
| --- | --- |
| Problem solved without hints | 10, or 15 for a hard skill |
| Skill mastered | 50 |
| Review passed | 20 |
| Fundamental cleared in the first check | 10 |
| Day's quest finished | up to 25, scaled by the share of its problems solved (nothing right, no bonus) |
| Slip confirmed and reviewed | 5 |
| Solved with hints, time spent, problems opened | 0 |

- **Daily streak:** days in a row with the quest finished. A day with no quest because of the calendar doesn't break it.
- **Honesty guard:** points are never shown alone. The header shows points, course mastery, and for each course with an exam in the next 21 days, the skills still missing for it. If mastery for that exam is below 50%, a calm warning replaces the points animation.

**Real grades** come only from results the student enters. They're kept apart from mastery and never estimated by Claude.

- The organization agent writes each course's grade rules once: components with weights (for example exam 60%, homework 40%) and the scale (Austrian 1 to 5, German 1.0 to 5.0, percent, and so on).
- Code computes the current weighted result and what's still needed on the remaining components to reach the target grade.
- An entered exam result is also stored as one assessment attempt per covered skill. These count as evidence but never on their own mark a skill as mastered.

## Worked example

One hard skill, "differentiate with the chain rule", over 15 days, with streak target 3, the hard ladder (2, 4, 8, 16, 35 days) and `estMinutes` 5. Each row can be checked by hand against the rules above, and it becomes the first unit test.

| Day | What happened | Streak | State and credit | Next due | Points |
| --- | --- | --- | --- | --- | --- |
| 1 | Solved with 2 hints, then a second problem solved clean (14 min, 11 min) | 1 | Learning, 0.17 | Day 2 | 15 |
| 2 | Solved clean (9 min). A second clean solve the same day doesn't add to the streak | 2 | Learning, 0.33 | Day 3 | 30 |
| 3 | Wrote 2·3 = 5. The student confirms the slip | 2 | Learning, 0.33 | Day 4 | 5 |
| 4 | Solved clean | 3 | Mastered, 1 (ladder step 1) | Day 6 | 15 + 50 |
| 6 | Review passed | 3 | Mastered, 1 (step 2) | Day 10 | 20 |
| 10 | Review: forgot the inner derivative. Not understood | 0 | Lapsed, 0. Review chat goes into the calendar for day 11 | Day 11 | 0 |
| 11 to 13 | Review chat, then one clean solve per day | 3 | Mastered again, 1 (restarts at step 1: 2 below step 2, floored at 1) | Day 15 | 45 + 50 |

**Time:** the first estimate was 5 × 2.0 = 10 min. After the 14, 11 and 9 minute solves, the expected time is their median, 11 min. If this skill had weight 2 in a course with 10 required skills of total weight 20, mastering it on day 4 would raise course mastery by 2 × (1 − 0.33) ÷ 20 = 6.7 percentage points.

## Notes for the other modules

These came up here but belong to modules designed later.

- **Onboarding:** ask for the target grade per course and the daily study goal. Offer calendar access. After everything is imported, generate the first quest as a fundamentals check.
- **Orchestrator:** lets the student change the daily study goal and target grades, and passes new homework, exams and classes to the organization agent.
- **Organization agent:** builds the live timetable from the calendar, writes key dates and the material catalog per course, maps target grades to required skills, and sets each skill's difficulty and streak target. It also writes the schedule settings the quest routine reads, and puts a "Review mistakes" slot in the calendar that links to the review chat.
