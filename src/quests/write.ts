// Claude writes the text inside a planned quest: explanations, practice
// problems, answer keys, hints and solved similar problems. Code already chose
// the skills and the minutes (plan.ts), so these calls never decide what goes
// into a quest.
//
// Replies use plain "=== KEY ===" sections instead of JSON, because math in
// JSON strings breaks easily (a "\frac" is not valid JSON).

import type { AskOptions, Turn } from "../platform/claude";
import type { Skill } from "../mastery/types";
import { applyQuestSettings, partMinutes, QUEST_CONFIG } from "./config";
import { readMinutes } from "./reading";
import type { Card, Course, FixIt, LearnPart, ProblemPart, Quest, QuestProblem, Semester } from "./types";

export type Ask = (turns: Turn[], opts?: AskOptions) => Promise<string>;

/** How StudyDesk explains things. Taken from the explanation style that worked in the first version. */
export const STYLE = `How to explain (StudyDesk style):
- Start from the very beginning. Before using a word or symbol, say in plain words what it is. Use the questions a confused beginner would ask as headings ("What is a series?", "What does converge mean?").
- Give quick reminders of prerequisites right where they're needed, with 2 or 3 tiny numeric examples.
- Concrete before abstract: plug in real numbers first and let the pattern show before stating the rule.
- Intuition, then the rule, then why the rule must be true ("Think about it: ..."), then the formal tool. Give the official name and the course's own term once the idea is clear.
- Never skip algebra. Include a short section "The tricky step, slowly" that does it line by line.
- Show limits and trends with a tiny table of values (n = 10, 100, 1000).
- Short paragraphs, plain conversational language, bold only for the one key rule.
- End with a short checklist the student can reuse on the next problem of this kind.
- Math in TeX: $...$ inline, $$...$$ on its own line.`;

const CUT_SHORT = "The answer was cut short";

/** Splits a reply into its "=== KEY ===" sections. Keys are upper-cased. */
export function parseSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^===\s*(.+?)\s*===\s*$/gm;
  const marks: Array<{ key: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ key: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim();
    out.set(mk.key, body);
  });
  return out;
}

export class WritingFailed extends Error {
  constructor(public what: string, public errors: string[]) {
    super(`Couldn't write ${what}: ${errors.join(" ")}`);
  }
}

type Ctx = { course: Course; skills: Map<string, Skill>; known: string[]; feel: string[]; anki?: boolean };

function context(semester: Semester, quest: Quest, knownSkillIds: string[], feel: string[] = []): Ctx {
  return {
    feel,
    anki: semester.questSettings?.anki,
    course: semester.courses.find((c) => c.id === quest.courseId)!,
    skills: new Map(semester.skills.map((s) => [s.id, s])),
    known: knownSkillIds.map((id) => semester.skills.find((s) => s.id === id)?.name).filter(Boolean) as string[],
  };
}

const skillLine = (ctx: Ctx, id: string) => {
  const s = ctx.skills.get(id)!;
  const pre = s.prereqSkillIds.map((p) => ctx.skills.get(p)?.name).filter(Boolean);
  return `- ${s.name}${s.isFundamental ? " (a fundamental)" : ""}${s.difficulty === "hard" ? " (hard)" : ""}${pre.length ? `; builds on: ${pre.join(", ")}` : ""}`;
};

const header = (ctx: Ctx) =>
  `Course: ${ctx.course.name}. Write in ${ctx.course.teachingLanguage}, the language the course is taught in.
${ctx.known.length ? `The student can already do: ${ctx.known.join(", ")}.` : "Assume the student knows only school basics unless a skill says otherwise."}${
    ctx.feel.length
      ? `\nHow recent quest parts felt to the student (adjust: "too hard" means slower, smaller steps and an easier own problem; "too easy" means brisker and a harder own problem):\n${ctx.feel.map((f) => `- ${f}`).join("\n")}`
      : ""
  }`;

/** "front | back" lines; anything else (NONE) is skipped. */
export function parseCards(text = ""): Card[] {
  return text.split("\n").flatMap((l) => {
    const [front, ...back] = l.replace(/^\s*[-*]\s*/, "").split(" | ");
    return back.length && front.trim() ? [{ front: front.trim(), back: back.join(" | ").trim() }] : [];
  });
}

/** What comes after a learn part, so the explanation prepares for it. */
function upcoming(quest: Quest, part: { skillIds?: string[] }, ctx: Ctx): string {
  const skillIds = part.skillIds ?? [];
  const i = quest.parts.findIndex((p) => p === part || (p as { id: string }).id === (part as { id?: string }).id);
  const later = quest.parts.slice(i + 1).filter((p): p is ProblemPart => p.kind !== "learn");
  const lines = later.flatMap((p) =>
    p.problems.filter((q) => skillIds.includes(q.skillId)).map((q) => (q.prompt ? `- ${q.label ?? ""} ${q.prompt}`.trim() : `- a practice problem on ${ctx.skills.get(q.skillId)!.name}`)),
  );
  return lines.length ? `Later in today's quest the student will solve:\n${lines.join("\n")}\nPrepare them for exactly these, without solving any of them.` : "";
}

export function learnTurns(quest: Quest, part: LearnPart, ctx: Ctx): Turn[] {
  return [
    {
      role: "user",
      content: `You write one "learn" part of today's study quest: an explanation from first principles, read in about ${part.estMinutes} minutes.

${header(ctx)}

Explain these skills:
${part.skillIds.map((id) => skillLine(ctx, id)).join("\n")}

${upcoming(quest, part, ctx)}

${STYLE}

Reply in this exact format and nothing else:
=== TITLE ===
a short title in the form of a question the student would ask
=== BODY ===
the explanation in Markdown`,
    },
  ];
}

const rateOf = (q: Quest) => q.readRate ?? QUEST_CONFIG.reading.startRate;
/** The lesson's length target: its planned reading minutes at the student's rate, to the nearest 10. */
const lessonWords = (q: Quest, part: ProblemPart) => Math.round(((part.readMinutes ?? QUEST_CONFIG.lesson.readMinutes) * rateOf(q)) / 10) * 10;

export function lessonTurns(quest: Quest, part: ProblemPart, ctx: Ctx): Turn[] {
  const id = part.skillIds![0];
  const p = part.problems[0];
  return [
    {
      role: "user",
      content: `You write one short lesson of today's study quest. It teaches ONE idea in a quick cycle: a brief explanation, one worked example, then the student solves a problem on their own straight away. Keep the explanation and worked example together to about ${lessonWords(quest, part)} words, where a displayed formula counts as ${QUEST_CONFIG.reading.displayFormula} words and an inline one as ${QUEST_CONFIG.reading.inlineFormula}: that's what this student reads in about ${part.readMinutes ?? QUEST_CONFIG.lesson.readMinutes} minutes. Teach exactly this idea, nothing around it.

${header(ctx)}

The idea:
${skillLine(ctx, id)}

${upcoming(quest, part, ctx)}

${STYLE}
(Here the checklist at the end is 2 or 3 lines at most.)${
        ctx.anki
          ? `\n\nThe student learns by heart with Anki. If this idea is vocabulary or other things learned purely by heart (terms and their meaning, names, fixed facts), list every item in CARDS as "front | back", one per line: the word or term in front, its meaning or translation on the back. These cards become the student's deck for this idea, so make it complete. Never methods or problem solving. If there is nothing to learn by heart, write NONE.`
          : ""
      }

Then write the student's own problem (${p.id}): like the worked example but with different numbers, solvable in about ${p.expMinutes} min, with one clear final answer.

Reply in this exact format and nothing else:
=== TITLE ===
a short title in the form of a question the student would ask
=== EXPLANATION ===
Markdown
=== WORKED EXAMPLE ===
Markdown: the problem, then the solution step by step
=== KEY RULE ===
the one key rule of this idea, in one plain sentence (the student writes theirs first, then compares)
=== ${p.id} PROMPT ===
the student's problem, Markdown
=== ${p.id} ANSWER ===
worked solution with the final result${ctx.anki ? "\n=== CARDS ===\nfront | back lines, or NONE" : ""}`,
    },
  ];
}

export function practiceTurns(part: ProblemPart, ctx: Ctx): Turn[] {
  const slots = part.problems
    .map((p) =>
      part.explain
        ? `${p.id}: ask the student to explain "${ctx.skills.get(p.skillId)!.name}" in their own words, as if teaching a classmate who missed it: the idea, why it works, when to use it, and a typical trap. No calculation needed. Here the ANSWER is the list of points a complete explanation covers`
        : p.cards
        ? `${p.id}: a recall test on "${ctx.skills.get(p.skillId)!.name}" from the student's Anki deck, about ${p.expMinutes} min. Ask for exactly these cards, mixed order, some from the back to the front: ${p.cards.map((c) => `${c.front} = ${c.back}`).join("; ")}`
        : `${p.id}: skill "${ctx.skills.get(p.skillId)!.name}"${ctx.skills.get(p.skillId)!.isFundamental ? " (fundamental)" : ""}, solvable in about ${p.expMinutes} min`,
    )
    .join("\n");
  return [
    {
      role: "user",
      content: `You write practice problems for today's study quest. Each problem tests exactly one skill. Use fresh numbers; keep each problem short and unambiguous, with one clear final answer.${part.gate ? " These check fundamentals the rest of the quest depends on, so they should reveal whether the student really has the skill." : ""}

${header(ctx)}

Problems to write:
${slots}

For each problem write the PROMPT (Markdown, what the student sees) and the ANSWER (a worked solution with the final result, used for grading and shown after hand-in).

Reply in this exact format and nothing else, for every problem id:
${part.problems.map((p) => `=== ${p.id} PROMPT ===\n...\n=== ${p.id} ANSWER ===\n...`).join("\n")}`,
    },
  ];
}

export function assignmentTurns(part: ProblemPart, ctx: Ctx): Turn[] {
  const n = QUEST_CONFIG.hints;
  const tasks = part.problems.map((p) => `${p.id} (task ${p.label}, skill "${ctx.skills.get(p.skillId)!.name}"):\n"""\n${p.prompt}\n"""`).join("\n\n");
  return [
    {
      role: "user",
      content: `The student is about to work on real homework that will be handed in at school. They write the answers themselves; you prepare the help around it.

${header(ctx)}

Tasks:
${tasks}

For each task write:
- ANSWER: a complete worked solution and rubric for the grader. The student does not see it before the hand-in date.
- HINT 1 to HINT ${n}: one at a time, each a little more specific. Hints guide with a question or a principle ("Which test fits factorials?"); they never give the answer or a finished step.
- SIMILAR: a fully solved similar problem with different numbers, in the StudyDesk style, so a student who is stuck after ${n} hints can see the method and then go back to the real task.

${STYLE}

Reply in this exact format and nothing else, for every task id:
${part.problems.map((p) => [`=== ${p.id} ANSWER ===`, "...", ...Array.from({ length: n }, (_, i) => `=== ${p.id} HINT ${i + 1} ===\n...`), `=== ${p.id} SIMILAR ===`, "..."].join("\n")).join("\n")}`,
    },
  ];
}

function check(text: string, keys: string[]): string[] {
  const errors: string[] = [];
  if (text.includes(CUT_SHORT)) errors.push("The reply was cut off.");
  const sec = parseSections(text);
  for (const k of keys) if (!sec.get(k)?.trim()) errors.push(`Section "=== ${k} ===" is missing or empty.`);
  return errors;
}

/** Asks, checks the sections, and retries once with what was wrong. */
async function askSections(ask: Ask, turns: Turn[], keys: string[], what: string, tier: AskOptions["tier"], signal?: AbortSignal) {
  const first = await ask(turns, { tier, signal });
  let errors = check(first, keys);
  if (!errors.length) return parseSections(first);
  const retry: Turn[] = [
    ...turns,
    { role: "assistant", content: first },
    { role: "user", content: `That reply can't be used:\n- ${errors.join("\n- ")}\nReply again in the exact format, shorter if needed.` },
  ];
  const second = await ask(retry, { tier, signal });
  errors = check(second, keys);
  if (!errors.length) return parseSections(second);
  throw new WritingFailed(what, errors);
}

export type PartWriter = {
  learn(quest: Quest, part: LearnPart): Promise<Pick<LearnPart, "title" | "body">>;
  lesson(quest: Quest, part: ProblemPart): Promise<{ title: string; body: string; keyRule?: string; cards?: Card[]; problems: Array<Pick<QuestProblem, "id" | "prompt" | "answerKey">> }>;
  practice(quest: Quest, part: ProblemPart): Promise<Array<Pick<QuestProblem, "id" | "prompt" | "answerKey">>>;
  assignment(quest: Quest, part: ProblemPart): Promise<Array<Pick<QuestProblem, "id" | "answerKey" | "hints" | "similarSolved">>>;
};

export function claudeWriter(semester: Semester, quest: Quest, knownSkillIds: string[], ask: Ask, signal?: AbortSignal, feel: string[] = []): PartWriter {
  applyQuestSettings(semester.questSettings);
  const ctx = context(semester, quest, knownSkillIds, feel);
  const t = QUEST_CONFIG.tiers;
  return {
    async learn(q, part) {
      const s = await askSections(ask, learnTurns(q, part, ctx), ["TITLE", "BODY"], `the explanation "${part.title}"`, t.learn, signal);
      return { title: s.get("TITLE")!.replace(/^#+\s*/, ""), body: s.get("BODY")! };
    },
    async lesson(q, part) {
      const pid = part.problems[0].id.toUpperCase();
      const s = await askSections(
        ask,
        lessonTurns(q, part, ctx),
        ["TITLE", "EXPLANATION", "WORKED EXAMPLE", "KEY RULE", `${pid} PROMPT`, `${pid} ANSWER`, ...(ctx.anki ? ["CARDS"] : [])],
        `the lesson "${part.title}"`,
        t.lesson,
        signal,
      );
      const cards = parseCards(s.get("CARDS"));
      return {
        title: s.get("TITLE")!.replace(/^#+\s*/, ""),
        body: `${s.get("EXPLANATION")!}\n\n### Worked example\n\n${s.get("WORKED EXAMPLE")!}`,
        keyRule: s.get("KEY RULE")!,
        ...(cards.length && { cards }),
        problems: [{ id: part.problems[0].id, prompt: s.get(`${pid} PROMPT`)!, answerKey: s.get(`${pid} ANSWER`)! }],
      };
    },
    async practice(_q, part) {
      const keys = part.problems.flatMap((p) => [`${p.id.toUpperCase()} PROMPT`, `${p.id.toUpperCase()} ANSWER`]);
      const s = await askSections(ask, practiceTurns(part, ctx), keys, "the practice problems", t.practice, signal);
      return part.problems.map((p) => ({ id: p.id, prompt: s.get(`${p.id.toUpperCase()} PROMPT`)!, answerKey: s.get(`${p.id.toUpperCase()} ANSWER`)! }));
    },
    async assignment(_q, part) {
      const n = QUEST_CONFIG.hints;
      const keys = part.problems.flatMap((p) => {
        const id = p.id.toUpperCase();
        return [`${id} ANSWER`, ...Array.from({ length: n }, (_, i) => `${id} HINT ${i + 1}`), `${id} SIMILAR`];
      });
      const s = await askSections(ask, assignmentTurns(part, ctx), keys, "the homework hints", t.assignment, signal);
      return part.problems.map((p) => {
        const id = p.id.toUpperCase();
        return {
          id: p.id,
          answerKey: s.get(`${id} ANSWER`)!,
          hints: Array.from({ length: n }, (_, i) => s.get(`${id} HINT ${i + 1}`)!),
          similarSolved: s.get(`${id} SIMILAR`)!,
        };
      });
    },
  };
}

export type WriteStatus = { partId: string; state: "waiting" | "writing" | "done" | "failed"; error?: string };

/**
 * Fills every part of a planned quest. Parts are written in parallel; the
 * quest is returned only when all of them are done, so a half-written quest is
 * never stored.
 */
/** Thrown when some parts couldn't be written; `quest` holds the parts that were, so a retry can carry on. */
export class QuestIncomplete extends Error {
  /** The Claude error code behind it, so the page shows the same words as for any failed call. */
  code?: string;
  constructor(public quest: Quest, public writtenIds: string[], public cause: unknown) {
    super(cause instanceof Error ? cause.message : String((cause as { message?: string })?.message ?? cause));
    const code = (cause as { code?: unknown })?.code;
    if (typeof code === "string") this.code = code;
  }
}

/**
 * Writes every part of a planned quest. At most two parts are written at
 * once, because Claude in the page only runs a couple of calls together and a
 * flood is refused. Parts in `skip` were already written (a retry).
 */
export async function writeQuest(
  plan: Quest,
  writer: PartWriter,
  onStatus?: (s: WriteStatus) => void,
  opts: { concurrency?: number; skip?: Set<string> } = {},
): Promise<Quest> {
  const quest: Quest = JSON.parse(JSON.stringify(plan));
  // Learn parts that already have a text were written by code (the Anki step).
  const written = new Set([...(opts.skip ?? []), ...plan.parts.filter((p) => p.kind === "learn" && p.body).map((p) => p.id)]);
  for (const id of written) onStatus?.({ partId: id, state: "done" });
  const queue = quest.parts.filter((p) => !written.has(p.id));
  let failure: unknown = null;
  const writeOne = async (part: Quest["parts"][number]) => {
    onStatus?.({ partId: part.id, state: "writing" });
    try {
      if (part.kind === "learn") {
        Object.assign(part, await writer.learn(plan, part));
      } else if (part.kind === "lesson") {
        const l = await writer.lesson(plan, part);
        part.title = l.title;
        part.body = l.body;
        if (l.keyRule) part.keyRule = l.keyRule;
        if (l.cards) part.cards = l.cards;
        part.readMinutes = readMinutes(l.body, rateOf(plan));
        for (const f of l.problems) Object.assign(part.problems.find((p) => p.id === f.id)!, f);
      } else {
        const filled = part.kind === "practice" ? await writer.practice(plan, part) : await writer.assignment(plan, part);
        for (const f of filled) Object.assign(part.problems.find((p) => p.id === f.id)!, f);
      }
      written.add(part.id);
      onStatus?.({ partId: part.id, state: "done" });
    } catch (e) {
      failure ??= e;
      onStatus?.({ partId: part.id, state: "failed", error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e) });
    }
  };
  const worker = async () => {
    // After the first failure no new part starts; the ones running finish.
    for (let part = queue.shift(); part && !failure; part = queue.shift()) await writeOne(part);
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));
  // Lessons now carry the reading time of their real text.
  quest.plannedMinutes = quest.parts.reduce((s, p) => s + partMinutes(p), 0);
  if (failure) throw new QuestIncomplete(quest, [...written], failure);
  return quest;
}

// ---------- fix-it ----------

export function fixItTurns(ctx: Ctx, problem: QuestProblem, answer: string, feedback: string): Turn[] {
  const s = ctx.skills.get(problem.skillId)!;
  return [
    {
      role: "user",
      content: `A student just got a fundamentals problem wrong in today's study quest, and the rest of the quest depends on it. Write a short fix-it: a 3 to 5 minute explanation of exactly the idea they're missing, then one fresh problem on the same skill to try again.

${header(ctx)}
Skill: ${s.name}

The problem:
"""
${problem.prompt}
"""
Their answer:
"""
${answer || "(no answer)"}
"""
The grader said: ${feedback}

Start from what their answer shows they think, and fix that first. ${STYLE}

Reply in this exact format and nothing else:
=== EXPLANATION ===
Markdown
=== PROMPT ===
the new problem, Markdown
=== ANSWER ===
worked solution with the final result`,
    },
  ];
}

export async function writeFixIt(
  semester: Semester,
  quest: Quest,
  problem: QuestProblem,
  answer: string,
  feedback: string,
  ask: Ask,
  signal?: AbortSignal,
): Promise<FixIt> {
  const ctx = context(semester, quest, []);
  const s = await askSections(ask, fixItTurns(ctx, problem, answer, feedback), ["EXPLANATION", "PROMPT", "ANSWER"], "the fix-it", QUEST_CONFIG.tiers.fixIt, signal);
  return {
    skillId: problem.skillId,
    fromProblemId: problem.id,
    explanation: s.get("EXPLANATION")!,
    problem: {
      ...problem,
      id: `${problem.id}-fix`,
      label: undefined,
      prompt: s.get("PROMPT")!,
      answerKey: s.get("ANSWER")!,
      hints: [],
      similarSolved: null,
    },
  };
}
