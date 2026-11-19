// Real grades from real results. Claude never estimates these.
// design/grading-and-mastery.md, "Points and real grades".

import type { AssessmentResult, Attempt, GradeScale } from "./types";
import { atLeastAsGood } from "./mastery";

/** Written once per course by the organization agent. */
export type GradeRules = {
  courseId: string;
  scale: GradeScale;
  /** Components with weights, e.g. exam 60, homework 40. */
  components: Array<{ id: string; weight: number }>;
  /** Minimum percent for each grade, e.g. [{grade: 1, minPercent: 87.5}, …]. */
  thresholds: Array<{ grade: number; minPercent: number }>;
};

/** The best grade a percentage reaches, or the scale's worst grade. */
export function gradeFor(rules: GradeRules, percent: number): number {
  const reached = rules.thresholds.filter((t) => percent >= t.minPercent).map((t) => t.grade);
  if (!reached.length) return rules.scale.worst;
  return reached.reduce((best, g) => (atLeastAsGood(rules.scale, g, best) ? g : best));
}

export type GradeStanding = {
  /** Weighted percent over the components that have results; null when none do. */
  percentSoFar: number | null;
  gradeSoFar: number | null;
  /** Share of the total weight that already has results, 0 to 1. */
  weightDone: number;
  /** Percent still needed on the remaining components for the target grade; null when nothing remains or the target has no threshold. */
  neededPercent: number | null;
};

export function gradeStanding(rules: GradeRules, results: AssessmentResult[], targetGrade: number): GradeStanding {
  const total = rules.components.reduce((s, c) => s + c.weight, 0);
  let doneWeight = 0;
  let earned = 0;
  for (const c of rules.components) {
    const rs = results.filter((r) => r.courseId === rules.courseId && r.component === c.id);
    if (!rs.length) continue;
    const max = rs.reduce((s, r) => s + r.maxPoints, 0);
    const got = rs.reduce((s, r) => s + r.points, 0);
    doneWeight += c.weight;
    earned += c.weight * (max ? (100 * got) / max : 0);
  }
  const percentSoFar = doneWeight ? earned / doneWeight : null;
  const need = rules.thresholds.find((t) => t.grade === targetGrade)?.minPercent;
  const remaining = total - doneWeight;
  return {
    percentSoFar,
    gradeSoFar: percentSoFar === null ? null : gradeFor(rules, percentSoFar),
    weightDone: total ? doneWeight / total : 0,
    neededPercent: need === undefined || remaining <= 0 ? null : (need * total - earned) / remaining,
  };
}

/** One evidence attempt per covered skill. They never mark a skill mastered on their own. */
export function assessmentAttempts(r: AssessmentResult, now: number): Attempt[] {
  const share = r.maxPoints ? r.points / r.maxPoints : 0;
  return r.skillIds.map((skillId) => ({
    id: `as_${r.assessmentId}_${skillId}`,
    skillId,
    questId: null,
    part: "assessment",
    day: r.date,
    verdict: share >= 0.5 ? "solved" : "not_understood",
    points: r.points,
    maxPoints: r.maxPoints,
    hintsUsed: 0,
    sawWorkedExample: false,
    activeSeconds: 0,
    startedAt: now,
    gradedAt: now,
  }));
}
