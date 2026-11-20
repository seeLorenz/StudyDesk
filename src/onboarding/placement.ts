// The first quest after setup (a placement check), and the daily workload
// recommended from its results. Plain code: Claude only writes the problems.
// design/onboarding.md, "The placement check".

import { CONFIG } from "../mastery/config";
import { addDays, daysBetween } from "../mastery/days";
import { isRequired } from "../mastery/mastery";
import { replay } from "../mastery/replay";
import { expectedMinutes, slownessFactor } from "../mastery/timing";
import type { Attempt, Day, ReviewItem, Skill } from "../mastery/types";
import { QUEST_CONFIG, partMinutes } from "../quests/config";
import { busyMinutes, weekdayOf } from "../quests/plan";
import type { ProblemPart, Quest, QuestProblem, Semester } from "../quests/types";
import type { Ask, PartWriter } from "../quests/write";
import { claudeWriter } from "../quests/write";
import type { Recommendation } from "./types";

export const PLACEMENT_CONFIG = {
  /** Fundamentals checked per course (those most other skills build on first). */
  fundamentalsPerCourse: 6,
  /** Problems per topic already taught. */
  perTaughtTopic: 2,
  /** The whole check never has more problems than this. */
  maxProblems: 30,
  /** Extra room in the recommendation for reviews and bad days. */
  buffer: 0.25,
  /** Without an exam date or semester end, plan over this many days. */
  defaultHorizonDays: 90,
};

const isMastered = (stage: string | undefined) => stage === "mastered" || stage === "retained";

/** Builds the placement check: one part per course, one short problem per skill. */
export function planPlacement(semester: Semester, attempts: Attempt[], reviews: ReviewItem[], today: Day, now = Date.now()): { quest: Quest; partCourse: Record<string, string>; left: number } {
  const { states } = replay(semester.skills, attempts, reviews);
  const slowness = slownessFactor(semester.skills, attempts);
  const minutes = (s: Skill) => Math.max(2, Math.round(expectedMinutes(s, attempts, slowness) * QUEST_CONFIG.lesson.problemShare));
  const dependents = (id: string) => semester.skills.filter((s) => s.prereqSkillIds.includes(id)).length;

  const picks = new Map<string, Skill[]>();
  let total = 0;
  let wanted = 0;
  for (const course of semester.courses) {
    const target = semester.targets.find((t) => t.courseId === course.id);
    const mine = semester.skills.filter((s) => s.courseId === course.id || (s.isFundamental && semester.skills.some((x) => x.courseId === course.id && x.prereqSkillIds.includes(s.id))));
    const open = mine.filter((s) => !isMastered(states.get(s.id)?.stage) && (!target || isRequired(s, target)));
    const fundamentals = open
      .filter((s) => s.isFundamental)
      .sort((a, b) => dependents(b.id) - dependents(a.id))
      .slice(0, PLACEMENT_CONFIG.fundamentalsPerCourse);
    const taught = course.topics.filter((t) => t.taught);
    const fromTopics = taught.flatMap((t) =>
      open
        .filter((s) => !s.isFundamental && s.topicId === t.id)
        .sort((a, b) => b.weight - a.weight || a.estMinutes - b.estMinutes)
        .slice(0, PLACEMENT_CONFIG.perTaughtTopic),
    );
    const list = [...fundamentals, ...fromTopics].filter((s) => ![...picks.values()].flat().some((x) => x.id === s.id));
    wanted += list.length;
    picks.set(course.id, list);
  }
  // Fit the cap: take from each course in turn so every course gets checked.
  const capped = new Map<string, Skill[]>([...picks.keys()].map((k) => [k, []]));
  for (let i = 0; total < PLACEMENT_CONFIG.maxProblems; i++) {
    let added = false;
    for (const [cid, list] of picks) {
      if (i < list.length && total < PLACEMENT_CONFIG.maxProblems) {
        capped.get(cid)!.push(list[i]);
        total++;
        added = true;
      }
    }
    if (!added) break;
  }

  let pn = 0;
  const parts: ProblemPart[] = [];
  const partCourse: Record<string, string> = {};
  for (const course of semester.courses) {
    const list = capped.get(course.id) ?? [];
    if (!list.length) continue;
    const id = `part${parts.length + 1}`;
    partCourse[id] = course.id;
    parts.push({
      kind: "practice",
      id,
      title: `${course.name}: where you stand`,
      gate: false,
      check: true,
      problems: list.map(
        (s): QuestProblem => ({
          id: `p${++pn}`,
          skillId: s.id,
          prompt: "",
          answerKey: "",
          hints: [],
          similarSolved: null,
          expMinutes: minutes(s),
          maxPoints: QUEST_CONFIG.practiceMaxPoints,
        }),
      ),
    });
  }
  const plannedMinutes = parts.reduce((s, p) => s + partMinutes(p), 0);
  const left = wanted - total;
  const notes = [
    "One short problem per skill: the basics your courses build on, and the topics already taught. Skip what you can't do; a gap here only tells StudyDesk where to start.",
    "A problem you solve without help counts as mastered right away. Then press Grade me early in the overview.",
  ];
  if (left > 0) notes.push(`${left} more ${left === 1 ? "skill comes" : "skills come"} up in the next quests.`);
  return {
    quest: {
      id: `qst_${today}_placement`,
      date: today,
      courseId: parts.length ? partCourse[parts[0].id] : semester.courses[0]?.id ?? "",
      budgetMinutes: plannedMinutes,
      plannedMinutes,
      reason: "Placement check: find out where you stand in each course, so StudyDesk can plan the right amount each day.",
      notes,
      parts,
      createdAt: now,
    },
    partCourse,
    left,
  };
}

/** Writes each part with its own course's context (language, names). */
export function placementWriter(semester: Semester, quest: Quest, partCourse: Record<string, string>, ask: Ask, fallback: PartWriter | null): PartWriter {
  const forPart = (partId: string) => (fallback ? fallback : claudeWriter(semester, { ...quest, courseId: partCourse[partId] ?? quest.courseId }, [], ask));
  return {
    learn: (q, p) => forPart(p.id).learn(q, p),
    lesson: (q, p) => forPart(p.id).lesson(q, p),
    practice: (q, p) => forPart(p.id).practice(q, p),
    assignment: (q, p) => forPart(p.id).assignment(q, p),
  };
}

/** Study days from tomorrow to `end`, counting weekdays with a study goal. */
export function studyDaysUntil(studyGoal: number[], today: Day, end: Day): number {
  let n = 0;
  for (let d = addDays(today, 1); d <= end; d = addDays(d, 1)) if ((studyGoal[weekdayOf(d)] ?? 0) > 0) n++;
  return n;
}

/**
 * The daily workload to reach every target grade: the remaining clean solves
 * on required skills, at the student's measured speed, spread over the study
 * days until each course's last exam, plus a buffer for reviews.
 */
export function recommendWorkload(semester: Semester, attempts: Attempt[], reviews: ReviewItem[], today: Day): Recommendation {
  const { states } = replay(semester.skills, attempts, reviews);
  const slowness = slownessFactor(semester.skills, attempts);
  const goal = semester.studyGoal.some((m) => m > 0) ? semester.studyGoal : [0, 60, 60, 60, 60, 60, 0];
  const perCourse: Recommendation["perCourse"] = [];
  for (const course of semester.courses) {
    const target = semester.targets.find((t) => t.courseId === course.id);
    const skills = semester.skills.filter((s) => s.courseId === course.id && (!target || isRequired(s, target)));
    let minutesNeeded = 0;
    let remainingSkills = 0;
    for (const s of skills) {
      const st = states.get(s.id);
      if (isMastered(st?.stage)) continue;
      remainingSkills++;
      const solves = Math.max(1, (s.streakTarget ?? CONFIG.defaultStreakTarget) - (st?.streak ?? 0));
      minutesNeeded += solves * expectedMinutes(s, attempts, slowness);
      if (!st || st.stage === "new") minutesNeeded += QUEST_CONFIG.lesson.readMinutes;
    }
    const exams = semester.keyDates.filter((k) => k.courseId === course.id && k.date > today).map((k) => k.date).sort();
    const deadline = exams[exams.length - 1] ?? (semester.endDate && semester.endDate > today ? semester.endDate : addDays(today, PLACEMENT_CONFIG.defaultHorizonDays));
    const studyDays = Math.max(1, studyDaysUntil(goal, today, deadline));
    const dailyMinutes = Math.ceil((minutesNeeded * (1 + PLACEMENT_CONFIG.buffer)) / studyDays);
    perCourse.push({ courseId: course.id, remainingSkills, minutesNeeded: Math.round(minutesNeeded), deadline, studyDays, dailyMinutes });
  }
  const daily = Math.max(15, Math.ceil(perCourse.reduce((s, c) => s + c.dailyMinutes, 0) / 15) * 15);
  // Quests get 80% of free time, so the goal must leave room for that, plus lectures.
  const studyGoal = goal.map((m, wd) => (m > 0 ? Math.ceil((busyMinutes(semester.timetable, wd) + daily / CONFIG.budget.shareOfFreeTime) / 15) * 15 : 0));
  return { perCourse, dailyQuestMinutes: daily, studyGoal };
}

/** Days until a date, for display. */
export const daysUntil = (today: Day, day: Day) => daysBetween(today, day);
