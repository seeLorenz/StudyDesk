// The mistake review: after grading, a chat at the top of the quest page that
// walks the student through what went wrong, one mistake at a time. Built on
// the first version's tutor, which worked: Socratic first, a clear
// first-principles explanation when stuck, and one fresh check question.

import type { Chat, Message } from "../chat/types";
import type { Attempt, Day, ReviewItem, Skill } from "../mastery/types";
import { answerTextFor, answerUnlocked } from "./handin";
import type { Assignment, ProblemPart, Quest, QuestProblem, QuestProgress } from "./types";
import { STYLE } from "./write";

export type Mistake = {
  /** The attempt that went wrong; its review item tracks whether the mistake is resolved. */
  attemptId: string;
  problem: QuestProblem;
  part: ProblemPart;
  skillName: string;
  answer: string;
  feedback: string;
  firstWrongStep: string | null;
  points: number;
  /** Real homework not handed in yet: hints only. */
  homeworkOpen: boolean;
};

/** Problems that weren't understood, and slips the student said were real mistakes. */
export function questMistakes(quest: Quest, progress: QuestProgress, skills: Map<string, Skill>, assignments: Assignment[], nowLocal: string): Mistake[] {
  const out: Mistake[] = [];
  for (const part of quest.parts) {
    // A miss in the placement check is a gap, not a mistake: the next quests teach it from the start.
    if (part.kind === "learn" || part.check) continue;
    for (const p of part.problems) {
      const w = progress.work[p.id];
      if (!w?.verdict) continue;
      const wrong = w.verdict === "not_understood" || (w.verdict === "slip" && w.slipAnswer === "disputed");
      if (!wrong) continue;
      const a = part.kind === "assignment" ? assignments.find((x) => x.id === part.assignmentId) : undefined;
      out.push({
        attemptId: w.attemptId ?? "",
        problem: p,
        part,
        skillName: skills.get(p.skillId)?.name ?? "",
        answer: answerTextFor(w),
        feedback: w.feedback ?? "",
        firstWrongStep: w.firstWrongStep ?? null,
        points: w.points ?? 0,
        homeworkOpen: part.kind === "assignment" && !answerUnlocked(a, nowLocal),
      });
    }
  }
  return out;
}

const name = (m: Mistake, _i: number) => (m.problem.label ? `Task ${m.problem.label} (${m.skillName})` : `${m.skillName} (practice problem)`);

export function reviewRules(mistakes: Mistake[], courseName: string, language: string): string {
  const list = mistakes
    .map(
      (m, i) => `### ${name(m, i)} [id: ${m.problem.id}]
Problem:
"""
${m.problem.prompt}
"""
Student's answer:
"""
${m.answer || "(no answer)"}
"""
Grade: ${m.points} / ${m.problem.maxPoints}
Grader's feedback: ${m.feedback}${m.firstWrongStep ? `\nFirst wrong step: ${m.firstWrongStep}` : ""}
Worked answer (for you only${m.homeworkOpen ? "; this is real homework not handed in yet, so NEVER reveal it or a finished step" : ""}):
"""
${m.problem.answerKey}
"""`,
    )
    .join("\n\n");

  return `You are StudyDesk's mistake-review tutor for the course ${courseName}. Today's quest has been graded, and this chat goes through the student's mistakes so they understand exactly where and why their answer went wrong, and could get it right alone next time.

How to talk:
- Go through the mistakes in the order below, one at a time. Say which one you're on.
- Socratic first: ask the student to explain what they did at the step where it went wrong, or ask one guiding question that points at that step. Don't give the correct answer straight away.
- One question at a time. Keep each message short (2 to 6 sentences). Build from definitions, not tricks.
- If the student is stuck after 2 or 3 tries on the same point, or says they have no idea, stop asking and explain it from first principles, then ask them to redo their step.
- A mistake is only resolved when the student solves a fresh problem on the same idea completely on their own. Understanding the explanation, agreeing, or fixing their old answer with your help is NOT enough. So when their reasoning is fixed, give ONE fresh check problem (new numbers or a slightly different setup, 2 to 5 minutes) and let them solve it alone. Don't give any step of that problem; if they ask for help or you end up giving a step, help them, then give another fresh check problem. Judge their full solution honestly: right method AND right result. A small input error in an otherwise correct solution may pass; a logic error never passes. End that judging message with the marker [[check:passed:ID]] if it is essentially right, or [[check:failed:ID]] if not (ID is the mistake's id shown below; then explain the gap and offer another try). Use the marker only when judging a check question. After a pass, move on to the next mistake.
- For real homework that isn't handed in yet: hints and principles only, never the answer or a finished step.
- After the last mistake, give a 2 to 4 point summary of what to remember.
- Be honest and warm; no empty praise. Write in ${language} unless the student writes in another language.

${STYLE}

The mistakes:

${list}`;
}

/** The chat's opening message, written by code so opening the review costs nothing. */
export function reviewIntro(mistakes: Mistake[]): string {
  const lines = mistakes.map((m, i) => `${i + 1}. **${name(m, i)}**`);
  const first = mistakes[0];
  return `Today's quest is graded. ${mistakes.length === 1 ? "One thing" : `${mistakes.length} things`} went wrong, so let's go through ${mistakes.length === 1 ? "it" : "them one at a time"}:

${lines.join("\n")}

Let's start with **${name(first, 0)}**. Without looking anything up: how did you approach it, and where did you get stuck?`;
}

export function newReviewChat(quest: Quest, mistakes: Mistake[]): Chat {
  const now = Date.now();
  const intro: Message = { id: `rv_${quest.id}_intro`, role: "assistant", text: reviewIntro(mistakes), createdAt: now };
  return { id: `review_${quest.id}`, title: "Mistake review", createdAt: now, updatedAt: now, messages: [intro], notes: [] };
}

const MARKER = /\[\[check:(passed|failed):([^\]\s]+)\]\]/g;

/** Check-question results the tutor marked in the chat, latest per mistake. */
export function checkResults(chat: Chat): Map<string, "passed" | "failed"> {
  const out = new Map<string, "passed" | "failed">();
  for (const m of chat.messages) {
    if (m.role !== "assistant" || m.error) continue;
    for (const hit of m.text.matchAll(MARKER)) {
      // A pass is never taken back by a later failed try.
      if (out.get(hit[2]) !== "passed") out.set(hit[2], hit[1] as "passed" | "failed");
    }
  }
  return out;
}

/**
 * What a passed check question changes, in code: the mistake's review item is
 * resolved, and the check counts as one clean solve of the skill (a "review"
 * attempt), so the streak can move again. Each mistake counts once.
 */
export function applyChecks(
  mistakes: Mistake[],
  results: Map<string, "passed" | "failed">,
  reviews: ReviewItem[],
  questId: string,
  day: Day,
  now: number,
): { attempts: Attempt[]; reviews: ReviewItem[] } {
  const attempts: Attempt[] = [];
  const updated: ReviewItem[] = [];
  for (const m of mistakes) {
    if (results.get(m.problem.id) !== "passed") continue;
    const item = reviews.find((r) => r.attemptId === m.attemptId);
    if (item?.status === "resolved") continue;
    if (item) updated.push({ ...item, status: "resolved", updatedAt: now });
    attempts.push({
      id: `${m.attemptId}_check`,
      skillId: m.problem.skillId,
      questId,
      part: "review",
      day,
      verdict: "solved",
      points: 1,
      maxPoints: 1,
      hintsUsed: 0,
      sawWorkedExample: false,
      activeSeconds: 0,
      startedAt: now,
      gradedAt: now,
    });
  }
  return { attempts, reviews: updated };
}

export function isResolved(m: Mistake, reviews: ReviewItem[]): boolean {
  return reviews.find((r) => r.attemptId === m.attemptId)?.status === "resolved";
}
