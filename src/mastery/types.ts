// Records of the grading and mastery module. See design/grading-and-mastery.md.
//
// The attempt log is the only source of truth. Skill state, mastery, time
// estimates and points are all computed from attempts (plus the student's
// answers on review items) and can be rebuilt at any time.

/** A calendar day in the student's own time zone, "YYYY-MM-DD". */
export type Day = string;

export type Difficulty = "normal" | "hard";

/** One kind of problem: the unit of mastery. Written by the organization agent. */
export type Skill = {
  id: string;
  courseId: string;
  topicId: string;
  name: string;
  difficulty: Difficulty;
  isFundamental: boolean;
  prereqSkillIds: string[];
  /** The least ambitious target grade that still needs this skill, on the course's scale. */
  tier: number;
  /** How much the skill counts for the course. */
  weight: number;
  /** Clean solves on different days needed for mastery. Default 3. */
  streakTarget?: number;
  /** First guess of minutes per problem, before the student has their own times. */
  estMinutes: number;
};

/**
 * A grading scale. `best` and `worst` give the direction: Austrian grades are
 * {best: 1, worst: 5}, percent is {best: 100, worst: 0}.
 */
export type GradeScale = { name: string; best: number; worst: number };

export type CourseTarget = { courseId: string; targetGrade: number; gradeScale: GradeScale };

export type AttemptPart = "practice" | "assignment" | "review" | "check" | "assessment";

export type Verdict = "solved" | "slip" | "not_understood";

/** One graded answer to one problem. Never edited after it is written. */
export type Attempt = {
  id: string;
  skillId: string;
  questId: string | null;
  /** "check" = fundamentals check, "assessment" = a real exam result entered by the student. */
  part: AttemptPart;
  day: Day;
  verdict: Verdict;
  points: number;
  maxPoints: number;
  hintsUsed: number;
  sawWorkedExample: boolean;
  /** Active time on the problem; 0 when not timed (assessments). */
  activeSeconds: number;
  startedAt: number;
  gradedAt: number;
};

export type ReviewKind = "slip" | "real_error";

/** Workflow of a review item. The slip answer itself is kept in `slipAnswer`. */
export type ReviewStatus = "open" | "answered" | "talked_through" | "resolved";

/**
 * Follow-up on one wrong answer. A slip waits for the student to confirm it
 * ("confirmed") or say it was a real mistake ("disputed").
 */
export type ReviewItem = {
  attemptId: string;
  kind: ReviewKind;
  status: ReviewStatus;
  /** The student's answer to a slip question; null until they answer. */
  slipAnswer: "confirmed" | "disputed" | null;
  /** The question shown to the student for a slip. */
  slipQuestion: string | null;
  chatId: string | null;
  updatedAt: number;
};

export type Stage = "new" | "learning" | "mastered" | "retained" | "lapsed";

/** Computed from attempts; a cache, never the truth. */
export type SkillState = {
  skillId: string;
  stage: Stage;
  streak: number;
  /** 1-based step on the review ladder while mastered; 0 otherwise. */
  ladderStep: number;
  /** Next day the skill should come back. null for new and retained skills. */
  dueAt: Day | null;
  lapses: number;
  /** Day of the last streak credit, so a skill counts at most once per day. */
  lastCreditDay: Day | null;
  /** Ladder step to restart at after a lapse. */
  restartStep: number;
  medianSeconds: number | null;
};

/** A real result from school, entered by the student. */
export type AssessmentResult = {
  assessmentId: string;
  courseId: string;
  component: string;
  points: number;
  maxPoints: number;
  date: Day;
  /** Skills the assessment covered; each gets one "assessment" attempt as evidence. */
  skillIds: string[];
};

export type PointsKind =
  | "solved"
  | "mastered"
  | "review_passed"
  | "fundamental_cleared"
  | "slip_confirmed"
  | "quest_finished";

export type PointsEvent = { day: Day; kind: PointsKind; points: number; skillId?: string; attemptId?: string; questId?: string };
