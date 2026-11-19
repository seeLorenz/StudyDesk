// Rebuilds every skill's state and the points log from the attempt log.
// Pure and deterministic: the same attempts and review answers always give
// the same result. Rules: design/grading-and-mastery.md, "Streaks and the
// review ladder" and "Points and real grades".

import { CONFIG } from "./config";
import { addDays, median } from "./days";
import type { Attempt, Day, PointsEvent, ReviewItem, Skill, SkillState } from "./types";

/** What one attempt means for the streak, after the student's slip answer. */
export type Outcome = "clean" | "helped" | "slip_ok" | "slip_pending" | "miss" | "evidence";

export function outcomeOf(a: Attempt, review: ReviewItem | undefined): Outcome {
  if (a.part === "assessment") return "evidence";
  switch (a.verdict) {
    case "solved":
      return a.hintsUsed === 0 && !a.sawWorkedExample ? "clean" : "helped";
    case "slip":
      if (review?.slipAnswer === "confirmed") return "slip_ok";
      if (review?.slipAnswer === "disputed") return "miss";
      return "slip_pending";
    case "not_understood":
      return "miss";
  }
}

export function emptyState(skillId: string): SkillState {
  return {
    skillId,
    stage: "new",
    streak: 0,
    ladderStep: 0,
    dueAt: null,
    lapses: 0,
    lastCreditDay: null,
    restartStep: 1,
    medianSeconds: null,
  };
}

export function ladderFor(skill: Skill): number[] {
  return CONFIG.ladder[skill.difficulty];
}

/** Attempts in the order they happened. */
export function sortAttempts(attempts: Attempt[]): Attempt[] {
  return [...attempts].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.gradedAt - b.gradedAt));
}

export type ReplayResult = {
  states: Map<string, SkillState>;
  points: PointsEvent[];
};

export function replay(skills: Skill[], attempts: Attempt[], reviews: ReviewItem[]): ReplayResult {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const reviewByAttempt = new Map(reviews.map((r) => [r.attemptId, r]));
  const states = new Map<string, SkillState>(skills.map((s) => [s.id, emptyState(s.id)]));
  const points: PointsEvent[] = [];
  const times = new Map<string, number[]>();

  for (const a of sortAttempts(attempts)) {
    const skill = byId.get(a.skillId);
    if (!skill) continue; // attempt on a skill that was removed: keep it in the log, ignore it here
    const st = states.get(a.skillId)!;
    const outcome = outcomeOf(a, reviewByAttempt.get(a.id));
    if (a.activeSeconds > 0) times.set(a.skillId, [...(times.get(a.skillId) ?? []), a.activeSeconds]);
    step(skill, st, a, outcome, points);
  }

  for (const [id, st] of states) {
    const t = times.get(id) ?? [];
    st.medianSeconds = median(t.slice(-CONFIG.timing.ownMedianWindow));
  }
  return { states, points };
}

function step(skill: Skill, st: SkillState, a: Attempt, outcome: Outcome, points: PointsEvent[]) {
  if (outcome === "evidence") return; // real exam results never move a skill on their own
  const ladder = ladderFor(skill);
  const target = skill.streakTarget ?? CONFIG.defaultStreakTarget;
  const award = (kind: PointsEvent["kind"], n: number) =>
    points.push({ day: a.day, kind, points: n, skillId: skill.id, attemptId: a.id });
  const solvedPoints = () => {
    if (a.part === "check" && skill.isFundamental) award("fundamental_cleared", CONFIG.points.fundamental_cleared);
    else award("solved", CONFIG.points.solved[skill.difficulty]);
  };

  if (outcome === "slip_ok") award("slip_confirmed", CONFIG.points.slip_confirmed);

  if (st.stage === "new") st.stage = "learning";

  if (st.stage === "learning" || st.stage === "lapsed") {
    if (outcome === "clean") {
      solvedPoints();
      if (st.lastCreditDay !== a.day) {
        st.streak += 1;
        st.lastCreditDay = a.day;
      }
      if (st.streak >= target) {
        st.stage = "mastered";
        st.ladderStep = st.restartStep;
        st.dueAt = addDays(a.day, ladder[st.ladderStep - 1]);
        award("mastered", CONFIG.points.mastered);
        return;
      }
    } else if (outcome === "miss") {
      st.streak = 0;
    }
    st.dueAt = addDays(a.day, 1); // still learning: back the next study day
    return;
  }

  // mastered or retained
  if (outcome === "clean") {
    const isReview = st.stage === "retained" || (st.dueAt !== null && a.day >= st.dueAt);
    if (!isReview) {
      solvedPoints(); // extra practice before the review is due: points, no ladder move
      return;
    }
    award("review_passed", CONFIG.points.review_passed);
    if (st.stage === "retained") return;
    st.ladderStep += 1;
    if (st.ladderStep > ladder.length) {
      st.stage = "retained";
      st.dueAt = null;
    } else {
      st.dueAt = addDays(a.day, ladder[st.ladderStep - 1]);
    }
    return;
  }

  if (outcome === "miss") {
    const at = st.stage === "retained" ? ladder.length + 1 : st.ladderStep;
    st.restartStep = Math.max(1, at - CONFIG.lapseStepsBack);
    st.stage = "lapsed";
    st.streak = 0;
    st.ladderStep = 0;
    st.lapses += 1;
    st.lastCreditDay = null;
    st.dueAt = addDays(a.day, 1);
  }
  // helped, slip_ok, slip_pending: unchanged
}

export type Exam = { courseId: string; date: Day; skillIds: string[] };

/**
 * Skills that should come back today: learning and lapsed skills, mastered
 * skills whose review is due, and retained skills with an exam on them in the
 * next week that haven't been checked in that window yet.
 */
export function dueSkills(
  skills: Skill[],
  states: Map<string, SkillState>,
  attempts: Attempt[],
  exams: Exam[],
  today: Day,
): string[] {
  const out: string[] = [];
  for (const s of skills) {
    const st = states.get(s.id);
    if (!st) continue;
    if (st.stage === "learning" || st.stage === "lapsed") out.push(s.id);
    else if (st.stage === "mastered" && st.dueAt !== null && st.dueAt <= today) out.push(s.id);
    else if (st.stage === "retained") {
      const exam = exams
        .filter((e) => e.skillIds.includes(s.id) && e.date >= today && e.date <= addDays(today, CONFIG.examCheckWindowDays))
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (!exam) continue;
      const windowStart = addDays(exam.date, -CONFIG.examCheckWindowDays);
      const checked = attempts.some((a) => a.skillId === s.id && a.part !== "assessment" && a.day >= windowStart && a.day <= today);
      if (!checked) out.push(s.id);
    }
  }
  return out;
}

/** +25 for each day's quest the student finished. */
export function questPoints(finished: Array<{ questId: string; day: Day }>): PointsEvent[] {
  return finished.map((q) => ({ day: q.day, kind: "quest_finished", points: CONFIG.points.quest_finished, questId: q.questId }));
}
