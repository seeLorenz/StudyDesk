// The mistake review: after grading, a chat at the top of the quest page that
// walks the student through what went wrong, one mistake at a time. Built on
// the first version's tutor, which worked: Socratic first, a clear
// first-principles explanation when stuck, and one fresh check question.

import type { Chat, Message } from "../chat/types";
import type { Skill } from "../mastery/types";
import { answerTextFor, answerUnlocked } from "./handin";
import type { Assignment, ProblemPart, Quest, QuestProblem, QuestProgress } from "./types";
import { STYLE } from "./write";

export type Mistake = {
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
    if (part.kind === "learn") continue;
    for (const p of part.problems) {
      const w = progress.work[p.id];
      if (!w?.verdict) continue;
      const wrong = w.verdict === "not_understood" || (w.verdict === "slip" && w.slipAnswer === "disputed");
      if (!wrong) continue;
      const a = part.kind === "assignment" ? assignments.find((x) => x.id === part.assignmentId) : undefined;
      out.push({
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
      (m, i) => `### ${name(m, i)}
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
- When their reasoning is fixed, give ONE fresh check question on the same idea (new numbers, 2 to 5 minutes). Judge their answer honestly, then move on to the next mistake.
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
