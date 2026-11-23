// Which course gets study time on which day. Plain code: agents judge, code
// counts (design/guidelines.md, rule 3). design/day-plan.md.
//
// A day is a few short blocks, each for one course, instead of one long quest
// for the course with the most urgent homework. What goes in, in this order:
// mistakes to understand, homework due next, the placement check (a couple of
// courses a day), prep for every exam in the next four weeks spread backwards
// from its date, reviews, and something new when there's room. Each block
// becomes a normal quest for its course (planQuest), so writing, grading and
// mastery stay as they are.

import { addDays, daysBetween } from "../mastery/days";
import { isRequired, masteryOf } from "../mastery/mastery";
import { replay } from "../mastery/replay";
import { expectedMinutes, questBudget, slownessFactor } from "../mastery/timing";
import type { Attempt, Day, ReviewItem, Skill, SkillState } from "../mastery/types";
import { QUEST_CONFIG, partMinutes } from "../quests/config";
import { busyMinutes, doneTasks, upcomingAssignments, weekdayOf } from "../quests/plan";
import type { BlockKind, BlockTone, KeyDate, ProblemPart, QuestRecord, Semester } from "../quests/types";

export type { BlockKind, BlockTone };

/** Tunable numbers of the day plan, in one place. */
export const DAY_PLAN = {
  /** How far ahead exams are prepared for, and how far the Week page looks. */
  horizonDays: 28,
  /** Minutes of one exam-prep block. */
  prepMinutes: 25,
  /** A block is never shorter than this, unless the whole day has less. */
  minBlock: 10,
  /** Blocks on one day, at most. */
  maxBlocksPerDay: 4,
  /** Placement check parts (one course each) per day. */
  checksPerDay: 2,
  /** Prep blocks go this many days before an exam, nearest first: spaced, never crammed. */
  prepOffsets: [1, 2, 4, 6, 9, 13],
  /** Prep blocks an exam wants: more the less of it is mastered. */
  examBlocks: { min: 2, max: 6 },
  quizBlocks: { min: 1, max: 3 },
  /** The mistake review: minutes per open mistake, and at most. */
  fixPerMistake: 4,
  fixMax: 20,
  reviewMax: 20,
  /** Two blocks of one course on one day become one, up to this long. */
  mergedMax: 50,
  /** Homework due before this time is done the day before; later, it can be the same day. */
  morningDue: "14:00",
  /** Homework longer than this is split over the days before it's due by the quests themselves. */
  homeworkMax: 90,
  /** A day may run this much over its budget rather than drop a block. */
  overBudget: 0.1,
};

const RANK = { fix: 0, homeworkUrgent: 1, check: 1.5, exam: 2, homework: 3, review: 4, new: 5 } as const;

export type PlannedBlock = {
  key: string;
  kind: BlockKind;
  courseId: string;
  minutes: number;
  day: Day;
  rank: number;
  tone: BlockTone;
  /** The exams this block prepares for, as exam keys. */
  examKeys: string[];
  /** Homework: the hand-in time. */
  dueAt?: string;
  /** A block that already exists as a quest record. */
  recordId?: string;
  /** Placement check parts this block works through (on the placement record). */
  partIds?: string[];
  /** Mistakes to understand: how many. */
  mistakes?: number;
  /** Reviews: how many skills come back. */
  reviewCount?: number;
};

export type DayPlan = { day: Day; budget: number; blocks: PlannedBlock[] };

export type ExamRun = {
  key: string;
  courseId: string;
  title: string;
  /** "Klausur", "Exam", "Quiz". */
  label: string;
  date: Day;
  kind: "exam" | "quiz";
  /** 0 to 1: the share of what the target grade needs for it that the student can do now. */
  readiness: number;
  /** Prep blocks it wants, and how many the plan has before its date. */
  wanted: number;
  planned: number;
  status: "on_track" | "tight" | "behind" | "needs_you";
};

export type Projection = {
  days: DayPlan[];
  exams: ExamRun[];
  /** Minutes a study day would need for all prep and homework to fit, and what a study day has. */
  neededPerDay: number;
  budgetPerDay: number;
  /** Exam prep and homework that found no room. */
  leftOut: PlannedBlock[];
};

export type PlannerInput = {
  semester: Semester;
  today: Day;
  /** Local time now, "YYYY-MM-DDTHH:MM". */
  nowLocal: string;
  attempts: Attempt[];
  reviews: ReviewItem[];
  records: QuestRecord[];
  /** How many days to plan, from `today`. */
  days?: number;
  /** Busy minutes from the calendar's last read, when it covers the day. */
  calendarBusy?: (day: Day) => number | undefined;
  /** Open mistakes from the newest graded quest, for a short first block today. */
  fix?: { courseId: string; count: number } | null;
};

// ---------- small helpers ----------

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 2 Dec". */
export function shortDate(day: Day): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]}`;
}

/** "today", "tomorrow", "in 9 days". */
export function inDays(n: number): string {
  return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

/** What a student calls the exam: "Klausur" when its title says so. */
export function examLabel(k: { title: string; kind: "exam" | "quiz" }): string {
  if (/klausur/i.test(k.title)) return "Klausur";
  if (/schularbeit/i.test(k.title)) return "Schularbeit";
  return k.kind === "quiz" ? "Quiz" : "Exam";
}

export const examKey = (k: Pick<KeyDate, "courseId" | "date" | "title">) => `${k.courseId}:${k.date}:${k.title}`;

/** "Due tomorrow 08:00", seen from `day`. */
export function dueLine(dueAt: string, day: Day): string {
  const [d, t] = dueAt.split("T");
  const n = daysBetween(day, d);
  const when = n <= 0 ? "today" : n === 1 ? "tomorrow" : shortDate(d);
  return `Due ${when}${t ? ` ${t.slice(0, 5)}` : ""}`;
}

/** One line on why a block is there, seen from the day it's on. */
export function whyLine(b: Pick<PlannedBlock, "kind" | "examKeys" | "dueAt" | "mistakes" | "reviewCount">, day: Day, semester: Pick<Semester, "keyDates">, fallback = ""): string {
  if (b.dueAt) return dueLine(b.dueAt, day);
  const k = b.examKeys.length ? semester.keyDates.find((x) => examKey(x) === b.examKeys[0]) : undefined;
  const exam = k ? `${examLabel(k)} ${shortDate(k.date)} · ${inDays(daysBetween(day, k.date))}` : "";
  if (b.kind === "fix") return `${b.mistakes ?? 0} ${b.mistakes === 1 ? "mistake" : "mistakes"} to understand`;
  if (b.kind === "check") return "Placement check: what you know already";
  if (exam) return exam;
  if (b.kind === "review") return `${b.reviewCount ?? 0} ${b.reviewCount === 1 ? "skill comes" : "skills come"} back`;
  if (b.kind === "new") return "Something new";
  return fallback;
}

/** A quest record's block as it counts on `day`: moved there, or of that day and neither moved nor skipped. */
export function recordOnDay(r: QuestRecord, day: Day): boolean {
  const p = r.progress;
  if (p.replacedAt) return false;
  if (p.skippedOn === day) return false;
  if (p.deferredTo) return p.deferredTo === day;
  return r.quest.date === day;
}

/** The records that are blocks of `day` (the placement check counts by its parts, not here). */
export function recordsOnDay(records: QuestRecord[], day: Day, placementId?: string): QuestRecord[] {
  return records.filter((r) => r.quest.id !== placementId && recordOnDay(r, day));
}

/** The course a placement part checks: named in its title, else most of its skills. */
export function checkCourse(part: ProblemPart, semester: Pick<Semester, "courses" | "skills">): string {
  const byTitle = semester.courses.find((c) => part.title.startsWith(`${c.name}:`));
  if (byTitle) return byTitle.id;
  const count = new Map<string, number>();
  const courseOf = new Map(semester.skills.map((s) => [s.id, s.courseId]));
  for (const p of part.problems) {
    const c = courseOf.get(p.skillId);
    if (c) count.set(c, (count.get(c) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? semester.courses[0]?.id ?? "";
}

/** Placement parts still to do, with their course, and the ones handed in on `today` (done, but still part of today). */
export function openChecks(
  semester: Semester,
  records: QuestRecord[],
  today?: Day,
): Array<{ recordId: string; part: ProblemPart; courseId: string; notBefore: Day | null; doneToday: boolean }> {
  const id = semester.placementQuestId;
  if (!id || id === "none") return [];
  const r = records.find((x) => x.quest.id === id);
  if (!r || r.progress.replacedAt) return [];
  return r.quest.parts
    .filter((p): p is ProblemPart => p.kind !== "learn" && !!p.check)
    .filter((p) => !r.progress.handedIn.includes(p.id) || (!!today && r.progress.handedInOn?.[p.id] === today))
    .map((part) => ({
      recordId: r.quest.id,
      part,
      courseId: checkCourse(part, semester),
      notBefore: r.progress.partsNotBefore?.[part.id] ?? null,
      doneToday: r.progress.handedIn.includes(part.id),
    }));
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ---------- the plan ----------

type Demand = PlannedBlock & { force: boolean; movable: "earlier" | "later" | "no" };

/** Plans `days` days from `today`. Pure: the same desk always gives the same plan. */
export function planDays(input: PlannerInput): Projection {
  const { semester, today, attempts, reviews, records } = input;
  const n = Math.max(1, input.days ?? 1);
  const days = Array.from({ length: n }, (_, i) => addDays(today, i));
  const last = days[days.length - 1];
  const { states } = replay(semester.skills, attempts, reviews);
  const slowness = slownessFactor(semester.skills, attempts);
  const expMin = (s: Skill) => Math.max(1, Math.round(expectedMinutes(s, attempts, slowness)));
  const byId = new Map(semester.skills.map((s) => [s.id, s]));
  const dayOff = (d: Day) => !!semester.daysOff?.includes(d);

  // ---- how much time each day has ----
  const budget = new Map<Day, number>();
  for (const d of days) {
    if (dayOff(d)) {
      budget.set(d, 0);
      continue;
    }
    const wd = weekdayOf(d);
    const goal = semester.studyGoal[wd] ?? 0;
    const fixed = busyMinutes(semester.timetable, wd);
    const cal = input.calendarBusy?.(d);
    const busy = cal !== undefined ? Math.max(cal, fixed) : fixed;
    budget.set(d, Math.max(0, questBudget(goal, busy, attempts, today).budgetMinutes));
  }
  const used = new Map<Day, number>(days.map((d) => [d, 0]));
  const count = new Map<Day, number>(days.map((d) => [d, 0]));
  const placed: Demand[] = [];
  // A written block takes the time it was given, even when its quest came out shorter,
  // so opening the page again doesn't squeeze in another block. (A quest from before the
  // day plan was the whole day: its budget was the day's.)
  const given = (r: QuestRecord) => Math.max(r.quest.plannedMinutes, r.quest.budgetMinutes);

  // ---- blocks that exist already (written earlier today, or overnight) ----
  const covered = new Set<string>(); // `${day}|${courseId}`
  for (const d of days) {
    // A block the student moved away or skipped still had its day: that course
    // isn't planned again that day, and its time isn't filled with something else.
    for (const r of records) {
      const p = r.progress;
      if (r.quest.id === semester.placementQuestId || p.replacedAt || r.quest.date !== d) continue;
      if (p.skippedOn === d || (p.deferredTo && p.deferredTo !== d)) {
        covered.add(`${d}|${r.quest.courseId}`);
        used.set(d, (used.get(d) ?? 0) + given(r));
      }
    }
    for (const r of recordsOnDay(records, d, semester.placementQuestId)) {
      const b = r.quest.block;
      placed.push({
        key: `rec:${r.quest.id}`,
        kind: b?.kind ?? "quest",
        courseId: r.quest.courseId,
        minutes: r.quest.plannedMinutes,
        day: d,
        rank: b?.rank ?? RANK.exam,
        tone: b?.tone ?? "plain",
        examKeys: b?.examKeys ?? [],
        dueAt: b?.dueAt,
        recordId: r.quest.id,
        force: true,
        movable: "no",
      });
      used.set(d, (used.get(d) ?? 0) + given(r));
      count.set(d, (count.get(d) ?? 0) + 1);
      covered.add(`${d}|${r.quest.courseId}`);
    }
  }

  const demands: Demand[] = [];

  // ---- 0. mistakes from the last grading, first thing today ----
  if (input.fix && input.fix.count > 0 && !dayOff(today)) {
    demands.push({
      key: `fix:${today}`,
      kind: "fix",
      courseId: input.fix.courseId,
      minutes: clamp(input.fix.count * DAY_PLAN.fixPerMistake, 5, DAY_PLAN.fixMax),
      day: today,
      rank: RANK.fix,
      tone: "plain",
      examKeys: [],
      mistakes: input.fix.count,
      force: true,
      movable: "no",
    });
  }

  // ---- 1. homework: the day before it's due (or that day, when it's due late) ----
  const done = doneTasks(records);
  const needsTeaching = (st: SkillState | undefined) => !st || st.stage === "new" || st.stage === "lapsed";
  for (const a of upcomingAssignments(semester, today, input.nowLocal, done)) {
    let minutes = 0;
    for (const t of a.tasks.filter((x) => !done.has(x.id))) {
      const s = byId.get(t.skillId);
      if (!s) continue;
      minutes += expMin(s);
      if (needsTeaching(states.get(s.id))) minutes += QUEST_CONFIG.lesson.readMinutes + Math.round(expMin(s) * QUEST_CONFIG.lesson.problemShare);
    }
    if (!minutes) continue;
    const [dueDay, dueTime = "23:59"] = a.dueAt.split("T");
    let day = dueTime < DAY_PLAN.morningDue ? addDays(dueDay, -1) : dueDay;
    if (day < today) day = today;
    if (day > last) continue;
    const urgent = daysBetween(today, dueDay) <= QUEST_CONFIG.urgentWithinDays;
    demands.push({
      key: `hw:${a.id}`,
      kind: "homework",
      courseId: a.courseId,
      minutes: Math.min(DAY_PLAN.homeworkMax, minutes),
      day,
      rank: urgent ? RANK.homeworkUrgent : RANK.homework,
      tone: "due",
      examKeys: [],
      dueAt: a.dueAt,
      force: urgent,
      movable: "earlier",
    });
  }

  // ---- 2. the placement check: a couple of courses a day, nearest exam first ----
  const nextExam = (courseId: string) => semester.keyDates.filter((k) => k.courseId === courseId && k.date > today).map((k) => k.date).sort()[0] ?? "9999-12-31";
  const courseIndex = (id: string) => semester.courses.findIndex((c) => c.id === id);
  const checks = openChecks(semester, records, today).sort(
    (a, b) => Number(b.doneToday) - Number(a.doneToday) || nextExam(a.courseId).localeCompare(nextExam(b.courseId)) || courseIndex(a.courseId) - courseIndex(b.courseId),
  );
  const checksOn = new Map<Day, number>();
  for (const c of checks) {
    if (c.doneToday) {
      // Done today: it stays in today's plan (with its tick), and counts as one of today's checks.
      const minutes = Math.max(5, partMinutes(c.part));
      placed.push({ key: `check:${c.part.id}`, kind: "check", courseId: c.courseId, minutes, day: today, rank: RANK.check, tone: "plain", examKeys: [], recordId: c.recordId, partIds: [c.part.id], force: true, movable: "no" });
      used.set(today, (used.get(today) ?? 0) + minutes);
      count.set(today, (count.get(today) ?? 0) + 1);
      checksOn.set(today, (checksOn.get(today) ?? 0) + 1);
      continue;
    }
    const day = days.find((d) => (!c.notBefore || d >= c.notBefore) && (checksOn.get(d) ?? 0) < DAY_PLAN.checksPerDay && (budget.get(d) ?? 0) > 0);
    if (!day) continue;
    checksOn.set(day, (checksOn.get(day) ?? 0) + 1);
    demands.push({
      key: `check:${c.part.id}`,
      kind: "check",
      courseId: c.courseId,
      minutes: Math.max(5, partMinutes(c.part)),
      day,
      rank: RANK.check,
      tone: "plain",
      examKeys: [],
      recordId: c.recordId,
      partIds: [c.part.id],
      force: false,
      movable: "later",
    });
  }

  // ---- 3. exams: prep spread backwards from each date ----
  const exams: Array<ExamRun & { wantedDays: Day[] }> = [];
  const horizonEnd = addDays(today, DAY_PLAN.horizonDays);
  for (const k of [...semester.keyDates].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (k.date <= today || k.date > horizonEnd) continue;
    const target = semester.targets.find((t) => t.courseId === k.courseId);
    const required = semester.skills.filter((s) => s.courseId === k.courseId && (!target || isRequired(s, target)));
    const onExam = k.skillIds.length ? required.filter((s) => k.skillIds.includes(s.id)) : [];
    const key = examKey(k);
    const base = { key, courseId: k.courseId, title: k.title, label: examLabel(k), date: k.date, kind: k.kind };
    if (!required.length) {
      exams.push({ ...base, readiness: 0, wanted: 0, planned: 0, status: "needs_you", wantedDays: [] });
      continue;
    }
    const readiness = masteryOf(onExam.length ? onExam : required, states, today).value;
    const range = k.kind === "quiz" ? DAY_PLAN.quizBlocks : DAY_PLAN.examBlocks;
    const wanted = readiness >= 0.95 ? 1 : clamp(Math.round((1 - readiness) * range.max), range.min, range.max);
    const wantedDays = DAY_PLAN.prepOffsets.slice(0, wanted).map((o) => addDays(k.date, -o));
    exams.push({ ...base, readiness, wanted, planned: 0, status: "on_track", wantedDays });
    for (const day of wantedDays) {
      if (day < today || day > last) continue;
      demands.push({
        key: `prep:${key}:${day}`,
        kind: "exam",
        courseId: k.courseId,
        minutes: DAY_PLAN.prepMinutes,
        day,
        rank: RANK.exam + daysBetween(today, k.date) / 1000,
        tone: "exam",
        examKeys: [key],
        force: false,
        movable: "earlier",
      });
    }
  }

  // ---- placing: most important first, on its day or the nearest day with room ----
  const room = (day: Day) => (budget.get(day) ?? 0) * (1 + DAY_PLAN.overBudget) - (used.get(day) ?? 0);
  const clash = (d: Demand, day: Day) =>
    (covered.has(`${day}|${d.courseId}`) && d.kind !== "check" && d.kind !== "fix") ||
    // A placement check and prep of one course don't share a day; one exam gets one block a day.
    placed.some((p) => p.day === day && p.courseId === d.courseId && (p.kind === "check") !== (d.kind === "check")) ||
    (d.examKeys.length > 0 && placed.some((p) => p.day === day && p.examKeys.some((x) => d.examKeys.includes(x))));
  const hasRoom = (d: Demand, day: Day) => {
    if ((budget.get(day) ?? 0) <= 0) return false;
    const sameCourse = placed.some((p) => p.day === day && p.courseId === d.courseId && !p.recordId && p.kind !== "check" && p.kind !== "fix" && d.kind !== "check" && d.kind !== "fix");
    return room(day) >= Math.min(d.minutes, DAY_PLAN.minBlock) && (sameCourse || (count.get(day) ?? 0) < DAY_PLAN.maxBlocksPerDay);
  };
  const put = (d: Demand, day: Day, forced: boolean) => {
    const minutes = forced ? d.minutes : Math.max(Math.min(d.minutes, DAY_PLAN.minBlock), Math.min(d.minutes, Math.floor(room(day))));
    placed.push({ ...d, day, minutes });
    used.set(day, (used.get(day) ?? 0) + minutes);
    count.set(day, (count.get(day) ?? 0) + 1);
  };
  const candidates = (d: Demand): Day[] => {
    const i = days.indexOf(d.day);
    if (i < 0) return [];
    if (d.movable === "earlier") return days.slice(0, i + 1).reverse();
    if (d.movable === "later") return days.slice(i);
    return [d.day];
  };
  const leftOut: Demand[] = [];
  for (const d of [...demands].sort((a, b) => a.rank - b.rank || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    if (covered.has(`${d.day}|${d.courseId}`) && d.kind !== "check" && d.kind !== "fix") continue; // that course has its block that day
    const list = candidates(d).filter((x) => !clash(d, x));
    const day = list.find((x) => hasRoom(d, x));
    if (day) put(d, day, false);
    else if (d.force && list.some((x) => !dayOff(x))) put(d, list.find((x) => !dayOff(x))!, true);
    else if (d.kind === "exam" || d.kind === "homework") leftOut.push(d);
  }

  // ---- 4. reviews due, where the course has no block that day ----
  for (const day of days) {
    const perCourse = new Map<string, Skill[]>();
    for (const s of semester.skills) {
      const st = states.get(s.id);
      if (!st) continue;
      const learning = st.stage === "learning" || st.stage === "lapsed";
      const due = (day === today && learning) || (st.stage === "mastered" && st.dueAt !== null && (day === today ? st.dueAt <= day : st.dueAt === day));
      if (due) perCourse.set(s.courseId, [...(perCourse.get(s.courseId) ?? []), s]);
    }
    for (const [courseId, list] of perCourse) {
      if (covered.has(`${day}|${courseId}`) || placed.some((p) => p.day === day && p.courseId === courseId && p.kind !== "check")) continue;
      const d: Demand = {
        key: `review:${courseId}:${day}`,
        kind: "review",
        courseId,
        minutes: Math.min(DAY_PLAN.reviewMax, list.reduce((s, x) => s + expMin(x), 0)),
        day,
        rank: RANK.review,
        tone: "plain",
        examKeys: [],
        reviewCount: list.length,
        force: false,
        movable: "no",
      };
      if (!clash(d, day) && hasRoom(d, day)) put(d, day, false);
    }
  }

  // ---- 5. room left: something new, taking turns between courses ----
  const lastNew = new Map<string, number>(semester.courses.map((c, i) => [c.id, -1000 + i]));
  for (const [i, day] of days.entries()) {
    for (;;) {
      const free = Math.floor((budget.get(day) ?? 0) - (used.get(day) ?? 0));
      if (free < DAY_PLAN.minBlock + 5 || (count.get(day) ?? 0) >= DAY_PLAN.maxBlocksPerDay) break;
      const pick = semester.courses
        .filter((c) => {
          if (covered.has(`${day}|${c.id}`) || placed.some((p) => p.day === day && p.courseId === c.id)) return false;
          const target = semester.targets.find((t) => t.courseId === c.id);
          return semester.skills.some((s) => s.courseId === c.id && (!target || isRequired(s, target)) && (states.get(s.id)?.stage ?? "new") === "new");
        })
        .sort((a, b) => nextExam(a.id).localeCompare(nextExam(b.id)) || (lastNew.get(a.id) ?? 0) - (lastNew.get(b.id) ?? 0))[0];
      if (!pick) break;
      lastNew.set(pick.id, i);
      // Something new for a course whose exam is ahead is prep for that exam.
      const exam = exams.find((e) => e.courseId === pick.id && e.date > day && e.status !== "needs_you");
      const minutes = Math.min(DAY_PLAN.prepMinutes, free);
      put(
        exam
          ? { key: `new:${pick.id}:${day}`, kind: "exam", courseId: pick.id, minutes, day, rank: RANK.new, tone: "exam", examKeys: [exam.key], force: false, movable: "no" }
          : { key: `new:${pick.id}:${day}`, kind: "new", courseId: pick.id, minutes, day, rank: RANK.new, tone: "plain", examKeys: [], force: false, movable: "no" },
        day,
        true,
      );
    }
  }

  // ---- a study day always gets at least one block, however small its time ----
  for (const day of days) {
    const b = budget.get(day) ?? 0;
    if (b <= 0 || placed.some((p) => p.day === day) || [...covered].some((c) => c.startsWith(`${day}|`))) continue;
    const exam = exams.find((e) => e.date > day && e.status !== "needs_you");
    const dueIn = (courseId: string) =>
      semester.skills.filter((s) => {
        const st = states.get(s.id);
        return s.courseId === courseId && !!st && (st.stage === "learning" || st.stage === "lapsed" || (st.stage === "mastered" && st.dueAt !== null && st.dueAt <= day));
      }).length;
    const review = semester.courses.find((c) => dueIn(c.id) > 0);
    const courseId = review?.id ?? exam?.courseId ?? semester.courses[0]?.id;
    if (!courseId) continue;
    const minutes = Math.max(DAY_PLAN.minBlock, b);
    const asExam = !review && !!exam && exam.courseId === courseId;
    put(
      {
        key: `min:${courseId}:${day}`,
        kind: review ? "review" : asExam ? "exam" : "new",
        courseId,
        minutes,
        day,
        rank: RANK.review,
        tone: asExam ? "exam" : "plain",
        examKeys: asExam && exam ? [exam.key] : [],
        ...(review ? { reviewCount: dueIn(courseId) } : {}),
        force: true,
        movable: "no",
      },
      day,
      true,
    );
  }

  // ---- one block per course and day ----
  const merged: PlannedBlock[] = [];
  for (const day of days) {
    for (const p of placed.filter((x) => x.day === day).sort((a, b) => a.rank - b.rank)) {
      const { force: _f, movable: _m, ...block } = p;
      const solo = (k: BlockKind) => k === "check" || k === "fix";
      const same = merged.find((m) => m.day === day && m.courseId === p.courseId && !m.recordId && !p.recordId && !solo(m.kind) && !solo(p.kind));
      if (!same) {
        merged.push({ ...block, examKeys: [...p.examKeys] });
        continue;
      }
      same.minutes = Math.min(DAY_PLAN.mergedMax, same.minutes + p.minutes);
      same.examKeys = [...new Set([...same.examKeys, ...p.examKeys])];
      same.dueAt ??= p.dueAt;
      if (same.tone === "plain") same.tone = p.tone;
    }
  }

  // ---- how each exam stands ----
  for (const e of exams) {
    if (e.status === "needs_you") continue;
    const coveredDays = days.filter((d) => d < e.date && covered.has(`${d}|${e.courseId}`)).length;
    e.planned = merged.filter((b) => b.examKeys.includes(e.key)).length + coveredDays;
    const possible = e.wantedDays.filter((d) => d >= today).length;
    e.status = e.planned >= e.wanted ? "on_track" : e.planned >= Math.ceil(e.wanted / 2) || (possible < e.wanted && e.planned >= possible) ? "tight" : "behind";
  }

  // ---- does it fit? ----
  const studyDays = days.filter((d) => (budget.get(d) ?? 0) > 0);
  const want = [...placed.filter((p) => !p.recordId && p.kind !== "new" && p.kind !== "review"), ...leftOut].reduce((s, p) => s + p.minutes, 0);
  const have = studyDays.reduce((s, d) => s + (budget.get(d) ?? 0), 0);

  return {
    days: days.map((d) => ({ day: d, budget: budget.get(d) ?? 0, blocks: merged.filter((b) => b.day === d) })),
    exams: exams.map(({ wantedDays: _w, ...e }) => e),
    neededPerDay: studyDays.length ? Math.round(want / studyDays.length) : 0,
    budgetPerDay: studyDays.length ? Math.round(have / studyDays.length) : 0,
    leftOut: leftOut.map(({ force: _f, movable: _m, ...b }) => b),
  };
}

/** The blocks of a day that still need a quest written: homework, exam prep, reviews, something new. */
export const needsQuest = (b: PlannedBlock): boolean => !b.recordId && (b.kind === "homework" || b.kind === "exam" || b.kind === "review" || b.kind === "new");

export const KIND_LABEL: Record<BlockKind, string> = {
  fix: "Mistake review",
  homework: "Homework",
  check: "Placement check",
  exam: "Exam prep",
  review: "Review",
  new: "Something new",
  quest: "Quest",
};
