// Mastery toward the target grade, and the honesty guard that keeps points
// next to it. design/grading-and-mastery.md, "Mastery toward the target grade".

import { CONFIG } from "./config";
import { addDays } from "./days";
import type { Exam } from "./replay";
import type { CourseTarget, Day, GradeScale, Skill, SkillState } from "./types";

/** True when grade a is at least as good as grade b on this scale. */
export function atLeastAsGood(scale: GradeScale, a: number, b: number): boolean {
  return scale.best < scale.worst ? a <= b : a >= b;
}

/** A skill counts when the student aims at its tier or better. */
export function isRequired(skill: Skill, target: CourseTarget): boolean {
  return atLeastAsGood(target.gradeScale, target.targetGrade, skill.tier);
}

export function credit(skill: Skill, st: SkillState | undefined, today: Day): number {
  if (!st) return 0;
  const target = skill.streakTarget ?? CONFIG.defaultStreakTarget;
  switch (st.stage) {
    case "new":
      return 0;
    case "learning":
    case "lapsed":
      return CONFIG.credit.learning * Math.min(st.streak, target) / target;
    case "mastered":
      return st.dueAt !== null && today > st.dueAt ? CONFIG.credit.overdue : CONFIG.credit.mastered;
    case "retained":
      return CONFIG.credit.retained;
  }
}

export type MasteryResult = {
  /** 0 to 1. */
  value: number;
  masteredCount: number;
  requiredCount: number;
  /** Required skills not yet mastered or retained. */
  missing: string[];
};

/** Weighted share of the given required skills the student can do right now. */
export function masteryOf(skills: Skill[], states: Map<string, SkillState>, today: Day): MasteryResult {
  let num = 0;
  let den = 0;
  const missing: string[] = [];
  let masteredCount = 0;
  for (const s of skills) {
    const st = states.get(s.id);
    num += s.weight * credit(s, st, today);
    den += s.weight;
    if (st?.stage === "mastered" || st?.stage === "retained") masteredCount += 1;
    else missing.push(s.id);
  }
  return { value: den ? num / den : 0, masteredCount, requiredCount: skills.length, missing };
}

export function courseMastery(skills: Skill[], states: Map<string, SkillState>, target: CourseTarget, today: Day): MasteryResult {
  return masteryOf(skills.filter((s) => s.courseId === target.courseId && isRequired(s, target)), states, today);
}

export function topicMastery(
  skills: Skill[],
  states: Map<string, SkillState>,
  target: CourseTarget,
  topicId: string,
  today: Day,
): MasteryResult {
  return masteryOf(
    skills.filter((s) => s.courseId === target.courseId && s.topicId === topicId && isRequired(s, target)),
    states,
    today,
  );
}

export type ExamReadiness = { exam: Exam; mastery: MasteryResult; warn: boolean };

/**
 * The honesty guard: for every exam in the next three weeks, how ready the
 * student is on the skills it covers that their target grade needs. Below
 * 50% the page shows a calm warning instead of celebrating points.
 */
export function examReadiness(
  skills: Skill[],
  states: Map<string, SkillState>,
  targets: CourseTarget[],
  exams: Exam[],
  today: Day,
): ExamReadiness[] {
  const until = addDays(today, CONFIG.honesty.examWithinDays);
  return exams
    .filter((e) => e.date >= today && e.date <= until)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((exam) => {
      const target = targets.find((t) => t.courseId === exam.courseId);
      const covered = skills.filter((s) => exam.skillIds.includes(s.id) && (!target || isRequired(s, target)));
      const mastery = masteryOf(covered, states, today);
      return { exam, mastery, warn: mastery.value < CONFIG.honesty.warnBelow };
    });
}
