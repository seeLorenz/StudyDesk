import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
class AnswerPending extends Error {
  constructor(callId2) {
    super(`Waiting for the answer to ${callId2}`);
    this.callId = callId2;
  }
}
function callId(turns, imageCount = 0) {
  const text = JSON.stringify(turns) + `|${imageCount}`;
  let a = 2166136261;
  let b = 16777619 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 1540483477);
  }
  return `c${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}
function deferredAsk(answers) {
  const pending = [];
  const used = /* @__PURE__ */ new Set();
  return {
    pending,
    used,
    ask: (label2, web = false) => async (turns, opts) => {
      const images = opts?.images ?? [];
      const id = callId(turns, images.length);
      const answer = answers.get(id);
      if (answer !== void 0) {
        used.add(id);
        return answer;
      }
      if (!pending.some((p) => p.id === id)) pending.push({ id, label: label2, turns, images, web });
      throw new AnswerPending(id);
    }
  };
}
const isPending = (e) => e instanceof AnswerPending || !!e && typeof e === "object" && "cause" in e && e.cause !== e && isPending(e.cause);
function guard(real, path) {
  return new Proxy({}, {
    has: (_t, prop) => prop in real,
    get(_t, prop) {
      const v = real[prop];
      if (typeof v !== "function") return v;
      const name = String(prop);
      return (...args) => {
        const out = v.apply(real, args);
        if (out && typeof out === "object" && (name === "doc" || name === "collection")) {
          const sub = out.path ?? `${path}/${String(args[0] ?? "")}`;
          return guard(out, sub);
        }
        return out;
      };
    }
  });
}
function window_() {
  const c = globalThis.claude;
  return c?.use ? c : null;
}
function host(opts = {}) {
  const c = window_();
  if (!c) return null;
  if (opts.raw) return c;
  return {
    use: (name) => c.use(name).then((ns) => name === "db" && ns ? guard(ns, "") : ns)
  };
}
function toDay(d = /* @__PURE__ */ new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const parse = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(b) - parse(a)) / 864e5);
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function busyFromAhead(ahead, day) {
  return ahead?.busy && Object.prototype.hasOwnProperty.call(ahead.busy, day) ? ahead.busy[day] : void 0;
}
const ENTRY_MARK = "[StudyDesk]";
const CONFIG = {
  defaultStreakTarget: 3,
  /**
   * Fast track: a skill solved clean on first sight, then clean again at least
   * minGapDays later (nothing but clean solves in between), is mastered after
   * `solves` solves instead of the full streak target. Outside the placement
   * check, one first-sight solve never counts as mastered on its own.
   */
  fastTrack: { solves: 2, minGapDays: 3 },
  /** Days until the next review, per ladder step. Past the last step a skill is retained. */
  ladder: {
    normal: [3, 7, 16, 35],
    hard: [2, 4, 8, 16, 35]
  },
  /** A lapsed skill restarts this many steps below where it lapsed (never below step 1). */
  lapseStepsBack: 2,
  /** A retained skill is checked once in this many days before an exam that covers it. */
  examCheckWindowDays: 7,
  timing: {
    /** Use the student's own median once they have this many timed attempts on a skill. */
    ownMedianMinAttempts: 3,
    slownessStart: 2,
    slownessMin: 1,
    slownessMax: 4
  },
  budget: {
    shareOfFreeTime: 0.8,
    paceFactor: 1.2,
    newStudentShare: 0.5
  },
  points: {
    solved: { normal: 10, hard: 15 },
    mastered: 50,
    review_passed: 20,
    fundamental_cleared: 10,
    slip_confirmed: 5
  }
};
function outcomeOf(a, review) {
  if (a.part === "assessment") return "evidence";
  switch (a.verdict) {
    case "solved":
      return a.hintsUsed === 0 && !a.sawWorkedExample ? "clean" : "helped";
    case "slip":
      if (review?.slipAnswer === "confirmed") return "slip_ok";
      if (review?.slipAnswer === "disputed") return "miss";
      return "slip_pending";
    case "not_understood":
      return "miss";
  }
}
function emptyState(skillId) {
  return {
    skillId,
    stage: "new",
    streak: 0,
    ladderStep: 0,
    dueAt: null,
    lapses: 0,
    lastCreditDay: null,
    restartStep: 1,
    fastTrackFrom: null,
    medianSeconds: null
  };
}
function ladderFor(skill) {
  return CONFIG.ladder[skill.difficulty];
}
function sortAttempts(attempts) {
  return [...attempts].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : a.gradedAt - b.gradedAt);
}
function replay(skills, attempts, reviews) {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const reviewByAttempt = new Map(reviews.map((r) => [r.attemptId, r]));
  const states = new Map(skills.map((s) => [s.id, emptyState(s.id)]));
  const points = [];
  const times = /* @__PURE__ */ new Map();
  for (const a of sortAttempts(attempts)) {
    const skill = byId.get(a.skillId);
    if (!skill) continue;
    const st = states.get(a.skillId);
    const outcome = outcomeOf(a, reviewByAttempt.get(a.id));
    if (a.activeSeconds > 0) times.set(a.skillId, [...times.get(a.skillId) ?? [], a.activeSeconds]);
    step(skill, st, a, outcome, points);
  }
  for (const [id, st] of states) {
    const t = times.get(id) ?? [];
    st.medianSeconds = median(t.slice(-5));
  }
  return { states, points };
}
function step(skill, st, a, outcome, points) {
  if (outcome === "evidence") return;
  const ladder = ladderFor(skill);
  const target = skill.streakTarget ?? CONFIG.defaultStreakTarget;
  const award = (kind, n) => points.push({ day: a.day, kind, points: n, skillId: skill.id, attemptId: a.id });
  const solvedPoints = () => {
    if (a.part === "check" && skill.isFundamental) award("fundamental_cleared", CONFIG.points.fundamental_cleared);
    else award("solved", CONFIG.points.solved[skill.difficulty]);
  };
  if (outcome === "slip_ok") award("slip_confirmed", CONFIG.points.slip_confirmed);
  const placementSolve = a.part === "check" && outcome === "clean" && st.stage === "new";
  if (st.stage === "new" && outcome === "clean" && !placementSolve) st.fastTrackFrom = a.day;
  else if (outcome !== "clean") st.fastTrackFrom = null;
  if (st.stage === "new") st.stage = "learning";
  if (placementSolve) st.streak = Math.max(st.streak, target - 1);
  if (st.stage === "learning" || st.stage === "lapsed") {
    if (outcome === "clean") {
      solvedPoints();
      if (st.lastCreditDay !== a.day) {
        st.streak += 1;
        st.lastCreditDay = a.day;
      }
      const ft = CONFIG.fastTrack;
      const fastTracked = st.fastTrackFrom !== null && st.streak >= ft.solves && a.day >= addDays(st.fastTrackFrom, ft.minGapDays);
      if (st.streak >= target || fastTracked) {
        st.stage = "mastered";
        st.fastTrackFrom = null;
        st.ladderStep = st.restartStep;
        st.dueAt = addDays(a.day, ladder[st.ladderStep - 1]);
        if (!placementSolve) award("mastered", CONFIG.points.mastered);
        return;
      }
    } else if (outcome === "miss") {
      st.streak = 0;
    }
    const firstSight = outcome === "clean" && st.fastTrackFrom === a.day && st.streak === 1;
    st.dueAt = addDays(a.day, firstSight ? CONFIG.fastTrack.minGapDays : 1);
    return;
  }
  if (outcome === "clean") {
    const isReview = st.stage === "retained" || st.dueAt !== null && a.day >= st.dueAt;
    if (!isReview) {
      solvedPoints();
      return;
    }
    award("review_passed", CONFIG.points.review_passed);
    if (st.stage === "retained") return;
    st.ladderStep += 1;
    if (st.ladderStep > ladder.length) {
      st.stage = "retained";
      st.dueAt = null;
    } else {
      st.dueAt = addDays(a.day, ladder[st.ladderStep - 1]);
    }
    return;
  }
  if (outcome === "miss") {
    const at = st.stage === "retained" ? ladder.length + 1 : st.ladderStep;
    st.restartStep = Math.max(1, at - CONFIG.lapseStepsBack);
    st.stage = "lapsed";
    st.streak = 0;
    st.ladderStep = 0;
    st.lapses += 1;
    st.lastCreditDay = null;
    st.fastTrackFrom = null;
    st.dueAt = addDays(a.day, 1);
  }
}
function dueSkills(skills, states, attempts, exams, today) {
  const out = [];
  for (const s of skills) {
    const st = states.get(s.id);
    if (!st) continue;
    if (st.stage === "learning" || st.stage === "lapsed") out.push(s.id);
    else if (st.stage === "mastered" && st.dueAt !== null && st.dueAt <= today) out.push(s.id);
    else if (st.stage === "retained") {
      const exam = exams.filter((e) => e.skillIds.includes(s.id) && e.date >= today && e.date <= addDays(today, CONFIG.examCheckWindowDays)).sort((a, b) => a.date < b.date ? -1 : 1)[0];
      if (!exam) continue;
      const windowStart = addDays(exam.date, -7);
      const checked = attempts.some((a) => a.skillId === s.id && a.part !== "assessment" && a.day >= windowStart && a.day <= today);
      if (!checked) out.push(s.id);
    }
  }
  return out;
}
const QUEST_CONFIG = {
  /** Real homework due within this many days is pulled into quests. */
  assignmentLookaheadDays: 7,
  /** Homework due within this many days goes before reviews; later homework after them. */
  urgentWithinDays: 2,
  /** A quest may run this much over its budget rather than split a task group. */
  overBudgetTolerance: 0.1,
  /**
   * A lesson teaches one idea: read a short explanation and a worked example,
   * then solve a short problem straight away. Its problem is a smaller one than
   * a full task, so it gets this share of the skill's expected time. Reading
   * minutes are the target the writer gets; the written text sets the real figure.
   */
  lesson: { readMinutes: 8, problemShare: 0.5 },
  /**
   * Reading time (reading.ts). Text size in word-equivalents: words plus this
   * much per displayed and inline formula. The student's rate is the median of
   * their last `window` reads of at least `minSeconds`, kept between min and max.
   */
  reading: { displayFormula: 15, inlineFormula: 4, startRate: 60, minRate: 25, maxRate: 200, minSeconds: 30 },
  /** At most this many brand-new skills per quest when there's no homework to prepare. */
  maxNewSkills: 2,
  /** The same in the week before an exam of the quest's course: only that exam's skills unless the student asks. */
  newBeforeExams: 0,
  /** Practice problems are worth this many grading points each. */
  practiceMaxPoints: 2,
  /** Hints per assignment task before the solved similar problem is offered. */
  hints: 3,
  /** Anki step before a deck test: minutes = base + per card tested; at most this many cards per skill in one test. */
  anki: { baseMinutes: 5, perCard: 0.5, cardsPerTest: 8 },
  /** Model size for each kind of writing. */
  tiers: { learn: "default", lesson: "default", practice: "default", assignment: "default" }
};
const ankiMinutes = (cards) => cards ? Math.round(QUEST_CONFIG.anki.baseMinutes + QUEST_CONFIG.anki.perCard * cards) : 0;
function partMinutes(p) {
  if (p.kind === "learn") return p.estMinutes ?? 0;
  return (p.readMinutes ?? 0) + (p.problems ?? []).reduce((s, q) => s + q.expMinutes, 0);
}
const QUEST_SETTING_LIMITS = { hints: [0, 5], lessonMinutes: [2, 15], newSkillsPerQuest: [0, 4], newSkillsBeforeExams: [0, 4] };
const DEFAULTS = { hints: QUEST_CONFIG.hints, lessonMinutes: QUEST_CONFIG.lesson.readMinutes, newSkillsPerQuest: QUEST_CONFIG.maxNewSkills, newSkillsBeforeExams: QUEST_CONFIG.newBeforeExams };
function applyQuestSettings(s) {
  QUEST_CONFIG.hints = s?.hints ?? DEFAULTS.hints;
  QUEST_CONFIG.lesson.readMinutes = s?.lessonMinutes ?? DEFAULTS.lessonMinutes;
  QUEST_CONFIG.maxNewSkills = s?.newSkillsPerQuest ?? DEFAULTS.newSkillsPerQuest;
  QUEST_CONFIG.newBeforeExams = s?.newSkillsBeforeExams ?? DEFAULTS.newSkillsBeforeExams;
}
function questSettingsNow(s) {
  return { ...DEFAULTS, ...s, anki: s?.anki ?? null };
}
const DISPLAY = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g;
const INLINE = /\$[^$\n]+\$|\\\([\s\S]+?\\\)/g;
function textSize(md) {
  const { displayFormula, inlineFormula } = QUEST_CONFIG.reading;
  let size = 0;
  const words = md.replace(DISPLAY, () => (size += displayFormula, " ")).replace(INLINE, () => (size += inlineFormula, " ")).split(/\s+/).filter((w) => /\w/.test(w)).length;
  return size + words;
}
function readingOf(records) {
  const { startRate, minRate, maxRate, minSeconds } = QUEST_CONFIG.reading;
  const rates = [];
  const minutesByDay = /* @__PURE__ */ new Map();
  for (const r of [...records].sort((a, b) => a.quest.createdAt - b.quest.createdAt)) {
    for (const p of r.quest.parts) {
      const s = r.progress.read?.[p.id] ?? 0;
      if (!s) continue;
      minutesByDay.set(r.quest.date, (minutesByDay.get(r.quest.date) ?? 0) + s / 60);
      if (s >= minSeconds && p.kind === "lesson" && p.body) rates.push(textSize(p.body) / (s / 60));
    }
  }
  const m = median(rates.slice(-10));
  return { rate: m === null ? startRate : Math.min(maxRate, Math.max(minRate, m)), minutesByDay };
}
const readMinutes = (md, rate) => Math.max(1, Math.round(textSize(md) / rate));
const STYLE = `How to explain (StudyDesk style):
- Start from the very beginning. Before using a word or symbol, say in plain words what it is. Use the questions a confused beginner would ask as headings ("What is a series?", "What does converge mean?").
- Give quick reminders of prerequisites right where they're needed, with 2 or 3 tiny numeric examples.
- Concrete before abstract: plug in real numbers first and let the pattern show before stating the rule.
- Intuition, then the rule, then why the rule must be true ("Think about it: ..."), then the formal tool. Give the official name and the course's own term once the idea is clear.
- Never skip algebra. Include a short section "The tricky step, slowly" that does it line by line.
- Show limits and trends with a tiny table of values (n = 10, 100, 1000).
- Short paragraphs, plain conversational language, bold only for the one key rule.
- End with a short checklist the student can reuse on the next problem of this kind.
- Math in TeX: $...$ inline, $$...$$ on its own line.`;
const CUT_SHORT$1 = "The answer was cut short";
function parseSections(text) {
  const out = /* @__PURE__ */ new Map();
  const re = /^===\s*(.+?)\s*===\s*$/gm;
  const marks = [];
  let m;
  while (m = re.exec(text)) marks.push({ key: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim();
    out.set(mk.key, body);
  });
  return out;
}
class WritingFailed extends Error {
  constructor(what, errors) {
    super(`Couldn't write ${what}: ${errors.join(" ")}`);
    this.what = what;
    this.errors = errors;
  }
}
function context(semester, quest, knownSkillIds, feel = []) {
  return {
    feel,
    anki: semester.questSettings?.anki,
    course: semester.courses.find((c) => c.id === quest.courseId),
    skills: new Map(semester.skills.map((s) => [s.id, s])),
    known: knownSkillIds.map((id) => semester.skills.find((s) => s.id === id)?.name).filter(Boolean)
  };
}
const skillLine = (ctx, id) => {
  const s = ctx.skills.get(id);
  const pre = s.prereqSkillIds.map((p) => ctx.skills.get(p)?.name).filter(Boolean);
  return `- ${s.name}${s.isFundamental ? " (a fundamental)" : ""}${s.difficulty === "hard" ? " (hard)" : ""}${pre.length ? `; builds on: ${pre.join(", ")}` : ""}`;
};
const header = (ctx) => `Course: ${ctx.course.name}. Write in ${ctx.course.teachingLanguage}, the language the course is taught in.
${ctx.known.length ? `The student can already do: ${ctx.known.join(", ")}.` : "Assume the student knows only school basics unless a skill says otherwise."}${ctx.feel.length ? `
How recent quest parts felt to the student (adjust: "too hard" means slower, smaller steps and an easier own problem; "too easy" means brisker and a harder own problem):
${ctx.feel.map((f) => `- ${f}`).join("\n")}` : ""}`;
function parseCards(text = "") {
  return text.split("\n").flatMap((l) => {
    const [front, ...back] = l.replace(/^\s*[-*]\s*/, "").split(" | ");
    return back.length && front.trim() ? [{ front: front.trim(), back: back.join(" | ").trim() }] : [];
  });
}
function upcoming(quest, part, ctx) {
  const skillIds = part.skillIds ?? [];
  const i = quest.parts.findIndex((p) => p === part || p.id === part.id);
  const later = quest.parts.slice(i + 1).filter((p) => p.kind !== "learn");
  const lines = later.flatMap(
    (p) => p.problems.filter((q) => skillIds.includes(q.skillId)).map((q) => q.prompt ? `- ${q.label ?? ""} ${q.prompt}`.trim() : `- a practice problem on ${ctx.skills.get(q.skillId).name}`)
  );
  return lines.length ? `Later in today's quest the student will solve:
${lines.join("\n")}
Prepare them for exactly these, without solving any of them.` : "";
}
function learnTurns(quest, part, ctx) {
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
the explanation in Markdown`
    }
  ];
}
const rateOf = (q) => q.readRate ?? QUEST_CONFIG.reading.startRate;
const lessonWords = (q, part) => Math.round((part.readMinutes ?? QUEST_CONFIG.lesson.readMinutes) * rateOf(q) / 10) * 10;
function lessonTurns(quest, part, ctx) {
  const id = part.skillIds[0];
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
(Here the checklist at the end is 2 or 3 lines at most.)${ctx.anki ? `

The student learns by heart with Anki. If this idea is vocabulary or other things learned purely by heart (terms and their meaning, names, fixed facts), list every item in CARDS as "front | back", one per line: the word or term in front, its meaning or translation on the back. These cards become the student's deck for this idea, so make it complete. Never methods or problem solving. If there is nothing to learn by heart, write NONE.` : ""}

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
worked solution with the final result${ctx.anki ? "\n=== CARDS ===\nfront | back lines, or NONE" : ""}`
    }
  ];
}
function practiceTurns(part, ctx) {
  const slots = part.problems.map(
    (p) => p.cards ? `${p.id}: a recall test on "${ctx.skills.get(p.skillId).name}" from the student's Anki deck, about ${p.expMinutes} min. Ask for exactly these cards, mixed order, some from the back to the front: ${p.cards.map((c) => `${c.front} = ${c.back}`).join("; ")}` : `${p.id}: skill "${ctx.skills.get(p.skillId).name}"${ctx.skills.get(p.skillId).isFundamental ? " (fundamental)" : ""}, solvable in about ${p.expMinutes} min`
  ).join("\n");
  return [
    {
      role: "user",
      content: `You write practice problems for today's study quest. Each problem tests exactly one skill. Use fresh numbers; keep each problem short and unambiguous, with one clear final answer.${part.gate ? " These check fundamentals the rest of the quest depends on, so they should reveal whether the student really has the skill." : ""}

${header(ctx)}

Problems to write:
${slots}

For each problem write the PROMPT (Markdown, what the student sees) and the ANSWER (a worked solution with the final result, used for grading and shown after hand-in).

Reply in this exact format and nothing else, for every problem id:
${part.problems.map((p) => `=== ${p.id} PROMPT ===
...
=== ${p.id} ANSWER ===
...`).join("\n")}`
    }
  ];
}
function assignmentTurns(part, ctx) {
  const n = QUEST_CONFIG.hints;
  const tasks = part.problems.map((p) => `${p.id} (task ${p.label}, skill "${ctx.skills.get(p.skillId).name}"):
"""
${p.prompt}
"""`).join("\n\n");
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
${part.problems.map((p) => [`=== ${p.id} ANSWER ===`, "...", ...Array.from({ length: n }, (_, i) => `=== ${p.id} HINT ${i + 1} ===
...`), `=== ${p.id} SIMILAR ===`, "..."].join("\n")).join("\n")}`
    }
  ];
}
function check(text, keys) {
  const errors = [];
  if (text.includes(CUT_SHORT$1)) errors.push("The reply was cut off.");
  const sec = parseSections(text);
  for (const k of keys) if (!sec.get(k)?.trim()) errors.push(`Section "=== ${k} ===" is missing or empty.`);
  return errors;
}
async function askSections(ask, turns, keys, what, tier, signal) {
  const first = await ask(turns, { tier, signal });
  let errors = check(first, keys);
  if (!errors.length) return parseSections(first);
  const retry = [
    ...turns,
    { role: "assistant", content: first },
    { role: "user", content: `That reply can't be used:
- ${errors.join("\n- ")}
Reply again in the exact format, shorter if needed.` }
  ];
  const second = await ask(retry, { tier, signal });
  errors = check(second, keys);
  if (!errors.length) return parseSections(second);
  throw new WritingFailed(what, errors);
}
function claudeWriter(semester, quest, knownSkillIds, ask, signal, feel = []) {
  applyQuestSettings(semester.questSettings);
  const ctx = context(semester, quest, knownSkillIds, feel);
  const t = QUEST_CONFIG.tiers;
  return {
    async learn(q, part) {
      const s = await askSections(ask, learnTurns(q, part, ctx), ["TITLE", "BODY"], `the explanation "${part.title}"`, t.learn, signal);
      return { title: s.get("TITLE").replace(/^#+\s*/, ""), body: s.get("BODY") };
    },
    async lesson(q, part) {
      const pid = part.problems[0].id.toUpperCase();
      const s = await askSections(
        ask,
        lessonTurns(q, part, ctx),
        ["TITLE", "EXPLANATION", "WORKED EXAMPLE", "KEY RULE", `${pid} PROMPT`, `${pid} ANSWER`, ...ctx.anki ? ["CARDS"] : []],
        `the lesson "${part.title}"`,
        t.lesson,
        signal
      );
      const cards = parseCards(s.get("CARDS"));
      return {
        title: s.get("TITLE").replace(/^#+\s*/, ""),
        body: `${s.get("EXPLANATION")}

### Worked example

${s.get("WORKED EXAMPLE")}`,
        keyRule: s.get("KEY RULE"),
        ...cards.length && { cards },
        problems: [{ id: part.problems[0].id, prompt: s.get(`${pid} PROMPT`), answerKey: s.get(`${pid} ANSWER`) }]
      };
    },
    async practice(_q, part) {
      const keys = part.problems.flatMap((p) => [`${p.id.toUpperCase()} PROMPT`, `${p.id.toUpperCase()} ANSWER`]);
      const s = await askSections(ask, practiceTurns(part, ctx), keys, "the practice problems", t.practice, signal);
      return part.problems.map((p) => ({ id: p.id, prompt: s.get(`${p.id.toUpperCase()} PROMPT`), answerKey: s.get(`${p.id.toUpperCase()} ANSWER`) }));
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
          answerKey: s.get(`${id} ANSWER`),
          hints: Array.from({ length: n }, (_, i) => s.get(`${id} HINT ${i + 1}`)),
          similarSolved: s.get(`${id} SIMILAR`)
        };
      });
    }
  };
}
class QuestIncomplete extends Error {
  constructor(quest, writtenIds, cause) {
    super(cause instanceof Error ? cause.message : String(cause?.message ?? cause));
    this.quest = quest;
    this.writtenIds = writtenIds;
    this.cause = cause;
    const code = cause?.code;
    if (typeof code === "string") this.code = code;
  }
  /** The Claude error code behind it, so the page shows the same words as for any failed call. */
  code;
}
async function writeQuest(plan, writer, onStatus, opts = {}) {
  const quest = JSON.parse(JSON.stringify(plan));
  const written = /* @__PURE__ */ new Set([...opts.skip ?? [], ...plan.parts.filter((p) => p.kind === "learn" && p.body).map((p) => p.id)]);
  for (const id of written) onStatus?.({ partId: id, state: "done" });
  const queue = quest.parts.filter((p) => !written.has(p.id));
  let failure = null;
  const writeOne = async (part) => {
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
        for (const f of l.problems) Object.assign(part.problems.find((p) => p.id === f.id), f);
      } else {
        const filled = part.kind === "practice" ? await writer.practice(plan, part) : await writer.assignment(plan, part);
        for (const f of filled) Object.assign(part.problems.find((p) => p.id === f.id), f);
      }
      written.add(part.id);
      onStatus?.({ partId: part.id, state: "done" });
    } catch (e) {
      failure ??= e;
    }
  };
  const worker = async () => {
    for (let part = queue.shift(); part && !failure; part = queue.shift()) await writeOne(part);
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));
  quest.plannedMinutes = quest.parts.reduce((s, p) => s + partMinutes(p), 0);
  if (failure) throw new QuestIncomplete(quest, [...written], failure);
  return quest;
}
const MAX_COURSE_CHARS = 15e4;
const MAX_QUESTIONS = 3;
const CUT_SHORT = "The answer was cut short";
const INLINE_OUTLINES = 2e4;
function inventoryLine(key2, f, markNew = false) {
  const u = f.upload;
  const what = u.state === "agent" ? `a scan, ${u.pages ?? "?"} pages, no text` : u.type === "video" ? "a video (Claude can't watch or listen)" : u.state === "listed" ? "a file StudyDesk can't open, name only" : u.type === "image" ? "an image" : `${u.type === "office" ? "Office file" : u.type}${u.pages ? `, ${u.pages} ${u.type === "office" ? "slides/sheets" : "pages"}` : ""}`;
  return `- ${key2}: ${markNew && u.cataloguedAt === null ? "NEW " : ""}${u.path ?? u.fileName} (${what})${u.studentNote ? ` the student says: "${u.studentNote}"` : ""}`;
}
const NAVIGATE = `## How to read: by reason, like a careful student on the first day
You get an inventory, not the files' text. Open only what you need, and say why.
1. Read the inventory first. Folder and file names say a lot: say what you expect where.
2. Open the course overview first: syllabus, module description, the organizational part of the first lecture.
3. Follow what it points to: grading and exam rules, exercise sheets with a hand-in date still ahead, the chapters or parts the exam covers.
4. For scripts and slide decks, the outline is usually enough to map skills to pages. Open pages only where the outline is unclear or a skill needs checking.
5. Skip with a reason: older versions of the same file, duplicates, admin files, solutions you don't need. Videos: go by the title and what the student said about them.
6. Stop when you can write every section with confidence. There's no limit on how many files you open, but every open needs a reason, and "read everything" must be argued file by file.
Every file you open and every group you skip gets one line in the LOG ("Opening F3 Syllabus.pdf p. 1-4: should list grading and dates"; "Skipping F20-F31: 2024 versions of the same sheets"). Catalog entries you built from an outline without opening the pages end with "(outline)".`;
const CLOUD_FILES = `## Opening files
Each line of the inventory ends with the file's upload id and, when the original is kept, its asset id. Read files from the student's StudyDesk:
- Kept text and outline: ArtifactData action "get", collection "data/users/me/files/uploads", doc_id "<upload id>". Fields: "outline", "text" (pages marked "--- page N ---", slides "--- slide N ---"), "image" (a data URL).
- The original (PDFs, images, scans): Artifact action "read" with your StudyDesk's url and path "<asset id>"; it saves the file locally, where you can open pages, search across files, or look at a scanned page.
- Scans have only the original. Read the pages you need by looking at them. For a long scan you need whole, you may hand the transcription to a helper agent on the Sonnet model (Agent tool, model "sonnet") and check a few pages of its work. Save what you transcribed so later reads are cheap: ArtifactData "update" on that upload's document with {"text": "--- page 1 ---\\n…"}.
- Never download or open every file just because you can.`;
function setupTurns(input, opts = {}) {
  const { profile, course, facts, files, today, draft } = input;
  const scale = profile.gradeScale;
  const fileKeys = /* @__PURE__ */ new Map();
  const clipped = [];
  const images = [];
  let budget = opts.maxChars ?? MAX_COURSE_CHARS;
  const navigate = opts.navigate;
  const outlineTotal = files.reduce((n, f) => n + (f.outline?.length ?? 0), 0);
  const reread = files.some((f) => f.upload.cataloguedAt !== null) && files.some((f) => f.upload.cataloguedAt === null);
  const fileBlocks = navigate ? [
    files.map((f, i) => {
      const key2 = `F${i + 1}`;
      fileKeys.set(key2, f.upload.id);
      if (navigate === "page" && f.image) images.push(f.image);
      const line = inventoryLine(key2, f, reread) + (navigate === "page" && f.image ? ` Attached as image ${images.length}.` : "") + (navigate === "cloud" ? ` [upload ${f.upload.id}${f.upload.assetId ? `, asset ${f.upload.assetId}` : ""}]` : "");
      return outlineTotal <= INLINE_OUTLINES && f.outline && f.upload.type !== "image" ? `${line}
  Outline:
${f.outline.replace(/^/gm, "    ")}` : line;
    }).join("\n"),
    outlineTotal > INLINE_OUTLINES ? "(Outlines aren't listed here: there are too many. Get a file's outline before opening it.)" : "",
    reread ? "This course was read before. Files marked NEW arrived since: open those, and re-open older files only when something points back to them." : "",
    navigate === "page" ? `## Opening files
Use the tools: outline(file) gives a file's outline; open(file, part, why) gives the text of pages "3-5" or "3,7-9", slides or sheets the same way, or lines "l. 40-80" of a text file. Ask for a few pages at a time. A scan has no text here: note it in the LOG and work from its name.` : CLOUD_FILES,
    NAVIGATE
  ].filter(Boolean) : files.map((f, i) => {
    const key2 = `F${i + 1}`;
    fileKeys.set(key2, f.upload.id);
    const head = `### ${key2}: ${f.upload.fileName}${f.upload.studentNote ? ` (the student says: "${f.upload.studentNote}")` : ""}`;
    if (f.image) {
      images.push(f.image);
      return `${head}
Image ${images.length} of the attached images. Refer to it as "${key2}, image".`;
    }
    let text = f.text ?? "";
    if (text.length > budget) {
      clipped.push(f.upload.fileName);
      text = text.slice(0, Math.max(0, budget)) + "\n[…the rest of this file was not sent]";
    }
    budget -= text.length;
    return `${head}
Pages are marked "--- page N ---"; for text files, count lines.
"""
${text}
"""`;
  });
  const prior = input.priorFundamentals.length ? `
Fundamentals this student already mastered in earlier semesters (reuse these exact ids when a fundamental here is the same skill; don't list them again otherwise):
${input.priorFundamentals.map((p) => `- ${p.id}: ${p.name}`).join("\n")}
` : "";
  const known2 = currentSkills(input);
  const current = known2.length ? `
Skills this course already has (the student's progress is stored under these ids). When a skill in your map is one of these, write its id exactly as given here. Never give one of these ids to a different skill; drop a skill only if it really isn't part of the course:
${known2.map((k) => `- ${k.id}: ${k.name}`).join("\n")}
` : "";
  const prev = input.draft.results?.[input.course.id];
  const items = [...(prev?.assignments ?? []).map((a) => `- homework "${a.title}", due ${a.dueAt}`), ...(prev?.keyDates ?? []).map((k) => `- ${k.kind} "${k.title}" on ${k.date}`)];
  const listed = items.length ? `
Homework and exams this course already has. When you list one of these again, write its title exactly as given here:
${items.join("\n")}
` : "";
  const content = `You are StudyDesk's organization agent. You set up one course for one student: you turn their real course materials into the list of skills StudyDesk teaches, practices and tracks. Everything later (daily quests, grading) depends on this map, so be thorough and precise.

## The student
- ${profile.level === "school" ? "School" : "University"}: ${profile.school || "not given"}, ${profile.country || "country not given"}
- Program or school type: ${profile.program || "not given"}, year ${profile.year || "not given"}
- Grade scale: ${scale.name} (best ${scale.best}, worst ${scale.worst})
- Semester: ${draft.name}, ${draft.startDate} to ${draft.endDate}. Today is ${today}.

## The course
- Name: ${course.name}${course.credits ? `, ${course.credits} credits` : ""}
- Target grade: ${course.targetGrade ?? "not given"}

## What the student said about it (word for word; if a file disagrees, the student's word wins, and you list the disagreement under CONFLICTS)
${facts.length ? facts.map((f) => `- "${f.text}"`).join("\n") : "- nothing"}
${prior}${current}${listed}
## Files
${files.length ? fileBlocks.join("\n\n") : opts.web ? "No files. Search the web for the official description of this course at this school (curriculum, course catalogue entry, syllabus, weekly schedule, exam rules) and build the map from it. If nothing official turns up, use what a course with this name usually covers in this program and country, and say which in the summary. Don't ask for files under QUESTIONS: StudyDesk asks for missing materials itself." : "No files. Use what a course with this name usually covers in this program and country, and say so in the summary. Don't ask for files under QUESTIONS: StudyDesk asks for missing materials itself."}${opts.web ? "\n\n## Web research\nYou can search the web. Before writing, look this course up: its official page or catalogue entry at the student's school, for topics, schedule, grading and exam dates. Prefer official sources. The student's words and files win where they say something; the web fills what they don't. Name the sites you used in the SUMMARY (site names, no links)." : ""}

## What to write

Skills are the unit of mastery: one kind of problem the student must be able to solve ("Decide convergence with the ratio test"), small enough to practice in 2 to 15 minutes. Typically 4 to 8 skills per topic. Also list the fundamentals from earlier schooling that the course's skills rely on (e.g. "Simplify fractions with powers"), marked fundamental; keep those to what this course really needs.

- tier: the least ambitious target grade on the scale above that still needs this skill. Core skills get the scale's worst passing grade; skills only needed for top grades get the best grade.
- difficulty: normal or hard.
- minutes: a first guess of how long one typical problem takes a student.
- weight: 1 normal, 2 for skills the exam weighs heavily, 0.5 for side topics.
- prereqs: ids of skills (or fundamentals) this one builds on.
- A topic is "taught" if, judging by the syllabus schedule, homework sheets or the student's words, it has already been covered in class by today. Otherwise "upcoming".
- Homework: only real sheets with a hand-in date that hasn't passed. Copy each task's text word for word (TeX for math: $...$). Give each task the one skill it practices.
- Catalog: for every skill, where the files cover it (file key and pages "p. 3-5" or lines "l. 40-80"). Several lines per skill are fine. Skills with no coverage get no line.
- Teaching language: the language the course is taught and examined in. Without files, judge it from the school and country (a school in Germany teaches in German), except for language courses.

Reply with exactly these sections, in this order, and nothing else. Use "|" between fields. Leave a section empty if there's nothing for it.

=== LOG ===
The student watches this section appear live, so write it first, as you work through the material: ${navigate ? "one short line in English per file you open or group you skip, with why" : "3 to 12 short lines in English, one per thing you look at and what you take from it"}. Name the file and pages, e.g.:
- Reading F1 (Skript.pdf), p. 1-40: limits and sequences, 3 worked examples per section
- F2 (Blatt 3.pdf): homework due 2026-11-27, 4 tasks on series
- Grading rules: F3 p. 2 says the exam counts 100 %
If there are no files, say plainly that you are estimating from the course name and your general knowledge, not from their materials and not from the internet.

=== SUMMARY ===
Two to four plain sentences in English for the student: what you read and what you found (how many topics and skills), and anything they should double-check.

=== LANGUAGE ===
English

=== TOPICS ===
t1 | Topic name | taught

=== SKILLS ===
id | topic id | skill name | fundamental or course | tier | normal or hard | minutes | weight | prereq ids separated by commas, or -
(ids: short lowercase, like s1, s2, f1 for fundamentals)

=== GRADING ===
component | exam | 60
threshold | ${scale.best} | 87.5
(components with their weight in percent; thresholds: minimum percent for each grade. Only what the files or the student say.)

=== DATES ===
YYYY-MM-DD | exam or quiz | title | topic ids separated by commas

=== HOMEWORK ===
### Sheet title | YYYY-MM-DDTHH:MM
#### task label | skill id | max points
The task text, word for word.

=== CATALOG ===
skill id | F1 | p. 3-5

=== CONFLICTS ===
- one line each, only where the student's word and a file really contradict each other on a date, the grading or what the course covers. Leave out small differences in wording, rounding or naming.

=== QUESTIONS ===
- usually none. Decide yourself whatever you are fairly sure about, and name the assumption in the SUMMARY instead of asking. Ask only what you really can't work out and what would change the skill map, the dates or the grading, e.g. an exam date you only guessed. At most 3, most important first, one short line each. Never ask them to upload files.`;
  return { turns: [{ role: "user", content }], images, fileKeys, clipped };
}
class SetupFailed extends Error {
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
const bullets = (s) => (s ?? "").split("\n").map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter((l) => l && !/^\(.*\)$/.test(l) && !/^(none|nothing|-)\.?$/i.test(l));
const rows = (s) => (s ?? "").split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter((l) => l.includes("|") && !/^\(/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
function currentSkills(input) {
  const prior = new Set(input.priorFundamentals.map((p) => p.id));
  return (input.draft?.results?.[input.course.id]?.skills ?? []).filter((s) => !prior.has(s.id));
}
const sameName = (a, b) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");
function parseSetup(reply, input, fileKeys, now = Date.now()) {
  const { course, profile } = input;
  const sec = parseSections(reply);
  const cid = course.id;
  const priorIds = new Set(input.priorFundamentals.map((p) => p.id));
  const topicId = (id) => `${cid}-t-${slug(id)}`;
  const known2 = new Map(currentSkills(input).map((s) => [s.id, s]));
  const given = /* @__PURE__ */ new Map();
  const baseId = (id) => priorIds.has(id) || known2.has(id) ? id : `${cid}-${slug(id)}`;
  const newId = (id, name) => {
    let sid = baseId(id);
    const old = known2.get(sid);
    if (old && sid !== id && !sameName(old.name, name)) {
      let n = 2;
      while (known2.has(`${sid}-${n}`)) n++;
      sid = `${sid}-${n}`;
    }
    given.set(id, sid);
    return sid;
  };
  const skillId = (id) => given.get(id) ?? baseId(id);
  const topics = [];
  for (const [id, name, taught] of rows(sec.get("TOPICS"))) {
    if (!id || !name || topics.some((t) => t.id === topicId(id))) continue;
    topics.push({ id: topicId(id), name, taught: /^taught|^yes/i.test(taught ?? "") });
  }
  const fundTopic = { id: `${cid}-t-fundamentals`, name: "Fundamentals" };
  const scale = profile.gradeScale;
  const lo = Math.min(scale.best, scale.worst);
  const hi = Math.max(scale.best, scale.worst);
  const skills = [];
  const rawPrereqs = /* @__PURE__ */ new Map();
  for (const r of rows(sec.get("SKILLS"))) {
    const [id, tid, name, kind, tier, diff, minutes, weight, prereqs] = r;
    if (!id || !name) continue;
    const sid = newId(id, name);
    if (skills.some((s) => s.id === sid)) continue;
    if (priorIds.has(id)) {
      skills.push(input.priorFundamentals.find((p) => p.id === id));
      continue;
    }
    const isFundamental = /^fund/i.test(kind ?? "");
    const t = topics.find((x) => x.id === topicId(tid ?? ""));
    const tierN = Number((tier ?? "").replace(",", "."));
    const min = Number(minutes);
    const w = Number((weight ?? "").replace(",", "."));
    skills.push({
      id: sid,
      courseId: cid,
      topicId: isFundamental || !t ? isFundamental ? fundTopic.id : topics[0]?.id ?? fundTopic.id : t.id,
      name,
      difficulty: /hard/i.test(diff ?? "") ? "hard" : "normal",
      isFundamental,
      prereqSkillIds: [],
      tier: Number.isFinite(tierN) ? Math.min(hi, Math.max(lo, tierN)) : scale.worst,
      weight: Number.isFinite(w) && w > 0 ? w : 1,
      estMinutes: Number.isFinite(min) && min > 0 ? Math.min(45, Math.round(min)) : 6
    });
    rawPrereqs.set(sid, (prereqs ?? "").split(/[,\s]+/).filter((x) => x && x !== "-"));
  }
  if (!skills.length) throw new SetupFailed(`No skills came back for ${course.name}.`);
  const ids = /* @__PURE__ */ new Set([...skills.map((s) => s.id), ...priorIds]);
  for (const s of skills) if (rawPrereqs.has(s.id)) s.prereqSkillIds = rawPrereqs.get(s.id).map(skillId).filter((p) => ids.has(p) && p !== s.id);
  if (skills.some((s) => s.isFundamental) && !topics.some((t) => t.id === fundTopic.id)) topics.unshift(fundTopic);
  if (!topics.length) topics.push({ id: `${cid}-t-main`, name: course.name });
  for (const s of skills) if (!priorIds.has(s.id) && !topics.some((t) => t.id === s.topicId)) s.topicId = topics[0].id;
  const components = [];
  const thresholds = [];
  for (const [kind, a, b] of rows(sec.get("GRADING"))) {
    const n = Number((b ?? "").replace(",", ".").replace("%", ""));
    if (!Number.isFinite(n)) continue;
    if (/^comp/i.test(kind)) components.push({ id: slug(a), weight: n });
    if (/^thres/i.test(kind)) {
      const g = Number((a ?? "").replace(",", "."));
      if (Number.isFinite(g)) thresholds.push({ grade: g, minPercent: n });
    }
  }
  const gradeRules = components.length || thresholds.length ? { courseId: cid, scale, components, thresholds } : null;
  const keyDates = [];
  for (const [date, kind, title, tids] of rows(sec.get("DATES"))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    const tset = new Set((tids ?? "").split(/[,\s]+/).filter(Boolean).map(topicId));
    const covered = skills.filter((s) => tset.has(s.topicId)).map((s) => s.id);
    keyDates.push({
      courseId: cid,
      date,
      kind: /quiz|test/i.test(kind ?? "") && !/exam/i.test(kind ?? "") ? "quiz" : "exam",
      title: title || "Exam",
      skillIds: covered.length ? covered : skills.map((s) => s.id)
    });
  }
  const assignments = [];
  const hw = sec.get("HOMEWORK") ?? "";
  for (const block of hw.split(/^###(?!#)\s*/m).slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [title, due] = head.split("|").map((x) => x.trim());
    const dueAt2 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(due ?? "") ? due.length === 10 ? `${due}T23:59` : due : null;
    if (!title || !dueAt2 || dueAt2.slice(0, 10) < input.today) continue;
    const base = input.draft?.results?.[cid]?.assignments.find((a) => sameName(a.title, title))?.id ?? `${cid}-hw-${slug(title)}`;
    let aid = base;
    for (let n = 2; assignments.some((a) => a.id === aid); n++) aid = `${base}-${n}`;
    const tasks = [];
    for (const tb of rest.join("\n").split(/^####\s*/m).slice(1)) {
      const [th, ...body] = tb.split("\n");
      const [label2, sk, pts] = th.split("|").map((x) => x.trim());
      const sid = skillId(sk ?? "");
      const prompt = body.join("\n").trim();
      if (!label2 || !prompt || !skills.some((s) => s.id === sid)) continue;
      const p = Number((pts ?? "").replace(",", "."));
      tasks.push({ id: `${aid}-${slug(label2)}`, label: label2, skillId: sid, prompt, maxPoints: Number.isFinite(p) && p > 0 ? p : 1 });
    }
    if (tasks.length) assignments.push({ id: aid, courseId: cid, title, dueAt: dueAt2, tasks });
  }
  const catalog = [];
  for (const [sk, key2, where] of rows(sec.get("CATALOG"))) {
    const sid = skillId(sk ?? "");
    const uploadId = fileKeys.get((key2 ?? "").toUpperCase());
    if (!uploadId || !skills.some((s) => s.id === sid)) continue;
    catalog.push({ skillId: sid, uploadId, where: where || "whole file" });
  }
  const language = (sec.get("LANGUAGE") ?? "").split("\n")[0].trim();
  return {
    courseId: cid,
    summary: (sec.get("SUMMARY") ?? "").replace(new RegExp(`\\*?\\(?${CUT_SHORT}[\\s\\S]*$`), "").trim(),
    // A language the student chose for the course wins over what the reading found.
    teachingLanguage: course.teachingLanguage || (language && language.length < 30 ? language : "") || "English",
    topics,
    skills,
    gradeRules,
    keyDates,
    assignments,
    catalog,
    conflicts: bullets(sec.get("CONFLICTS")),
    questions: bullets(sec.get("QUESTIONS")).map((q) => q.replace(new RegExp(`\\*?\\(?${CUT_SHORT}[\\s\\S]*$`), "").trim()).filter(Boolean).slice(0, MAX_QUESTIONS),
    basis: fileKeys.size ? "materials" : "general",
    truncated: reply.includes(CUT_SHORT),
    finishedAt: now
  };
}
function buildSemester(draft, profile, now = Date.now()) {
  const courses = draft.courses.filter((c) => draft.results[c.id]);
  const res = courses.map((c) => draft.results[c.id]);
  return {
    id: draft.id,
    name: draft.name,
    source: "onboarding",
    createdAt: now,
    startDate: draft.startDate,
    endDate: draft.endDate,
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      short: c.short,
      teachingLanguage: draft.results[c.id].teachingLanguage || c.teachingLanguage,
      topics: draft.results[c.id].topics
    })),
    targets: courses.filter((c) => c.targetGrade !== null).map((c) => ({ courseId: c.id, targetGrade: c.targetGrade, gradeScale: profile.gradeScale })),
    skills: dedupe(res.flatMap((r) => r.skills)),
    assignments: res.flatMap((r) => r.assignments),
    keyDates: res.flatMap((r) => r.keyDates),
    timetable: draft.timetable,
    studyGoal: draft.studyGoal,
    studyGoalSource: "student",
    // Calendar data is live unless the student said otherwise.
    calendarSync: !!draft.calendarImportedAt && draft.calendarLive !== false,
    gradeRules: res.flatMap((r) => r.gradeRules ? [r.gradeRules] : []),
    uploads: draft.uploads,
    catalog: res.flatMap((r) => r.catalog),
    daysOff: (draft.daysOff ?? []).map((d) => d.date),
    questSettings: draft.questSettings,
    focus: draft.focus
  };
}
function dedupe(skills) {
  const seen = /* @__PURE__ */ new Set();
  return skills.filter((s) => seen.has(s.id) ? false : (seen.add(s.id), true));
}
const APP_VERSION = "dev";
const DATA_VERSION = 1;
const DEV_CHANNEL = "main";
const RELEASE_REPO = "seeLorenz/StudyDesk";
const RELEASE_BRANCH = "releases";
function parseVersion(v) {
  const m = /^v(\d+(?:\.\d+)*)$/.exec(String(v ?? "").trim());
  return m ? m[1].split(".").map(Number) : null;
}
const isRelease = (v) => parseVersion(v) !== null;
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
const WISH_URL = "https://github.com/seeLorenz/StudyDesk/issues/new";
const wishLink = (w, chat) => {
  const cap = (s = "", n = 600) => s.trim().slice(0, n);
  const enc = (s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
  const body = `_Sent from StudyDesk ${APP_VERSION}, ${chat} chat. Written by StudyDesk's Claude from a student's request._

### What the student asked
${cap(w.asked) || "Not given."}

### What StudyDesk can't do yet
${cap(w.missing) || "Not given."}

### Proposed fix
${cap(w.fix) || "Not given."}`;
  return `[Send to developer](${WISH_URL}?title=${enc(cap(w.title, 80) || "Wish from StudyDesk")}&body=${enc(body)})`;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
function atLeastAsGood(scale, a, b) {
  return scale.best < scale.worst ? a <= b : a >= b;
}
function isRequired(skill, target) {
  return atLeastAsGood(target.gradeScale, target.targetGrade, skill.tier);
}
function assessmentAttempts(r, now) {
  const share = r.maxPoints ? r.points / r.maxPoints : 0;
  return r.skillIds.map((skillId) => ({
    id: `as_${r.assessmentId}_${skillId}`,
    skillId,
    questId: null,
    part: "assessment",
    day: r.date,
    verdict: share >= 0.5 ? "solved" : "not_understood",
    points: r.points,
    maxPoints: r.maxPoints,
    hintsUsed: 0,
    sawWorkedExample: false,
    activeSeconds: 0,
    startedAt: now,
    gradedAt: now
  }));
}
function subId(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h << 5) + h + text.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}
function withSubs(done, key2, lines, make) {
  const subs = lines.map((text) => {
    const k = `${key2}:${subId(text)}`;
    return { key: k, text, done: done.has(k) || done.has(key2) };
  });
  const open = subs.filter((x) => !x.done).map((x) => x.text);
  return { key: key2, ...make(open.length ? open : lines, lines.length), done: done.has(key2) || open.length === 0, subs };
}
const asksForFiles = (q) => /\b(upload|share|send)\b|\bsyllabus\b|LV-Beschreibung/i.test(q);
const label = (c) => (c.short || c.name).trim();
const ASKS_PER_DAY = 3;
function asksOf(draft, today) {
  return draft.courses.filter((c) => draft.results[c.id]).flatMap((c) => {
    const r = draft.results[c.id];
    const at = [...r.keyDates.map((k) => k.date), ...r.assignments.map((x) => x.dueAt)].filter((d) => d >= today).sort()[0] ?? "~";
    const ask = (key2, text) => ({ key: key2, sub: `${key2}:${subId(text)}`, text, course: c.name, at });
    return [
      ...r.conflicts.map((t) => ask("conflicts", `**${label(c)}:** ${t}`)),
      ...r.questions.filter((q) => !asksForFiles(q)).slice(0, MAX_QUESTIONS).map((q) => ask(`q-${c.id}`, q))
    ];
  }).sort((x, y) => x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
}
function setupTodo(draft, today = toDay()) {
  const done = new Set(draft.todoDone ?? []);
  const items = [
    {
      key: "anki",
      title: "Do you use Anki?",
      body: "If you do, quests that teach vocabulary or other things to learn by heart come with a deck to import into Anki.",
      chatPrompt: "Next on your list: do you use Anki? If you do, quests that teach vocabulary or other things to learn by heart come with a deck you can import. You can change this any time.",
      done: draft.questSettings?.anki !== void 0 || done.has("anki")
    }
  ];
  const results = draft.courses.filter((c) => draft.results[c.id]);
  const needFiles = results.filter((c) => {
    const r = draft.results[c.id];
    return r.basis === "general" || r.questions.some(asksForFiles);
  });
  if (needFiles.length) {
    const names = needFiles.map(label).join(", ");
    items.push({
      key: "upload",
      title: `Add materials for ${needFiles.length} ${needFiles.length === 1 ? "course" : "courses"}`,
      body: `StudyDesk only guessed what **${names}** ${needFiles.length === 1 ? "covers" : "cover"}, or is missing sheets. Drop the course description with the weekly schedule and any current exercise sheets into the chat, and say which course each is for.`,
      chatPrompt: `Next on your list: materials. I only guessed what ${names} ${needFiles.length === 1 ? "covers" : "cover"}, or I'm missing sheets. Drop the course description (with the weekly schedule) and any current exercise sheets here, one course at a time, and tell me which course each file is for.`,
      done: done.has("upload")
    });
  }
  const unsure = draft.uploads.filter((u) => u.courseUnsure && u.courseId);
  if (unsure.length) {
    const list = unsure.map((u) => `- ${u.fileName} → ${draft.courses.find((c) => c.id === u.courseId)?.name ?? "?"} (${u.courseUnsure})`).join("\n");
    items.push({
      key: "unsure",
      title: `${unsure.length} ${unsure.length === 1 ? "file" : "files"} StudyDesk isn't sure about`,
      body: `Say whether each belongs to the course it was put in:

${list}`,
      chatPrompt: `Next on your list: files I wasn't sure about. Does each belong to the course I put it in?

${list}`,
      done: done.has("unsure")
    });
  }
  let left = ASKS_PER_DAY - Object.entries(draft.todoDoneOn ?? {}).filter(([k, d]) => k !== "anki" && d === today && done.has(k)).length;
  const groups = /* @__PURE__ */ new Map();
  for (const x of asksOf(draft, today)) if (done.has(x.key) || done.has(x.sub) || left-- > 0) groups.set(x.key, [...groups.get(x.key) ?? [], x.text]);
  for (const [key2, lines] of groups) {
    if (key2 === "conflicts") {
      items.push(
        withSubs(done, key2, lines, (open) => ({
          title: `${open.length} ${open.length === 1 ? "place where your files disagree" : "places where your files disagree"} with you`,
          body: "Your word was used. Say if the file was right instead.",
          chatPrompt: `Next on your list: where your files disagree with what you told me. I went with your word; tell me if a file was right instead:

${open.map((l) => `- ${l}`).join("\n")}`
        }))
      );
      continue;
    }
    const c = results.find((x) => `q-${x.id}` === key2);
    items.push(
      withSubs(done, key2, lines, (open, total) => ({
        title: `${label(c)}: ${open.length === total ? `${total} ${total === 1 ? "question" : "questions"}` : `${open.length} of ${total} questions left`}`,
        body: "Answer whatever you know, skip the rest.",
        chatPrompt: `Next on your list: ${c.name}. ${open.length === 1 ? "One question" : `${open.length} quick questions`}. Answer whatever you know, skip the rest:

${open.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      }))
    );
  }
  return items;
}
function filesOf(ref, uploads) {
  if (ref.startsWith("zip_")) return uploads.filter((u) => u.zipId === ref).map((u) => u.id);
  return uploads.some((u) => u.id === ref) ? [ref] : [];
}
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CONFIRM_FIRST = /* @__PURE__ */ new Set(["drop_course"]);
const str = (x) => typeof x === "string" ? x.trim() : x === void 0 || x === null ? "" : String(x).trim();
const num = (x) => {
  const n = typeof x === "number" ? x : Number(String(x ?? "").replace(",", "."));
  return x === void 0 || x === null || x === "" || !Number.isFinite(n) ? null : n;
};
function isRealDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const hhmm = (s) => {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(s);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
function dueAt(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}[:.]\d{2}))?$/.exec(s);
  if (!m || !isRealDay(m[1])) return null;
  const t = m[2] ? hhmm(m[2]) : "23:59";
  return t ? `${m[1]}T${t}` : null;
}
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(day) {
  const [, m, d] = day.slice(0, 10).split("-").map(Number);
  const time = day.length > 10 && !day.endsWith("23:59") ? ` ${day.slice(11, 16)}` : "";
  return `${d} ${MONTH[m - 1]}${time}`;
}
const minutesText = (m) => m === 0 ? "off" : m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ""}${m % 60} min` : `${m / 60} h`;
function findCourse(draft, ref) {
  const r = str(ref).toLowerCase();
  if (!r) return void 0;
  return draft.courses.find((c) => c.id.toLowerCase() === r) ?? draft.courses.find((c) => c.name.toLowerCase() === r) ?? draft.courses.find((c) => c.short.toLowerCase() === r) ?? (draft.courses.filter((c) => c.name.toLowerCase().includes(r)).length === 1 ? draft.courses.find((c) => c.name.toLowerCase().includes(r)) : void 0);
}
function getPart(desk, key2) {
  if (key2 === "profile") return desk.profile;
  const r = /^results\.([^.]+)\.(\w+)$/.exec(key2);
  if (r) return desk.draft.results[r[1]]?.[r[2]];
  return desk.draft[key2];
}
function setPart(desk, key2, value) {
  if (key2 === "profile") return { ...desk, profile: value };
  const r = /^results\.([^.]+)\.(\w+)$/.exec(key2);
  if (r) {
    const cur = desk.draft.results[r[1]];
    if (!cur) return desk;
    return { ...desk, draft: { ...desk.draft, results: { ...desk.draft.results, [r[1]]: { ...cur, [r[2]]: value } } } };
  }
  return { ...desk, draft: { ...desk.draft, [key2]: value } };
}
const OWN_WORD = " (set by the student in StudyDesk)";
const dateLabel = (k) => `${k.kind === "quiz" ? "Quiz" : "Exam"} "${k.title}"`;
const clone = (x) => x === void 0 ? x : JSON.parse(JSON.stringify(x));
const same$1 = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function applyOps(desk0, ops, o) {
  const now = o.now ?? Date.now();
  let desk = { draft: { ...desk0.draft }, profile: { ...desk0.profile } };
  const lines = [];
  const errors = [];
  const touched = /* @__PURE__ */ new Set();
  const needsConfirm = [];
  const newCourses = [];
  const attempts = [];
  const targets = [];
  let undoable = true;
  const touch = (key2, value) => {
    touched.add(key2);
    desk = setPart(desk, key2, value);
  };
  const course = (op) => {
    const c = findCourse(desk.draft, op.course);
    if (!c) errors.push(`${op.op}: no course "${str(op.course)}". Courses: ${desk.draft.courses.map((x) => `${x.name} (${x.id})`).join(", ") || "none"}.`);
    return c ?? null;
  };
  const result = (c) => desk.draft.results[c.id];
  const scale = () => desk.profile.gradeScale;
  const inScale = (g) => {
    const lo = Math.min(scale().best, scale().worst);
    const hi = Math.max(scale().best, scale().worst);
    return g >= lo && g <= hi;
  };
  const fact = (c, text) => touch("facts", [...desk.draft.facts, { id: uid(), courseId: c?.id ?? null, text, addedAt: now }]);
  const isOwn = (c, label2) => (f) => f.courseId === c.id && f.text.startsWith(`${label2}:`) && f.text.endsWith(OWN_WORD);
  const studentSet = (c, label2) => o.by === "organization" && desk.draft.facts.some(isOwn(c, label2));
  const ownWord = (c, label2, value) => {
    if (o.by === "organization") return;
    touch("facts", [...desk.draft.facts.filter((f) => !isOwn(c, label2)(f)), { id: uid(), courseId: c.id, text: `${label2}: ${value}${OWN_WORD}`, addedAt: now }]);
  };
  for (const op of ops) {
    if (CONFIRM_FIRST.has(op.op) && !o.confirmed) {
      needsConfirm.push(op);
      continue;
    }
    switch (op.op) {
      case "set_target_grade": {
        const c = course(op);
        const g = num(op.grade);
        if (!c) break;
        if (g === null || !inScale(g)) {
          errors.push(`set_target_grade: ${str(op.grade)} isn't on the scale ${scale().name} (${scale().best} best, ${scale().worst} worst).`);
          break;
        }
        touch("courses", desk.draft.courses.map((x) => x.id === c.id ? { ...x, targetGrade: g } : x));
        targets.push({ courseId: c.id, targetGrade: g, gradeScale: scale() });
        lines.push(`${c.name}, target grade: ${c.targetGrade ?? "none"} → ${g}`);
        break;
      }
      case "set_exam_date": {
        const c = course(op);
        const date = str(op.date);
        if (!c) break;
        if (!isRealDay(date)) {
          errors.push(`set_exam_date: "${date}" isn't a real date (YYYY-MM-DD).`);
          break;
        }
        const kind = op.kind === "quiz" ? "quiz" : "exam";
        const title = str(op.title) || (kind === "exam" ? "Exam" : "Quiz");
        const r = result(c);
        if (!r) {
          fact(c, `${title}: ${date}`);
          lines.push(`${c.name}, ${title}: ${shortDate(date)} (noted; used once the course is read)`);
          break;
        }
        const list = r.keyDates;
        const i = list.findIndex((k) => k.title.toLowerCase() === title.toLowerCase());
        const j = i >= 0 ? i : list.filter((k) => k.kind === kind).length === 1 && !op.title ? list.findIndex((k) => k.kind === kind) : -1;
        if (j >= 0) {
          if (list[j].date === date) break;
          if (studentSet(c, dateLabel(list[j]))) {
            errors.push(`set_exam_date: the student set ${c.name}, ${list[j].title} to ${list[j].date} themselves; not changed.`);
            break;
          }
          touch(`results.${c.id}.keyDates`, list.map((k, n) => n === j ? { ...k, date } : k));
          ownWord(c, dateLabel(list[j]), date);
          lines.push(`${c.name}, ${list[j].title}: ${shortDate(list[j].date)} → ${shortDate(date)}`);
        } else {
          touch(`results.${c.id}.keyDates`, [...list, { courseId: c.id, date, kind, title, skillIds: [] }]);
          ownWord(c, dateLabel({ kind, title }), date);
          lines.push(`${c.name}, ${title}: added on ${shortDate(date)}`);
        }
        break;
      }
      case "remove_exam_date": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const title = str(op.title).toLowerCase();
        const k = r?.keyDates.find((x) => x.title.toLowerCase() === title);
        if (!r || !k) {
          errors.push(`remove_exam_date: ${c.name} has no date called "${str(op.title)}".`);
          break;
        }
        touch(`results.${c.id}.keyDates`, r.keyDates.filter((x) => x !== k));
        ownWord(c, dateLabel(k), "removed, there is no such date");
        lines.push(`${c.name}, ${k.title} on ${shortDate(k.date)}: removed`);
        break;
      }
      case "set_due": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const ref = str(op.homework).toLowerCase();
        const a = r?.assignments.find((x) => x.id.toLowerCase() === ref || x.title.toLowerCase() === ref);
        const due = dueAt(str(op.dueAt));
        if (!r || !a) {
          errors.push(`set_due: ${c.name} has no homework "${str(op.homework)}". Homework: ${r?.assignments.map((x) => x.title).join(", ") || "none"}.`);
          break;
        }
        if (!due) {
          errors.push(`set_due: "${str(op.dueAt)}" isn't a date (YYYY-MM-DD or YYYY-MM-DDTHH:MM).`);
          break;
        }
        if (studentSet(c, `Homework "${a.title}"`)) {
          errors.push(`set_due: the student set ${c.name}, ${a.title} themselves; not changed.`);
          break;
        }
        touch(`results.${c.id}.assignments`, r.assignments.map((x) => x.id === a.id ? { ...x, dueAt: due } : x));
        ownWord(c, `Homework "${a.title}"`, `due ${due}`);
        lines.push(`${c.name}, ${a.title} due: ${shortDate(a.dueAt)} → ${shortDate(due)}`);
        break;
      }
      case "add_homework": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const due = dueAt(str(op.dueAt));
        const title = str(op.title);
        if (!r) {
          errors.push(`add_homework: ${c.name} hasn't been read yet, so there are no skills to link the tasks to. Start a job with the sheet instead.`);
          break;
        }
        if (!title || !due) {
          errors.push(`add_homework: needs a title and a due date (YYYY-MM-DD or YYYY-MM-DDTHH:MM).`);
          break;
        }
        const tasksIn = Array.isArray(op.tasks) ? op.tasks : [];
        const skills = r.skills.filter((s) => s.courseId === c.id);
        const bad = [];
        const id = `as_${uid().slice(0, 8)}`;
        const tasks = tasksIn.flatMap((t, n) => {
          const sk = str(t.skill).toLowerCase();
          const skill = skills.find((s) => s.id.toLowerCase() === sk) ?? skills.find((s) => s.name.toLowerCase() === sk);
          const text = str(t.text);
          if (!skill || !text) {
            bad.push(str(t.label) || String(n + 1));
            return [];
          }
          return [{ id: `${id}_${n + 1}`, label: str(t.label) || String(n + 1), skillId: skill.id, prompt: text, maxPoints: Math.max(1, num(t.points) ?? 1) }];
        });
        if (!tasks.length || bad.length) {
          errors.push(`add_homework: ${bad.length ? `tasks ${bad.join(", ")} need the task text and an existing skill of ${c.name} (look_up skills)` : "no tasks given"}. If the sheet is new material, start a job with it instead.`);
          break;
        }
        const a = { id, courseId: c.id, title, dueAt: due, tasks };
        touch(`results.${c.id}.assignments`, [...r.assignments, a]);
        ownWord(c, `Homework "${title}"`, `due ${due}, ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`);
        lines.push(`${c.name}, ${title}: added, ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}, due ${shortDate(due)}`);
        break;
      }
      case "remove_homework": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const ref = str(op.homework).toLowerCase();
        const a = r?.assignments.find((x) => x.id.toLowerCase() === ref || x.title.toLowerCase() === ref);
        if (!r || !a) {
          errors.push(`remove_homework: ${c.name} has no homework "${str(op.homework)}".`);
          break;
        }
        touch(`results.${c.id}.assignments`, r.assignments.filter((x) => x.id !== a.id));
        ownWord(c, `Homework "${a.title}"`, "removed, it doesn't count");
        lines.push(`${c.name}, ${a.title}: removed`);
        break;
      }
      case "set_study_goal": {
        const goal = op.minutes ?? {};
        const next = [...desk.draft.studyGoal];
        const changed = [];
        for (const [k, v] of Object.entries(goal)) {
          const wd = DAY.findIndex((d) => d.toLowerCase() === k.slice(0, 3).toLowerCase());
          const m = num(v);
          if (wd < 0 || m === null || m < 0 || m > 16 * 60) {
            errors.push(`set_study_goal: "${k}: ${str(v)}" needs a weekday and 0 to 960 minutes.`);
            continue;
          }
          if (next[wd] === Math.round(m)) continue;
          changed.push(`${DAY[wd]} ${minutesText(next[wd] ?? 0)} → ${minutesText(Math.round(m))}`);
          next[wd] = Math.round(m);
        }
        if (changed.length) {
          touch("studyGoal", next);
          lines.push(`Study goal: ${changed.join(", ")}`);
        }
        break;
      }
      case "set_day_off": {
        const date = str(op.date);
        if (!isRealDay(date)) {
          errors.push(`set_day_off: "${date}" isn't a real date (YYYY-MM-DD).`);
          break;
        }
        const list = desk.draft.daysOff ?? [];
        if (list.some((d) => d.date === date)) break;
        touch("daysOff", [...list, { date, reason: str(op.reason) }].sort((a, b) => a.date < b.date ? -1 : 1));
        lines.push(`Day off: ${shortDate(date)}${str(op.reason) ? ` (${str(op.reason)})` : ""}, no quest that day`);
        break;
      }
      case "remove_day_off": {
        const date = str(op.date);
        const list = desk.draft.daysOff ?? [];
        if (!list.some((d) => d.date === date)) {
          errors.push(`remove_day_off: ${date} isn't a day off.`);
          break;
        }
        touch("daysOff", list.filter((d) => d.date !== date));
        lines.push(`Day off on ${shortDate(date)}: removed`);
        break;
      }
      case "add_slot": {
        const weekday = DAY.findIndex((d) => d.toLowerCase() === str(op.weekday).slice(0, 3).toLowerCase());
        const start = hhmm(str(op.start));
        const end = hhmm(str(op.end));
        if (weekday < 0 || !start || !end || start >= end) {
          errors.push(`add_slot: needs a weekday and a start before the end (HH:MM).`);
          break;
        }
        const kind = op.kind === "lecture" || op.kind === "exercise" ? op.kind : "fixed";
        const c = kind === "fixed" ? void 0 : findCourse(desk.draft, op.course);
        const entry = { weekday, start, end, kind, title: str(op.title) || c?.name || "Commitment", courseId: c?.id ?? null };
        touch("timetable", [...desk.draft.timetable, entry]);
        lines.push(`Weekly: ${DAY[weekday]} ${start}–${end} ${entry.title} added`);
        break;
      }
      case "remove_slot": {
        const weekday = DAY.findIndex((d) => d.toLowerCase() === str(op.weekday).slice(0, 3).toLowerCase());
        const start = hhmm(str(op.start));
        const t = desk.draft.timetable.find((x) => x.weekday === weekday && x.start === start);
        if (!t) {
          errors.push(`remove_slot: nothing on ${str(op.weekday)} at ${str(op.start)}.`);
          break;
        }
        touch("timetable", desk.draft.timetable.filter((x) => x !== t));
        lines.push(`Weekly: ${DAY[t.weekday]} ${t.start}–${t.end} ${t.title} removed`);
        break;
      }
      case "set_language": {
        const c = course(op);
        const lang = str(op.language);
        if (!c) break;
        if (!lang) {
          errors.push("set_language: needs a language.");
          break;
        }
        const old = result(c)?.teachingLanguage || c.teachingLanguage || "not set";
        touch("courses", desk.draft.courses.map((x) => x.id === c.id ? { ...x, teachingLanguage: lang } : x));
        if (result(c)) touch(`results.${c.id}.teachingLanguage`, lang);
        lines.push(`${c.name}, language of explanations: ${old} → ${lang}`);
        break;
      }
      case "set_quest_settings": {
        const cur = { ...desk.draft.questSettings ?? {} };
        const now_ = questSettingsNow(cur);
        const labels = { hints: "hints per task", lessonMinutes: "lesson reading minutes", newSkillsPerQuest: "new skills per quest", newSkillsBeforeExams: "new skills per quest in exam weeks" };
        const changed = [];
        for (const k of Object.keys(QUEST_SETTING_LIMITS)) {
          if (op[k] === void 0) continue;
          const v = num(op[k]);
          const [lo, hi] = QUEST_SETTING_LIMITS[k];
          if (v === null || v < lo || v > hi || Math.round(v) !== v) {
            errors.push(`set_quest_settings: ${k} must be a whole number from ${lo} to ${hi}.`);
            continue;
          }
          if (now_[k] === v) continue;
          changed.push(`${labels[k]} ${now_[k]} → ${v}`);
          cur[k] = v;
        }
        if (typeof op.anki === "boolean" && op.anki !== cur.anki) {
          changed.push(`Anki decks ${op.anki ? "on" : "off"}`);
          cur.anki = op.anki;
        }
        if (changed.length) {
          touch("questSettings", cur);
          lines.push(`Quests: ${changed.join(", ")} (from the next quest)`);
        }
        break;
      }
      case "set_focus": {
        if (/^(none|off|end)$/i.test(str(op.course))) {
          if (!desk.draft.focus) break;
          touch("focus", void 0);
          lines.push("Focus ended: quests pick the most urgent course again");
          break;
        }
        const c = course(op);
        const until = str(op.until);
        if (!c) break;
        if (!isRealDay(until) || until < toDay(new Date(now))) {
          errors.push(`set_focus: "${until}" must be a real date from today on (YYYY-MM-DD).`);
          break;
        }
        touch("focus", { courseId: c.id, until });
        lines.push(`Focus: only ${c.name} until ${shortDate(until)}, other courses' deadlines still show`);
        break;
      }
      case "add_fact": {
        const text = str(op.text);
        const c = op.course ? course(op) : null;
        if (!text || op.course && !c) {
          if (!text) errors.push("add_fact: needs the text.");
          break;
        }
        fact(c, text);
        lines.push(`Noted${c ? ` for ${c.name}` : ""}: "${text}"`);
        break;
      }
      case "set_calendar_live": {
        const v = op.on === true || op.on === "true" ? true : op.on === false || op.on === "false" ? false : null;
        if (v === null) {
          errors.push("set_calendar_live: on must be true or false.");
          break;
        }
        if (!desk.draft.calendarImportedAt) {
          errors.push("set_calendar_live: no calendar was imported; use read_calendar first.");
          break;
        }
        if (desk.draft.calendarLive !== false === v) break;
        touch("calendarLive", v);
        lines.push(v ? "Calendar: followed live again, each day's quest is sized from it" : "Calendar: no longer followed day by day, quests go by the weekly timetable");
        break;
      }
      case "set_file_course": {
        const c = course(op);
        const ref = str(op.file);
        const ids = new Set(filesOf(ref, desk.draft.uploads));
        if (!c) break;
        if (!ids.size) {
          errors.push(`set_file_course: no file or zip "${ref}" (look_up files).`);
          break;
        }
        touch("uploads", desk.draft.uploads.map((u) => ids.has(u.id) ? { ...u, courseId: c.id, courseUnsure: void 0 } : u));
        if (ref.startsWith("zip_")) touch("zips", (desk.draft.zips ?? []).map((z) => z.id === ref ? { ...z, courseId: c.id } : z));
        lines.push(`${ids.size === 1 ? desk.draft.uploads.find((u) => ids.has(u.id)).fileName : `${ids.size} files`} → ${c.name}`);
        break;
      }
      case "tick_todo": {
        const key2 = str(op.key);
        const todo = setupTodo(desk.draft, toDay(new Date(now)));
        const item = todo.find((t) => t.key === key2 || t.title === key2);
        const sub = item ? void 0 : todo.flatMap((t) => t.subs ?? []).find((x) => x.key === key2);
        if (!item && !sub) {
          errors.push(`tick_todo: no to-do "${key2}"; use a key from openToDo (an item or one of its parts).`);
          break;
        }
        const target = item ? { key: item.key, label: item.title, done: item.done } : { key: sub.key, label: sub.text.replace(/\*\*/g, ""), done: sub.done };
        const on = !(op.done === false || op.done === "false");
        if (target.done === on) break;
        const list = desk.draft.todoDone ?? [];
        const parent = target.key.split(":")[0];
        touch("todoDone", on ? [.../* @__PURE__ */ new Set([...list, target.key])] : list.filter((k) => k !== target.key && k !== parent));
        if (on) touch("todoDoneOn", { ...desk.draft.todoDoneOn, [target.key]: toDay(new Date(now)) });
        lines.push(on ? `To do: ticked off "${target.label}"` : `To do: "${target.label}" is open again`);
        break;
      }
      case "set_nightly": {
        const cur = nightlySettings(desk.profile.nightly);
        const next = { ...cur };
        const changed = [];
        if (op.time !== void 0) {
          const t = hhmm(str(op.time));
          if (!t) errors.push("set_nightly: time must be HH:MM.");
          else if (t !== cur.time) {
            changed.push(`time ${cur.time} → ${t}`);
            next.time = t;
          }
        }
        const flags = { paused: "paused", grading: "grading at night", check: "the courses' nightly check", quest: "writing tomorrow's quest at night" };
        for (const k of Object.keys(flags)) {
          if (op[k] === void 0) continue;
          const v = op[k] === true || op[k] === "true" ? true : op[k] === false || op[k] === "false" ? false : null;
          if (v === null) {
            errors.push(`set_nightly: ${k} must be true or false.`);
            continue;
          }
          if (v === cur[k]) continue;
          changed.push(k === "paused" ? v ? "paused" : "running again" : `${flags[k]} ${v ? "on" : "off"}`);
          next[k] = v;
        }
        if (changed.length) {
          touch("profile", { ...desk.profile, nightly: next, updatedAt: now });
          lines.push(`Nightly run: ${changed.join(", ")}`);
        }
        break;
      }
      case "set_sweep": {
        const c = course(op);
        if (!c) break;
        const date = str(op.date);
        const cur = { ...desk.draft.sweepDates ?? {} };
        if (date === "" || date === "none") {
          if (!cur[c.id]) break;
          delete cur[c.id];
          touch("sweepDates", cur);
          lines.push(`${c.name}: your deep sweep date removed (StudyDesk picks one again)`);
          break;
        }
        if (!isRealDay(date)) {
          errors.push('set_sweep: date must be YYYY-MM-DD (or "none").');
          break;
        }
        if (cur[c.id] === date) break;
        cur[c.id] = date;
        touch("sweepDates", cur);
        lines.push(`${c.name}: deep sweep (full re-read) on the night of ${shortDate(date)}`);
        break;
      }
      case "add_wish": {
        const text = str(op.text);
        if (!text) break;
        touch("profile", { ...desk.profile, wishes: [...desk.profile.wishes ?? [], { text, at: now }] });
        lines.push(`Wish saved: ${str(op.title) || text} ${wishLink({ ...op }, "panel")}`);
        break;
      }
      case "set_profile": {
        const p = { ...desk.profile };
        const changed = [];
        for (const k of ["school", "country", "program", "year"]) {
          if (op[k] === void 0 || str(op[k]) === p[k]) continue;
          changed.push(`${k} ${p[k] || "–"} → ${str(op[k])}`);
          p[k] = str(op[k]);
        }
        if (changed.length) {
          touch("profile", { ...p, updatedAt: now });
          lines.push(`Profile: ${changed.join(", ")}`);
        }
        break;
      }
      case "add_result": {
        const c = course(op);
        if (!c) break;
        const points = num(op.points);
        const max = num(op.maxPoints);
        const date = str(op.date);
        if (points === null || max === null || max <= 0 || points < 0 || points > max || !isRealDay(date)) {
          errors.push("add_result: needs points between 0 and maxPoints, maxPoints above 0, and a date (YYYY-MM-DD).");
          break;
        }
        const known2 = new Set((result(c)?.skills ?? []).map((s) => s.id));
        const skillIds = (Array.isArray(op.skills) ? op.skills : []).map(str).filter((s) => known2.has(s));
        const r = { assessmentId: `res_${uid().slice(0, 8)}`, courseId: c.id, component: str(op.component) || "Result", points, maxPoints: max, date, skillIds };
        touch("assessments", [...desk.draft.assessments ?? [], r]);
        attempts.push(...assessmentAttempts(r, now));
        undoable = false;
        lines.push(`${c.name}, ${r.component}: ${points} of ${max} on ${shortDate(date)}`);
        break;
      }
      case "add_course": {
        const name = str(op.name);
        if (!name) {
          errors.push("add_course: needs a name.");
          break;
        }
        const existing = findCourse(desk.draft, name);
        if (existing) {
          errors.push(`add_course: ${existing.name} (${existing.id}) is already there.`);
          break;
        }
        const g = num(op.targetGrade);
        const c = {
          id: `c${uid().slice(0, 6)}`,
          name,
          short: (str(op.short) || name).slice(0, 8),
          credits: num(op.credits),
          teachingLanguage: "",
          targetGrade: g !== null && inScale(g) ? g : null,
          setupStatus: "waiting"
        };
        touch("courses", [...desk.draft.courses, c]);
        if (c.targetGrade !== null) targets.push({ courseId: c.id, targetGrade: c.targetGrade, gradeScale: scale() });
        newCourses.push({ id: c.id, name: c.name });
        lines.push(`New course: ${name}${c.targetGrade !== null ? `, target ${c.targetGrade}` : ""}`);
        break;
      }
      case "drop_course": {
        const c = course(op);
        if (!c) break;
        touch("courses", desk.draft.courses.filter((x) => x.id !== c.id));
        touch("timetable", desk.draft.timetable.filter((t) => t.courseId !== c.id));
        lines.push(`${c.name}: dropped. Its quests stop; its data is kept`);
        break;
      }
      default:
        errors.push(`Unknown operation "${op.op}".`);
    }
  }
  if (!touched.size) return { desk: desk0, change: null, needsConfirm, errors, newCourses, attempts, targets };
  const keys = [...touched];
  const before = {};
  const after = {};
  for (const k of keys) {
    before[k] = clone(getPart(desk0, k));
    after[k] = clone(getPart(desk, k));
  }
  desk = { ...desk, draft: { ...desk.draft, updatedAt: now } };
  const change = { id: `ch_${uid()}`, at: now, by: o.by ?? "orchestrator", studentWords: o.studentWords, ops, lines, touched: keys, before, after, status: "applied", undoable };
  return { desk, change, needsConfirm, errors, newCourses, attempts, targets };
}
function syncSemester(draft, profile, current, now = Date.now()) {
  const built = buildSemester(draft, profile, now);
  if (!current || current.id !== built.id) return built;
  const goalChanged = !same$1(current.studyGoal, built.studyGoal);
  return {
    ...built,
    createdAt: current.createdAt,
    placementQuestId: current.placementQuestId,
    studyGoalSource: goalChanged ? "student" : current.studyGoalSource ?? "student",
    studyGoalDecidedAt: current.studyGoalDecidedAt ?? (goalChanged ? now : void 0)
  };
}
let inFlight = 0;
const BUSY_RETRY_MS = [8e3, 2e4];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(t);
    reject({ code: "cancelled", message: "Stopped." });
  });
});
const MODEL = "claude-opus-5-5";
const FALLBACK_TIER = "complex";
let lastUsed = null;
let samplePromise = null;
function getSample() {
  if (!samplePromise) {
    const c = host();
    samplePromise = c?.use ? c.use("sample").catch(() => null) : Promise.resolve(null);
  }
  return samplePromise;
}
async function maxImages() {
  const sample = await getSample();
  if (!sample) return 0;
  const limits = await sample.limits().catch(() => null);
  return limits?.images ? Math.max(0, limits.images.maxCount) : 0;
}
function fitImages(now, earlier, limits) {
  if (!limits) return { images: [], leftOutNow: now.length, leftOutEarlier: earlier.length };
  const ok = (b) => (!limits.mediaTypes?.length || limits.mediaTypes.includes(b.type)) && (!limits.maxInputBytes || b.size <= limits.maxInputBytes);
  const room = Math.max(0, limits.maxCount);
  const n = now.filter(ok).slice(0, room);
  const e = earlier.filter(ok).slice(0, room - n.length);
  return { images: [...n, ...e], leftOutNow: now.length - n.length, leftOutEarlier: earlier.length - e.length };
}
function withNote(turns, note) {
  if (!note) return turns;
  const out = turns.map((t) => ({ ...t }));
  out[out.length - 1].content += `

${note}`;
  return out;
}
function leftOutNote(leftOutNow, leftOutEarlier) {
  return [
    leftOutNow ? `(StudyDesk could attach only some of this turn's images: the last ${leftOutNow} ${leftOutNow === 1 ? "is" : "are"} missing. Tell the student which ones you can't see, and ask them to send those again in a later message.)` : "",
    leftOutEarlier ? `(${leftOutEarlier} of the earlier images couldn't be attached again this turn. Go by what was already said about ${leftOutEarlier === 1 ? "it" : "them"}.)` : ""
  ].filter(Boolean).join("\n");
}
async function askClaude(turns, opts = {}) {
  const sample = await getSample();
  if (!sample) return mockAnswer(turns, opts);
  if (opts.background && inFlight > 0) throw { code: "skipped", message: "Another call is running." };
  inFlight++;
  try {
    for (let attempt = 0; ; attempt++) {
      let streamed = false;
      try {
        return await askOnce(sample, turns, { ...opts, onText: opts.onText ? (t) => (streamed = true, opts.onText(t)) : void 0 });
      } catch (e) {
        const err = e;
        if (err.code !== "rate_limited" || streamed || opts.background || attempt >= BUSY_RETRY_MS.length || opts.signal?.aborted) throw err;
        await sleep(BUSY_RETRY_MS[attempt], opts.signal);
      }
    }
  } finally {
    inFlight--;
  }
}
async function askOnce(sample, turns, opts) {
  const now = opts.images ?? [];
  const earlier = opts.earlierImages ?? [];
  if (!now.length && !earlier.length) return askWith(sample, turns, opts, []);
  const limits = await sample.limits().catch(() => null);
  const fit = fitImages(now, earlier, limits?.images);
  if (opts.strictImages && fit.leftOutNow) throw { code: "image_rejected", message: `${fit.leftOutNow} of ${now.length} images can't be sent in one question here.` };
  try {
    return await askWith(sample, withNote(turns, leftOutNote(fit.leftOutNow, fit.leftOutEarlier)), opts, fit.images);
  } catch (e) {
    const err = e;
    const sentEarlier = fit.images.length - (now.length - fit.leftOutNow);
    if (err?.code !== "image_rejected" || err.text || sentEarlier <= 0 || opts.signal?.aborted) throw err;
    const onlyNow = fit.images.slice(0, fit.images.length - sentEarlier);
    return askWith(sample, withNote(turns, leftOutNote(fit.leftOutNow, earlier.length)), opts, onlyNow);
  }
}
async function askWith(sample, turns, opts, images) {
  try {
    const res = await sample(turns, {
      ...opts.tools ? { tools: opts.tools } : { cache: false },
      signal: opts.signal,
      model: MODEL,
      modelTier: FALLBACK_TIER,
      images: images.length ? images : void 0,
      onText: opts.onText ? ({ text: text2 }) => opts.onText(text2) : void 0
    });
    const { text, truncated } = res;
    lastUsed = { opus: res.modelApplied === MODEL, tier: res.modelTierApplied };
    return truncated ? text + "\n\n*(The answer was cut short. Ask for less at a time.)*" : text;
  } catch (e) {
    throw normalize(e);
  }
}
function normalize(e) {
  if (e && typeof e === "object" && "code" in e) return e;
  return { code: "upstream_error", message: String(e) };
}
async function mockAnswer(turns, opts) {
  const last = turns[turns.length - 1]?.content ?? "";
  const isNote = last.includes("HIGHLIGHTED PASSAGE") || turns.some((t) => t.content.includes("HIGHLIGHTED PASSAGE"));
  const text = isNote ? "**Short answer:** this is a local preview, so no real Claude is connected.\n\nInside claude.ai this box would explain the highlighted passage, using the whole chat as context, without adding anything to the main conversation." : "Here's a sample answer from the local preview.\n\n## Photosynthesis in one paragraph\n\nPlants turn light energy into chemical energy. In the **light-dependent reactions**, water is split and ATP and NADPH are made. In the **Calvin cycle**, that energy fixes CO₂ into glucose:\n\n$$6\\,CO_2 + 6\\,H_2O \\xrightarrow{light} C_6H_{12}O_6 + 6\\,O_2$$\n\n### Watch out for\n\n- Include **zero coefficients** for missing powers. For $x^3 + 4$, use $1, 0, 0, 4$.\n- A divisor $(x + 2)$ means $c = -2$, so mind the sign.\n\nSelect any part of this answer and press **Reply** to ask about it in a side note.";
  let out = "";
  for (const word of text.split(/(?<= )/)) {
    if (opts.signal?.aborted) throw { code: "cancelled", message: "aborted", text: out };
    await new Promise((r) => setTimeout(r, 12));
    out += word;
    opts.onText?.(out);
  }
  return out;
}
const VERDICTS = ["solved", "slip", "not_understood"];
const ERROR_KINDS = ["none", "slip", "concept", "missing_fundamental"];
function gradingTurns(problems) {
  let img = 0;
  const blocks = problems.map((p) => {
    const images = (p.answerImages ?? []).map(() => `image ${++img}`);
    return [
      `### Problem ${p.problemId}`,
      `Skill: ${p.skillName}`,
      p.fundamentals.length ? `Fundamentals it depends on: ${p.fundamentals.map((f) => `${f.name} (id ${f.skillId})`).join("; ")}` : "Fundamentals it depends on: none listed",
      `Max points: ${p.maxPoints}`,
      `Hints used: ${p.hintsUsed}${p.sawWorkedExample ? ", and the student saw a fully solved similar problem" : ""}`,
      p.homeworkNotHandedIn ? "This is real homework that hasn't been handed in to school yet: in feedback, name the first wrong step and the principle, and do NOT give the full answer." : "Practice problem: feedback may show the correct result.",
      `Problem:
"""
${p.prompt}
"""`,
      `Answer key or rubric:
"""
${p.answerKey}
"""`,
      `Student's answer:
"""
${p.answerText || "(see images)"}
"""`,
      images.length ? `Student's work is also in ${images.join(", ")}.` : ""
    ].filter(Boolean).join("\n");
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
  return [{ role: "user", content: `${instructions}

${blocks.join("\n\n")}` }];
}
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in the reply");
  return JSON.parse(body.slice(start, end + 1));
}
function parseGrading(text, problems) {
  let raw;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, errors: [`Reply was not a JSON array (${e.message}).`] };
  }
  if (!Array.isArray(raw)) return { ok: false, errors: ["Reply was not a JSON array."] };
  const errors = [];
  const results = [];
  for (const p of problems) {
    const r = raw.find((x) => x && typeof x === "object" && x.problemId === p.problemId);
    if (!r) {
      errors.push(`Missing problem ${p.problemId}.`);
      continue;
    }
    const verdict = r.verdict;
    const errorKind = r.errorKind ?? (verdict === "solved" ? "none" : "concept");
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
      feedback
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, results };
}
class GradingFailed extends Error {
  constructor(errors) {
    super(`The grading agent's answer couldn't be used: ${errors.join(" ")}`);
    this.errors = errors;
  }
}
function imageGroups(problems, limit) {
  if (!limit) return [problems];
  const groups = [];
  let group = [];
  let count = 0;
  for (const p of problems) {
    const n = p.answerImages?.length ?? 0;
    if (n > limit) throw { code: "image_rejected", message: `One answer has ${n} photos; at most ${limit} can be sent at once.` };
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
async function gradeProblems(problems, ask = askClaude, signal, imageLimit) {
  const hasImages = problems.some((p) => p.answerImages?.length);
  const limit = hasImages ? await maxImages() : 0;
  const results = [];
  for (const group of imageGroups(problems, limit)) results.push(...await gradeGroup(group, ask, signal));
  return results;
}
async function gradeGroup(problems, ask, signal) {
  const turns = gradingTurns(problems);
  const images = problems.flatMap((p) => p.answerImages ?? []);
  const opts = { images: images.length ? images : void 0, strictImages: true, signal, tier: "default" };
  const first = await ask(turns, opts);
  const parsed = parseGrading(first, problems);
  if (parsed.ok) return parsed.results;
  const retry = [
    ...turns,
    { role: "assistant", content: first },
    { role: "user", content: `That reply can't be used:
- ${parsed.errors.join("\n- ")}
Reply again with only the corrected JSON array.` }
  ];
  const second = parseGrading(await ask(retry, opts), problems);
  if (second.ok) return second.results;
  throw new GradingFailed(second.errors);
}
function recordResult(p, r, meta) {
  const attempt = {
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
    gradedAt: meta.now
  };
  const review = r.verdict === "solved" ? null : {
    attemptId: attempt.id,
    kind: r.verdict === "slip" ? "slip" : "real_error",
    status: "open",
    slipAnswer: null,
    slipQuestion: r.slipQuestion,
    chatId: null,
    updatedAt: meta.now
  };
  return { attempt, review };
}
const emptyWork = () => ({ answerText: "", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 0, startedAt: null });
function emptyProgress(questId) {
  return { questId, work: {}, handedIn: [], fixIts: [], gatesCleared: [], finishedAt: null, updatedAt: Date.now() };
}
function answerUnlocked(a, nowLocal) {
  return !a || a.dueAt <= nowLocal;
}
function answerTextFor(w) {
  const files = w.files.filter((f) => f.text).map((f) => `[${f.name}]
${f.text}`);
  return [w.answerText.trim(), ...files].filter(Boolean).join("\n\n");
}
function gradingProblem(p, part, w, skills, images, homeworkOpen) {
  const s = skills.get(p.skillId);
  return {
    problemId: p.id,
    skillId: p.skillId,
    skillName: s.name,
    fundamentals: s.prereqSkillIds.map((id) => skills.get(id)).filter((f) => !!f && f.isFundamental).map((f) => ({ skillId: f.id, name: f.name })),
    part: part !== "fixit" && part.kind === "assignment" ? "assignment" : part !== "fixit" && part.check ? "check" : "practice",
    prompt: p.prompt,
    answerKey: p.answerKey,
    maxPoints: p.maxPoints,
    answerText: answerTextFor(w),
    answerImages: images.length ? images : void 0,
    hintsUsed: w.hintsShown,
    sawWorkedExample: w.sawSimilar,
    homeworkNotHandedIn: part !== "fixit" && part.kind === "assignment" && homeworkOpen
  };
}
async function handIn(opts) {
  const skills = new Map(opts.semester.skills.map((s) => [s.id, s]));
  const assignmentOf = (part) => part === "fixit" ? void 0 : opts.semester.assignments.find((a) => a.id === part.assignmentId);
  const gps = opts.problems.map(
    ({ problem, part }) => gradingProblem(
      problem,
      part,
      opts.work[problem.id] ?? emptyWork(),
      skills,
      opts.images[problem.id] ?? [],
      part !== "fixit" && part.kind === "assignment" && !answerUnlocked(assignmentOf(part), opts.nowLocal)
    )
  );
  const results = await gradeProblems(gps, opts.ask, opts.signal);
  const now = opts.now ?? Date.now();
  const attempts = [];
  const reviews = [];
  const work = {};
  for (const { problem } of opts.problems) {
    const r = results.find((x) => x.problemId === problem.id);
    const gp = gps.find((x) => x.problemId === problem.id);
    const w = opts.work[problem.id] ?? emptyWork();
    const attemptId = `${opts.quest.id}_${problem.id}_${now.toString(36)}`;
    const { attempt, review } = recordResult(gp, r, {
      attemptId,
      questId: opts.quest.id,
      day: opts.today,
      activeSeconds: Math.round(w.activeSeconds),
      startedAt: w.startedAt ?? now,
      now
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
      fundamentalSkillId: r.fundamentalSkillId
    };
  }
  return { attempts, reviews, work };
}
function allHandedIn(quest, progress) {
  return quest.parts.every((p) => progress.handedIn.includes(p.id));
}
function ungraded(quest, progress) {
  return quest.parts.flatMap(
    (part) => part.kind === "learn" || !progress.handedIn.includes(part.id) || progress.dismissed?.includes(part.id) ? [] : part.problems.filter((p) => !progress.work[p.id]?.verdict).map((problem) => ({ problem, part }))
  );
}
function isFinished(quest, progress) {
  return allHandedIn(quest, progress) && ungraded(quest, progress).length === 0;
}
const flat = (s) => s.replace(/\s+/g, " ").trim();
const key = (c) => flat(c.front).toLowerCase();
function decks(quests) {
  const out = /* @__PURE__ */ new Map();
  for (const quest of [...quests].sort((a, b) => a.createdAt - b.createdAt))
    for (const p of quest.parts) {
      if (p.kind !== "lesson" || !p.cards?.length) continue;
      const deck = out.get(p.skillIds[0]) ?? /* @__PURE__ */ new Map();
      for (const c of p.cards) deck.set(key(c), c);
      out.set(p.skillIds[0], deck);
    }
  return new Map([...out].map(([id, d]) => [id, [...d.values()]]));
}
function deckSizes(records, semester) {
  if (!semester.questSettings?.anki) return void 0;
  return new Map([...decks(records.map((r) => r.quest))].map(([id, d]) => [id, d.length]));
}
function addAnki(quest, records, semester) {
  if (!semester.questSettings?.anki) return;
  const all = decks(records.map((r) => r.quest));
  const tested = /* @__PURE__ */ new Set();
  const { cardsPerTest } = QUEST_CONFIG.anki;
  let cards = 0;
  for (const part of quest.parts) {
    if (part.kind !== "lesson" && part.kind !== "practice") continue;
    for (const p of part.problems) {
      const deck = all.get(p.skillId);
      if (!deck) continue;
      const past = records.flatMap((r) => r.quest.parts).filter((x) => x.kind !== "learn" && x.problems.some((y) => y.skillId === p.skillId && y.cards)).length;
      const start = past * cardsPerTest % deck.length;
      p.cards = [...deck, ...deck].slice(start, start + Math.min(cardsPerTest, deck.length));
      cards += p.cards.length;
      tested.add(p.skillId);
    }
    if (part.kind === "lesson" && part.problems[0].cards) {
      const test = { kind: "practice", id: part.id, title: `Test: ${part.title}`, gate: false, problems: part.problems };
      quest.parts[quest.parts.indexOf(part)] = test;
    }
  }
  if (!tested.size) return;
  const minutes = ankiMinutes(cards);
  const names = [...tested].map((id) => semester.skills.find((s) => s.id === id)?.name ?? id);
  const first = quest.parts.findIndex((x) => x.kind !== "learn" && x.problems.some((p) => p.cards));
  quest.parts.splice(first, 0, {
    kind: "learn",
    id: "anki",
    title: `Study in Anki: ${names.join(", ")}`,
    skillIds: [...tested],
    estMinutes: minutes,
    body: `Study these cards in Anki for about ${minutes} minutes: ${names.join(", ")}. If they aren't in Anki yet, use **Export deck** at the top and import the file first. Then take the short test below; that test is what counts for your progress.`
  });
  quest.plannedMinutes = quest.parts.reduce((s, p) => s + partMinutes(p), 0);
}
const timed = (attempts) => sortAttempts(attempts).filter((a) => a.part !== "assessment" && a.activeSeconds > 0);
function slownessFactor(skills, attempts) {
  const est = new Map(skills.map((s) => [s.id, s.estMinutes]));
  const ratios = timed(attempts).filter((a) => (est.get(a.skillId) ?? 0) > 0).slice(-20).map((a) => a.activeSeconds / 60 / est.get(a.skillId));
  const m = median(ratios);
  if (m === null) return CONFIG.timing.slownessStart;
  return Math.min(CONFIG.timing.slownessMax, Math.max(CONFIG.timing.slownessMin, m));
}
function expectedMinutes(skill, attempts, slowness) {
  const own = timed(attempts).filter((a) => a.skillId === skill.id);
  if (own.length >= CONFIG.timing.ownMedianMinAttempts) {
    return median(own.slice(-5).map((a) => a.activeSeconds / 60));
  }
  return skill.estMinutes * slowness;
}
function activeMinutesByDay(attempts) {
  const m = /* @__PURE__ */ new Map();
  for (const a of timed(attempts)) m.set(a.day, (m.get(a.day) ?? 0) + a.activeSeconds / 60);
  return [...m].sort(([a], [b]) => a < b ? -1 : 1).map(([day, minutes]) => ({ day, minutes }));
}
function questBudget(dailyGoalMinutes, busyMinutes2, attempts, today, readByDay) {
  const freeMinutes = Math.max(0, dailyGoalMinutes - busyMinutes2);
  const byDay = new Map(activeMinutesByDay(attempts).map((d) => [d.day, d.minutes]));
  for (const [day, m] of readByDay ?? []) byDay.set(day, (byDay.get(day) ?? 0) + m);
  const days = [...byDay].filter(([day]) => day < today).sort(([a], [b]) => a < b ? -1 : 1).slice(-3);
  const paceMinutes = days.length ? days.reduce((s, [, m]) => s + m, 0) / days.length : null;
  const raw = paceMinutes === null ? freeMinutes * CONFIG.budget.newStudentShare : Math.min(freeMinutes * CONFIG.budget.shareOfFreeTime, paceMinutes * CONFIG.budget.paceFactor);
  return { freeMinutes, paceMinutes, budgetMinutes: Math.round(raw) };
}
const minutesOf = (hhmm2) => {
  const [h, m] = hhmm2.split(":").map(Number);
  return h * 60 + m;
};
function weekdayOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function busyMinutes(timetable, weekday) {
  return timetable.filter((t) => t.weekday === weekday).reduce((s, t) => s + Math.max(0, minutesOf(t.end) - minutesOf(t.start)), 0);
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function formatDue(dueAt2, today) {
  const [day, time] = dueAt2.split("T");
  const diff = daysBetween(today, day);
  const when = diff === 0 ? "today" : diff === 1 ? "tomorrow" : WEEKDAYS[weekdayOf(day)];
  return time ? `${when} ${time}` : when;
}
const known = (st) => st?.stage === "mastered" || st?.stage === "retained";
const needsTeaching = (st) => !st || st.stage === "new" || st.stage === "lapsed";
const openTasks = (a, done) => a.tasks.filter((t) => !done.has(t.id));
function upcomingAssignments(semester, today, nowLocal, done, courseId) {
  const until = addDays(today, QUEST_CONFIG.assignmentLookaheadDays);
  return semester.assignments.filter((a) => (!courseId || a.courseId === courseId) && a.dueAt >= nowLocal && a.dueAt.slice(0, 10) <= until).filter((a) => openTasks(a, done).length > 0).sort((a, b) => a.dueAt < b.dueAt ? -1 : 1);
}
function examsSoon(semester, today) {
  const until = addDays(today, CONFIG.examCheckWindowDays);
  return semester.keyDates.filter((k) => k.date >= today && k.date <= until).map((k) => {
    const target = semester.targets.find((t) => t.courseId === k.courseId);
    const ids = k.skillIds.length ? new Set(k.skillIds) : null;
    const skillIds = semester.skills.filter((s) => s.courseId === k.courseId && (!ids || ids.has(s.id)) && (!target || isRequired(s, target))).map((s) => s.id);
    return { ...k, skillIds };
  });
}
function focusNow(semester, today) {
  const f = semester.focus;
  return f && today <= f.until && semester.courses.some((c) => c.id === f.courseId) ? f : null;
}
function pickCourse(input, exam) {
  if (input.courseId) return input.courseId;
  const focus = focusNow(input.semester, input.today);
  if (focus) return focus.courseId;
  const hw = upcomingAssignments(input.semester, input.today, input.nowLocal, input.doneTaskIds)[0];
  const hwDay = hw?.dueAt.slice(0, 10);
  if (exam && !(hwDay && hwDay <= addDays(input.today, QUEST_CONFIG.urgentWithinDays) && hwDay < exam.date)) return exam.courseId;
  return hw?.courseId ?? input.semester.courses[0].id;
}
function planQuest(input) {
  const { semester, today, attempts, reviews } = input;
  applyQuestSettings(semester.questSettings);
  const skills = semester.skills;
  const { states } = replay(skills, attempts, reviews);
  const exams = examsSoon(semester, today);
  const dueAll = new Set(dueSkills(skills, states, attempts, exams, today));
  const open = (k) => k.skillIds.filter((id) => !known(states.get(id)) || dueAll.has(id)).length;
  const load = (k) => open(k) / Math.max(1, daysBetween(today, k.date));
  const exam = exams.filter((k) => open(k) > 0).sort((a, b) => load(b) - load(a) || (a.date < b.date ? -1 : 1))[0];
  const courseId = pickCourse(input, exam);
  const course = semester.courses.find((c) => c.id === courseId);
  const target = semester.targets.find((t) => t.courseId === courseId);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const courseSkills = skills.filter((s) => s.courseId === courseId);
  const required = (s) => !target || isRequired(s, target);
  const courseExams = exams.filter((k) => k.courseId === courseId);
  const examSkills = new Set(courseExams.flatMap((k) => k.skillIds));
  const slowness = slownessFactor(skills, attempts);
  const expMin = (s) => Math.max(1, Math.round(expectedMinutes(s, attempts, slowness)));
  const weekday = weekdayOf(today);
  const goal = semester.daysOff?.includes(today) ? 0 : semester.studyGoal[weekday] ?? 0;
  const fixedBusy = busyMinutes(semester.timetable, weekday);
  const busy = input.calendarBusyMinutes !== void 0 ? Math.max(input.calendarBusyMinutes, fixedBusy) : fixedBusy;
  const budget = questBudget(goal, busy, attempts, today, input.reading?.minutesByDay);
  const budgetMinutes = input.budgetOverride ?? budget.budgetMinutes;
  if (budgetMinutes <= 0) return { kind: "no_time", freeMinutes: budget.freeMinutes, goalMinutes: goal };
  const limit = budgetMinutes * (1 + QUEST_CONFIG.overBudgetTolerance);
  const gate = [];
  const concepts = [];
  const taskLearn = [];
  const tasks = [];
  const reviewIds = [];
  const newIds = [];
  const planned = /* @__PURE__ */ new Set();
  const leftOut = [];
  const empty = () => !gate.length && !tasks.length && !reviewIds.length && !newIds.length;
  const lessonMin = (s) => Math.max(1, Math.round(expMin(s) * QUEST_CONFIG.lesson.problemShare));
  const cards = (id) => Math.min(QUEST_CONFIG.anki.cardsPerTest, input.deckSizes?.get(id) ?? 0);
  const minutes = () => {
    let m = 0;
    for (const id of [...concepts, ...taskLearn, ...newIds]) m += (cards(id) ? 0 : QUEST_CONFIG.lesson.readMinutes) + lessonMin(byId.get(id));
    for (const id of [...gate, ...reviewIds]) m += expMin(byId.get(id));
    for (const t of tasks) m += expMin(byId.get(t.task.skillId));
    return m + ankiMinutes([...concepts, ...taskLearn, ...newIds, ...gate, ...reviewIds].reduce((n, id) => n + cards(id), 0));
  };
  const tryAdd = (apply, rollback, force = false) => {
    apply();
    if (force || minutes() <= limit) return true;
    rollback();
    return false;
  };
  for (const id of input.blockerSkillIds) {
    const s = byId.get(id);
    if (!s || s.courseId !== courseId || planned.has(id) || known(states.get(id))) continue;
    tryAdd(
      () => (gate.push(id), planned.add(id)),
      () => (gate.pop(), planned.delete(id))
    );
  }
  const assignments = upcomingAssignments(semester, today, input.nowLocal, input.doneTaskIds, courseId);
  const urgentUntil = addDays(today, QUEST_CONFIG.urgentWithinDays);
  const addHomework = (list, urgent) => {
    for (const a of list) {
      for (const task of openTasks(a, input.doneTaskIds)) {
        const skill = byId.get(task.skillId);
        if (!skill) continue;
        const added = { gate: [], concepts: [], learn: [] };
        for (const pid of skill.prereqSkillIds) {
          const p = byId.get(pid);
          if (!p || planned.has(pid) || !needsTeaching(states.get(pid))) continue;
          (p.isFundamental ? added.gate : added.concepts).push(pid);
        }
        if (!planned.has(skill.id) && needsTeaching(states.get(skill.id))) added.learn.push(skill.id);
        const ok = tryAdd(
          () => {
            gate.push(...added.gate);
            concepts.push(...added.concepts);
            taskLearn.push(...added.learn);
            tasks.push({ assignment: a, task });
            [...added.gate, ...added.concepts, ...added.learn].forEach((id) => planned.add(id));
          },
          () => {
            gate.splice(gate.length - added.gate.length);
            concepts.splice(concepts.length - added.concepts.length);
            taskLearn.splice(taskLearn.length - added.learn.length);
            tasks.pop();
            [...added.gate, ...added.concepts, ...added.learn].forEach((id) => planned.delete(id));
          },
          urgent && tasks.length === 0
          // urgent homework always gets at least one task
        );
        if (!ok) leftOut.push(`${a.title} ${task.label}`);
      }
    }
    for (const t of tasks) planned.add(t.task.skillId);
  };
  addHomework(assignments.filter((a) => a.dueAt.slice(0, 10) <= urgentUntil), true);
  const stageOrder = { lapsed: 0, mastered: 1, learning: 2, retained: 3, new: 4 };
  const due = courseSkills.filter((s) => dueAll.has(s.id) && !planned.has(s.id) && (!examSkills.size || examSkills.has(s.id))).sort((a, b) => stageOrder[states.get(a.id).stage] - stageOrder[states.get(b.id).stage] || b.weight - a.weight).map((s) => s.id);
  for (const id of due) {
    const ok = tryAdd(
      () => (reviewIds.push(id), planned.add(id)),
      () => (reviewIds.pop(), planned.delete(id))
    );
    if (!ok) leftOut.push(`review: ${byId.get(id).name}`);
  }
  const examRank = (s) => {
    const e = semester.keyDates.filter((x) => x.date >= today && x.skillIds.includes(s.id)).sort((a, b) => a.date < b.date ? -1 : 1)[0];
    return e ? daysBetween(today, e.date) : 9999;
  };
  const topicRank = (s) => course.topics.findIndex((t) => t.id === s.topicId);
  const addNew = (list, max) => {
    const fresh = list.filter((s) => required(s) && !planned.has(s.id) && (states.get(s.id)?.stage ?? "new") === "new").sort((a, b) => examRank(a) - examRank(b) || topicRank(a) - topicRank(b) || Number(b.isFundamental) - Number(a.isFundamental));
    let added = 0;
    for (const s of fresh) {
      if (added >= max) break;
      if (!s.prereqSkillIds.every((p) => known(states.get(p)) || planned.has(p) || !byId.has(p))) continue;
      if (tryAdd(() => (newIds.push(s.id), planned.add(s.id)), () => (newIds.pop(), planned.delete(s.id)), empty())) added++;
    }
  };
  addNew(courseSkills.filter((s) => examSkills.has(s.id)), Infinity);
  addHomework(
    assignments.filter((a) => a.dueAt.slice(0, 10) > urgentUntil),
    empty()
  );
  if (tasks.length === 0) {
    addNew(
      courseSkills.filter((s) => !examSkills.has(s.id)),
      examSkills.size ? QUEST_CONFIG.newBeforeExams : QUEST_CONFIG.maxNewSkills
    );
  }
  if (empty()) return { kind: "nothing_to_do", courseId };
  let pn = 0;
  let partN = 0;
  const names = (ids) => ids.map((id) => byId.get(id).name);
  const practiceProblem = (id) => ({
    id: `p${++pn}`,
    skillId: id,
    prompt: "",
    answerKey: "",
    hints: [],
    similarSolved: null,
    expMinutes: expMin(byId.get(id)),
    maxPoints: QUEST_CONFIG.practiceMaxPoints
  });
  const lesson = (id) => ({
    kind: "lesson",
    id: `part${++partN}`,
    title: byId.get(id).name,
    gate: false,
    skillIds: [id],
    readMinutes: QUEST_CONFIG.lesson.readMinutes,
    body: "",
    problems: [{ ...practiceProblem(id), expMinutes: lessonMin(byId.get(id)) }]
  });
  const practice = (ids, title, isGate) => ({
    kind: "practice",
    id: `part${++partN}`,
    title,
    gate: isGate,
    problems: ids.map(practiceProblem)
  });
  const parts = [];
  if (reviewIds.length) parts.push(practice(reviewIds, "Warm-up: skills coming back today", false));
  if (gate.length) parts.push(practice(gate, "Quick check: the basics the next steps use", true));
  for (const id of [...concepts, ...taskLearn, ...newIds]) parts.push(lesson(id));
  for (const a of assignments) {
    const mine = tasks.filter((t) => t.assignment.id === a.id);
    if (!mine.length) continue;
    parts.push({
      kind: "assignment",
      id: `part${++partN}`,
      title: `${a.title}, ${mine.length === 1 ? "task" : "tasks"} ${mine.map((t) => t.task.label).join(" and ")}`,
      gate: false,
      assignmentId: a.id,
      handedInToSchool: false,
      problems: mine.map(({ task }) => ({
        id: `p${++pn}`,
        skillId: task.skillId,
        label: task.label,
        assignmentTaskId: task.id,
        prompt: task.prompt,
        answerKey: "",
        hints: [],
        similarSolved: null,
        expMinutes: expMin(byId.get(task.skillId)),
        maxPoints: task.maxPoints
      }))
    });
  }
  let reason;
  if (courseExams.length && !tasks.length) {
    reason = `${courseExams.map((k) => `${k.title} is ${formatDue(k.date, today)}`).join(" and ")}, so today covers only exam skills.`;
  } else if (tasks.length) {
    const a = tasks[0].assignment;
    const mine = tasks.filter((t) => t.assignment.id === a.id);
    const lower = (x) => x.charAt(0).toLowerCase() + x.slice(1);
    const needs = [...new Set(mine.map((t) => lower(byId.get(t.task.skillId).name)))];
    const labels = mine.map((t) => t.task.label);
    const who = labels.length > 3 ? `${labels.length} of its tasks` : labels.length < 3 ? labels.join(" and ") : `${labels[0]}, ${labels[1]} and ${labels[2]}`;
    reason = `${a.title} is due ${formatDue(a.dueAt, today)}. ${who} ${labels.length === 1 ? "needs" : "need"}: ${needs.join("; ")}.`;
  } else if (gate.length) {
    reason = `Recent mistakes came from ${names(gate).join(" and ")}, so today fixes that first.`;
  } else if (reviewIds.length && !newIds.length) {
    reason = `${reviewIds.length} ${reviewIds.length === 1 ? "skill is" : "skills are"} due to come back today.`;
  } else {
    reason = `No homework is due this week, so today starts ${names(newIds).join(" and ")}.`;
  }
  const notes = [];
  if (input.budgetOverride !== void 0) {
    notes.push(`You asked for a quest today, so it's about ${budgetMinutes} min.`);
  } else {
    notes.push(
      `Your time today: ${budget.freeMinutes} min free (study goal ${goal} min${busy ? `, minus ${busy} min ${input.calendarBusyMinutes !== void 0 ? "in your calendar" : "of lectures"}` : ""}).`
    );
    notes.push(
      budget.paceMinutes === null ? `StudyDesk doesn't know your pace yet, so this quest uses half of it.` : `You've been finishing about ${Math.round(budget.paceMinutes)} min a day, so this quest is sized to ${budgetMinutes} min.`
    );
  }
  const focus = focusNow(semester, today);
  if (focus?.courseId === courseId) {
    const of = (id) => semester.courses.find((c) => c.id === id)?.name;
    const elsewhere = [
      ...upcomingAssignments(semester, today, input.nowLocal, input.doneTaskIds).filter((a) => a.courseId !== courseId).map((a) => `${of(a.courseId)} ${a.title} due ${formatDue(a.dueAt, today)}`),
      ...exams.filter((k) => k.courseId !== courseId).map((k) => `${of(k.courseId)} ${k.title} ${formatDue(k.date, today)}`)
    ];
    notes.push(`Only ${course.name} until ${(/* @__PURE__ */ new Date(`${focus.until}T12:00`)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, as you asked.${elsewhere.length ? ` Still coming up in other courses: ${elsewhere.join("; ")}.` : ""}`);
  }
  for (const a of assignments) {
    const missing = openTasks(a, input.doneTaskIds).filter((t) => !tasks.some((x) => x.task.id === t.id));
    if (missing.length && daysBetween(today, a.dueAt.slice(0, 10)) <= 1) {
      notes.push(
        `${a.title} ${missing.map((t) => t.label).join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} fit today and ${a.title} is due ${formatDue(a.dueAt, today)}. Ask for a longer quest if you want to finish it.`
      );
    }
  }
  const plannedMinutes = parts.reduce((s, p) => s + partMinutes(p), 0);
  return {
    kind: "quest",
    quest: {
      id: input.questId ?? `qst_${today}_${courseId}`,
      date: today,
      courseId,
      budgetMinutes,
      plannedMinutes,
      reason,
      notes,
      parts,
      readRate: input.reading?.rate ?? QUEST_CONFIG.reading.startRate,
      createdAt: Date.now()
    }
  };
}
function recentBlockers(records, today) {
  const since = addDays(today, -7);
  const out = [];
  for (const r of [...records].sort((a, b) => a.quest.date < b.quest.date ? 1 : -1)) {
    if (r.quest.date < since) continue;
    for (const w of Object.values(r.progress.work)) {
      if (w.verdict && w.verdict !== "solved" && w.fundamentalSkillId && !out.includes(w.fundamentalSkillId)) out.push(w.fundamentalSkillId);
    }
  }
  return out;
}
function doneTasks(records) {
  const done = /* @__PURE__ */ new Set();
  for (const r of records)
    for (const p of r.quest.parts)
      if (p.kind === "assignment") {
        for (const q of p.problems) if (q.assignmentTaskId && r.progress.work[q.id]?.attemptId) done.add(q.assignmentTaskId);
      }
  return done;
}
const FEEL = { easy: "too easy", right: "just right", hard: "too hard" };
function recentFeel(records, skillName, today) {
  const since = addDays(today, -14);
  const bySkill = /* @__PURE__ */ new Map();
  for (const r of [...records].sort((a, b) => a.quest.createdAt - b.quest.createdAt)) {
    if (r.quest.date < since) continue;
    for (const part of r.quest.parts) {
      const rating = r.progress.ratings?.[part.id];
      if (!rating) continue;
      const ids = part.kind === "learn" ? part.skillIds : part.skillIds ?? part.problems.map((p) => p.skillId);
      const kind = part.kind === "assignment" ? "homework" : part.kind === "lesson" ? "lesson" : part.kind;
      for (const id of new Set(ids)) {
        const n = skillName(id);
        if (n) bySkill.set(id, `${n}: ${FEEL[rating]} (${kind}, ${r.quest.date})`);
      }
    }
  }
  return [...bySkill.values()];
}
function carriedOver(records, quest) {
  const out = [];
  for (const part of quest.parts) {
    if (part.kind !== "assignment") continue;
    for (const p of part.problems) {
      const prev = records.find(
        (r) => r.quest.date < quest.date && r.quest.parts.some((x) => x.kind === "assignment" && !r.progress.handedIn.includes(x.id) && x.problems.some((q) => q.assignmentTaskId === p.assignmentTaskId))
      );
      if (prev) out.push({ label: p.label ?? "", from: prev.quest.date });
    }
  }
  return out;
}
function timesTurns(o) {
  const when = o.after ? "today" : "tomorrow";
  return [
    {
      role: "user",
      content: `Pick when the student should study ${when} (${o.weekday}). StudyDesk puts these times into their Google Calendar.${o.after ? ` It's already ${o.after}, so only times after that.` : ""}

The quest: ${o.courseName}, about ${o.quest.plannedMinutes} min in total, in ${o.quest.parts.length} parts: ${o.quest.parts.map((p) => p.title).join("; ")}.

${when === "today" ? "Today" : "Tomorrow"} in their calendar:
${o.events.length ? o.events.join("\n") : "(nothing)"}

What the student has told StudyDesk about themselves:
${o.notes.trim() || "(nothing yet)"}

Rules: only free time; leave about 15 min between a commitment and study; one to three blocks, none shorter than 25 min, adding up to about the quest's time; follow anything the student said about when or where they like to study; otherwise prefer daytime and the gaps between commitments, and nothing after 22:00.
Reply with only the blocks, one per line, as HH:MM-HH:MM, or "none" if there's no good time left.`
    }
  ];
}
const hm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const pad = (n) => String(n).padStart(2, "0");
function parseTimes(reply) {
  const out = [];
  for (const m of reply.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)) {
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
    const t = { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}` };
    if (hm(t.end) > hm(t.start)) out.push(t);
  }
  out.sort((a, b) => hm(a.start) - hm(b.start));
  return out.filter((t, i) => i === 0 || hm(t.start) >= hm(out[i - 1].end)).slice(0, 3);
}
function busyLines(events, timetable, weekday) {
  const slots = timetable.filter((t) => t.weekday === weekday).map((t) => `${t.start}-${t.end} ${t.title}`);
  return [...events, ...slots.filter((l) => !events.some((e) => e.slice(0, 11) === l.slice(0, 11)))].sort();
}
async function pickTimes(ask, o) {
  const busy = o.events.map((l) => /^(\d\d:\d\d)-(\d\d:\d\d)/.exec(l)).filter((m) => !!m).map((m) => [hm(m[1]), hm(m[2])]);
  return parseTimes(await ask(timesTurns(o), { tier: "default" })).filter(
    (t) => (!o.after || t.start >= o.after) && !busy.some(([s, e]) => hm(t.start) < e && hm(t.end) > s)
  );
}
function studyEntries(o) {
  return o.times.map((t) => ({
    day: o.day,
    ...t,
    title: `Study · ${o.courseName}`,
    description: `${ENTRY_MARK} ${short(o.reason)}${o.url ? `
Open StudyDesk: ${o.url}` : ""}`,
    timeZone: o.timeZone
  }));
}
const short = (t) => (/^.{1,200}?[.!?](\s|$)/.exec(t)?.[0] ?? t.slice(0, 200)).trim();
const sig = (e) => `${e.day} ${e.start}-${e.end} ${e.title}`;
function calendarWant(day, questId, entries) {
  const sigs = entries.map(sig);
  const key2 = `${day}|${sigs.join("|")}`;
  const events = entries.map((e) => ({
    summary: e.title,
    description: e.description,
    startTime: `${e.day}T${e.start}:00`,
    endTime: `${e.day}T${e.end}:00`,
    timeZone: e.timeZone,
    overrideReminders: [{ method: "popup", minutes: 10 }],
    notificationLevel: "NONE"
  }));
  const instructions = `1. Get the document calendarWritten from the same collection (it may not exist). Get the time now in milliseconds with \`date +%s%3N\`.
2. If its key is ${JSON.stringify(key2)}, only update calendarWritten with {"taskSeenAt": <now>} and end.
3. Delete every event id in its "ids" with mcp__Google_Calendar__delete_event (notificationLevel "NONE"). An event that is already gone is fine.
4. Create each of these events with mcp__Google_Calendar__create_event, in this order, using exactly these arguments: ${JSON.stringify(events)}
5. Set calendarWritten to {"key": ${JSON.stringify(key2)}, "day": "${day}", "ids": [the ids you created, in order], "sigs": ${JSON.stringify(sigs)}, "taskSeenAt": <now>}. Never touch any other event.`;
  return { day, questId, key: key2, entries, instructions };
}
const GRADE_FIELDS = ["attemptId", "verdict", "points", "feedback", "firstWrongStep", "slipQuestion", "slipAnswer", "fundamentalSkillId"];
function gradingFields(w) {
  const out = {};
  for (const k of GRADE_FIELDS) if (w[k] !== void 0) out[k] = w[k];
  return out;
}
function mergeGrading(record, box, now) {
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
function applySweep(desk, box, now) {
  const d = desk.draft;
  if (d.id !== box.semesterId || !d.courses.some((c) => c.id === box.courseId)) return desk;
  const r = box.setup;
  const check2 = r.conflicts.length > 0 || r.questions.length > 0 || r.truncated || r.basis === "general";
  return {
    ...desk,
    draft: {
      ...d,
      results: { ...d.results, [box.courseId]: r },
      uploads: d.uploads.map((u) => box.readIds.includes(u.id) ? { ...u, cataloguedAt: now } : u),
      courses: d.courses.map((k) => k.id === box.courseId ? { ...k, setupStatus: check2 ? "needs_check" : "ready", teachingLanguage: r.teachingLanguage || k.teachingLanguage } : k),
      // New questions should be asked even if the student ticked off the old ones.
      todoDone: r.questions.length ? (d.todoDone ?? []).filter((k) => k !== `q-${box.courseId}`) : d.todoDone
    }
  };
}
function applyShallow(desk0, box, now) {
  if (desk0.draft.id !== box.semesterId) return { desk: desk0, change: null, errors: ["The semester changed since this check."] };
  let desk = desk0;
  let change = null;
  let errors = [];
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
function outboxOrder(docs) {
  const rank = (d) => d.kind === "grading" ? 0 : d.kind === "org-sweep" ? 1 : 2;
  return [...docs].sort((a, b) => a.day === b.day ? rank(a) - rank(b) || a.createdAt - b.createdAt : a.day < b.day ? -1 : 1);
}
const outboxId = (kind, day, extra = "") => `${day}_${kind}${extra ? `_${extra}` : ""}_${uid().slice(0, 4)}`;
const ORG_CONFIG = {
  /** A deep sweep is never further away than this, so no course goes unread for long. */
  maxDaysBetweenSweeps: 28,
  /** Nor sooner than this after the last one. */
  minDaysBetweenSweeps: 3,
  /** The first sweep after setup, when the shallow run doesn't pick a date. */
  firstSweepAfterDays: 7,
  maxQuestionsPerCourse: 3
};
const NIGHTLY_OPS = /* @__PURE__ */ new Set(["set_exam_date", "set_due", "add_homework", "add_fact", "set_language"]);
const fmtDue = (s) => s.replace("T", " ");
function shallowTurns(draft, profile, org, today) {
  const courses = draft.courses.map((c) => {
    const r = draft.results[c.id];
    const st = org[c.id];
    const homework = (r?.assignments ?? []).map((a) => `  - ${a.title} (id ${a.id}), due ${fmtDue(a.dueAt)}, ${a.tasks.length} tasks`).join("\n") || "  - none known";
    const dates = (r?.keyDates ?? []).map((k) => `  - ${k.kind} "${k.title}" on ${k.date}`).join("\n") || "  - none known";
    const facts = draft.facts.filter((f) => f.courseId === c.id).map((f) => `  - "${f.text}"`).join("\n") || "  - none";
    const files = draft.uploads.filter((u) => u.courseId === c.id).map((u) => `  - ${u.fileName}${u.studentNote ? ` (${u.studentNote})` : ""}`).join("\n") || "  - none";
    const skills = (r?.skills ?? []).map((s) => s.name).slice(0, 60).join("; ");
    return `### ${c.name} (id ${c.id}, short "${c.short}")
Taught in: ${c.teachingLanguage || "unknown"}
Summary from setup: ${r?.summary ?? "not read yet"}
Homework StudyDesk knows:
${homework}
Exams and quizzes StudyDesk knows:
${dates}
What the student said:
${facts}
Files the student gave:
${files}
Skills (names): ${skills || "none yet"}
Last deep sweep: ${st?.lastDeepSweep ?? "only the setup reading"}; next planned: ${st?.nextDeepSweep ?? "none yet"}${draft.sweepDates?.[c.id] ? `; the student asked for one on ${draft.sweepDates[c.id]} (keep that date)` : ""}`;
  });
  const user = `You are StudyDesk's organization agent, doing tonight's short check (${today}) for one student. Nobody reads this answer except code. You can't ask the student anything now.

The student: ${profile.level}, ${profile.program || "program unknown"}, year ${profile.year || "?"}, at ${profile.school || "an unknown school"} (${profile.country || "country unknown"}). Semester "${draft.name}", ${draft.startDate} to ${draft.endDate}.

## Your job tonight
For each course, check whether anything StudyDesk relies on has changed or is missing: a new homework sheet, a moved deadline, an exam date announced or moved. Use the web when the course has public pages (search the course name with the school and semester). Don't invent anything: only report what you found in a source, and say which.

Then pick, per course, the date of the next deep sweep (a full re-reading of the course's materials and pages): sooner when an exam phase or a new block of material is near, later in quiet weeks. Between ${ORG_CONFIG.minDaysBetweenSweeps} and ${ORG_CONFIG.maxDaysBetweenSweeps} days from today.

## Courses
${courses.join("\n\n")}

## Reply format (exactly these sections)
=== CHANGES ===
A JSON array of operations, [] when nothing changed. Only these:
- {"op":"set_exam_date","course":"<id>","title":"<title>","date":"YYYY-MM-DD","kind":"exam"|"quiz","source":"<url or where>"}
- {"op":"set_due","course":"<id>","homework":"<homework id or title>","dueAt":"YYYY-MM-DDTHH:MM","source":"..."}
- {"op":"add_homework","course":"<id>","title":"...","dueAt":"YYYY-MM-DDTHH:MM","tasks":[{"label":"1a","text":"<task word for word>","skill":"<skill name from the list>","points":null}],"source":"..."}
- {"op":"add_fact","course":"<id>","text":"<what you found, one sentence, with the source>"}
=== QUESTIONS ===
At most ${ORG_CONFIG.maxQuestionsPerCourse} per course, only what the student must answer and you couldn't find. One per line: "<course id>: <question>". Write "none" when there is nothing.
=== NEXT DEEP SWEEP ===
One line per course: "<course id>: YYYY-MM-DD".
=== NOTE ===
One or two plain sentences on what you checked and found, for the student's log.`;
  return [{ role: "user", content: user }];
}
function parseShallow(reply, draft, today) {
  const s = parseSections(reply);
  const errors = [];
  for (const key2 of ["CHANGES", "QUESTIONS", "NEXT DEEP SWEEP", "NOTE"]) if (!s.has(key2)) errors.push(`The section === ${key2} === is missing.`);
  let raw = [];
  const changes = (s.get("CHANGES") ?? "[]").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    raw = JSON.parse(changes || "[]");
  } catch {
    errors.push("CHANGES is not a JSON array.");
  }
  if (!Array.isArray(raw)) errors.push("CHANGES is not a JSON array.");
  if (errors.length) throw new Error(errors.join(" "));
  const ids = new Set(draft.courses.map((c) => c.id));
  const ops = [];
  const skipped = [];
  for (const o of raw) {
    const op = String(o?.op ?? "");
    if (!NIGHTLY_OPS.has(op)) {
      skipped.push(`${op || "an operation"} is left for the student to decide`);
      continue;
    }
    const { source, ...rest } = o;
    ops.push({ ...rest, op, ...source ? { why: String(source) } : {} });
  }
  const questions = [];
  for (const line of (s.get("QUESTIONS") ?? "").split("\n")) {
    const m = /^\s*[-*]?\s*([^:]+):\s*(.+)$/.exec(line);
    if (!m || /^none$/i.test(line.trim())) continue;
    const cid = m[1].trim();
    if (!ids.has(cid)) continue;
    if (questions.filter((q) => q.courseId === cid).length >= ORG_CONFIG.maxQuestionsPerCourse) continue;
    questions.push({ courseId: cid, text: m[2].trim() });
  }
  const nextSweep = {};
  for (const line of (s.get("NEXT DEEP SWEEP") ?? "").split("\n")) {
    const m = /^\s*[-*]?\s*([^:]+):\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (!m || !ids.has(m[1].trim()) || !isRealDay(m[2])) continue;
    nextSweep[m[1].trim()] = clampSweep(m[2], today);
  }
  return { ops, questions, nextSweep, note: (s.get("NOTE") ?? "").trim(), skipped };
}
function clampSweep(day, today) {
  const d = daysBetween(today, day);
  if (d < ORG_CONFIG.minDaysBetweenSweeps) return addDays(today, ORG_CONFIG.minDaysBetweenSweeps);
  if (d > ORG_CONFIG.maxDaysBetweenSweeps) return addDays(today, ORG_CONFIG.maxDaysBetweenSweeps);
  return day;
}
function sweepsDue(draft, org, today) {
  return draft.courses.filter((c) => c.setupStatus === "ready" || c.setupStatus === "needs_check").filter((c) => {
    const asked = draft.sweepDates?.[c.id];
    const last = org[c.id]?.lastDeepSweep ?? null;
    if (asked && asked <= today && (!last || last < asked)) return true;
    const next = org[c.id]?.nextDeepSweep;
    return !!next && next <= today;
  }).map((c) => c.id);
}
function nextOrgState(org, draft, today, shallow, swept) {
  const out = {};
  for (const c of draft.courses) {
    const prev = org[c.id] ?? { nextDeepSweep: null, lastDeepSweep: null, lastShallow: null };
    const asked = draft.sweepDates?.[c.id];
    const picked = asked && asked > today ? asked : shallow?.nextSweep[c.id] ?? null;
    let next = prev.nextDeepSweep;
    if (swept.includes(c.id)) next = picked ?? addDays(today, ORG_CONFIG.firstSweepAfterDays);
    else if (picked) next = picked;
    else if (!next) next = addDays(today, ORG_CONFIG.firstSweepAfterDays);
    out[c.id] = {
      nextDeepSweep: next,
      lastDeepSweep: swept.includes(c.id) ? today : prev.lastDeepSweep,
      lastShallow: shallow ? today : prev.lastShallow
    };
  }
  return out;
}
const NIGHTLY_DEFAULTS = { time: "22:00", paused: false, grading: true, check: true, quest: true };
const nightlySettings = (s) => ({ ...NIGHTLY_DEFAULTS, ...s ?? {} });
const emptyRoutine = () => ({ org: {}, nights: [], updatedAt: 0 });
const plain = (x) => JSON.parse(JSON.stringify(x));
function dataUrlToBlob(url) {
  const [head, body] = url.split(",");
  const type = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
  const bin = atob(body ?? "");
  const bytes2 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes2[i] = bin.charCodeAt(i);
  return new Blob([bytes2], { type });
}
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayName = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
async function runNightly(input, d) {
  const { today, now } = input;
  const tomorrow = addDays(today, 1);
  const log = [];
  const writes = [];
  const routine = input.routine ?? emptyRoutine();
  const settings = nightlySettings(input.profile?.nightly);
  let records = input.records.map((r) => r);
  let desk = input.draft && input.profile ? { draft: input.draft, profile: input.profile } : null;
  for (const box of outboxOrder(input.outbox)) {
    if (box.kind === "grading") records = records.map((r) => r.quest.id === box.questId ? mergeGrading(r, box, now) : r);
    else if (desk && box.kind === "org-sweep") desk = applySweep(desk, box, now);
    else if (desk && box.kind === "org-shallow") desk = applyShallow(desk, box, now).desk;
  }
  let semester = input.semester;
  if (desk && desk.draft.status === "active" && semester && semester.id === desk.draft.id) semester = syncSemester(desk.draft, desk.profile, semester, now);
  const mastery = {
    skills: [...input.mastery.skills],
    targets: input.mastery.targets,
    attempts: [...input.mastery.attempts],
    reviews: [...input.mastery.reviews]
  };
  if (semester) {
    for (const s of semester.skills) if (!mastery.skills.some((x) => x.id === s.id)) mastery.skills.push(s);
  }
  if (!settings.grading) log.push('Grading at night is turned off; use "Grade me early".');
  if (!settings.check) log.push("The courses' nightly check is turned off.");
  const grading = settings.grading ? gradeAll(input, records, semester, d, log) : Promise.resolve({ pending: false, attempts: [], reviews: [], boxes: [] });
  const org = settings.check && desk && desk.draft.status === "active" && desk.draft.courses.length ? organize(input, desk, routine.org, mastery, d, log) : Promise.resolve(null);
  const [g, o] = await Promise.all([grading, org]);
  if (g.pending || o?.pending) return { kind: "pending", log };
  for (const a of g.attempts) writes.push({ path: ["mastery", "attempts", a.id], data: plain(a), mode: "create" });
  for (const r of g.reviews) writes.push({ path: ["mastery", "reviews", r.attemptId], data: plain(r), mode: "create" });
  for (const box of g.boxes) writes.push({ path: ["routine", "outbox", box.id], data: plain(box), mode: "create" });
  mastery.attempts.push(...g.attempts);
  for (const r of g.reviews) {
    const i = mastery.reviews.findIndex((x) => x.attemptId === r.attemptId);
    if (i >= 0) mastery.reviews[i] = r;
    else mastery.reviews.push(r);
  }
  records = records.map((r) => {
    const box = g.boxes.find((b) => b.questId === r.quest.id);
    return box ? mergeGrading(r, box, now) : r;
  });
  let orgState = routine.org;
  if (o && desk) {
    for (const box of o.boxes) writes.push({ path: ["routine", "outbox", box.id], data: plain(box), mode: "create" });
    for (const box of o.boxes) {
      if (box.kind === "org-sweep") desk = applySweep(desk, box, now);
      else if (box.kind === "org-shallow") desk = applyShallow(desk, box, now).desk;
    }
    orgState = nextOrgState(routine.org, desk.draft, today, o.shallow, o.swept);
    if (semester && semester.id === desk.draft.id) semester = syncSemester(desk.draft, desk.profile, semester, now);
  }
  let questId = null;
  const q = settings.quest ? await writeTomorrow(semester, input.calendar ?? null, records, mastery, tomorrow, now, d, log) : { pending: false, record: null };
  if (!settings.quest) log.push("Writing the quest overnight is turned off; it's written when you open StudyDesk.");
  if (q.pending) return { kind: "pending", log };
  if (q.record) {
    questId = q.record.quest.id;
    writes.push({ path: ["quests", "records", questId], data: plain(q.record), mode: "create" });
    const want = semester?.calendarSync ? await studyTimes(input, semester, q.record.quest, d, log) : null;
    if (want === "pending") return { kind: "pending", log };
    if (want) writes.push({ path: ["calendarWant"], data: plain(want), mode: "replace" });
  }
  const night = { day: today, status: "done", startedAt: now, finishedAt: null, lines: log, questId };
  const nights = [...routine.nights.filter((n) => n.day !== today), night].slice(-14);
  writes.push({ path: ["routine"], data: plain({ org: orgState, nights, updatedAt: now }), mode: "replace" });
  return { kind: "done", writes, log, night };
}
async function gradeAll(input, records, semester, d, log) {
  const out = { pending: false, attempts: [], reviews: [], boxes: [] };
  if (!semester) return out;
  const todo = records.filter((r) => !r.progress.replacedAt && r.quest.date <= input.today && ungraded(r.quest, r.progress).length);
  if (!todo.length) {
    log.push("Grading: nothing was handed in that still needed grading.");
    return out;
  }
  const results = await Promise.all(
    todo.map(
      (r) => settle(
        (async () => {
          const problems = ungraded(r.quest, r.progress);
          const images = {};
          for (const { problem } of problems) {
            const files = (r.progress.work[problem.id]?.files ?? []).filter((f) => f.kind === "image" && f.stored);
            const blobs = files.map((f) => input.images.get(f.id)).filter((u) => !!u).map(dataUrlToBlob);
            if (blobs.length) images[problem.id] = blobs;
          }
          const res = await handIn({
            quest: r.quest,
            problems,
            work: r.progress.work,
            images,
            semester,
            today: input.today,
            nowLocal: input.nowLocal,
            ask: d.ask(`Grading ${weekdayName(r.quest.date)}'s quest (${r.quest.date})`),
            now: input.now
          });
          return { r, res, count: problems.length };
        })()
      )
    )
  );
  for (const x of results) {
    if (!x.ok) {
      if (isPending(x.e)) out.pending = true;
      else log.push(`Grading failed for one quest: ${x.e?.message ?? String(x.e)} It stays ungraded; "Grade me early" can try again.`);
      continue;
    }
    const { r, res, count } = x.v;
    out.attempts.push(...res.attempts);
    out.reviews.push(...res.reviews);
    const work = Object.fromEntries(Object.entries(res.work).map(([pid, w]) => [pid, gradingFields(w)]));
    out.boxes.push({ kind: "grading", id: outboxId("grading", input.today, r.quest.id.slice(-6)), day: input.today, questId: r.quest.id, work, createdAt: input.now });
    const solved = res.attempts.filter((a) => a.verdict === "solved").length;
    log.push(`Graded ${weekdayName(r.quest.date)}'s quest: ${solved} of ${count} problems solved.`);
  }
  return out;
}
async function organize(input, desk, org, mastery, d, log) {
  const out = { pending: false, boxes: [], shallow: null, swept: [] };
  const { draft, profile } = desk;
  const today = input.today;
  const due = sweepsDue(draft, org, today);
  const { states } = replay(mastery.skills, mastery.attempts, mastery.reviews);
  const prior = mastery.skills.filter((s2) => s2.isFundamental && ["mastered", "retained"].includes(states.get(s2.id)?.stage ?? ""));
  const sweeps = due.map(
    (cid) => settle(
      (async () => {
        const course = draft.courses.find((c) => c.id === cid);
        const files = [];
        for (const u of draft.uploads.filter((x) => x.courseId === cid)) {
          const content = input.uploads.get(u.id);
          files.push({ upload: u, text: content?.text ?? null, image: null, outline: content?.outline });
        }
        const si = { profile, draft, course, facts: draft.facts.filter((f) => f.courseId === cid), files, today, priorFundamentals: prior };
        const { turns, fileKeys } = setupTurns(si, { web: true, navigate: "cloud" });
        const ask = d.ask(`Deep sweep of ${course.name}: check its materials again where it matters, and look it up online`, true);
        const reply = await ask(turns, { tier: "complex" });
        let setup;
        try {
          setup = parseSetup(reply, si, fileKeys, input.now);
        } catch (e) {
          const retry = [
            ...turns,
            { role: "assistant", content: reply },
            { role: "user", content: `That reply couldn't be used: ${e.message} Write the whole reply again in exactly the section format, with at least one line under SKILLS.` }
          ];
          setup = parseSetup(await ask(retry, { tier: "complex" }), si, fileKeys, input.now);
        }
        return { cid, name: course.name, setup, readIds: files.map((f) => f.upload.id) };
      })()
    )
  );
  const shallowAsk = d.ask("Tonight's short check of every course (dates, new homework, next deep sweep)", true);
  const shallow = settle(
    (async () => {
      const turns = shallowTurns(draft, profile, org, today);
      const reply = await shallowAsk(turns, { tier: "default" });
      try {
        return parseShallow(reply, draft, today);
      } catch (e) {
        const retry = [...turns, { role: "assistant", content: reply }, { role: "user", content: `That reply can't be used: ${e.message} Reply again in exactly the four sections.` }];
        return parseShallow(await shallowAsk(retry, { tier: "default" }), draft, today);
      }
    })()
  );
  for (const x of await Promise.all(sweeps)) {
    if (!x.ok) {
      if (isPending(x.e)) out.pending = true;
      else log.push(`A deep sweep failed: ${x.e?.message ?? String(x.e)} It runs again tomorrow night.`);
      continue;
    }
    const box = { kind: "org-sweep", id: outboxId("org-sweep", today, x.v.cid), day: today, semesterId: draft.id, courseId: x.v.cid, setup: x.v.setup, readIds: x.v.readIds, createdAt: input.now };
    out.boxes.push(box);
    out.swept.push(x.v.cid);
    log.push(`Deep sweep of ${x.v.name}: ${x.v.setup.skills.length} skills, ${x.v.setup.assignments.length} homework sheets, ${x.v.setup.keyDates.length} dates.`);
  }
  const s = await shallow;
  if (!s.ok) {
    if (isPending(s.e)) out.pending = true;
    else log.push(`The short check of the courses failed: ${s.e?.message ?? String(s.e)}`);
    return out;
  }
  out.shallow = s.v;
  if (s.v.ops.length || s.v.questions.length || s.v.note) {
    const box = { kind: "org-shallow", id: outboxId("org-shallow", today), day: today, semesterId: draft.id, ops: s.v.ops, questions: s.v.questions, note: s.v.note, createdAt: input.now };
    out.boxes.push(box);
  }
  log.push(`Checked the courses: ${s.v.note || "nothing new."}${s.v.ops.length ? ` ${s.v.ops.length} ${s.v.ops.length === 1 ? "change" : "changes"} to look at.` : ""}${s.v.questions.length ? ` ${s.v.questions.length} ${s.v.questions.length === 1 ? "question" : "questions"} for you.` : ""}`);
  for (const k of s.v.skipped) log.push(`Left for you: ${k}.`);
  return out;
}
async function studyTimes(input, semester, quest, d, log) {
  const courseName = semester.courses.find((c) => c.id === quest.courseId)?.name ?? "Quest";
  try {
    const times = await pickTimes(d.ask("Picking tomorrow's study times for the calendar"), {
      quest,
      courseName,
      weekday: weekdayName(quest.date),
      events: busyLines(input.calendar?.events?.[quest.date] ?? [], semester.timetable, weekdayOf(quest.date)),
      notes: input.notes ?? ""
    });
    if (!times.length) {
      log.push("No study times were picked for tomorrow, so nothing goes into your calendar.");
      return null;
    }
    log.push(`Study times for tomorrow: ${times.map((t) => `${t.start}-${t.end}`).join(", ")}. They go into your calendar.`);
    return calendarWant(quest.date, quest.id, studyEntries({ day: quest.date, times, courseName, reason: quest.reason, timeZone: input.profile?.schedule?.timeZone ?? "UTC", url: input.url ?? null }));
  } catch (e) {
    if (isPending(e)) return "pending";
    log.push(`Tomorrow's study times couldn't be picked (${e?.message ?? String(e)}).`);
    return null;
  }
}
function sizedBy(semester, calendar, busy, now) {
  if (!semester.calendarSync) return "It goes by your weekly timetable.";
  if (busy === void 0 || !calendar) return "It goes by your weekly timetable: your calendar hasn't been read for tomorrow yet (it's read whenever StudyDesk is open).";
  const h = Math.max(0, Math.round((now - calendar.readAt) / 36e5));
  const ago = h < 1 ? "less than an hour ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  return `It's sized from your calendar, last read ${ago}.`;
}
async function writeTomorrow(semester, calendar, records, mastery, tomorrow, now, d, log) {
  const out = { pending: false, record: null };
  if (!semester) {
    log.push("No semester yet, so no quest was written.");
    return out;
  }
  if (semester.source === "onboarding" && !semester.placementQuestId) {
    log.push("The placement check comes first, so tomorrow's quest is written when you open StudyDesk.");
    return out;
  }
  if (records.some((r) => r.quest.date === tomorrow && !r.progress.replacedAt)) {
    log.push("Tomorrow's quest already exists.");
    return out;
  }
  const calendarBusyMinutes = semester.calendarSync ? busyFromAhead(calendar, tomorrow) : void 0;
  const res = planQuest({
    calendarBusyMinutes,
    semester,
    today: tomorrow,
    nowLocal: `${tomorrow}T00:00`,
    attempts: mastery.attempts,
    reviews: mastery.reviews,
    doneTaskIds: doneTasks(records),
    deckSizes: deckSizes(records, semester),
    reading: readingOf(records),
    blockerSkillIds: recentBlockers(records, tomorrow),
    questId: `qst_${tomorrow}_${now.toString(36)}`
  });
  if (res.kind !== "quest") {
    log.push(res.kind === "no_time" ? "Tomorrow has no study time planned, so there's no quest." : "Nothing to do tomorrow, so there's no quest.");
    return out;
  }
  const { states } = replay(mastery.skills, mastery.attempts, mastery.reviews);
  const knownIds = [...states.values()].filter((s) => s.stage === "mastered" || s.stage === "retained").map((s) => s.skillId);
  recentFeel(records, (id) => semester.skills.find((s) => s.id === id)?.name, tomorrow);
  addAnki(res.quest, records, semester);
  const carried = carriedOver(records, res.quest);
  if (carried.length) res.quest.notes.unshift(`Carried over from ${weekdayName(carried[0].from)}, when the quest wasn't finished: ${carried.map((c) => c.label).join(", ")}.`);
  const course = semester.courses.find((c) => c.id === res.quest.courseId);
  const writer = claudeWriter(semester, res.quest, knownIds, d.ask(`Writing tomorrow's quest (${course?.name ?? "quest"}, ${weekdayName(tomorrow)})`));
  try {
    const quest = await writeQuest(res.quest, writer, void 0, { concurrency: res.quest.parts.length });
    out.record = { quest, progress: emptyProgress(quest.id) };
    const minutes = quest.plannedMinutes;
    log.push(`Wrote tomorrow's quest: ${course?.name ?? "quest"}, ${quest.parts.length} ${quest.parts.length === 1 ? "part" : "parts"}, about ${minutes} min. ${sizedBy(semester, calendar, calendarBusyMinutes, now)}`);
  } catch (e) {
    if (isPending(e)) out.pending = true;
    else log.push(`Tomorrow's quest couldn't be written (${e?.message ?? String(e)}). StudyDesk writes it when you open it.`);
  }
  return out;
}
function releaseDocFrom(list, now) {
  const seen = /* @__PURE__ */ new Map();
  const builds = [];
  for (const x of list) {
    const o = x && typeof x === "object" ? x : {};
    const isBuild = typeof o.commit === "string" && (o.version === DEV_CHANNEL || typeof o.version === "string" && o.version.startsWith("branch-") && typeof o.branch === "string");
    if (isBuild) {
      builds.push({
        folder: o.version,
        branch: o.version === DEV_CHANNEL ? DEV_CHANNEL : o.branch,
        commit: o.commit.slice(0, 7),
        builtAt: typeof o.builtAt === "string" ? o.builtAt : null,
        notes: typeof o.notes === "string" && o.notes.trim() ? o.notes.trim().slice(0, 300) : null,
        dataVersion: Number.isInteger(o.dataVersion) ? o.dataVersion : null
      });
      continue;
    }
    if (typeof o.version !== "string" || !isRelease(o.version)) continue;
    seen.set(o.version, {
      version: o.version,
      notes: typeof o.notes === "string" && o.notes.trim() ? o.notes.trim().slice(0, 4e3) : null,
      dataVersion: Number.isInteger(o.dataVersion) ? o.dataVersion : null
    });
  }
  const releases = [...seen.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, 30);
  const newest = releases[0];
  const sorted = builds.sort((a, b) => Number(b.folder === DEV_CHANNEL) - Number(a.folder === DEV_CHANNEL) || String(b.builtAt).localeCompare(String(a.builtAt))).slice(0, 20);
  const m = sorted.find((b) => b.folder === DEV_CHANNEL);
  const main2 = m ? { commit: m.commit, builtAt: m.builtAt, notes: m.notes, dataVersion: m.dataVersion } : null;
  return newest ? { latest: newest.version, notes: newest.notes, dataVersion: newest.dataVersion, checkedAt: now, releases, main: main2, builds: sorted } : null;
}
const folder = (dir) => join(dir, "releases");
function releaseStepLines(dir, repo = RELEASE_REPO) {
  const d = folder(dir);
  return [
    "NEXT STEP: check whether a newer StudyDesk release exists (this only reads the public releases branch).",
    "",
    `Run: (git clone --quiet --depth 1 --branch ${RELEASE_BRANCH} --filter=blob:none --sparse https://github.com/${repo}.git ${d} && git -C ${d} sparse-checkout set --no-cone '/*/release.json') || mkdir -p ${d}`,
    "Then run this program again with the same arguments."
  ];
}
function readReleases(dir, now) {
  const d = folder(dir);
  if (!existsSync(d)) return void 0;
  const list = [];
  for (const name of readdirSync(d)) {
    try {
      list.push(JSON.parse(readFileSync(join(d, name, "release.json"), "utf8")));
    } catch {
    }
  }
  return releaseDocFrom(list, now);
}
const PARTS_DOC = "parts";
const PARTS_COL = "docs";
const SPLIT_BYTES = 2e5;
const bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
function hash(s) {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 1540483477) >>> 0;
  }
  return (h1.toString(36) + (h2 & 1048575).toString(36)).slice(0, 12);
}
function chunk(items, size) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const it of items) {
    const s = size(it) + 1;
    if (cur.length && n + s > SPLIT_BYTES) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(it);
    n += s;
  }
  if (cur.length) out.push(cur);
  return out;
}
function splitDoc(name, doc2, now = Date.now()) {
  const plain2 = JSON.parse(JSON.stringify(doc2));
  delete plain2.__parts;
  if (bytes(plain2) <= SPLIT_BYTES) return { main: plain2, parts: {} };
  const main2 = { ...plain2 };
  const refs = [];
  const parts = {};
  const fields = Object.keys(plain2).filter((k) => plain2[k] && typeof plain2[k] === "object").sort((a, b) => bytes(plain2[b]) - bytes(plain2[a]));
  for (const field of fields) {
    if (bytes(main2) <= SPLIT_BYTES) break;
    const v = plain2[field];
    const kind = Array.isArray(v) ? "array" : "object";
    const groups = kind === "array" ? chunk(v, bytes) : chunk(Object.entries(v), bytes);
    const ids = [];
    for (const g of groups) {
      const body = kind === "array" ? { items: g } : { entries: Object.fromEntries(g) };
      const id = `${name}.${field}.${hash(JSON.stringify(body))}`;
      parts[id] = { doc: name, field, createdAt: now, ...body };
      ids.push(id);
    }
    refs.push({ field, kind, ids });
    delete main2[field];
  }
  main2.__parts = refs;
  return { main: main2, parts };
}
function partIdsOf(main2) {
  const refs = main2?.__parts ?? [];
  return Array.isArray(refs) ? refs.flatMap((r) => r.ids ?? []) : [];
}
function joinDoc(main2, part) {
  const refs = main2.__parts;
  if (!Array.isArray(refs)) return main2;
  const out = { ...main2 };
  delete out.__parts;
  for (const r of refs) {
    if (r.kind === "array") {
      const items = [];
      for (const id of r.ids) {
        const p = part(id);
        if (!p || !Array.isArray(p.items)) throw new Error(`A part of your saved data is missing (${id}).`);
        items.push(...p.items);
      }
      out[r.field] = items;
    } else {
      const entries = {};
      for (const id of r.ids) {
        const p = part(id);
        if (!p || !p.entries) throw new Error(`A part of your saved data is missing (${id}).`);
        Object.assign(entries, p.entries);
      }
      out[r.field] = entries;
    }
  }
  return out;
}
function joinAll(doc2, parts) {
  return doc2 && partIdsOf(doc2).length ? joinDoc(doc2, (id) => parts[id]) : doc2;
}
const DOC_KINDS = {
  profile: "profile",
  setup: "onboarding",
  semester: "semester",
  orchestrator: "orchestrator",
  routine: "routine",
  updates: "updates"
};
const COLLECTION_KINDS = {
  askChats: ["profile", "chats"],
  uploadContents: ["files", "uploads"],
  archivedSemesters: ["archive", "semesters"],
  questRecords: ["quests", "records"],
  questReviews: ["quests", "reviews"],
  answerPhotos: ["quests", "images"],
  masterySkills: ["mastery", "skills"],
  masteryTargets: ["mastery", "targets"],
  masteryAttempts: ["mastery", "attempts"],
  masteryReviews: ["mastery", "reviews"],
  orchestratorChat: ["orchestrator", "days"],
  routineOutbox: ["routine", "outbox"]
};
const DOC_KIND_LIST = Object.keys(DOC_KINDS);
const COLLECTION_KIND_LIST = Object.keys(COLLECTION_KINDS);
function emptySnapshot() {
  const s = {};
  for (const k of DOC_KIND_LIST) s[k] = null;
  for (const k of COLLECTION_KIND_LIST) s[k] = {};
  return s;
}
const isRec = (x) => !!x && typeof x === "object" && !Array.isArray(x);
function toSnapshot(x) {
  const src = isRec(x) ? x : {};
  const s = emptySnapshot();
  for (const k of DOC_KIND_LIST) s[k] = isRec(src[k]) ? src[k] : null;
  for (const k of COLLECTION_KIND_LIST) {
    const col = src[k];
    s[k] = isRec(col) ? Object.fromEntries(Object.entries(col).filter(([, v]) => isRec(v))) : {};
  }
  return s;
}
function docPath(kind, id) {
  if (kind in DOC_KINDS) return [DOC_KINDS[kind]];
  const [doc2, col] = COLLECTION_KINDS[kind];
  return [doc2, col, id];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diffSnapshots(before, after) {
  const sets = [];
  const deletes = [];
  for (const k of DOC_KIND_LIST) {
    const a = before[k];
    const b = after[k];
    if (same(a, b)) continue;
    if (b) sets.push({ path: docPath(k), data: b });
    else deletes.push({ path: docPath(k), data: null });
  }
  for (const k of COLLECTION_KIND_LIST) {
    const a = before[k];
    const b = after[k];
    for (const [id, d] of Object.entries(b)) if (!same(a[id], d)) sets.push({ path: docPath(k, id), data: d });
    for (const id of Object.keys(a)) if (!(id in b)) deletes.push({ path: docPath(k, id), data: null });
  }
  return [...sets, ...deletes];
}
function joinSnapshot(s, parts) {
  const out = { ...s };
  for (const k of DOC_KIND_LIST) out[k] = joinAll(s[k], parts);
  for (const k of COLLECTION_KIND_LIST) out[k] = Object.fromEntries(Object.entries(s[k]).map(([id, d]) => [id, joinAll(d, parts)]));
  return out;
}
const STEPS = {};
function upgrade(snapshot, from, to = DATA_VERSION, steps = STEPS) {
  if (!Number.isInteger(from) || from < 1) return { ok: false, error: `The data version "${from}" isn't valid.` };
  if (from > to) return { ok: false, error: `Your data comes from a newer StudyDesk (data version ${from}); this one reads up to ${to}.` };
  let s = toSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const ran = [];
  for (let v = from; v < to; v++) {
    const step2 = steps[v];
    if (!step2) return { ok: false, error: `StudyDesk has no upgrade step from data version ${v} to ${v + 1}.` };
    try {
      s = toSnapshot(step2(s));
    } catch (e) {
      return { ok: false, error: `The upgrade from data version ${v} to ${v + 1} failed: ${e?.message ?? String(e)}` };
    }
    ran.push(v);
  }
  return { ok: true, snapshot: s, ran };
}
function dataVersionOf(s) {
  const v = Number(s.updates?.dataVersion);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}
const DOC_RULES = {
  profile: { "level?": "string", "school?": "string", "country?": "string", "updatedAt?": "number", "handoff?": "object", "schedule?": "object", "nightly?": "object" },
  setup: { id: "string", name: "string", status: "string", courses: "array", "timetable?": "array", "studyGoal?": "array", "uploads?": "array", "facts?": "array", "results?": "object", "chat?": "array" },
  semester: { id: "string", name: "string", courses: "array", "skills?": "array", "targets?": "array", "assignments?": "array", "keyDates?": "array", "timetable?": "array", "studyGoal?": "array" },
  orchestrator: { "memory?": "object", "changes?": "array", "confirms?": "array", "jobs?": "array", "notifications?": "array", "notes?": "array" },
  routine: { "org?": "object", "nights?": "array" },
  updates: { "dataVersion?": "number", "backups?": "array" }
};
const COLLECTION_RULES = {
  askChats: { id: "string", messages: "array", "notes?": "array", "title?": "string" },
  uploadContents: { "text?": "string", "image?": "string" },
  archivedSemesters: { id: "string", name: "string", courses: "array" },
  questRecords: { quest: "object", progress: "object" },
  questReviews: { id: "string", messages: "array" },
  answerPhotos: { "dataUrl?": "string" },
  masterySkills: { id: "string", courseId: "string", name: "string" },
  masteryTargets: { courseId: "string" },
  masteryAttempts: { id: "string", skillId: "string", day: "string", verdict: "string", "points?": "number", "maxPoints?": "number" },
  masteryReviews: { attemptId: "string", "status?": "string" },
  orchestratorChat: { "semesterId?": "string", "day?": "string", messages: "array" },
  routineOutbox: { id: "string", kind: "string" }
};
function typeOk(v, t) {
  switch (t) {
    case "array":
      return Array.isArray(v);
    case "object":
      return !!v && typeof v === "object" && !Array.isArray(v);
    case "string|null":
      return v === null || typeof v === "string";
    case "number|null":
      return v === null || typeof v === "number" && Number.isFinite(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    default:
      return typeof v === t;
  }
}
function checkRecord(rec, rule, where) {
  const out = [];
  for (const [key2, t] of Object.entries(rule)) {
    const optional = key2.endsWith("?");
    const name = optional ? key2.slice(0, -1) : key2;
    const v = rec[name];
    if (v === void 0) {
      if (!optional) out.push(`${where}: "${name}" is missing`);
      continue;
    }
    if (!typeOk(v, t)) out.push(`${where}: "${name}" should be ${t === "array" ? "a list" : t === "object" ? "an object" : `a ${t}`}`);
  }
  return out;
}
function validateSnapshot(s, max = 20) {
  const problems = [];
  for (const k of DOC_KIND_LIST) {
    const d = s[k];
    if (d) problems.push(...checkRecord(d, DOC_RULES[k], k));
  }
  for (const k of COLLECTION_KIND_LIST) {
    for (const [id, d] of Object.entries(s[k])) {
      problems.push(...checkRecord(d, COLLECTION_RULES[k], `${k}/${id}`));
      if (problems.length > max) break;
    }
  }
  const qr = s.questRecords;
  for (const [id, r] of Object.entries(qr)) {
    const q = r.quest;
    if (q && typeof q === "object") problems.push(...checkRecord(q, { id: "string", date: "string", courseId: "string" }, `questRecords/${id}/quest`));
  }
  return { ok: problems.length === 0, problems: problems.slice(0, max) };
}
const ME = "data/users/me";
const COLLECTIONS = [...Object.values(COLLECTION_KINDS).map((p) => p.join("/")), `${PARTS_DOC}/${PARTS_COL}`];
const DOCS = [...Object.values(DOC_KINDS), "release", "calendar"];
const BATCH_BYTES = 8e5;
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? "" : null;
}
function say(lines) {
  process.stdout.write(lines.join("\n") + "\n");
}
function localParts(ts, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function freeze(night) {
  process.env.TZ = night.timeZone;
  Date.now = () => night.now;
  let s = night.seed >>> 0 || 1;
  Math.random = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
function loadAll(root) {
  const out = /* @__PURE__ */ new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        const rel = relative(root, p).split(sep).join("/").replace(/\.json$/, "");
        const key2 = rel.replace(/^(?:.*?\/)?data\/users\/[^/]+\//, `${ME}/`);
        try {
          out.set(key2, unwrap(JSON.parse(readFileSync(p, "utf8"))));
        } catch {
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
function unwrap(x) {
  const o = x ?? {};
  if (o && typeof o === "object" && o.data && typeof o.data === "object" && ("version" in o || "id" in o || "doc_id" in o)) {
    const v = Number(o.version);
    return { data: o.data, version: Number.isFinite(v) ? v : null };
  }
  return { data: o, version: null };
}
function partsOf(all) {
  const prefix = `${ME}/${PARTS_DOC}/${PARTS_COL}/`;
  return Object.fromEntries([...all.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v.data]));
}
function doc(all, path) {
  const d = all.get(`${ME}/${path}`)?.data ?? null;
  return d && partIdsOf(d).length ? joinAll(d, partsOf(all)) : d;
}
function collection(all, path) {
  const prefix = `${ME}/${path}/`;
  return [...all.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([k, v]) => ({ id: k.slice(prefix.length), data: v.data }));
}
function downloadStep(dir, url) {
  const data = join(dir, "data");
  const where = url ? `url "${url}"` : `the StudyDesk url`;
  say([
    "NEXT STEP: download the student's StudyDesk data (into files, not into this conversation).",
    "",
    `Use ArtifactData with ${where} and always out_dir "${data}":`,
    ...DOCS.map((d) => `- action "get", collection "${ME}", doc_id "${d}" (a missing document just answers "No document": that's fine)`),
    ...COLLECTIONS.map((c) => `- action "list", collection "${ME}/${c}", query {"limit": 1000}; while the result has a next_cursor, list again with query {"limit": 1000, "cursor": <next_cursor>}`),
    "",
    `When every call is done (empty collections are fine), create the empty file ${join(data, "READY")} and run this program again with the same arguments.`
  ]);
}
function formatCall(c, dir) {
  const parts = [
    `# ${c.label}`,
    "",
    `Answer this as StudyDesk's Claude. The conversation below is exactly what StudyDesk sends; reply as the assistant's next turn.`,
    `Write ONLY that reply, in exactly the format the conversation asks for, into the file ${join(dir, "answers", `${c.id}.md`)}. No preamble, no comments about this file.`,
    c.web ? "You may search the web and fetch pages for this one, and open the student's files as the conversation explains (the data you downloaded has each file's kept text under files/uploads)." : "Answer from the conversation alone; no web needed."
  ];
  if (c.images.length) parts.push(`The student's photos for this call, in order (open each with Read): ${c.images.map((_, i) => join(dir, "calls", `${c.id}-${i + 1}.jpg`)).join(", ")}. "image N" in the text means the N-th of these.`);
  c.turns.forEach((t, i) => {
    parts.push("", `<<<<< TURN ${i + 1}: ${t.role.toUpperCase()} >>>>>`, t.content);
  });
  parts.push("", "<<<<< END OF CONVERSATION >>>>>");
  return parts.join("\n");
}
async function callsStep(dir, calls) {
  mkdirSync(join(dir, "calls"), { recursive: true });
  mkdirSync(join(dir, "answers"), { recursive: true });
  for (const c of calls) {
    writeFileSync(join(dir, "calls", `${c.id}.md`), formatCall(c, dir));
    for (let i = 0; i < c.images.length; i++) writeFileSync(join(dir, "calls", `${c.id}-${i + 1}.jpg`), Buffer.from(await c.images[i].arrayBuffer()));
  }
  say([
    `NEXT STEP: answer ${calls.length} ${calls.length === 1 ? "call" : "calls"} from StudyDesk.`,
    "",
    "Each file below is one conversation StudyDesk would send to Claude. Read it, answer it carefully with your full judgment (this is the real answer the student gets), and write only the reply into the answer file it names. Work through them one by one.",
    ...calls.map((c) => `- ${join(dir, "calls", `${c.id}.md`)}  (${c.label})`),
    "",
    "When every answer file is written, run this program again with the same arguments."
  ]);
}
function splitUploads(writes, versions) {
  const parts = [];
  const rest = [];
  for (const w of writes) {
    if (w.mode === "delete") {
      rest.push(w);
      continue;
    }
    const { main: main2, parts: ps } = splitDoc(w.path.join("."), w.data);
    for (const [id, p] of Object.entries(ps)) if (!versions.has(`${ME}/${PARTS_DOC}/${PARTS_COL}/${id}`)) parts.push({ path: [PARTS_DOC, PARTS_COL, id], data: p, mode: "create" });
    rest.push({ ...w, data: main2 });
  }
  return [...parts, ...rest];
}
function uploadStep(dir, url, writes0, versions, upgrade2) {
  const writes = splitUploads(writes0, versions);
  const up = join(dir, "upload");
  mkdirSync(up, { recursive: true });
  const batches = [[]];
  let size = 0;
  writes.forEach((w, i) => {
    const file = join(up, `${String(i).padStart(3, "0")}.json`);
    const path = w.path;
    const collection2 = [ME, ...path.slice(0, -1)].join("/");
    const text = w.mode === "delete" ? "" : JSON.stringify(w.data);
    let entry;
    if (w.mode === "delete") entry = { op: "delete", collection: collection2, doc_id: path[path.length - 1] };
    else {
      writeFileSync(file, text);
      entry = { op: "set", collection: collection2, doc_id: path[path.length - 1], file_path: file };
      const v = versions.get(`${ME}/${path.join("/")}`);
      if (w.mode === "replace" && v) entry.if_version = v;
    }
    let batch = batches[batches.length - 1];
    if (batch.length >= 50 || size + text.length > BATCH_BYTES) {
      batch = [];
      batches.push(batch);
      size = 0;
    }
    batch.push(entry);
    size += text.length;
  });
  if (upgrade2) {
    say([
      `NEXT STEP: upgrade the student's StudyDesk data from data version ${upgrade2.from} to ${upgrade2.to} (StudyDesk was updated and the page hasn't been opened since).`,
      "",
      `Use ArtifactData action "batch" with url "${url}", one call per list below, in this order. Use the entries exactly as given.`,
      `If a batch is refused because a document's version changed: for that document only, get it (action "get") to learn its version and redo the entry with "if_version".`,
      ...batches.filter((b) => b.length).map((b, i) => `
Batch ${i + 1}:
${JSON.stringify(b)}`),
      "",
      `When every batch is saved, delete the folder ${join(dir, "data")} (the downloaded data is out of date now) and run this program again with the same arguments.`
    ]);
    return;
  }
  say([
    "NEXT STEP: save tonight's results into the student's StudyDesk.",
    "",
    `Use ArtifactData action "batch" with url "${url}", one call per list below, in this order. Use the entries exactly as given.`,
    'If a batch is refused because a document already exists or its version changed: for that document only, get it (action "get") to learn its version and redo the entry with "if_version". For mastery/attempts, mastery/reviews and quests/records documents that already exist, skip the entry instead (they were saved before).',
    ...batches.filter((b) => b.length).map((b, i) => `
Batch ${i + 1}:
${JSON.stringify(b)}`),
    "",
    `When every batch is saved, run this program again with the same arguments plus --saved.`
  ]);
}
function snapshotOf(all) {
  const s = emptySnapshot();
  for (const k of DOC_KIND_LIST) s[k] = doc(all, DOC_KINDS[k]);
  for (const k of COLLECTION_KIND_LIST) s[k] = Object.fromEntries(collection(all, COLLECTION_KINDS[k].join("/")).map((x) => [x.id, x.data]));
  return joinSnapshot(s, partsOf(all));
}
async function main() {
  const dir = arg("dir");
  const key2 = arg("key");
  if (!dir || !key2) {
    say(["Usage: node routine.mjs --dir <work folder> --key <schedule key> [--url <StudyDesk url>] [--dry-run --tz <IANA zone>]"]);
    process.exitCode = 2;
    return;
  }
  mkdirSync(dir, { recursive: true });
  const url = arg("url") || (existsSync(join(dir, "url.txt")) ? readFileSync(join(dir, "url.txt"), "utf8").trim() : null);
  if (url) writeFileSync(join(dir, "url.txt"), url);
  if (!existsSync(join(dir, "data", "READY"))) return downloadStep(dir, url);
  if (!url) {
    say([`Write the StudyDesk url into ${join(dir, "url.txt")} (or pass --url), then run this program again.`]);
    return;
  }
  const all = loadAll(join(dir, "data"));
  const profile = doc(all, "profile");
  const schedule = profile?.schedule;
  const dry = process.argv.includes("--dry-run");
  if (!dry && (!schedule || schedule.key !== key2)) {
    say([
      "STOP. This scheduled task was replaced by a newer one (or the nightly run was turned off), so it does nothing tonight.",
      `Don't write anything. Reply "Replaced: nothing to do." and end. NIGHTLY RUN FINISHED`
    ]);
    return;
  }
  const nightFile = join(dir, "night.json");
  let night;
  if (existsSync(nightFile)) night = JSON.parse(readFileSync(nightFile, "utf8"));
  else {
    const now = Date.now();
    const timeZone = schedule?.timeZone ?? arg("tz") ?? "UTC";
    const p = localParts(now, timeZone);
    night = { now, today: p.day, nowLocal: `${p.day}T${p.time}`, timeZone, seed: now % 2147483647 || 7 };
    writeFileSync(nightFile, JSON.stringify(night));
  }
  freeze(night);
  if (!dry && profile?.nightly?.paused) {
    say([`STOP. The student paused the nightly run. Don't write anything. Reply "Paused: nothing to do." and end. NIGHTLY RUN FINISHED`]);
    return;
  }
  const stored = snapshotOf(all);
  const dataVersion = dataVersionOf(stored);
  if (dataVersion > DATA_VERSION) {
    say([`STOP. The student's data is from a newer StudyDesk (data version ${dataVersion}) than this nightly program (${DATA_VERSION}). Don't write anything. Reply "Data is newer than the program: nothing done." and end. NIGHTLY RUN FINISHED`]);
    return;
  }
  if (dataVersion < DATA_VERSION) {
    const up = upgrade(stored, dataVersion);
    const check2 = up.ok ? validateSnapshot(up.snapshot) : null;
    if (!up.ok || !check2?.ok) {
      say([`STOP. StudyDesk was updated, but the student's data couldn't be upgraded here: ${up.ok ? check2.problems.slice(0, 5).join("; ") : up.error}. Nothing was written; the page tries again (with a backup) when the student opens it. Don't write anything. Reply with this sentence and end. NIGHTLY RUN FINISHED`]);
      return;
    }
    const writes2 = diffSnapshots({ ...stored, updates: null }, { ...up.snapshot, updates: null }).map(
      (w) => w.data ? { path: w.path, data: w.data, mode: "replace" } : { path: w.path, data: null, mode: "delete" }
    );
    writes2.push({ path: ["updates"], data: { ...stored.updates ?? {}, dataVersion: DATA_VERSION, updatedAt: night.now }, mode: "replace" });
    const versions2 = new Map([...all.entries()].map(([k, v]) => [k, v.version]));
    return uploadStep(dir, url, writes2, versions2, { from: dataVersion, to: DATA_VERSION });
  }
  const routine = doc(all, "routine");
  if (!dry && routine?.nights.some((n) => n.day === night.today && n.status === "done" && night.now - n.startedAt < 3 * 36e5) && !process.argv.includes("--saved")) {
    say([`A run already finished in the last few hours (${night.today}). Don't write anything. NIGHTLY RUN FINISHED`]);
    return;
  }
  const answers = /* @__PURE__ */ new Map();
  const ansDir = join(dir, "answers");
  if (existsSync(ansDir)) {
    for (const f of readdirSync(ansDir)) if (f.endsWith(".md")) answers.set(f.slice(0, -3), readFileSync(join(ansDir, f), "utf8").trim());
  }
  const images = new Map(collection(all, "quests/images").filter((x) => x.data.dataUrl).map((x) => [x.id, x.data.dataUrl]));
  const uploads = new Map(collection(all, "files/uploads").map((x) => [x.id, x.data]));
  const mastery = {
    skills: collection(all, "mastery/skills").map((x) => x.data),
    targets: collection(all, "mastery/targets").map((x) => x.data),
    attempts: collection(all, "mastery/attempts").map((x) => x.data),
    reviews: collection(all, "mastery/reviews").map((x) => x.data)
  };
  const input = {
    today: night.today,
    nowLocal: night.nowLocal,
    now: night.now,
    profile,
    draft: doc(all, "onboarding"),
    semester: doc(all, "semester"),
    calendar: doc(all, "calendar"),
    url,
    notes: doc(all, "orchestrator")?.memory?.text ?? "",
    records: collection(all, "quests/records").map((x) => x.data),
    mastery,
    outbox: collection(all, "routine/outbox").map((x) => x.data),
    routine,
    images,
    uploads
  };
  const d = deferredAsk(answers);
  const result = await runNightly(input, d);
  if (result.kind === "pending") {
    if (!d.pending.length) {
      say(["Something stopped without a call to answer. Reply with the log below and end.", ...result.log, "NIGHTLY RUN FINISHED"]);
      return;
    }
    return callsStep(dir, d.pending);
  }
  if (dry) {
    say([
      "NIGHTLY RUN FINISHED (dry run: nothing is saved).",
      `It would save ${result.writes.length} documents: ${result.writes.map((w) => w.path.join("/")).join(", ")}`,
      "Tonight's log would be:",
      ...result.log.map((l) => `- ${l}`),
      "",
      "Reply with that and end. Don't write anything into StudyDesk."
    ]);
    return;
  }
  if (process.argv.includes("--saved")) {
    say([
      "NIGHTLY RUN FINISHED. Tonight's log for the student:",
      ...result.log.map((l) => `- ${l}`),
      "",
      "Reply with that log and end the session. Don't write anything else."
    ]);
    return;
  }
  const release = readReleases(dir, night.now);
  if (release === void 0) return say(releaseStepLines(dir));
  const versions = new Map([...all.entries()].map(([k, v]) => [k, v.version]));
  const writes = [...result.writes];
  if (release) writes.push({ path: ["release"], data: { ...release }, mode: "replace" });
  uploadStep(dir, url, writes, versions);
}
main().catch((e) => {
  say([`The nightly program failed: ${e?.stack ?? String(e)}`, "Reply with this error and end. NIGHTLY RUN FINISHED"]);
  process.exitCode = 1;
});
