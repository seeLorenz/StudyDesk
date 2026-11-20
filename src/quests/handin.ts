// Hand-in: turns a part of a quest plus the student's work into grading calls,
// and the verdicts back into attempts, review items and the work record.
// The rules themselves live in src/mastery (agents judge, code counts).

import { gradeProblems, recordResult, type GradingProblem, type GradingResult } from "../mastery/grading";
import type { Attempt, Day, ReviewItem, Skill } from "../mastery/types";
import type { Ask } from "./write";
import type { Assignment, ProblemPart, ProblemWork, Quest, QuestProblem, QuestProgress, Semester } from "./types";

export const emptyWork = (): ProblemWork => ({ answerText: "", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 0, startedAt: null });

export function emptyProgress(questId: string): QuestProgress {
  return { questId, work: {}, handedIn: [], fixIts: [], gatesCleared: [], finishedAt: null, updatedAt: Date.now() };
}

/** True once the assignment's hand-in date has passed, so the full worked answer may be shown. */
export function answerUnlocked(a: Assignment | undefined, nowLocal: string): boolean {
  return !a || a.dueAt <= nowLocal;
}

/** The text sent to the grader: what was typed plus the text of attached PDFs and files. */
export function answerTextFor(w: ProblemWork): string {
  const files = w.files.filter((f) => f.text).map((f) => `[${f.name}]\n${f.text}`);
  return [w.answerText.trim(), ...files].filter(Boolean).join("\n\n");
}

export function gradingProblem(
  p: QuestProblem,
  part: ProblemPart | "fixit",
  w: ProblemWork,
  skills: Map<string, Skill>,
  images: Blob[],
  homeworkOpen: boolean,
): GradingProblem {
  const s = skills.get(p.skillId)!;
  return {
    problemId: p.id,
    skillId: p.skillId,
    skillName: s.name,
    fundamentals: s.prereqSkillIds
      .map((id) => skills.get(id))
      .filter((f): f is Skill => !!f && f.isFundamental)
      .map((f) => ({ skillId: f.id, name: f.name })),
    part: part === "fixit" ? "practice" : part.kind,
    prompt: p.prompt,
    answerKey: p.answerKey,
    maxPoints: p.maxPoints,
    answerText: answerTextFor(w),
    answerImages: images.length ? images : undefined,
    hintsUsed: w.hintsShown,
    sawWorkedExample: w.sawSimilar,
    homeworkNotHandedIn: part !== "fixit" && part.kind === "assignment" && homeworkOpen,
  };
}

export type HandInResult = { attempts: Attempt[]; reviews: ReviewItem[]; work: Record<string, ProblemWork> };

/**
 * Grades a set of problems and returns everything to store. Nothing is
 * written here; the caller stores attempts first, then the work record.
 */
export async function handIn(opts: {
  quest: Quest;
  problems: Array<{ problem: QuestProblem; part: ProblemPart | "fixit" }>;
  work: Record<string, ProblemWork>;
  images: Record<string, Blob[]>;
  semester: Semester;
  today: Day;
  nowLocal: string;
  ask?: Ask;
  signal?: AbortSignal;
  now?: number;
}): Promise<HandInResult> {
  const skills = new Map(opts.semester.skills.map((s) => [s.id, s]));
  const assignmentOf = (part: ProblemPart | "fixit") =>
    part === "fixit" ? undefined : opts.semester.assignments.find((a) => a.id === part.assignmentId);
  const gps = opts.problems.map(({ problem, part }) =>
    gradingProblem(
      problem,
      part,
      opts.work[problem.id] ?? emptyWork(),
      skills,
      opts.images[problem.id] ?? [],
      part !== "fixit" && part.kind === "assignment" && !answerUnlocked(assignmentOf(part), opts.nowLocal),
    ),
  );
  const results: GradingResult[] = await gradeProblems(gps, opts.ask, opts.signal);
  const now = opts.now ?? Date.now();
  const attempts: Attempt[] = [];
  const reviews: ReviewItem[] = [];
  const work: Record<string, ProblemWork> = {};
  for (const { problem } of opts.problems) {
    const r = results.find((x) => x.problemId === problem.id)!;
    const gp = gps.find((x) => x.problemId === problem.id)!;
    const w = opts.work[problem.id] ?? emptyWork();
    const attemptId = `${opts.quest.id}_${problem.id}_${now.toString(36)}`;
    const { attempt, review } = recordResult(gp, r, {
      attemptId,
      questId: opts.quest.id,
      day: opts.today,
      activeSeconds: Math.round(w.activeSeconds),
      startedAt: w.startedAt ?? now,
      now,
    });
    attempts.push(attempt);
    if (review) reviews.push(review);
    work[problem.id] = {
      ...w,
      attemptId,
      verdict: r.verdict,
      points: r.points,
      feedback: r.feedback,
      firstWrongStep: r.firstWrongStep,
      slipQuestion: r.slipQuestion,
      slipAnswer: null,
      fundamentalSkillId: r.fundamentalSkillId,
    };
  }
  return { attempts, reviews, work };
}

/** Problem parts that must wait: everything after a gate that isn't cleared yet. */
export function lockedParts(quest: Quest, progress: QuestProgress): Set<string> {
  const locked = new Set<string>();
  let blocked = false;
  for (const part of quest.parts) {
    if (part.kind === "learn") continue;
    if (blocked) locked.add(part.id);
    if (part.gate && gateFailed(part, progress) && !progress.gatesCleared.includes(part.id)) blocked = true;
  }
  return locked;
}

/** A handed-in gate with a problem that wasn't understood (or a slip the student said was a real mistake). */
export function gateFailed(part: ProblemPart, progress: QuestProgress): boolean {
  if (!progress.handedIn.includes(part.id)) return false;
  return part.problems.some((p) => {
    const w = progress.work[p.id];
    return w?.verdict === "not_understood" || (w?.verdict === "slip" && w.slipAnswer === "disputed");
  });
}

/** Every part done (read or handed in). */
export function allHandedIn(quest: Quest, progress: QuestProgress): boolean {
  return quest.parts.every((p) => progress.handedIn.includes(p.id));
}

/** Handed-in problems still waiting for the grading run. */
export function ungraded(quest: Quest, progress: QuestProgress): Array<{ problem: QuestProblem; part: ProblemPart }> {
  return quest.parts.flatMap((part) =>
    part.kind === "learn" || !progress.handedIn.includes(part.id)
      ? []
      : part.problems.filter((p) => !progress.work[p.id]?.verdict).map((problem) => ({ problem, part })),
  );
}

/** Every part done and every problem graded. */
export function isFinished(quest: Quest, progress: QuestProgress): boolean {
  return allHandedIn(quest, progress) && ungraded(quest, progress).length === 0;
}
