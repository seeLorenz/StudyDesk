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
