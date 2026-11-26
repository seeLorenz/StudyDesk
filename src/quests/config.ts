// Tunable numbers of the quest builder, in one place, so they can change after
// Lorenz has tried quests for real without touching the rules.

export const QUEST_CONFIG: {
  assignmentLookaheadDays: number;
  urgentWithinDays: number;
  overBudgetTolerance: number;
  lesson: { readMinutes: number; problemShare: number };
  reading: { displayFormula: number; inlineFormula: number; startRate: number; minRate: number; maxRate: number; window: number; minSeconds: number };
  maxNewSkills: number;
  newBeforeExams: number;
  practiceMaxPoints: number;
  explainMinutes: number;
  hints: number;
  restDayMinutes: number;
  anki: { baseMinutes: number; perCard: number; cardsPerTest: number };
  tiers: { learn: "default"; lesson: "default"; practice: "default"; assignment: "default"; fixIt: "default" };
} = {
  /** Real homework due within this many days is pulled into quests. */
  assignmentLookaheadDays: 7,
  /** Homework due within this many days goes before reviews; later homework after them. */
  urgentWithinDays: 2,
  /** A quest may run this much over its budget rather than split a task group. */
  overBudgetTolerance: 0.1,
  /**
   * A lesson teaches one idea: read a short explanation and a worked example,
   * then solve a short problem straight away. Its problem is a smaller one than
   * a full task, so it gets this share of the skill's expected time. Reading
   * minutes are the target the writer gets; the written text sets the real figure.
   */
  lesson: { readMinutes: 8, problemShare: 0.5 },
  /**
   * Reading time (reading.ts). Text size in word-equivalents: words plus this
   * much per displayed and inline formula. The student's rate is the median of
   * their last `window` reads of at least `minSeconds`, kept between min and max.
   */
  reading: { displayFormula: 15, inlineFormula: 4, startRate: 60, minRate: 25, maxRate: 200, window: 10, minSeconds: 30 },
  /** At most this many brand-new skills per quest when there's no homework to prepare. */
  maxNewSkills: 2,
  /** The same in the week before an exam of the quest's course: only that exam's skills unless the student asks. */
  newBeforeExams: 0,
  /** Practice problems are worth this many grading points each. */
  practiceMaxPoints: 2,
  /** Minutes for an "Explain it" part: one skill coming back, explained in the student's own words. */
  explainMinutes: 6,
  /** Hints per assignment task before the solved similar problem is offered. */
  hints: 3,
  /** Minutes used when the student asks for a quest on a day their goal leaves no time. */
  restDayMinutes: 30,
  /** Anki step before a deck test: minutes = base + per card tested; at most this many cards per skill in one test. */
  anki: { baseMinutes: 5, perCard: 0.5, cardsPerTest: 8 },
  /** Model size for each kind of writing. */
  tiers: { learn: "default", lesson: "default", practice: "default", assignment: "default", fixIt: "default" } as const,
};

/** Minutes of the "Study in Anki" step before deck tests on this many cards. */
export const ankiMinutes = (cards: number) => (cards ? Math.round(QUEST_CONFIG.anki.baseMinutes + QUEST_CONFIG.anki.perCard * cards) : 0);

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
  /** The same in the week before an exam, for skills that aren't on it (0 to 4). */
  newSkillsBeforeExams?: number;
  /** The student learns with Anki: quests then come with a deck of what to learn by heart. Unset = not asked yet. */
  anki?: boolean;
};

export const QUEST_SETTING_LIMITS = { hints: [0, 5], lessonMinutes: [2, 15], newSkillsPerQuest: [0, 4], newSkillsBeforeExams: [0, 4] } as const;

const DEFAULTS = { hints: QUEST_CONFIG.hints, lessonMinutes: QUEST_CONFIG.lesson.readMinutes, newSkillsPerQuest: QUEST_CONFIG.maxNewSkills, newSkillsBeforeExams: QUEST_CONFIG.newBeforeExams };

/**
 * Uses a student's own quest settings for the next planning and writing.
 * Each student runs their own StudyDesk, so the settings of the semester in
 * use are the ones in effect.
 */
export function applyQuestSettings(s: QuestSettings | undefined): void {
  QUEST_CONFIG.hints = s?.hints ?? DEFAULTS.hints;
  QUEST_CONFIG.lesson.readMinutes = s?.lessonMinutes ?? DEFAULTS.lessonMinutes;
  QUEST_CONFIG.maxNewSkills = s?.newSkillsPerQuest ?? DEFAULTS.newSkillsPerQuest;
  QUEST_CONFIG.newBeforeExams = s?.newSkillsBeforeExams ?? DEFAULTS.newSkillsBeforeExams;
}

/** The settings in effect, for the Orchestrator's snapshot. */
export function questSettingsNow(s: QuestSettings | undefined) {
  return { ...DEFAULTS, ...s, anki: s?.anki ?? null };
}
