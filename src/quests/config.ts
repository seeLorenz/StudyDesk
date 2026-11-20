// Tunable numbers of the quest builder, in one place, so they can change after
// Lorenz has tried quests for real without touching the rules.

export const QUEST_CONFIG: {
  assignmentLookaheadDays: number;
  urgentWithinDays: number;
  overBudgetTolerance: number;
  learnMinutes: { base: number; perSkill: number };
  lesson: { readMinutes: number; problemShare: number };
  maxNewSkills: number;
  practiceMaxPoints: number;
  hints: number;
  restDayMinutes: number;
  tiers: { learn: "default"; lesson: "default"; practice: "default"; assignment: "default"; fixIt: "default" };
} = {
  /** Real homework due within this many days is pulled into quests. */
  assignmentLookaheadDays: 7,
  /** Homework due within this many days goes before reviews; later homework after them. */
  urgentWithinDays: 2,
  /** A quest may run this much over its budget rather than split a task group. */
  overBudgetTolerance: 0.1,
  /** Minutes for a learn part: base plus this much per skill it covers. Reading isn't scaled by slowness. */
  learnMinutes: { base: 6, perSkill: 3 },
  /**
   * A lesson teaches one idea: read a short explanation and a worked example,
   * then solve a short problem straight away. Its problem is a smaller one than
   * a full task, so it gets this share of the skill's expected time.
   */
  lesson: { readMinutes: 4, problemShare: 0.5 },
  /** At most this many brand-new skills per quest when there's no homework to prepare. */
  maxNewSkills: 2,
  /** Practice problems are worth this many grading points each. */
  practiceMaxPoints: 2,
  /** Hints per assignment task before the solved similar problem is offered. */
  hints: 3,
  /** Minutes used when the student asks for a quest on a day their goal leaves no time. */
  restDayMinutes: 30,
  /** Model size for each kind of writing. */
  tiers: { learn: "default", lesson: "default", practice: "default", assignment: "default", fixIt: "default" } as const,
};

export function learnMinutes(skillCount: number): number {
  return skillCount ? QUEST_CONFIG.learnMinutes.base + QUEST_CONFIG.learnMinutes.perSkill * skillCount : 0;
}

/** Minutes for a quest part: reading plus its problems. */
export function partMinutes(p: { kind: string; estMinutes?: number; readMinutes?: number; problems?: Array<{ expMinutes: number }> }): number {
  if (p.kind === "learn") return p.estMinutes ?? 0;
  return (p.readMinutes ?? 0) + (p.problems ?? []).reduce((s, q) => s + q.expMinutes, 0);
}

/** What a student can change about their quests by telling the Orchestrator. Unset = the default above. */
export type QuestSettings = {
  /** Hints per homework task before the solved similar problem (0 to 5). */
  hints?: number;
  /** Minutes to read a lesson's explanation and example (2 to 15). */
  lessonMinutes?: number;
  /** Brand-new skills per quest when there's no homework to prepare (0 to 4). */
  newSkillsPerQuest?: number;
};

export const QUEST_SETTING_LIMITS = { hints: [0, 5], lessonMinutes: [2, 15], newSkillsPerQuest: [0, 4] } as const;

const DEFAULTS = { hints: QUEST_CONFIG.hints, lessonMinutes: QUEST_CONFIG.lesson.readMinutes, newSkillsPerQuest: QUEST_CONFIG.maxNewSkills };

/**
 * Uses a student's own quest settings for the next planning and writing.
 * Each student runs their own StudyDesk, so the settings of the semester in
 * use are the ones in effect.
 */
export function applyQuestSettings(s: QuestSettings | undefined): void {
  QUEST_CONFIG.hints = s?.hints ?? DEFAULTS.hints;
  QUEST_CONFIG.lesson.readMinutes = s?.lessonMinutes ?? DEFAULTS.lessonMinutes;
  QUEST_CONFIG.maxNewSkills = s?.newSkillsPerQuest ?? DEFAULTS.newSkillsPerQuest;
}

/** The settings in effect, for the Orchestrator's snapshot. */
export function questSettingsNow(s: QuestSettings | undefined): Required<QuestSettings> {
  return { hints: s?.hints ?? DEFAULTS.hints, lessonMinutes: s?.lessonMinutes ?? DEFAULTS.lessonMinutes, newSkillsPerQuest: s?.newSkillsPerQuest ?? DEFAULTS.newSkillsPerQuest };
}
