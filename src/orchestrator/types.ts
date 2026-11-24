// Records of the Orchestrator. See design/orchestrator.md.
//
// The Orchestrator is the one agent the student talks to about their desk
// (the tutor answers learning questions). It changes the semester through
// typed, code-checked operations that are logged and can be undone, starts
// organization agent jobs, keeps a running memory summary, and speaks first
// when code finds a reason (check-ins).

import type { Note } from "../chat/types";
import type { Day } from "../mastery/types";

/** Which screen the student was on when they wrote. */
export type Screen = { name: string; detail?: string };

export type ChatCard =
  | { kind: "change"; changeId: string }
  | { kind: "job"; jobId: string }
  | { kind: "confirm"; confirmId: string }
  /** The "Update to vX" notice (design/updates.md). */
  | { kind: "update" }
  /** Going back to the version before the last update, with its warning. */
  | { kind: "goback" };

export type OrchMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  files?: string[];
  /** The kept files of this message, so later turns can send its images again. */
  uploadIds?: string[];
  /** What the dropped files turned into (zips opened, videos found). */
  intake?: import("../onboarding/types").IntakeReport;
  error?: string;
  /** Where the student was, and what they had selected, when they wrote. */
  screen?: string;
  quote?: string;
  cards?: ChatCard[];
  /** Written by StudyDesk on its own (a check-in), not as an answer. */
  checkin?: boolean;
  /** A remark the tutor passed on. */
  fromTutor?: boolean;
};

/** One typed operation. Claude decides what the student meant; code checks and applies it. */
export type Operation = { op: string } & Record<string, unknown>;

/** What a change touched, so it can be undone. Keys name the parts of the desk. */
export type Touched = string[];

export type Change = {
  id: string;
  at: number;
  by: "student" | "orchestrator" | "organization";
  /** What the student said, word for word. */
  studentWords: string;
  ops: Operation[];
  /** One line per effect, "Analysis 1, final exam: 28 Jan → 4 Feb". */
  lines: string[];
  touched: Touched;
  /** The touched parts before and after, as plain JSON. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  status: "applied" | "undone";
  /** Results and similar can't be taken back (they add to the attempt log). */
  undoable: boolean;
};

/** A change that needs the student's yes first (dropping a course, re-reading everything). */
export type PendingConfirm = {
  id: string;
  at: number;
  question: string;
  studentWords: string;
  ops: Operation[];
  job?: JobRequest;
  /** A new placement check, with or without deleting the past stats. */
  placement?: { resetStats: boolean };
  status: "waiting" | "yes" | "no";
};

export type JobKind = "new_material" | "new_course" | "remap";

export type JobRequest = { kind: JobKind; courseIds: string[]; studentWords: string; uploadIds: string[] };

/**
 * An organization agent job. It runs as the setup run of its courses (in a
 * cloud session when hand-off is on, in the page otherwise); its state is read
 * from those courses.
 */
export type Job = JobRequest & {
  id: string;
  startedAt: number;
  /** Skills and homework per course when the job started, to report what changed. */
  before: Record<string, { skills: number; assignments: number; keyDates: number }>;
  /** "queued" while another job still reads one of its courses. */
  status: "queued" | "running" | "done" | "failed";
  finishedAt: number | null;
  /** One line per course, written by code when the job ends. */
  result: string[];
};

export type NotificationKind = "needs_answer" | "job_done" | "too_slow" | "off_track" | "doing_great" | "check_date" | "day_note" | "passed_on" | "night" | "calendar_task";

export type Notification = {
  /** Dedupe key: the same key is never sent twice ("date:c1:2027-01-28"). */
  key: string;
  kind: NotificationKind;
  day: Day;
  at: number;
  courseId: string | null;
  /** The facts code found, for Claude to put into words. */
  facts: string;
  /** The message that told the student. */
  messageId: string | null;
  seenAt: number | null;
};

/** The Orchestrator's lasting memory: a short summary it keeps rewriting. */
export type Memory = {
  text: string;
  updatedAt: number;
  /** createdAt of the newest message the summary covers. */
  coversUpTo: number;
  /** The day the summary was last refreshed. */
  day: Day | null;
};

/** Everything the Orchestrator keeps, apart from the chat messages. */
export type OrchState = {
  memory: Memory;
  changes: Change[];
  confirms: PendingConfirm[];
  jobs: Job[];
  notifications: Notification[];
  /** Side notes from select-to-reply on the chat. */
  notes?: Note[];
  updatedAt: number;
};

export const emptyState = (): OrchState => ({
  memory: { text: "", updatedAt: 0, coversUpTo: 0, day: null },
  changes: [],
  confirms: [],
  jobs: [],
  notifications: [],
  updatedAt: 0,
});
