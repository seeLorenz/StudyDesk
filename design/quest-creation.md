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
> Why today: Sheet 4 closes Wednesday 11:00, and 4.2a and 4.2b need: apply the ratio test; apply the root test. Your time today: 2 h free after lectures. You've been finishing about 50 min a day, so this quest is 55 min.

Skill names are verb phrases, so they follow a colon; more than three tasks become a count ("5 of its tasks need: …").

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

1. **Code plans it** (`plan.ts`). **Which course:** homework due within 2 days wins if it's due before the nearest exam; otherwise an exam or quiz in the next 7 days, and with two of them the one with the most open skills (not known yet, or due for their check) per day left, so both get days; otherwise the earliest homework. An exam without a skill list covers every skill of its course the target grade needs. Today's budget comes from the timing rules in the grading spec (study goal minus lectures, then 80% of that or 1.2 × recent pace, half of it for a new student). Then it fills the budget in this order:
   1. fundamentals a recent grading named as the cause of a mistake,
   2. homework due within 2 days, task by task; each task brings the fundamentals it needs (a gate), the concepts it builds on, and an explanation of its own skill if the student hasn't learned it yet,
   3. skills coming back today (still learning, lapsed, or due on the review ladder) as a short warm-up,
   4. **in the week before an exam of this course:** its skills the student hasn't started, as Learn & try, as many as fit (they're on the exam, so they don't count as new material),
   5. homework due later in the week,
   6. if there's no homework at all, the next one or two new skills, those on the nearest exam first. In an exam week none that aren't on the exam, unless the student asked for some (quest setting "new skills before exams", default 0).

   In an exam week, reviews (step 3) only take that exam's skills; the others wait until after it. A group is only added if it fits (10% over budget is allowed rather than splitting a task from what it needs). Urgent homework always gets at least one task. Anything left out is named, with a warning if the sheet is due tomorrow.
2. **Claude writes it** (`write.ts`). One call per part, in parallel: learn parts get the StudyDesk explanation style and what comes later in the quest; practice parts get one fresh problem and worked answer per skill; homework gets three hints, a worked answer and a solved similar problem. Replies use plain `=== SECTION ===` blocks instead of JSON (math breaks JSON), are checked, and retried once.
3. **The nightly run** writes the next day's quest at 22:00 ([scheduled-runs.md](scheduled-runs.md)); the page builds it on the first open of the day only if none is there.

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

## Note: how grading should work (decided 2026-11-20; the 22:00 run is built, see scheduled-runs.md)

- **Grading runs once per quest**, not per part. Handing in a part only saves it.
- **It runs automatically at 22:00** (the nightly run). The "Grade me early" button in the overview starts it by hand.
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
- **Planned against actual time** on every row of the overview, from the problem timers ("9 of 12 min"). Since 2026-11-25 reading is timed too (see "Realistic part times" below).
- **Autosave**: every change to the work (answers, hints, key-rule lines, notes) is copied to this browser at once, and saved to the student's StudyDesk within 2 seconds, and immediately when the tab is hidden or closed. **Two devices never overwrite each other:** each save writes only what that page changed since the saved version it started from, merged field by field onto whatever another tab or device saved meanwhile (`src/quests/merge.ts`). A page coming back to the front takes over work saved elsewhere the same way, and after a crash the browser copy's own changes are merged onto the saved record. Only the same field edited on two devices at once is decided by the later save. Pages from before this rule (up to v1.2) still save their whole copy, so an old version left open on another device can still overwrite work until it reloads.
- **Carry-over**: homework from an unfinished earlier quest comes back automatically (tasks only count as done when handed in), and the new quest says so ("Carried over from Thursday: 4.2b").

## Anki for by-heart material (2026-11-23)

For students who use Anki (asked once on the To do list, see onboarding.md; changed any time by telling StudyDesk). Everything below is `src/quests/anki.ts`, run right after planning, so the planner itself is untouched.

- **One deck per skill, written once.** When Anki is on, the lesson that first teaches a skill also asks Claude for a `CARDS` section: vocabulary and other things learned purely by heart (terms and their meaning, names, fixed facts), one "front | back" per line, or NONE. Methods and problem solving never become cards. The cards are kept on that lesson in the quest record; later quests reuse them and never write them again. If a skill is taught again (lapsed), new cards are merged in by their front.
- **Later quests: Anki, then a test.** When the plan has a review problem or a lesson on a skill that already has cards, that problem becomes a deck test (up to 8 cards, the next ones in the deck each time, so the whole deck comes round), a lesson on it becomes a test part, and a "Study in Anki" step goes first: about 5 min + 0.5 min per tested card. Only the StudyDesk test is graded, so only it counts toward mastery; StudyDesk can't see Anki's stats. Spaced re-tests come from the review ladder, nothing extra.
- **Export deck (N cards)** in the quest header, when the quest touches a skill with cards. One file holds a deck per topic (`StudyDesk::<course>::<topic>`) with every card of the topics this quest touches. It is Anki's plain-text import (tab-separated, header lines for the Basic card type, an id column and a deck column), which the desktop app, AnkiDroid and AnkiMobile all read. Each card's id comes from the course and its front, so importing again, or after the topic grew, updates cards instead of duplicating them.
- Not chosen: `.apkg` (needs SQLite and a zip in the page for no gain to the student), live sync through AnkiConnect (only reachable on the student's own computer, not from the artifact or a phone), storing decks on the semester (it is rebuilt from the setup draft in several places; the quest records already hold the cards).
- **Inside the budget.** The planner gets each skill's deck size (`deckSizes`) and counts the Anki step and the tests while it fills the quest: a lesson on a skill with a deck costs no reading time, and the step costs 5 min + 0.5 min per tested card once. So the Anki step never pushes a quest over its budget.

## Realistic part times (2026-11-25)

**The problem.** Lorenz's sinh/cosh/tanh lesson said 10 min: 4 min to read, 6 for its own problem. Nobody reads and understands two formula-heavy screens in 4 minutes. Three causes in today's code:

1. **Reading time is a fixed guess.** Every lesson gets `readMinutes` 4 (learn parts 6 + 3 per skill), however much Claude actually writes. Claude is told "read in about 4 minutes" but can't turn minutes into length, so lessons come out longer than the number on them.
2. **Reading is never timed**, so the guess never learns, and the daily pace (which sizes quests) only counts problem time.
3. **The problem timer starts on the first keystroke, hint or file**, not when the student starts working. Thinking time is lost, and a student who solves on paper and adds a photo at the end gets almost no time recorded. That makes the slowness factor too low, so problem estimates shrink too.

**The fix: time passively, estimate from the real text, calibrate per student. No button.**

- **One clock per open part.** A part's time runs while it's expanded and the page is in front; the 2-minute hidden-tab auto-pause and the pause button stay. In a lesson, time before its problem card scrolls into view is reading; after that it belongs to the problem. In parts with several problems, the clock follows the unanswered problem in view (typing in one still switches to it). Closing a part stops its clock. Reading seconds are stored on the quest progress (`read`, by part id); the size is measured again from the lesson's text when needed.
- **Reading minutes from the text, by code.** After Claude writes a lesson, code measures its size in word-equivalents: words, plus 15 per displayed formula and 4 per inline formula (formulas read slowly). Reading minutes = size ÷ the student's reading rate. This replaces the planned figure on the part, so the header shows what's really there.
- **Per-student reading rate, by code.** Median of size ÷ reading minutes over the student's last 10 timed reads, starting at 60 per minute and kept between 25 and 200. Same pattern as the slowness factor; the median keeps an odd tab left open from skewing it.
- **Claude gets a length, not a time.** The planner reserves the lesson length setting per lesson (`lessonMinutes`, now 8 by default instead of 4), and the writer is told the matching size at the student's rate ("about 480 words, a displayed formula counts as 15") instead of "about 4 minutes". The quest keeps the rate it was planned with (`readRate`).
- **Pace counts reading.** Recent pace = problem time + reading time per day. Otherwise honest, longer estimates would make quests shrink day after day.
- Problem estimates keep today's rules (own median, else `estMinutes` × slowness); they just get honest times now.

**What changes elsewhere.** Quests hold fewer parts for the same budget (that's the point). Calendar study blocks get longer, since they use `plannedMinutes`. The Anki step and exam weighting are unchanged; they share a budget that's now counted honestly. The overview's "9 of 12 min" includes reading.

**Not chosen.**
- A start/stop button for learning time: students forget to press it, and the data is then worse than passive timing. The system does the busywork.
- Asking Claude to estimate minutes: guessing times is what went wrong. Claude controls length, code measures it.
- Pausing after N minutes without a keystroke or scroll: it would pause during paper work, the usual way to solve maths problems. The median handles the odd left-open tab.

**Lesson clock** (Lorenz: yes): a small "Reading · about N min" clock above each open lesson, with Pause, and Resume after a pause. A paused clock stays off until the student types, presses Resume or opens a part. Hidden-tab time past 2 minutes is skipped and the clock runs on when the page is back.

Code: `src/quests/reading.ts` (size, rate, reading minutes per day), `QUEST_CONFIG.reading`, the clock in `QuestPage.tsx`.

## Study more, focus and dismissing (2026-11-25)

- **One more quest today:** once today's quest is handed in, StudyDesk can write one more on request (`new_quest`, design in [orchestrator.md](orchestrator.md)), with an optional length (`budgetOverride`) and course (`courseId`). Today's quest is graded first, so the planner sees its results. One at a time.
- **Focus:** a saved `focus` (course + end date) on the semester. `pickCourse` returns it while it runs (a course the student asks for still wins), and the quest notes list other courses' homework and exams in the planner's windows.
- **Dismissed parts:** `progress.dismissed` (part ids), also added to `handedIn` so the quest finishes and calendar entries go. `ungraded` and the speed signal skip them, so they're never graded and earn nothing; the finishing bonus counts them as unsolved.

## Explain it (2026-11-25)

Explaining a topic simply, as if teaching it, shows the gaps at once (the Feynman technique). So a quest with skills coming back opens with one **Explain it** part: the first of those skills (lapsed ones first), explained in the student's own words: the idea, why it works, when to use it, a typical trap. About 6 minutes (`QUEST_CONFIG.explainMinutes`), and only if it fits the budget. Then the warm-up asks a fresh problem on the same skill.

- **Graded like other answers.** The writer's answer key is the list of points a full explanation covers. The grading agent says "solved" when the core idea and why it works are right, even if informal, and "not understood" only for a wrong or missing core idea. Its feedback lists each gap or vague spot as a short point.
- **What it counts for** (`part: "explain"` attempts, [grading-and-mastery.md](grading-and-mastery.md)): a good explanation earns solve points but no streak credit, because explaining isn't solving. A gap counts as a miss, like a wrong answer, and goes into the mistake review, so only a fresh problem solved without help clears it. Its time is kept out of the skill's time estimates.
- *Rejected:* a new part kind with its own screen. It's a practice part with `explain: true`, so the answer box, hand-in and grading stay the same. Also rejected: an explanation after a brand-new lesson. Lessons already ask for the key rule in the student's own words, and explaining a skill from memory days later is retrieval practice.

## Notes for other modules

- **Grading run at 22:00:** built as part of the nightly run ([scheduled-runs.md](scheduled-runs.md)), with the same `handIn` code. Still open: the grading results opening as their own window, with the mistake review in it.
- **Orchestrator:** let the student change hints per task, lesson length and the daily budget by talking; all live in `src/quests/config.ts`.
- **Onboarding (built, see onboarding.md):** replaces the sample semester (`seed.ts`) with real courses, homework and dates; the quest code reads the same `Semester` record. The sample stays available from the welcome screen for looking around.
