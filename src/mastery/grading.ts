// The grading agent: judges one handed-in quest and returns plain data.
// It has no memory and never sees streaks or mastery; everything it needs is
// in the call. design/grading-and-mastery.md, "Grading agent".

import { askClaude, maxImages, type AskError, type AskOptions, type Turn } from "../platform/claude";
import type { Attempt, AttemptPart, Day, ReviewItem, Verdict } from "./types";

export type GradingProblem = {
  problemId: string;
  skillId: string;
  skillName: string;
  /** Names of the fundamentals this skill depends on, so a missing one can be named. */
  fundamentals: Array<{ skillId: string; name: string }>;
  part: AttemptPart;
  prompt: string;
  answerKey: string;
  maxPoints: number;
  answerText: string;
  /** Photos or scans of the student's work for this problem. */
  answerImages?: Blob[];
  hintsUsed: number;
  sawWorkedExample: boolean;
  /** Real homework not yet handed in to school: point to the first wrong step only. */
  homeworkNotHandedIn: boolean;
};

export type ErrorKind = "none" | "slip" | "concept" | "missing_fundamental";

export type GradingResult = {
  problemId: string;
  verdict: Verdict;
  points: number;
  maxPoints: number;
  firstWrongStep: string | null;
  errorKind: ErrorKind;
  fundamentalSkillId: string | null;
  slipQuestion: string | null;
  feedback: string;
};

const VERDICTS: Verdict[] = ["solved", "slip", "not_understood"];
const ERROR_KINDS: ErrorKind[] = ["none", "slip", "concept", "missing_fundamental"];

export function gradingTurns(problems: GradingProblem[]): Turn[] {
  let img = 0;
  const blocks = problems.map((p) => {
    const images = (p.answerImages ?? []).map(() => `image ${++img}`);
    return [
      `### Problem ${p.problemId}`,
      `Skill: ${p.skillName}`,
      p.fundamentals.length
        ? `Fundamentals it depends on: ${p.fundamentals.map((f) => `${f.name} (id ${f.skillId})`).join("; ")}`
        : "Fundamentals it depends on: none listed",
      `Max points: ${p.maxPoints}`,
      `Hints used: ${p.hintsUsed}${p.sawWorkedExample ? ", and the student saw a fully solved similar problem" : ""}`,
      p.part === "explain"
        ? 'The student explained this skill in their own words, as if teaching it. "solved" when the core idea and why it works are right, even if informal; "not_understood" only for a wrong or missing core idea; never "slip". In feedback, list each gap or vague spot against the rubric, one short point each.'
        : p.homeworkNotHandedIn
        ? "This is real homework that hasn't been handed in to school yet: in feedback, name the first wrong step and the principle, and do NOT give the full answer."
        : "Practice problem: feedback may show the correct result.",
      `Problem:\n"""\n${p.prompt}\n"""`,
      `Answer key or rubric:\n"""\n${p.answerKey}\n"""`,
      `Student's answer:\n"""\n${p.answerText || "(see images)"}\n"""`,
      images.length ? `Student's work is also in ${images.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const instructions = `You are the grading agent of a study app. Judge each problem the student handed in. You only judge: you don't plan, encourage or teach beyond the feedback.

For each problem decide one verdict:
- "solved": the method and the result are right.
- "slip": the method shows the student understood, and only an execution detail is wrong (a typo, a copied number, an arithmetic slip). Always add a slipQuestion that names the exact detail and asks the student to confirm, e.g. "You set up the chain rule correctly but wrote 2·3 = 5. Was that just a typo?"
- "not_understood": a wrong method, a missing idea, or no real attempt.
If unsure between slip and not_understood, choose not_understood.

errorKind: "none" when solved, "slip" for a slip, "concept" for a wrong idea in this skill, "missing_fundamental" when the error comes from one of the listed fundamentals (then set fundamentalSkillId to its id).
firstWrongStep: quote or describe the first line that goes wrong; null when solved.
feedback: 2 to 5 sentences in the language the student wrote in: what is right, the first wrong step, and the principle behind it.
points: whole or half points between 0 and maxPoints.

Reply with only a JSON array, one object per problem, in this shape:
[{"problemId":"...","verdict":"solved|slip|not_understood","points":0,"maxPoints":0,"firstWrongStep":null,"errorKind":"none|slip|concept|missing_fundamental","fundamentalSkillId":null,"slipQuestion":null,"feedback":"..."}]`;

  return [{ role: "user", content: `${instructions}\n\n${blocks.join("\n\n")}` }];
}

/** Pulls the JSON array out of the reply, tolerating a code fence or stray text around it. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in the reply");
  return JSON.parse(body.slice(start, end + 1));
}

/** Checks the agent's reply against the problems it was given. Returns the results or a list of what's wrong. */
export function parseGrading(
  text: string,
  problems: GradingProblem[],
): { ok: true; results: GradingResult[] } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, errors: [`Reply was not a JSON array (${(e as Error).message}).`] };
  }
  if (!Array.isArray(raw)) return { ok: false, errors: ["Reply was not a JSON array."] };

  const errors: string[] = [];
  const results: GradingResult[] = [];
  for (const p of problems) {
    const r = raw.find((x) => x && typeof x === "object" && (x as { problemId?: unknown }).problemId === p.problemId) as
      | Record<string, unknown>
      | undefined;
    if (!r) {
      errors.push(`Missing problem ${p.problemId}.`);
      continue;
    }
    const verdict = r.verdict as Verdict;
    const errorKind = (r.errorKind ?? (verdict === "solved" ? "none" : "concept")) as ErrorKind;
    const points = Number(r.points);
    const fundamentalSkillId = typeof r.fundamentalSkillId === "string" ? r.fundamentalSkillId : null;
    const slipQuestion = typeof r.slipQuestion === "string" && r.slipQuestion.trim() ? r.slipQuestion.trim() : null;
    const feedback = typeof r.feedback === "string" ? r.feedback.trim() : "";

    if (!VERDICTS.includes(verdict)) errors.push(`${p.problemId}: unknown verdict "${String(r.verdict)}".`);
    if (!ERROR_KINDS.includes(errorKind)) errors.push(`${p.problemId}: unknown errorKind "${String(r.errorKind)}".`);
    if (!Number.isFinite(points) || points < 0 || points > p.maxPoints)
      errors.push(`${p.problemId}: points must be between 0 and ${p.maxPoints}.`);
    if (verdict === "slip" && !slipQuestion) errors.push(`${p.problemId}: a slip needs a slipQuestion.`);
    if (errorKind === "missing_fundamental" && !p.fundamentals.some((f) => f.skillId === fundamentalSkillId))
      errors.push(`${p.problemId}: fundamentalSkillId must be one of the listed fundamentals.`);
    if (!feedback) errors.push(`${p.problemId}: feedback is empty.`);

    results.push({
      problemId: p.problemId,
      verdict,
      points,
      maxPoints: p.maxPoints,
      firstWrongStep: typeof r.firstWrongStep === "string" && r.firstWrongStep.trim() ? r.firstWrongStep.trim() : null,
      errorKind,
      fundamentalSkillId: errorKind === "missing_fundamental" ? fundamentalSkillId : null,
      slipQuestion: verdict === "slip" ? slipQuestion : null,
      feedback,
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, results };
}

export class GradingFailed extends Error {
  constructor(public errors: string[]) {
    super(`The grading agent's answer couldn't be used: ${errors.join(" ")}`);
  }
}

type Ask = (turns: Turn[], opts?: AskOptions) => Promise<string>;

/**
 * Splits problems into groups that each carry at most `limit` images, in
 * order, so every photo of a student's work reaches the grader. A limit of 0
 * means unknown: one group. A single problem with more photos than the limit
 * can't be graded here and fails visibly. Pure.
 */
export function imageGroups(problems: GradingProblem[], limit: number): GradingProblem[][] {
  if (!limit) return [problems];
  const groups: GradingProblem[][] = [];
  let group: GradingProblem[] = [];
  let count = 0;
  for (const p of problems) {
    const n = p.answerImages?.length ?? 0;
    if (n > limit) throw { code: "image_rejected", message: `One answer has ${n} photos; at most ${limit} can be sent at once.` } satisfies AskError;
    if (group.length && count + n > limit) {
      groups.push(group);
      group = [];
      count = 0;
    }
    group.push(p);
    count += n;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * Grades a hand-in. A reply that fails the checks is retried once with the
 * problems listed. Photos are never left out: a hand-in with more photos than
 * one question can carry is graded in several calls (`imageLimit`, read from
 * the view by default).
 */
export async function gradeProblems(problems: GradingProblem[], ask: Ask = askClaude, signal?: AbortSignal, imageLimit?: number): Promise<GradingResult[]> {
  const hasImages = problems.some((p) => p.answerImages?.length);
  const limit = hasImages ? (imageLimit ?? (await maxImages())) : 0;
  const results: GradingResult[] = [];
  for (const group of imageGroups(problems, limit)) results.push(...(await gradeGroup(group, ask, signal)));
  return results;
}

async function gradeGroup(problems: GradingProblem[], ask: Ask, signal?: AbortSignal): Promise<GradingResult[]> {
  const turns = gradingTurns(problems);
  const images = problems.flatMap((p) => p.answerImages ?? []);
  const opts: AskOptions = { images: images.length ? images : undefined, strictImages: true, signal, tier: "default" };

  const first = await ask(turns, opts);
  const parsed = parseGrading(first, problems);
  if (parsed.ok) return parsed.results;

  const retry: Turn[] = [
    ...turns,
    { role: "assistant", content: first },
    { role: "user", content: `That reply can't be used:\n- ${parsed.errors.join("\n- ")}\nReply again with only the corrected JSON array.` },
  ];
  const second = parseGrading(await ask(retry, opts), problems);
  if (second.ok) return second.results;
  throw new GradingFailed(second.errors);
}

/** Turns a verdict into the attempt that gets stored, plus a review item for anything wrong. */
export function recordResult(
  p: GradingProblem,
  r: GradingResult,
  meta: { attemptId: string; questId: string | null; day: Day; activeSeconds: number; startedAt: number; now: number },
): { attempt: Attempt; review: ReviewItem | null } {
  const attempt: Attempt = {
    id: meta.attemptId,
    skillId: p.skillId,
    questId: meta.questId,
    part: p.part,
    day: meta.day,
    verdict: r.verdict,
    points: r.points,
    maxPoints: r.maxPoints,
    hintsUsed: p.hintsUsed,
    sawWorkedExample: p.sawWorkedExample,
    activeSeconds: meta.activeSeconds,
    startedAt: meta.startedAt,
    gradedAt: meta.now,
  };
  const review: ReviewItem | null =
    r.verdict === "solved"
      ? null
      : {
          attemptId: attempt.id,
          kind: r.verdict === "slip" ? "slip" : "real_error",
          status: "open",
          slipAnswer: null,
          slipQuestion: r.slipQuestion,
          chatId: null,
          updatedAt: meta.now,
        };
  return { attempt, review };
}

/** The student's answer to a slip question. "No, it was a real mistake" turns it into a real error. */
export function answerSlip(item: ReviewItem, confirmed: boolean, now: number): ReviewItem {
  return {
    ...item,
    status: "answered",
    slipAnswer: confirmed ? "confirmed" : "disputed",
    kind: confirmed ? "slip" : "real_error",
    updatedAt: now,
  };
}
