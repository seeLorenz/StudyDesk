// Records of the quest module. See design/quest-creation.md.
//
// Code plans a quest (which skills, which tasks, how many minutes), Claude
// writes the text inside each part, and every problem points to exactly one
// skill so grading knows what to count.

import type { CourseTarget, Day, Skill } from "../mastery/types";
import type { Note } from "../chat/types";

// ---------- course data (written by onboarding and the setup session) ----------

export type Topic = { id: string; name: string };

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

export type ProblemPart = {
  kind: "practice" | "assignment";
  id: string;
  title: string;
  /** If a problem here isn't understood, later problem parts wait for a fix-it. */
  gate: boolean;
  assignmentId?: string;
  /** For grading: real homework not yet handed in shows only the first wrong step. */
  handedInToSchool?: boolean;
  problems: QuestProblem[];
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
export type AnswerFile = { id: string; name: string; kind: "image" | "pdf" | "text"; text?: string; thumb?: string };

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
  fixIts: FixIt[];
  /** Gate parts the student moved past (after a fix-it, or by choice). */
  gatesCleared: string[];
  finishedAt: number | null;
  updatedAt: number;
};

export type QuestRecord = { quest: Quest; progress: QuestProgress };
