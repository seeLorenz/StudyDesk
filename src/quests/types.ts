// Records of the quest module. See design/quest-creation.md.
//
// Code plans a quest (which skills, which tasks, how many minutes), Claude
// writes the text inside each part, and every problem points to exactly one
// skill so grading knows what to count.

import type { CourseTarget, Day, Skill } from "../mastery/types";
import type { Note } from "../chat/types";
import type { GradeRules } from "../mastery/grades";
import type { CatalogEntry, Upload } from "../onboarding/types";
import type { QuestSettings } from "./config";

// ---------- course data (written by onboarding and the setup session) ----------

export type Topic = {
  id: string;
  name: string;
  /** Already taught in class when the semester was set up (the placement check covers it). */
  taught?: boolean;
};

export type Course = {
  id: string;
  name: string;
  short: string;
  /** Language the explanations and problems are written in. */
  teachingLanguage: string;
  topics: Topic[];
};

/** One task of a real homework sheet. */
export type AssignmentTask = {
  id: string;
  /** How the sheet names it, e.g. "4.2a". */
  label: string;
  skillId: string;
  /** The task text, word for word from the sheet. */
  prompt: string;
  maxPoints: number;
};

/** A real homework sheet with a hand-in date. */
export type Assignment = {
  id: string;
  courseId: string;
  title: string;
  /** Hand-in deadline, local time, "YYYY-MM-DDTHH:MM". */
  dueAt: string;
  tasks: AssignmentTask[];
};

export type KeyDate = { courseId: string; date: Day; kind: "exam" | "quiz"; title: string; skillIds: string[] };

/** A fixed weekly slot: lectures, exercises, other commitments. weekday: 0 = Sunday. */
export type TimetableEntry = {
  weekday: number;
  start: string;
  end: string;
  kind: "lecture" | "exercise" | "fixed";
  title: string;
  courseId: string | null;
};

/** Everything the quest builder reads about a semester. */
export type Semester = {
  id: string;
  name: string;
  /** "sample" until onboarding exists and writes real data. */
  source: "sample" | "onboarding";
  createdAt: number;
  courses: Course[];
  targets: CourseTarget[];
  skills: Skill[];
  assignments: Assignment[];
  keyDates: KeyDate[];
  timetable: TimetableEntry[];
  /** Study goal in minutes per weekday, index 0 = Sunday. */
  studyGoal: number[];
  /** Written by onboarding; absent on the sample semester. */
  startDate?: Day;
  endDate?: Day;
  /** "student" until the student accepts the workload recommended after the placement check. */
  studyGoalSource?: "student" | "recommended";
  /** Set once the student has answered the workload recommendation. */
  studyGoalDecidedAt?: number;
  gradeRules?: GradeRules[];
  /** The original files and where each skill is covered in them. */
  uploads?: Upload[];
  catalog?: CatalogEntry[];
  /** Read today's Google Calendar when sizing quests (set when the student imported it during setup). */
  calendarSync?: boolean;
  /** The id of the placement check quest. */
  placementQuestId?: string;
  /** Days without studying (no quest budget), set through the Orchestrator. */
  daysOff?: Day[];
  /** The student's own hints, lesson length and new skills per quest, set through the Orchestrator. */
  questSettings?: QuestSettings;
};

// ---------- the quest itself ----------

export type QuestProblem = {
  id: string;
  skillId: string;
  /** The sheet's label for assignment tasks ("4.2a"). */
  label?: string;
  assignmentTaskId?: string;
  prompt: string;
  /** Worked answer or rubric. Sent to grading; shown to the student only when allowed. */
  answerKey: string;
  /** Up to three hints, shown one at a time. Assignment problems only. */
  hints: string[];
  /** A fully solved similar problem, offered after the last hint. */
  similarSolved: string | null;
  /** From the timing rules, never from Claude. */
  expMinutes: number;
  maxPoints: number;
  /** A deck test: the cards from the student's Anki deck this problem asks for. */
  cards?: Card[];
};

export type LearnPart = {
  kind: "learn";
  id: string;
  title: string;
  skillIds: string[];
  estMinutes: number;
  /** Markdown. */
  body: string;
};

/** One Anki card: a word or term and its meaning. */
export type Card = { front: string; back: string };

/**
 * A part with problems. A "lesson" teaches one idea in a short cycle: a brief
 * explanation, a worked example, then the student's own turn right away.
 */
export type ProblemPart = {
  kind: "practice" | "assignment" | "lesson";
  id: string;
  title: string;
  /** If a problem here isn't understood, later problem parts wait for a fix-it. */
  gate: boolean;
  assignmentId?: string;
  /** For grading: real homework not yet handed in shows only the first wrong step. */
  handedInToSchool?: boolean;
  problems: QuestProblem[];
  /** Lessons only: the explanation and worked example (Markdown). */
  body?: string;
  /** Lessons only: minutes to read the explanation and example. */
  readMinutes?: number;
  /** Lessons only: the idea being taught. */
  skillIds?: string[];
  /** Lessons only: the key rule in one line, revealed after the student writes theirs. */
  keyRule?: string;
  /** Lessons only: what to learn by heart, written once; later quests test it from Anki (anki.ts). */
  cards?: Card[];
  /** Placement check: answers count as "check" attempts, and a solve masters the skill at once. */
  check?: boolean;
};

export type QuestPart = LearnPart | ProblemPart;

export type Quest = {
  id: string;
  date: Day;
  courseId: string;
  budgetMinutes: number;
  plannedMinutes: number;
  /** One line: why this quest, today. */
  reason: string;
  /** Short lines shown under the title: time today, what was left out. */
  notes: string[];
  parts: QuestPart[];
  createdAt: number;
};

// ---------- the student's work on a quest ----------

/** A stored attachment: text is kept, images keep only a small preview. */
export type AnswerFile = {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text";
  text?: string;
  thumb?: string;
  /** Images: a compressed copy is saved with the quest, so it can be graded after a reload. */
  stored?: boolean;
};

export type ProblemWork = {
  answerText: string;
  files: AnswerFile[];
  hintsShown: number;
  sawSimilar: boolean;
  activeSeconds: number;
  startedAt: number | null;
  /** Filled in after grading. */
  attemptId?: string;
  verdict?: "solved" | "slip" | "not_understood";
  points?: number;
  feedback?: string;
  firstWrongStep?: string | null;
  slipQuestion?: string | null;
  slipAnswer?: "confirmed" | "disputed" | null;
  fundamentalSkillId?: string | null;
};

/** A short repair after a gate problem wasn't understood. */
export type FixIt = {
  skillId: string;
  /** The gate problem that went wrong. */
  fromProblemId: string;
  explanation: string;
  problem: QuestProblem;
};

export type QuestProgress = {
  questId: string;
  work: Record<string, ProblemWork>;
  /** Parts the student finished, by part id: learn parts read, problem parts handed in (saved, not yet graded). */
  handedIn: string[];
  /** Side notes from select-to-reply anywhere in the quest. */
  notes?: Note[];
  /** Lessons: the student's own one-line version of the key rule, by part id. */
  keyLines?: Record<string, string>;
  /** How each part felt, by part id. Fed into how the next quests are written. */
  ratings?: Record<string, Rating>;
  fixIts: FixIt[];
  /** Gate parts the student moved past (after a fix-it, or by choice). */
  gatesCleared: string[];
  finishedAt: number | null;
  /** Set when the student asked for a new quest for today before starting this one (through the Orchestrator). */
  replacedAt?: number;
  updatedAt: number;
};

export type Rating = "easy" | "right" | "hard";

export type QuestRecord = { quest: Quest; progress: QuestProgress };
