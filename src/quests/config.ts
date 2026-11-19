// Tunable numbers of the quest builder, in one place, so they can change after
// Lorenz has tried quests for real without touching the rules.

export const QUEST_CONFIG = {
  /** Real homework due within this many days is pulled into quests. */
  assignmentLookaheadDays: 7,
  /** Homework due within this many days goes before reviews; later homework after them. */
  urgentWithinDays: 2,
  /** A quest may run this much over its budget rather than split a task group. */
  overBudgetTolerance: 0.1,
  /** Minutes for a learn part: base plus this much per skill it covers. Reading isn't scaled by slowness. */
  learnMinutes: { base: 6, perSkill: 3 },
  /** At most this many brand-new skills per quest when there's no homework to prepare. */
  maxNewSkills: 2,
  /** Practice problems are worth this many grading points each. */
  practiceMaxPoints: 2,
  /** Hints per assignment task before the solved similar problem is offered. */
  hints: 3,
  /** Minutes used when the student asks for a quest on a day their goal leaves no time. */
  restDayMinutes: 30,
  /** Model size for each kind of writing. */
  tiers: { learn: "default", practice: "default", assignment: "default", fixIt: "default" } as const,
};

export function learnMinutes(skillCount: number): number {
  return skillCount ? QUEST_CONFIG.learnMinutes.base + QUEST_CONFIG.learnMinutes.perSkill * skillCount : 0;
}
