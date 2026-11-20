# Quest creation

What a daily quest looks like, how it's stored, and what happens after the student hands it in. Grading rules come from [grading-and-mastery.md](grading-and-mastery.md).

## Shape of a quest

A quest is one day's work for one student, sized to the time they actually have. It's a sequence of parts:

- **Learn:** an explanation from first principles of what the student needs next.
- **Practice:** short problems on the fundamentals or the topic. A practice part can be a **gate**: if a problem in it isn't understood, the quest stops and offers a short fix-it first, because what follows can't work without it.
- **Assignment:** the real homework task, done by the student with guidance.

Typical shapes are "learn, assignment" or "learn, practice, learn, assignment".

## Example quest

A calculus course with a homework sheet due tomorrow, rebuilt in the new layout. Content is shortened here, and math is shown as plain text.

> **Tuesday · Calculus · about 55 minutes**
> Why today: Sheet 4 closes Wednesday 11:00, and tasks 4.2a and 4.2b need the ratio and root tests. Your time today: 2 h free after lectures. You've been finishing about 50 min a day, so this quest is 55 min.

**Part 1 · Learn: what does it mean for a series to converge?** (about 10 min)

Starts from zero: what a series is (adding infinitely many numbers), what "converges" means (the running total settles), and the geometric series Σ qⁿ = 1/(1 − q) for |q| < 1, with the first few partial sums written out. It ends with the key rule: if the terms don't shrink to 0, the series can't converge.

**Part 2 · Practice: the fundamentals 4.2 needs** (about 8 min, 2 problems, gate)

1. Simplify (n+1)!/n! and (2n+2)!/(2n)!. *Skill: simplify factorial quotients (fundamental).*
2. Find the limit of (2n+1)/(3n+5) as n grows, and say which power of n you divided by. *Skill: limits of rational expressions (fundamental).*

If either one is not understood, the quest stops here and offers a short fix-it before Part 3.

**Part 3 · Learn: two tests that compare with a geometric series** (about 8 min)

Why the ratio test works (each term is at most a fraction of the one before, so a geometric series is bigger), the same idea for the root test, and which one to pick: factorials mean ratio, a whole term to the n-th power means root. Two worked examples, Σ n²/3ⁿ and Σ ((2n+1)/(3n+5))ⁿ, and Σ 1/n against Σ 1/n² to show that a limit of 1 decides nothing.

**Part 4 · Assignment: Sheet 4, tasks 4.2a and 4.2b** (about 30 min)

- **4.2a** Decide convergence and absolute convergence of Σ (2n)! / (2ⁿ (n!)²).
- **4.2b** The same for Σ ((1+2n)/(3n+4n²))ⁿ.

The student solves both on paper the way they'd present them, and hands in a photo or typed answer. A hint button gives up to 3 hints per task, one at a time ("which test fits factorials?", "write the ratio as a product of short factors", "is the limit below, above or equal to 1?"). After 3 hints it offers a fully solved similar problem instead, Σ (n!)²/(2n)!, and then sends the student back to 4.2a. The solved similar problem gives no streak credit.

## The same quest as data

The quest builder stores one record per quest. Code picks the skills and the time, Claude writes the text inside each part, and every problem points to exactly one skill so grading knows what to count.

```json
{
  "id": "qst_2026-11-03_calc",
  "date": "2026-11-03",
  "courseId": "calc",
  "budgetMinutes": 60,
  "plannedMinutes": 56,
  "reason": "Sheet 4 closes Wed 11:00; 4.2a and 4.2b need the ratio and root tests",
  "parts": [
    { "kind": "learn", "title": "What does it mean for a series to converge?",
      "skillIds": ["sk_series-def"], "estMinutes": 10, "body": "markdown" },
    { "kind": "practice", "gate": true,
      "problems": [
        { "id": "p1", "skillId": "sk_factorial-quotients", "prompt": "markdown", "answerKey": "...", "expMinutes": 4 },
        { "id": "p2", "skillId": "sk_rational-limits", "prompt": "markdown", "answerKey": "...", "expMinutes": 4 } ] },
    { "kind": "learn", "title": "Two tests that compare with a geometric series",
      "skillIds": ["sk_ratio-test", "sk_root-test"], "estMinutes": 8, "body": "markdown" },
    { "kind": "assignment", "assignmentId": "calc-sheet4", "handedInToSchool": false,
      "problems": [
        { "id": "p3", "label": "4.2a", "skillId": "sk_ratio-test", "prompt": "markdown",
          "hints": ["...", "...", "..."], "similarSolved": "markdown", "expMinutes": 15 },
        { "id": "p4", "label": "4.2b", "skillId": "sk_root-test", "prompt": "markdown",
          "hints": ["...", "...", "..."], "similarSolved": "markdown", "expMinutes": 15 } ] }
  ]
}
```

- `gate: true` means the quest stops if a problem in that part is not understood, and offers a fix-it first.
- `expMinutes` comes from the timing rules in the grading spec, not from Claude.
- `handedInToSchool: false` tells grading to show only the first wrong step, not the full answer.

## After hand-in

The grading agent judges each problem, and code applies the rules from the grading spec. Times and answers below are illustrative.

| Problem | What was handed in | Verdict | Streak and points | What the student sees |
| --- | --- | --- | --- | --- |
| p1 factorials | (n+1) and (2n+2)(2n+1), 3 min | Solved | Factorial quotients +1, 10 points | "Right." |
| p2 limit | Divided by n correctly, then wrote 2/5 instead of 2/3, 5 min | Slip | Unchanged until the student answers | "You divided by n correctly but wrote 2/5. The limit is 2/3. Typo?" Yes: confirmed slip, 5 points. No: not understood, and a review chat is planned |
| p3 4.2a | Ratio (2n+1)/(n+1) → 2 > 1, so divergent; all terms positive, so not absolutely convergent either. 0 hints, 17 min | Solved | Ratio test +1, 10 points | "Correct and board-ready." The full worked answer is held back until Sheet 4 is handed in |
| p4 4.2b | n-th root → 0, so convergent; a verdict line was missing. 0 hints, 14 min | Solved | Root test +1, 10 points | "Right. For the board, add the one-line verdict: 0 < 1, so convergent by the root test" |

- Quest finished: +25 points. Total 60 (55 if the slip is disputed).
- Times feed the student's medians: ratio test 17 min and root test 14 min, against an estimate of 15 each.
- On Wednesday, the Sheet 4 hand-in passes, so the full worked answers for 4.2a and 4.2b unlock.

## Open questions

These will be settled once quests run in practice.

- **Shape:** are four parts and about 55 minutes right for one sitting?
- **The gate:** should a wrong fundamental stop the quest for a fix-it (current default), or carry on and just flag it?
- **Learn parts:** should each end with a one-minute check question?
- **One course per quest:** one quest per course per day, or one mixed quest across courses?
- **Hints:** are 3 hints and then a solved similar problem the right amount of help?

## First version (built)

The quest module is in `src/quests/` and the quest page is reachable from **Today's quest** in the sidebar. It's deliberately rough: the overall app layout comes later.

**How a quest is made**

1. **Code plans it** (`plan.ts`). Today's budget comes from the timing rules in the grading spec (study goal minus lectures, then 80% of that or 1.2 × recent pace, half of it for a new student). Then it fills the budget in this order:
   1. fundamentals a recent grading named as the cause of a mistake,
   2. homework due within 2 days, task by task; each task brings the fundamentals it needs (a gate), the concepts it builds on, and an explanation of its own skill if the student hasn't learned it yet,
   3. skills coming back today (still learning, lapsed, or due on the review ladder) as a short warm-up,
   4. homework due later in the week,
   5. if there's no homework at all, the next one or two new skills, those on the nearest exam first.
   A group is only added if it fits (10% over budget is allowed rather than splitting a task from what it needs). Urgent homework always gets at least one task. Anything left out is named, with a warning if the sheet is due tomorrow.
2. **Claude writes it** (`write.ts`). One call per part, in parallel: learn parts get the StudyDesk explanation style and what comes later in the quest; practice parts get one fresh problem and worked answer per skill; homework gets three hints, a worked answer and a solved similar problem. Replies use plain `=== SECTION ===` blocks instead of JSON (math breaks JSON), are checked, and retried once.
3. **The page** builds the quest on the first open of the day (the in-page fallback; the scheduled routine comes later).

**Working through it (layout, round 2).** The quest page is an overview with one row per part. Clicking a row expands the part; the student works through it and presses **Hand in** (or **Done reading** for a learn part). Hand-in only saves: the part collapses and its row gets a check mark. Graded parts show their points on the row. The only grading button is in the overview, at the bottom ("Grade me early", or "Submit for grading" once everything is in). Each problem has its own answer box (type, paste, drop or attach photos and files) and its own timer, which runs for one problem at a time and pauses after 2 minutes in the background. Select-to-reply works on every piece of quest text (explanations, problems, hints, feedback, worked answers); notes are saved with the quest. On open homework, a note guides without giving the answer.

Because grading now happens once, the gate no longer stops the quest mid-way. A missed fundamental is picked up by the next day's quest, which puts it first.

**Sample data.** Until Start New Semester exists, the page creates a sample semester (Calculus 1, Sheet 4 due tomorrow, Sheet 5 next week, a midterm in a month) with the same records onboarding will write. "Restart the sample semester" re-dates it to today. Outside claude.ai, a built-in stand-in writes and grades so the page can be clicked through.

**Defaults chosen for the open questions** (all in `src/quests/config.ts` or noted here, to be revisited after real use):

| Question | Default for now |
| --- | --- |
| Shape and length | Whatever fits the budget; for the sample's first day that's learn, practice (gate), learn, homework at about 59 min |
| The gate | With one grading run per quest, a missed fundamental goes first in the next day's quest instead of pausing today's (the fix-it code is kept for the grading window) |
| Check question after learn parts | Each lesson ends with "In one line: what's the key rule?"; the student writes it, then compares with Claude's one-liner (not graded) |
| One course per quest | One quest per day, for the course with the most urgent homework |
| Hints | 3 hints, then a solved similar problem (no streak credit for that problem) |
| Reviews | Placed first as a warm-up, after urgent homework in priority |
| Learn part time | 6 min plus 3 per skill, not scaled by the student's speed |
| Points per problem for grading | 2 per practice problem, the sheet's own points for homework |
| Photos of answers | A compressed copy (JPEG, one database document each) is saved with the quest, so photos are graded after a reload too |

## Note: how grading should work (decided 2026-11-20, not built yet)

- **Grading runs once per quest**, not per part. Handing in a part only saves it.
- **It runs automatically at 22:00.** Until that routine exists, the "Grade me early" button in the overview starts it by hand.
- **The button lives only in the quest overview**, nowhere else on the page.
- **Grading opens as its own window or quest**: the results, slip questions, and fix-its for real mistakes happen there, separate from the day's quest. Today's version still shows results inside each part as a stand-in.

## Round 3 changes (2026-11-20)

- **Short cycles instead of big blocks.** The goal is learning, so a quest teaches one idea at a time: a short explanation and a worked example (about 4 minutes to read), then a short problem of the student's own right away ("Learn & try"). Then the next idea. The real homework comes last. Fundamentals are a quick check at the start; skills coming back today are a warm-up before that. A lesson's own problem gets half of the skill's expected time, because it's smaller than a full task.
- **Finishing bonus only for real progress.** Up to 25 points, scaled by the share of the quest's problems solved. Nothing right means no bonus.
- **Mistake review.** Once a quest is graded and something went wrong, a "Mistake review" chat appears at the top of the quest page. It goes through the mistakes one at a time in the first version's tutor style: the student explains their step first, gets a first-principles explanation when stuck, then one fresh check question. Open homework gets hints only. Select-to-reply works in it like everywhere else.
- **Archive.** A graded quest, and any earlier day's quest, moves to "Done quests" below, collapsed, to keep the page clear.

## Round 4 changes (2026-11-20)

- **The mistake review closes the loop.** A mistake is resolved only when the student solves a fresh check problem completely on their own. An explanation, agreeing, or fixing the old answer with help is not enough; if the tutor gives a step of the check problem, a new one follows. Input errors never get here: a slip the student confirms as a typo keeps the streak at grading time. The tutor marks each judged check with a hidden `[[check:passed:ID]]` or `[[check:failed:ID]]`. Code then sets the review item to resolved and records one "review" attempt for the skill (counted once), so the streak can move again. The review card shows "N of M understood".
- **Photos survive reloads**: see the table above.
- **Key rule in one line** at the end of each lesson: see the table above.
- **"Too easy / just right / too hard"** on every part. The most recent rating per skill (last 14 days) goes into the prompts that write the next quests: too hard means slower, smaller steps and an easier own problem; too easy means brisker and harder.
- **Planned against actual time** on every row of the overview, from the problem timers ("9 of 12 min"). Reading time isn't timed.
- **Autosave**: every change to the work (answers, hints, key-rule lines, notes) is copied to this browser at once, and saved to the student's StudyDesk within 2 seconds, and immediately when the tab is hidden or closed. After a crash, the newer of the two is used, so at most the last keystrokes before a crash on a different device are lost.
- **Carry-over**: homework from an unfinished earlier quest comes back automatically (tasks only count as done when handed in), and the new quest says so ("Carried over from Thursday: 4.2b").

## Notes for other modules

- **Grading run at 22:00 (scheduled routine, outside the page):** reads every quest with handed-in, ungraded parts and grades them with the same `handIn` code. The page's "Grade me early" stays as the manual trigger. The grading results should open as their own window, with the mistake review in it.
- **Orchestrator:** let the student change hints per task, lesson length and the daily budget by talking; all live in `src/quests/config.ts`.
- **Onboarding:** replaces the sample semester (`seed.ts`) with real courses, homework and dates; the quest code reads the same `Semester` record.
