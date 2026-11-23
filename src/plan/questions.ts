// Which of the organization agent's open questions are worth the student's
// time now: the ones about courses with the nearest exam. Plain code, so the
// Now page and the StudyDesk chat ask about the same few. design/day-plan.md,
// "Quick answers".

import { daysBetween } from "../mastery/days";
import { setupTodo, type TodoItem } from "../onboarding/todo";
import type { SemesterDraft } from "../onboarding/types";
import type { KeyDate } from "../quests/types";
import { examLabel, shortDate } from "./day";

export const QUESTIONS = {
  /** Questions shown on Now at once. */
  shown: 2,
  /** Items the StudyDesk chat brings up by itself (the rest wait on the to-do list). */
  pushed: 2,
};

export type RankedQuestion = {
  /** The to-do sub-item key (or the item's key when it has no parts). */
  key: string;
  itemKey: string;
  courseId: string;
  course: string;
  text: string;
  /** Days until the course's next exam; null without one. */
  days: number | null;
  impact: string;
};

const courseOf = (item: TodoItem) => (item.key.startsWith("q-") ? item.key.slice(2) : null);

function nextExam(keyDates: KeyDate[], courseId: string, today: string): KeyDate | null {
  return keyDates.filter((k) => k.courseId === courseId && k.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null;
}

/** Open to-do items with questions, nearest exam first; ties keep the course order. */
export function rankedItems(draft: SemesterDraft, keyDates: KeyDate[], today: string): TodoItem[] {
  const order = new Map(draft.courses.map((c, i) => [c.id, i]));
  const days = (item: TodoItem) => {
    const c = courseOf(item);
    const k = c ? nextExam(keyDates, c, today) : null;
    return k ? daysBetween(today, k.date) : 9999;
  };
  return setupTodo(draft)
    .filter((t) => !t.done && courseOf(t))
    .sort((a, b) => days(a) - days(b) || (order.get(courseOf(a)!) ?? 0) - (order.get(courseOf(b)!) ?? 0));
}

/** The questions to show on Now, and how many others wait. */
export function quickQuestions(draft: SemesterDraft | null, keyDates: KeyDate[], today: string): { top: RankedQuestion[]; waiting: number } {
  if (!draft) return { top: [], waiting: 0 };
  const all: RankedQuestion[] = [];
  for (const item of rankedItems(draft, keyDates, today)) {
    const courseId = courseOf(item)!;
    const course = draft.courses.find((c) => c.id === courseId)?.name ?? courseId;
    const k = nextExam(keyDates, courseId, today);
    const d = k ? daysBetween(today, k.date) : null;
    const impact = k && d !== null && d <= 28 ? `Sharpens the prep for the ${examLabel(k)} on ${shortDate(k.date)}.` : `Helps StudyDesk plan ${course}.`;
    const parts = item.subs?.filter((s) => !s.done) ?? [];
    if (parts.length) for (const s of parts) all.push({ key: s.key, itemKey: item.key, courseId, course, text: s.text, days: d, impact });
    else all.push({ key: item.key, itemKey: item.key, courseId, course, text: item.body, days: d, impact });
  }
  const others = setupTodo(draft).filter((t) => !t.done && !courseOf(t)).length;
  return { top: all.slice(0, QUESTIONS.shown), waiting: all.length - Math.min(all.length, QUESTIONS.shown) + others };
}
