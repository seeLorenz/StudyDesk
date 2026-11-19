// Every tunable number of the grading and mastery module, in one place, so it
// can be changed after the test round without touching the rules.

import type { Difficulty, PointsKind } from "./types";

export const CONFIG = {
  defaultStreakTarget: 3,

  /** Days until the next review, per ladder step. Past the last step a skill is retained. */
  ladder: {
    normal: [3, 7, 16, 35],
    hard: [2, 4, 8, 16, 35],
  } satisfies Record<Difficulty, number[]>,

  /** A lapsed skill restarts this many steps below where it lapsed (never below step 1). */
  lapseStepsBack: 2,

  /** A retained skill is checked once in this many days before an exam that covers it. */
  examCheckWindowDays: 7,

  /** Mastery credit per stage. Learning and lapsed get learningCredit × streak ÷ target. */
  credit: { learning: 0.5, mastered: 1, overdue: 0.75, retained: 1 },

  timing: {
    /** Use the student's own median once they have this many timed attempts on a skill. */
    ownMedianMinAttempts: 3,
    ownMedianWindow: 5,
    slownessWindow: 20,
    slownessStart: 2.0,
    slownessMin: 1,
    slownessMax: 4,
    /** The timer pauses itself when the tab is hidden this long. */
    autoPauseAfterMs: 2 * 60 * 1000,
  },

  budget: {
    shareOfFreeTime: 0.8,
    paceFactor: 1.2,
    paceDays: 3,
    newStudentShare: 0.5,
  },

  points: {
    solved: { normal: 10, hard: 15 },
    mastered: 50,
    review_passed: 20,
    fundamental_cleared: 10,
    slip_confirmed: 5,
    quest_finished: 25,
  } satisfies Record<Exclude<PointsKind, "solved">, number> & { solved: Record<Difficulty, number> },

  /** The honesty guard warns instead of celebrating below this exam readiness. */
  honesty: { examWithinDays: 21, warnBelow: 0.5 },
};
