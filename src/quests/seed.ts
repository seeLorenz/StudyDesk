// Sample semester data until the Start New Semester flow exists. It has the
// same shape onboarding and the setup session will write (design/onboarding.md):
// one calculus course with skills, two homework sheets, an exam, a timetable
// and a study goal. Dates are relative to the day the sample is created, so the
// first quest always has homework due the next day.
//
// Also here: stand-ins for Claude in local development (no claude.ai), so the
// quest page can be clicked through without a real model.

import { addDays } from "../mastery/days";
import type { Day, Skill } from "../mastery/types";
import type { Turn } from "../platform/claude";
import type { PartWriter } from "./write";
import type { Semester, TimetableEntry } from "./types";

const AUSTRIAN = { name: "Austrian 1–5", best: 1, worst: 5 };

const sk = (s: Partial<Skill> & Pick<Skill, "id" | "name" | "topicId" | "estMinutes">): Skill => ({
  courseId: "calc",
  difficulty: "normal",
  isFundamental: false,
  prereqSkillIds: [],
  tier: 3,
  weight: 1,
  ...s,
});

export const SAMPLE_SKILLS: Skill[] = [
  sk({ id: "sk_factorial-quotients", name: "Simplify factorial quotients", topicId: "t_fund", isFundamental: true, tier: 4, estMinutes: 2 }),
  sk({ id: "sk_rational-limits", name: "Limits of rational expressions", topicId: "t_fund", isFundamental: true, tier: 4, estMinutes: 2 }),
  sk({ id: "sk_nth-root-limits", name: "Limits of n-th roots", topicId: "t_fund", isFundamental: true, tier: 4, estMinutes: 2 }),
  sk({ id: "sk_series-def", name: "What it means for a series to converge", topicId: "t_series", tier: 4, estMinutes: 3 }),
  sk({ id: "sk_geometric", name: "Geometric series", topicId: "t_series", prereqSkillIds: ["sk_series-def"], tier: 4, estMinutes: 4 }),
  sk({ id: "sk_ratio-test", name: "Ratio test", topicId: "t_series", prereqSkillIds: ["sk_series-def", "sk_factorial-quotients", "sk_rational-limits"], estMinutes: 7, weight: 2 }),
  sk({ id: "sk_root-test", name: "Root test", topicId: "t_series", prereqSkillIds: ["sk_series-def", "sk_rational-limits", "sk_nth-root-limits"], estMinutes: 6, weight: 2 }),
  sk({ id: "sk_comparison", name: "Comparison test", topicId: "t_series", prereqSkillIds: ["sk_series-def", "sk_geometric"], tier: 2, estMinutes: 7 }),
  sk({ id: "sk_leibniz", name: "Alternating series (Leibniz criterion)", topicId: "t_series", prereqSkillIds: ["sk_series-def", "sk_rational-limits"], tier: 2, difficulty: "hard", estMinutes: 8 }),
];

/** A fresh sample semester anchored on `today`. Each anchor gets its own sheet ids, so a restart has open homework again. */
export function sampleSemester(today: Day, now = Date.now()): Semester {
  const tag = today.replace(/-/g, "");
  return {
    id: `sem_sample_${tag}`,
    name: "Sample semester",
    source: "sample",
    createdAt: now,
    courses: [
      {
        id: "calc",
        name: "Calculus 1",
        short: "Calc",
        teachingLanguage: "English",
        topics: [
          { id: "t_fund", name: "Fundamentals" },
          { id: "t_series", name: "Series" },
        ],
      },
    ],
    targets: [{ courseId: "calc", targetGrade: 2, gradeScale: AUSTRIAN }],
    skills: SAMPLE_SKILLS,
    assignments: [
      {
        id: `calc-sheet4-${tag}`,
        courseId: "calc",
        title: "Sheet 4",
        dueAt: `${addDays(today, 1)}T11:00`,
        tasks: [
          { id: `s4-2a-${tag}`, label: "4.2a", skillId: "sk_ratio-test", maxPoints: 4, prompt: "Decide whether the series $\\sum_{n\\ge 1} \\frac{(2n)!}{2^n (n!)^2}$ converges, and whether it converges absolutely." },
          { id: `s4-2b-${tag}`, label: "4.2b", skillId: "sk_root-test", maxPoints: 4, prompt: "Decide whether the series $\\sum_{n\\ge 1} \\left(\\frac{1+2n}{3n+4n^2}\\right)^n$ converges, and whether it converges absolutely." },
        ],
      },
      {
        id: `calc-sheet5-${tag}`,
        courseId: "calc",
        title: "Sheet 5",
        dueAt: `${addDays(today, 8)}T11:00`,
        tasks: [
          { id: `s5-1-${tag}`, label: "5.1", skillId: "sk_geometric", maxPoints: 3, prompt: "Compute $\\sum_{n\\ge 0} \\frac{3^n + 2^n}{5^n}$." },
          { id: `s5-2-${tag}`, label: "5.2", skillId: "sk_comparison", maxPoints: 4, prompt: "Show that $\\sum_{n\\ge 1} \\frac{1}{n^2 + n}$ converges by comparing it with a series you know." },
          { id: `s5-3-${tag}`, label: "5.3", skillId: "sk_leibniz", maxPoints: 4, prompt: "Does $\\sum_{n\\ge 1} \\frac{(-1)^n}{\\sqrt{n}}$ converge? Does it converge absolutely? Justify both answers." },
        ],
      },
    ],
    keyDates: [
      { courseId: "calc", date: addDays(today, 30), kind: "exam", title: "Midterm", skillIds: SAMPLE_SKILLS.map((s) => s.id) },
    ],
    timetable: [
      ...[1, 2, 4].map((weekday): TimetableEntry => ({ weekday, start: "10:00", end: "11:30", kind: "lecture", title: "Calculus 1 lecture", courseId: "calc" })),
      { weekday: 3, start: "13:00", end: "14:30", kind: "exercise", title: "Calculus 1 exercise class", courseId: "calc" },
    ],
    // Sunday off, 3.5 h on weekdays, 4 h on Saturday.
    studyGoal: [0, 210, 210, 210, 210, 210, 240],
  };
}

// ---------- local stand-ins for Claude ----------

const BANK: Record<string, Array<[string, string]>> = {
  "sk_factorial-quotients": [["Simplify $\\frac{(n+1)!}{n!}$ and $\\frac{(2n+2)!}{(2n)!}$.", "$n+1$ and $(2n+2)(2n+1)$."]],
  "sk_rational-limits": [["Find $\\lim_{n\\to\\infty} \\frac{2n+1}{3n+5}$ and say which power of $n$ you divided by.", "Divide by $n$: $\\frac{2+1/n}{3+5/n} \\to \\frac{2}{3}$."]],
  "sk_nth-root-limits": [["Find $\\lim_{n\\to\\infty} \\sqrt[n]{n}$ and $\\lim_{n\\to\\infty} \\sqrt[n]{5}$.", "Both limits are 1."]],
  "sk_series-def": [["Write the first three partial sums of $\\sum_{n\\ge 1} \\frac{1}{2^n}$. What do they settle towards?", "$\\frac12, \\frac34, \\frac78$; they settle towards 1."]],
  "sk_geometric": [["Compute $\\sum_{n\\ge 0} \\left(\\frac{2}{5}\\right)^n$.", "$\\frac{1}{1-2/5} = \\frac53$."]],
  "sk_ratio-test": [["Does $\\sum_{n\\ge1} \\frac{n^2}{3^n}$ converge? Use the ratio test.", "Ratio $\\to \\frac13 < 1$, so it converges."]],
  "sk_root-test": [["Does $\\sum_{n\\ge1} \\left(\\frac{n}{2n+1}\\right)^n$ converge? Use the root test.", "n-th root $\\to \\frac12 < 1$, so it converges."]],
  "sk_comparison": [["Show that $\\sum_{n\\ge1} \\frac{1}{n^2+1}$ converges.", "$\\frac{1}{n^2+1} \\le \\frac{1}{n^2}$ and $\\sum \\frac1{n^2}$ converges."]],
  "sk_leibniz": [["Does $\\sum_{n\\ge1} \\frac{(-1)^n}{n}$ converge?", "Yes by Leibniz ($1/n$ decreases to 0); not absolutely."]],
};

/** Writes quests from a tiny built-in bank. Used only outside claude.ai. */
export function sampleWriter(skills: Skill[]): PartWriter {
  const name = (id: string) => skills.find((s) => s.id === id)?.name ?? id;
  return {
    async learn(_q, part) {
      await new Promise((r) => setTimeout(r, 300));
      return {
        title: `What is ${part.skillIds.map(name).join(" and ").toLowerCase()}?`,
        body: `*Local preview: inside claude.ai, Claude writes this explanation from first principles.*\n\n### What is this about?\nThis part would explain **${part.skillIds.map(name).join(", ")}** step by step, with numbers first and the tricky step done slowly.\n\n$$\\sum_{n\\ge 0} q^n = \\frac{1}{1-q} \\quad (|q| < 1)$$\n\n### Checklist\n1. Write out the first few terms.\n2. Do the terms go to 0?\n3. Pick the test that fits.`,
      };
    },
    async lesson(_q, part) {
      await new Promise((r) => setTimeout(r, 300));
      const id = part.skillIds![0];
      const [prompt, answerKey] = BANK[id]?.[0] ?? [`A short problem on ${name(id)}.`, "Sample answer."];
      return {
        title: `How does ${name(id).toLowerCase()} work?`,
        body: `*Local preview: inside claude.ai, Claude writes a short first-principles explanation here.*\n\n### What is this about?\nOne idea only: **${name(id)}**, with numbers first.\n\n### Worked example\n\nA solved example in the same shape as your problem below.`,
        problems: [{ id: part.problems[0].id, prompt, answerKey }],
      };
    },
    async practice(_q, part) {
      await new Promise((r) => setTimeout(r, 300));
      return part.problems.map((p) => {
        const [prompt, answerKey] = BANK[p.skillId]?.[0] ?? [`A practice problem on ${name(p.skillId)}.`, "Sample answer."];
        return { id: p.id, prompt, answerKey };
      });
    },
    async assignment(_q, part) {
      await new Promise((r) => setTimeout(r, 300));
      return part.problems.map((p) => ({
        id: p.id,
        answerKey: "Sample worked answer (local preview).",
        hints: ["Which test fits the shape of the terms?", "Write the ratio (or the n-th root) and simplify it.", "Is the limit below, above or equal to 1?"],
        similarSolved: `*Local preview.* A solved similar problem on ${name(p.skillId).toLowerCase()} would appear here.`,
      }));
    },
  };
}

/**
 * Stands in for the grading agent outside claude.ai: an empty answer is not
 * understood, an answer containing "typo" is a slip, anything else is solved.
 */
export async function sampleGradingAsk(turns: Turn[]): Promise<string> {
  const text = turns[turns.length - 1].content;
  const blocks = text.split(/^### Problem /m).slice(1);
  await new Promise((r) => setTimeout(r, 400));
  const out = blocks.map((b) => {
    const id = b.split("\n")[0].trim();
    const max = Number(/Max points: ([\d.]+)/.exec(b)?.[1] ?? 1);
    const answer = /Student's answer:\n"""\n([\s\S]*?)\n"""/.exec(b)?.[1] ?? "";
    const hasImage = /Student's work is also in image/.test(b);
    const empty = (!answer.trim() || answer.trim() === "(see images)") && !hasImage;
    if (empty)
      return { problemId: id, verdict: "not_understood", points: 0, maxPoints: max, firstWrongStep: "No answer.", errorKind: "concept", fundamentalSkillId: null, slipQuestion: null, feedback: "Local preview: there was no answer to judge." };
    if (/typo/i.test(answer))
      return { problemId: id, verdict: "slip", points: max / 2, maxPoints: max, firstWrongStep: "The last line.", errorKind: "slip", fundamentalSkillId: null, slipQuestion: "Your method is right but the last number is off. Was that just a typo?", feedback: "Local preview: the method is right, one detail is off." };
    return { problemId: id, verdict: "solved", points: max, maxPoints: max, firstWrongStep: null, errorKind: "none", fundamentalSkillId: null, slipQuestion: null, feedback: "Local preview: marked as solved. Inside claude.ai the grading agent judges the real answer." };
  });
  return JSON.stringify(out);
}

/** A fix-it from the built-in bank. Used only outside claude.ai. */
export async function sampleFixIt(problem: import("./types").QuestProblem): Promise<import("./types").FixIt> {
  await new Promise((r) => setTimeout(r, 300));
  const [prompt, answerKey] = BANK[problem.skillId]?.[0] ?? ["Try a similar problem.", "Sample answer."];
  return {
    skillId: problem.skillId,
    fromProblemId: problem.id,
    explanation: "*Local preview: inside claude.ai, Claude explains exactly the idea your answer was missing.*",
    problem: { ...problem, id: `${problem.id}-fix`, label: undefined, prompt, answerKey, hints: [], similarSolved: null },
  };
}
