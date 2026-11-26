// Plans one day's quest in plain code: which skills, which homework tasks,
// how many minutes. Claude only writes the text afterwards (write.ts).
// design/quest-creation.md and design/grading-and-mastery.md, "Main design
// choices" 5 to 7.

import { CONFIG } from "../mastery/config";
import { addDays, daysBetween } from "../mastery/days";
import { isRequired } from "../mastery/mastery";
import { dueSkills, replay } from "../mastery/replay";
import { expectedMinutes, questBudget, slownessFactor } from "../mastery/timing";
import type { Attempt, Day, ReviewItem, Skill, SkillState } from "../mastery/types";
import { ankiMinutes, applyQuestSettings, QUEST_CONFIG, partMinutes } from "./config";
import type { Reading } from "./reading";
import type { Assignment, AssignmentTask, Focus, KeyDate, ProblemPart, Quest, QuestProblem, Semester, TimetableEntry } from "./types";

export type PlanInput = {
  semester: Semester;
  today: Day;
  /** Local time now, "YYYY-MM-DDTHH:MM", to tell which deadlines have passed. */
  nowLocal: string;
  attempts: Attempt[];
  reviews: ReviewItem[];
  /** Assignment tasks already handed in through a quest. */
  doneTaskIds: Set<string>;
  /** Fundamentals a recent grading named as the cause of a wrong answer. They go first. */
  blockerSkillIds: string[];
  /** Plan this course instead of the most urgent one. */
  courseId?: string;
  /** Minutes to plan instead of the computed budget (e.g. the student asks for a quest on a rest day). */
  budgetOverride?: number;
  questId?: string;
  /** Minutes already taken today according to the student's calendar, when it's connected. */
  calendarBusyMinutes?: number;
  /** Cards per skill in the student's Anki decks, when Anki is on (anki.ts). Those skills become deck tests with an Anki step first. */
  deckSizes?: Map<string, number>;
  /** The student's reading rate and reading minutes per day (reading.ts). */
  reading?: Reading;
};

export type PlanResult =
  | { kind: "quest"; quest: Quest }
  | { kind: "no_time"; freeMinutes: number; goalMinutes: number }
  | { kind: "nothing_to_do"; courseId: string };

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function weekdayOf(day: Day): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function busyMinutes(timetable: TimetableEntry[], weekday: number): number {
  return timetable.filter((t) => t.weekday === weekday).reduce((s, t) => s + Math.max(0, minutesOf(t.end) - minutesOf(t.start)), 0);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Wednesday 11:00", or "today 11:00" / "tomorrow 11:00". */
export function formatDue(dueAt: string, today: Day): string {
  const [day, time] = dueAt.split("T");
  const diff = daysBetween(today, day);
  const when = diff === 0 ? "today" : diff === 1 ? "tomorrow" : WEEKDAYS[weekdayOf(day)];
  return time ? `${when} ${time}` : when;
}

const known = (st: SkillState | undefined) => st?.stage === "mastered" || st?.stage === "retained";
/** Never tried, or forgotten: needs an explanation, not just a problem. */
const needsTeaching = (st: SkillState | undefined) => !st || st.stage === "new" || st.stage === "lapsed";

const openTasks = (a: Assignment, done: Set<string>) => a.tasks.filter((t) => !done.has(t.id));

/** Open homework due from now to the lookahead, most urgent first. */
export function upcomingAssignments(semester: Semester, today: Day, nowLocal: string, done: Set<string>, courseId?: string): Assignment[] {
  const until = addDays(today, QUEST_CONFIG.assignmentLookaheadDays);
  return semester.assignments
    .filter((a) => (!courseId || a.courseId === courseId) && a.dueAt >= nowLocal && a.dueAt.slice(0, 10) <= until)
    .filter((a) => openTasks(a, done).length > 0)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
}

/**
 * Exams and quizzes in the next week. One without a skill list covers every
 * skill of its course the student's target grade needs.
 */
function examsSoon(semester: Semester, today: Day): KeyDate[] {
  const until = addDays(today, CONFIG.examCheckWindowDays);
  return semester.keyDates
    .filter((k) => k.date >= today && k.date <= until)
    .map((k) => {
      const target = semester.targets.find((t) => t.courseId === k.courseId);
      const ids = k.skillIds.length ? new Set(k.skillIds) : null;
      const skillIds = semester.skills
        .filter((s) => s.courseId === k.courseId && (!ids || ids.has(s.id)) && (!target || isRequired(s, target)))
        .map((s) => s.id);
      return { ...k, skillIds };
    });
}

/** The student's one-course focus, while it runs. */
export function focusNow(semester: Semester, today: Day): Focus | null {
  const f = semester.focus;
  return f && today <= f.until && semester.courses.some((c) => c.id === f.courseId) ? f : null;
}

/**
 * The course that needs today's quest most. A focus the student set wins. Homework due within a couple of
 * days wins if it's due before the exam; otherwise the exam with the most open
 * skills per day left; otherwise the earliest homework, else the first course.
 */
function pickCourse(input: PlanInput, exam: KeyDate | undefined): string {
  if (input.courseId) return input.courseId;
  const focus = focusNow(input.semester, input.today);
  if (focus) return focus.courseId;
  const hw = upcomingAssignments(input.semester, input.today, input.nowLocal, input.doneTaskIds)[0];
  const hwDay = hw?.dueAt.slice(0, 10);
  if (exam && !(hwDay && hwDay <= addDays(input.today, QUEST_CONFIG.urgentWithinDays) && hwDay < exam.date)) return exam.courseId;
  return hw?.courseId ?? input.semester.courses[0].id;
}

export function planQuest(input: PlanInput): PlanResult {
  const { semester, today, attempts, reviews } = input;
  applyQuestSettings(semester.questSettings);
  const skills = semester.skills;
  const { states } = replay(skills, attempts, reviews);

  // Open exam skills: not known yet, or known and due for their check before the exam.
  const exams = examsSoon(semester, today);
  const dueAll = new Set(dueSkills(skills, states, attempts, exams, today));
  const open = (k: KeyDate) => k.skillIds.filter((id) => !known(states.get(id)) || dueAll.has(id)).length;
  const load = (k: KeyDate) => open(k) / Math.max(1, daysBetween(today, k.date));
  const exam = exams.filter((k) => open(k) > 0).sort((a, b) => load(b) - load(a) || (a.date < b.date ? -1 : 1))[0];

  const courseId = pickCourse(input, exam);
  const course = semester.courses.find((c) => c.id === courseId)!;
  const target = semester.targets.find((t) => t.courseId === courseId);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const courseSkills = skills.filter((s) => s.courseId === courseId);
  const required = (s: Skill) => !target || isRequired(s, target);
  // In the week before this course's exams, the quest covers only their skills.
  const courseExams = exams.filter((k) => k.courseId === courseId);
  const examSkills = new Set(courseExams.flatMap((k) => k.skillIds));
  const slowness = slownessFactor(skills, attempts);
  const expMin = (s: Skill) => Math.max(1, Math.round(expectedMinutes(s, attempts, slowness)));

  // ---- time ----
  const weekday = weekdayOf(today);
  // A day off (set through the Orchestrator) has no study time.
  const goal = semester.daysOff?.includes(today) ? 0 : semester.studyGoal[weekday] ?? 0;
  const fixedBusy = busyMinutes(semester.timetable, weekday);
  // Today's calendar is the live source; the weekly timetable covers lectures that aren't in it.
  const busy = input.calendarBusyMinutes !== undefined ? Math.max(input.calendarBusyMinutes, fixedBusy) : fixedBusy;
  const budget = questBudget(goal, busy, attempts, today, input.reading?.minutesByDay);
  const budgetMinutes = input.budgetOverride ?? budget.budgetMinutes;
  if (budgetMinutes <= 0) return { kind: "no_time", freeMinutes: budget.freeMinutes, goalMinutes: goal };
  const limit = budgetMinutes * (1 + QUEST_CONFIG.overBudgetTolerance);

  // ---- what goes in, in priority order ----
  const gate: string[] = []; // fundamentals checked before the homework
  const concepts: string[] = []; // non-fundamental prerequisites taught first
  const taskLearn: string[] = []; // skills taught right before the homework
  const tasks: Array<{ assignment: Assignment; task: AssignmentTask }> = [];
  const reviewIds: string[] = [];
  const newIds: string[] = [];
  let explainId: string | null = null;
  const planned = new Set<string>();
  const leftOut: string[] = [];
  const empty = () => !gate.length && !tasks.length && !reviewIds.length && !newIds.length;

  const lessonMin = (s: Skill) => Math.max(1, Math.round(expMin(s) * QUEST_CONFIG.lesson.problemShare));
  const cards = (id: string) => Math.min(QUEST_CONFIG.anki.cardsPerTest, input.deckSizes?.get(id) ?? 0);
  const minutes = () => {
    let m = 0;
    // A lesson on a skill with a deck becomes a test (no reading); the Anki step is counted once below.
    for (const id of [...concepts, ...taskLearn, ...newIds]) m += (cards(id) ? 0 : QUEST_CONFIG.lesson.readMinutes) + lessonMin(byId.get(id)!);
    for (const id of [...gate, ...reviewIds]) m += expMin(byId.get(id)!);
    for (const t of tasks) m += expMin(byId.get(t.task.skillId)!);
    if (explainId) m += QUEST_CONFIG.explainMinutes;
    return m + ankiMinutes([...concepts, ...taskLearn, ...newIds, ...gate, ...reviewIds].reduce((n, id) => n + cards(id), 0));
  };
  /** Adds a group if it fits (or if `force`); rolls it back otherwise. */
  const tryAdd = (apply: () => void, rollback: () => void, force = false) => {
    apply();
    if (force || minutes() <= limit) return true;
    rollback();
    return false;
  };

  // 1. Fundamentals that recent mistakes were traced back to.
  for (const id of input.blockerSkillIds) {
    const s = byId.get(id);
    if (!s || s.courseId !== courseId || planned.has(id) || known(states.get(id))) continue;
    tryAdd(
      () => (gate.push(id), planned.add(id)),
      () => (gate.pop(), planned.delete(id)),
    );
  }

  // 2. Real homework: each task brings the prerequisites and explanation it needs.
  //    Homework due within a couple of days comes before reviews; later homework after them.
  const assignments = upcomingAssignments(semester, today, input.nowLocal, input.doneTaskIds, courseId);
  const urgentUntil = addDays(today, QUEST_CONFIG.urgentWithinDays);
  const addHomework = (list: Assignment[], urgent: boolean) => {
    for (const a of list) {
      for (const task of openTasks(a, input.doneTaskIds)) {
        const skill = byId.get(task.skillId);
        if (!skill) continue;
        const added = { gate: [] as string[], concepts: [] as string[], learn: [] as string[] };
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
          urgent && tasks.length === 0, // urgent homework always gets at least one task
        );
        if (!ok) leftOut.push(`${a.title} ${task.label}`);
      }
    }
    for (const t of tasks) planned.add(t.task.skillId);
  };
  addHomework(assignments.filter((a) => a.dueAt.slice(0, 10) <= urgentUntil), true);

  // 3. Reviews: skills still being learned, lapsed, or due on the review ladder.
  //    Before an exam only its skills; the rest wait until after it.
  const stageOrder = { lapsed: 0, mastered: 1, learning: 2, retained: 3, new: 4 } as const;
  const due = courseSkills
    .filter((s) => dueAll.has(s.id) && !planned.has(s.id) && (!examSkills.size || examSkills.has(s.id)))
    .sort((a, b) => stageOrder[states.get(a.id)!.stage] - stageOrder[states.get(b.id)!.stage] || b.weight - a.weight)
    .map((s) => s.id);
  for (const id of due) {
    const ok = tryAdd(
      () => (reviewIds.push(id), planned.add(id)),
      () => (reviewIds.pop(), planned.delete(id)),
    );
    if (!ok) leftOut.push(`review: ${byId.get(id)!.name}`);
  }

  // Explain it: the first skill coming back is explained in the student's own words before it's solved.
  if (reviewIds.length) tryAdd(() => (explainId = reviewIds[0]), () => (explainId = null));

  // 4. Skills the student hasn't started, those on the nearest exam first.
  const examRank = (s: Skill) => {
    const e = semester.keyDates.filter((x) => x.date >= today && x.skillIds.includes(s.id)).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    return e ? daysBetween(today, e.date) : 9999;
  };
  const topicRank = (s: Skill) => course.topics.findIndex((t) => t.id === s.topicId);
  const addNew = (list: Skill[], max: number) => {
    const fresh = list
      .filter((s) => required(s) && !planned.has(s.id) && (states.get(s.id)?.stage ?? "new") === "new")
      .sort((a, b) => examRank(a) - examRank(b) || topicRank(a) - topicRank(b) || Number(b.isFundamental) - Number(a.isFundamental));
    let added = 0;
    for (const s of fresh) {
      if (added >= max) break;
      // Checked here, not up front, so a skill can build on one added just before it.
      if (!s.prereqSkillIds.every((p) => known(states.get(p)) || planned.has(p) || !byId.has(p))) continue;
      if (tryAdd(() => (newIds.push(s.id), planned.add(s.id)), () => (newIds.pop(), planned.delete(s.id)), empty())) added++;
    }
  };
  // An exam's own skills aren't new material: they come before later homework, as many as fit.
  addNew(courseSkills.filter((s) => examSkills.has(s.id)), Infinity);

  addHomework(
    assignments.filter((a) => a.dueAt.slice(0, 10) > urgentUntil),
    empty(),
  );

  // 5. Nothing due at all: start the next new skills. Before an exam only if the student asked for that.
  if (tasks.length === 0) {
    addNew(
      courseSkills.filter((s) => !examSkills.has(s.id)),
      examSkills.size ? QUEST_CONFIG.newBeforeExams : QUEST_CONFIG.maxNewSkills,
    );
  }

  if (empty()) return { kind: "nothing_to_do", courseId };

  // ---- assemble the parts ----
  let pn = 0;
  let partN = 0;
  const names = (ids: string[]) => ids.map((id) => byId.get(id)!.name);
  const practiceProblem = (id: string): QuestProblem => ({
    id: `p${++pn}`,
    skillId: id,
    prompt: "",
    answerKey: "",
    hints: [],
    similarSolved: null,
    expMinutes: expMin(byId.get(id)!),
    maxPoints: QUEST_CONFIG.practiceMaxPoints,
  });
  /** One idea: explanation, worked example, then a short problem of the student's own. */
  const lesson = (id: string): ProblemPart => ({
    kind: "lesson",
    id: `part${++partN}`,
    title: byId.get(id)!.name,
    gate: false,
    skillIds: [id],
    readMinutes: QUEST_CONFIG.lesson.readMinutes,
    body: "",
    problems: [{ ...practiceProblem(id), expMinutes: lessonMin(byId.get(id)!) }],
  });
  const practice = (ids: string[], title: string, isGate: boolean): ProblemPart => ({
    kind: "practice",
    id: `part${++partN}`,
    title,
    gate: isGate,
    problems: ids.map(practiceProblem),
  });

  const parts: Quest["parts"] = [];
  // Short cycles, one idea at a time, the real homework last.
  if (explainId) parts.push({ ...practice([explainId], byId.get(explainId)!.name, false), explain: true, problems: [{ ...practiceProblem(explainId), expMinutes: QUEST_CONFIG.explainMinutes }] });
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
        expMinutes: expMin(byId.get(task.skillId)!),
        maxPoints: task.maxPoints,
      })),
    });
  }

  // ---- why today ----
  let reason: string;
  if (courseExams.length && !tasks.length) {
    reason = `${courseExams.map((k) => `${k.title} is ${formatDue(k.date, today)}`).join(" and ")}, so today covers only exam skills.`;
  } else if (tasks.length) {
    const a = tasks[0].assignment;
    const mine = tasks.filter((t) => t.assignment.id === a.id);
    const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
    const needs = [...new Set(mine.map((t) => lower(byId.get(t.task.skillId)!.name)))];
    // Skill names are verb phrases ("Solve …"), so they follow a colon; more than three task labels become a count.
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

  const notes: string[] = [];
  if (input.budgetOverride !== undefined) {
    notes.push(`You asked for a quest today, so it's about ${budgetMinutes} min.`);
  } else {
    notes.push(
      `Your time today: ${budget.freeMinutes} min free (study goal ${goal} min${busy ? `, minus ${busy} min ${input.calendarBusyMinutes !== undefined ? "in your calendar" : "of lectures"}` : ""}).`,
    );
    notes.push(
      budget.paceMinutes === null
        ? `StudyDesk doesn't know your pace yet, so this quest uses half of it.`
        : `You've been finishing about ${Math.round(budget.paceMinutes)} min a day, so this quest is sized to ${budgetMinutes} min.`,
    );
  }
  // A focus never hides other courses' deadlines.
  const focus = focusNow(semester, today);
  if (focus?.courseId === courseId) {
    const of = (id: string) => semester.courses.find((c) => c.id === id)?.name;
    const elsewhere = [
      ...upcomingAssignments(semester, today, input.nowLocal, input.doneTaskIds).filter((a) => a.courseId !== courseId).map((a) => `${of(a.courseId)} ${a.title} due ${formatDue(a.dueAt, today)}`),
      ...exams.filter((k) => k.courseId !== courseId).map((k) => `${of(k.courseId)} ${k.title} ${formatDue(k.date, today)}`),
    ];
    notes.push(`Only ${course.name} until ${new Date(`${focus.until}T12:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, as you asked.${elsewhere.length ? ` Still coming up in other courses: ${elsewhere.join("; ")}.` : ""}`);
  }
  for (const a of assignments) {
    const missing = openTasks(a, input.doneTaskIds).filter((t) => !tasks.some((x) => x.task.id === t.id));
    if (missing.length && daysBetween(today, a.dueAt.slice(0, 10)) <= 1) {
      notes.push(
        `${a.title} ${missing.map((t) => t.label).join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} fit today and ${a.title} is due ${formatDue(a.dueAt, today)}. Ask for a longer quest if you want to finish it.`,
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
      createdAt: Date.now(),
    },
  };
}

/** Fundamentals named as the cause of a wrong answer in the last few days, newest first. */
export function recentBlockers(records: Array<{ quest: Quest; progress: { work: Record<string, { fundamentalSkillId?: string | null; verdict?: string }> } }>, today: Day): string[] {
  const since = addDays(today, -CONFIG.examCheckWindowDays);
  const out: string[] = [];
  for (const r of [...records].sort((a, b) => (a.quest.date < b.quest.date ? 1 : -1))) {
    if (r.quest.date < since) continue;
    for (const w of Object.values(r.progress.work)) {
      if (w.verdict && w.verdict !== "solved" && w.fundamentalSkillId && !out.includes(w.fundamentalSkillId)) out.push(w.fundamentalSkillId);
    }
  }
  return out;
}

/** Assignment tasks handed in through any quest. */
export function doneTasks(records: Array<{ quest: Quest; progress: { work: Record<string, { attemptId?: string }> } }>): Set<string> {
  const done = new Set<string>();
  for (const r of records)
    for (const p of r.quest.parts)
      if (p.kind === "assignment")
        for (const q of p.problems) if (q.assignmentTaskId && r.progress.work[q.id]?.attemptId) done.add(q.assignmentTaskId);
  return done;
}

const FEEL = { easy: "too easy", right: "just right", hard: "too hard" } as const;

/** How recent parts felt, per skill, newest rating wins. For the writer. */
export function recentFeel(
  records: Array<{ quest: Quest; progress: { ratings?: Record<string, "easy" | "right" | "hard"> } }>,
  skillName: (id: string) => string | undefined,
  today: Day,
): string[] {
  const since = addDays(today, -14);
  const bySkill = new Map<string, string>();
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

/** Homework tasks in `quest` that an earlier, unfinished quest already had. */
export function carriedOver(
  records: Array<{ quest: Quest; progress: { handedIn: string[] } }>,
  quest: Quest,
): Array<{ label: string; from: Day }> {
  const out: Array<{ label: string; from: Day }> = [];
  for (const part of quest.parts) {
    if (part.kind !== "assignment") continue;
    for (const p of part.problems) {
      const prev = records.find(
        (r) =>
          r.quest.date < quest.date &&
          r.quest.parts.some((x) => x.kind === "assignment" && !r.progress.handedIn.includes(x.id) && x.problems.some((q) => q.assignmentTaskId === p.assignmentTaskId)),
      );
      if (prev) out.push({ label: p.label ?? "", from: prev.quest.date });
    }
  }
  return out;
}
