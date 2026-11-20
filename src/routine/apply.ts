// Folding the nightly run's results into the student's desk. design/scheduled-runs.md.
//
// The nightly run never overwrites a document the page may hold open (a quest
// the student is still working on, the semester draft). It writes what it found
// into an outbox instead, and these functions merge it: in the page when it
// opens (or while it's open), and in the next nightly run if the page wasn't
// opened in between. Same code both ways. Pure, so it is tested.

import { uid } from "../chat/types";
import type { CourseSetup } from "../onboarding/types";
import { applyOps, type Desk } from "../orchestrator/changes";
import type { Change, Operation } from "../orchestrator/types";
import { isFinished } from "../quests/handin";
import type { ProblemWork, QuestRecord } from "../quests/types";
import type { Day } from "../mastery/types";

/** Grades for one quest. Attempts and review items are written straight to the mastery store; only the quest's own record waits here. */
export type GradingOutbox = {
  kind: "grading";
  id: string;
  day: Day;
  questId: string;
  /** The grading fields per problem: verdict, points, feedback… (answers stay as the student left them). */
  work: Record<string, Partial<ProblemWork>>;
  createdAt: number;
};

/** Tonight's short check: changes found, questions for the student, a note. */
export type ShallowOutbox = {
  kind: "org-shallow";
  id: string;
  day: Day;
  semesterId: string;
  ops: Operation[];
  questions: Array<{ courseId: string; text: string }>;
  note: string;
  createdAt: number;
};

/** One course read again from scratch (a deep sweep). */
export type SweepOutbox = {
  kind: "org-sweep";
  id: string;
  day: Day;
  semesterId: string;
  courseId: string;
  setup: CourseSetup;
  readIds: string[];
  createdAt: number;
};

export type OutboxDoc = GradingOutbox | ShallowOutbox | SweepOutbox;

const GRADE_FIELDS = ["attemptId", "verdict", "points", "feedback", "firstWrongStep", "slipQuestion", "slipAnswer", "fundamentalSkillId"] as const;

/** Only the grading fields of a work entry, for the outbox. */
export function gradingFields(w: ProblemWork): Partial<ProblemWork> {
  const out: Partial<ProblemWork> = {};
  for (const k of GRADE_FIELDS) if (w[k] !== undefined) (out as Record<string, unknown>)[k] = w[k];
  return out;
}

/**
 * A quest record with tonight's grades merged in. A problem the student had
 * graded in the meantime ("Grade me early") keeps its own grade. Returns the
 * same object when nothing changed.
 */
export function mergeGrading(record: QuestRecord, box: GradingOutbox, now: number): QuestRecord {
  let changed = false;
  const work = { ...record.progress.work };
  for (const [pid, g] of Object.entries(box.work)) {
    const cur = work[pid];
    if (!cur || cur.verdict) continue;
    work[pid] = { ...cur, ...g };
    changed = true;
  }
  if (!changed) return record;
  const progress = { ...record.progress, work, updatedAt: now };
  if (!progress.finishedAt && isFinished(record.quest, progress)) progress.finishedAt = now;
  return { ...record, progress };
}

/** A course's setup result put into the draft, as the setup screen does after a reading. */
export function applySweep(desk: Desk, box: SweepOutbox, now: number): Desk {
  const d = desk.draft;
  if (d.id !== box.semesterId || !d.courses.some((c) => c.id === box.courseId)) return desk;
  const r = box.setup;
  const check = r.conflicts.length > 0 || r.questions.length > 0 || r.truncated || r.basis === "general";
  return {
    ...desk,
    draft: {
      ...d,
      results: { ...d.results, [box.courseId]: r },
      uploads: d.uploads.map((u) => (box.readIds.includes(u.id) ? { ...u, cataloguedAt: now } : u)),
      courses: d.courses.map((k) => (k.id === box.courseId ? { ...k, setupStatus: check ? "needs_check" : "ready", teachingLanguage: r.teachingLanguage || k.teachingLanguage } : k)),
      // New questions should be asked even if the student ticked off the old ones.
      todoDone: r.questions.length ? (d.todoDone ?? []).filter((k) => k !== `q-${box.courseId}`) : d.todoDone,
    },
  };
}

/**
 * Tonight's check applied: its operations through the same checks as any
 * change (logged as by the organization agent, with Undo), and its questions
 * added to the course's open questions so the Orchestrator asks them.
 */
export function applyShallow(desk0: Desk, box: ShallowOutbox, now: number): { desk: Desk; change: Change | null; errors: string[] } {
  if (desk0.draft.id !== box.semesterId) return { desk: desk0, change: null, errors: ["The semester changed since this check."] };
  let desk = desk0;
  let change: Change | null = null;
  let errors: string[] = [];
  if (box.ops.length) {
    const r = applyOps(desk, box.ops, { studentWords: `Found by StudyDesk's nightly check: ${box.note}`.trim(), by: "organization", now });
    desk = r.desk;
    change = r.change;
    errors = r.errors;
  }
  if (box.questions.length) {
    const d = desk.draft;
    const results = { ...d.results };
    let todoDone = d.todoDone ?? [];
    for (const q of box.questions) {
      const r = results[q.courseId];
      if (!r || r.questions.includes(q.text)) continue;
      results[q.courseId] = { ...r, questions: [...r.questions, q.text] };
      todoDone = todoDone.filter((k) => k !== `q-${q.courseId}`);
    }
    desk = { ...desk, draft: { ...d, results, todoDone } };
  }
  return { desk, change, errors };
}

/** Outbox documents in the order they must be applied: oldest first, a course's sweep before the check of the same night. */
export function outboxOrder(docs: OutboxDoc[]): OutboxDoc[] {
  const rank = (d: OutboxDoc) => (d.kind === "grading" ? 0 : d.kind === "org-sweep" ? 1 : 2);
  return [...docs].sort((a, b) => (a.day === b.day ? rank(a) - rank(b) || a.createdAt - b.createdAt : a.day < b.day ? -1 : 1));
}

export const outboxId = (kind: OutboxDoc["kind"], day: Day, extra = "") => `${day}_${kind}${extra ? `_${extra}` : ""}_${uid().slice(0, 4)}`;
