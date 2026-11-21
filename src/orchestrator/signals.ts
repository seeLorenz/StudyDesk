// What code knows about how the student is doing, and when the Orchestrator
// should speak first. design/orchestrator.md, "Notifications and check-ins".
//
// Agents judge, code counts: every trigger here is a plain rule on the stats,
// so it's testable and never guessed. Claude only puts the facts into words.

import { addDays, daysBetween } from "../mastery/days";
import { courseMastery, isRequired } from "../mastery/mastery";
import { replay } from "../mastery/replay";
import type { Attempt, Day, ReviewItem, SkillState } from "../mastery/types";
import { recommendWorkload } from "../onboarding/placement";
import { setupTodo } from "../onboarding/todo";
import type { SemesterDraft } from "../onboarding/types";
import type { ProblemPart, QuestRecord, Semester } from "../quests/types";
import type { Job, Notification, NotificationKind } from "./types";

/** Tunable numbers of the Orchestrator, in one place. */
export const ORCH_CONFIG = {
  /** "Too slow": actual time this much over planned, across the last few quests. */
  slowMargin: 0.3,
  slowQuests: 3,
  /** Pace is measured over this many days. */
  paceDays: 14,
  /** No pace verdicts before the student has studied on this many days. */
  minStudyDays: 3,
  /** "Off track": the minutes a course needs per study day exceed the recent pace by this share and this many minutes. */
  offTrackMargin: 0.25,
  offTrackMinGap: 10,
  /** Lapsed skills in one course that count as "slipping". */
  lapsesWarn: 2,
  /** "Ahead": the course needs at most this share of the recent pace. */
  aheadShare: 0.6,
  /** Ask the student to double-check an exam date this many days before it. */
  checkDateWithinDays: 14,
  /** A check-in of the same kind (and course) comes back at the earliest after this many days. */
  repeatDays: { too_slow: 3, off_track: 3, doing_great: 7 } as Partial<Record<NotificationKind, number>>,
  /** Memory: summarize once this many words aren't covered yet, and each new day. */
  memoryWords: 6000,
  /** Messages sent with every call, besides the summary. */
  historyMessages: 30,
};

const minutes = (secs: number) => secs / 60;

/** Planned against actual minutes over the last few quests with timed, handed-in problems. */
export function speed(records: QuestRecord[], today: Day, n = ORCH_CONFIG.slowQuests): { quests: number; planned: number; actual: number; ratio: number | null } {
  const rows = [...records]
    .filter((r) => r.quest.date <= today)
    .sort((a, b) => (a.quest.date < b.quest.date ? 1 : -1))
    .map((r) => {
      let planned = 0;
      let actual = 0;
      for (const part of r.quest.parts) {
        if (part.kind === "learn" || !r.progress.handedIn.includes(part.id)) continue;
        for (const p of (part as ProblemPart).problems) {
          const w = r.progress.work[p.id];
          if (!w || w.activeSeconds <= 0) continue;
          planned += p.expMinutes;
          actual += minutes(w.activeSeconds);
        }
      }
      return { planned, actual };
    })
    .filter((x) => x.planned > 0)
    .slice(0, n);
  const planned = rows.reduce((s, x) => s + x.planned, 0);
  const actual = rows.reduce((s, x) => s + x.actual, 0);
  return { quests: rows.length, planned: Math.round(planned), actual: Math.round(actual), ratio: planned > 0 ? actual / planned : null };
}

export type CourseSignal = {
  courseId: string;
  name: string;
  /** 0 to 1, toward the target grade, as the grading module computes it. */
  mastery: number;
  mastered: number;
  required: number;
  deadline: Day;
  /** Quest minutes per study day this course needs until its deadline. */
  neededPerDay: number;
  /** Minutes per study day spent on it lately; null before enough study days. */
  pacePerDay: number | null;
  status: "on_track" | "behind" | "ahead" | "unknown";
  lapsed: string[];
  openReviews: number;
};

/** Per course: mastery, what it needs per day, the recent pace, and a verdict. */
export function courseSignals(semester: Semester, attempts: Attempt[], reviews: ReviewItem[], today: Day): { signals: CourseSignal[]; states: Map<string, SkillState> } {
  const { states } = replay(semester.skills, attempts, reviews);
  const rec = recommendWorkload(semester, attempts, reviews, today);
  const from = addDays(today, -ORCH_CONFIG.paceDays);
  const recent = attempts.filter((a) => a.part !== "assessment" && a.activeSeconds > 0 && a.day >= from && a.day < today);
  const studyDays = new Set(recent.map((a) => a.day)).size;
  const courseOf = new Map(semester.skills.map((s) => [s.id, s.courseId]));
  const attemptOf = new Map(attempts.map((a) => [a.id, a]));
  const signals = semester.courses.map((c) => {
    const target = semester.targets.find((t) => t.courseId === c.id);
    const m = target ? courseMastery(semester.skills, states, target, today) : null;
    const r = rec.perCourse.find((p) => p.courseId === c.id)!;
    const secs = recent.filter((a) => courseOf.get(a.skillId) === c.id).reduce((s, a) => s + a.activeSeconds, 0);
    const pace = studyDays >= ORCH_CONFIG.minStudyDays ? minutes(secs) / studyDays : null;
    const need = r?.dailyMinutes ?? 0;
    let status: CourseSignal["status"] = "unknown";
    if (pace !== null && r && r.remainingSkills > 0) {
      if (need > pace * (1 + ORCH_CONFIG.offTrackMargin) && need - pace >= ORCH_CONFIG.offTrackMinGap) status = "behind";
      else if (need <= pace * ORCH_CONFIG.aheadShare) status = "ahead";
      else status = "on_track";
    } else if (r && r.remainingSkills === 0 && m && m.requiredCount > 0) status = "ahead";
    const lapsed = semester.skills.filter((s) => s.courseId === c.id && states.get(s.id)?.stage === "lapsed" && (!target || isRequired(s, target))).map((s) => s.name);
    const openReviews = reviews.filter((rv) => rv.status !== "resolved" && courseOf.get(attemptOf.get(rv.attemptId)?.skillId ?? "") === c.id).length;
    return {
      courseId: c.id,
      name: c.name,
      mastery: m?.value ?? 0,
      mastered: m?.masteredCount ?? 0,
      required: m?.requiredCount ?? 0,
      deadline: r?.deadline ?? today,
      neededPerDay: need,
      pacePerDay: pace === null ? null : Math.round(pace),
      status,
      lapsed,
      openReviews,
    };
  });
  return { signals, states };
}

export type Trigger = { key: string; kind: NotificationKind; courseId: string | null; facts: string };

export type TriggerInput = {
  semester: Semester;
  draft: SemesterDraft;
  attempts: Attempt[];
  reviews: ReviewItem[];
  records: QuestRecord[];
  jobs: Job[];
  sent: Notification[];
  today: Day;
};

/** Reasons to speak first, not yet sent. Code decides; Claude writes the words. */
export function checkinTriggers(input: TriggerInput): Trigger[] {
  const { semester, draft, attempts, reviews, records, jobs, sent, today } = input;
  const keys = new Set(sent.map((n) => n.key));
  const out: Trigger[] = [];
  const recently = (kind: NotificationKind, courseId: string | null) => {
    const days = ORCH_CONFIG.repeatDays[kind];
    if (!days) return false;
    return sent.some((n) => n.kind === kind && n.courseId === courseId && daysBetween(n.day, today) < days);
  };
  const add = (t: Trigger) => {
    if (keys.has(t.key) || out.some((x) => x.key === t.key) || recently(t.kind, t.courseId)) return;
    out.push(t);
  };

  // Needs: questions from the organization agent, finished jobs.
  for (const item of setupTodo(draft)) {
    // Dates and file conflicts are for the student to look over on the to-do list; exam dates get their own check-in below.
    if (item.done || item.key === "dates" || item.key === "conflicts") continue;
    const cid = item.key.startsWith("q-") ? item.key.slice(2) : null;
    // Keyed by the question itself: a re-read that asks the same thing doesn't ask again.
    add({ key: `todo:${item.key}:${hash(item.body)}`, kind: "needs_answer", courseId: cid, facts: item.chatPrompt });
  }
  for (const j of jobs) {
    if (j.status === "running") continue;
    add({ key: `job:${j.id}`, kind: "job_done", courseId: j.courseIds[0] ?? null, facts: j.status === "done" ? `Job finished: ${j.result.join("; ")}` : `Job failed: ${j.result.join("; ") || "the reading stopped"}. Offer to try again.` });
  }

  // Exam dates to double-check.
  for (const k of semester.keyDates) {
    const d = daysBetween(today, k.date);
    if (k.kind !== "exam" || d <= 0 || d > ORCH_CONFIG.checkDateWithinDays) continue;
    const c = semester.courses.find((x) => x.id === k.courseId);
    add({ key: `date:${k.courseId}:${k.title}:${k.date}`, kind: "check_date", courseId: k.courseId, facts: `${c?.name ?? k.courseId}: "${k.title}" is on ${k.date}, in ${d} days. Ask the student to confirm the date is still right.` });
  }

  if (!semester.courses.length) return out;

  // Speed.
  const sp = speed(records, today);
  if (sp.quests >= ORCH_CONFIG.slowQuests && sp.ratio !== null && sp.ratio > 1 + ORCH_CONFIG.slowMargin) {
    add({
      key: `slow:${today}`,
      kind: "too_slow",
      courseId: null,
      facts: `The last ${sp.quests} quests took ${sp.actual} min of problem time against ${sp.planned} min planned (${Math.round((sp.ratio - 1) * 100)}% longer). Planned times already adapt to the student's measured speed, so this is about getting faster or planning less: offer both.`,
    });
  }

  // Off track, slipping, and doing well, per course.
  const { signals, states } = courseSignals(semester, attempts, reviews, today);
  for (const s of signals) {
    const base = `${s.name}: ${Math.round(s.mastery * 100)}% toward the target grade (${s.mastered} of ${s.required} required skills), deadline ${s.deadline}`;
    if (s.status === "behind")
      add({ key: `off:${s.courseId}:${today}`, kind: "off_track", courseId: s.courseId, facts: `${base}. Needs about ${s.neededPerDay} quest minutes per study day; lately about ${s.pacePerDay}.${s.lapsed.length ? ` Lapsed: ${s.lapsed.join(", ")}.` : ""}` });
    else if (s.lapsed.length >= ORCH_CONFIG.lapsesWarn)
      add({ key: `off:${s.courseId}:${today}`, kind: "off_track", courseId: s.courseId, facts: `${base}. ${s.lapsed.length} skills lapsed (forgotten on review): ${s.lapsed.join(", ")}.` });
    else if (s.status === "ahead" && s.pacePerDay !== null)
      add({ key: `ahead:${s.courseId}:${today}`, kind: "doing_great", courseId: s.courseId, facts: `${base}. Ahead of plan: needs about ${s.neededPerDay} min per study day, studying about ${s.pacePerDay}.` });
  }
  for (const c of semester.courses) {
    const target = semester.targets.find((t) => t.courseId === c.id);
    for (const t of c.topics) {
      const sk = semester.skills.filter((s) => s.courseId === c.id && s.topicId === t.id && (!target || isRequired(s, target)));
      if (sk.length < 2) continue;
      if (sk.every((s) => ["mastered", "retained"].includes(states.get(s.id)?.stage ?? ""))) {
        add({ key: `topic:${c.id}:${t.id}`, kind: "doing_great", courseId: c.id, facts: `${c.name}: every skill of the topic "${t.name}" is mastered (${sk.length} skills).` });
      }
    }
  }

  // A short note after grading.
  const gradedToday = attempts.filter((a) => a.part !== "assessment" && dayOf(a.gradedAt) === today);
  if (gradedToday.length && !keys.has(`day:${today}`)) {
    const solved = gradedToday.filter((a) => a.verdict === "solved").length;
    const before = replay(semester.skills, attempts.filter((a) => !gradedToday.includes(a)), reviews).states;
    const newly = semester.skills.filter((s) => states.get(s.id)?.stage === "mastered" && before.get(s.id)?.stage !== "mastered").map((s) => s.name);
    const open = reviews.filter((r) => r.status !== "resolved" && gradedToday.some((a) => a.id === r.attemptId)).length;
    out.push({
      key: `day:${today}`,
      kind: "day_note",
      courseId: null,
      facts: `Graded today: ${solved} of ${gradedToday.length} problems solved.${newly.length ? ` Newly mastered: ${newly.join(", ")}.` : ""}${open ? ` ${open} mistakes wait in the mistake review.` : ""}`,
    });
  }
  return out;
}

const dayOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A short stable fingerprint of a text. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
