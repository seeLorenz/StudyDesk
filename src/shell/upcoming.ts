// What's coming up: every hand-in, exam and quiz in the next weeks, from the
// semester's homework and key dates. Plain code (dates have one right answer).

import { addDays, daysBetween } from "../mastery/days";
import type { Day } from "../mastery/types";
import type { Semester } from "../quests/types";

export type UpcomingItem = {
  id: string;
  kind: "homework" | "exam" | "quiz";
  courseId: string;
  courseName: string;
  title: string;
  date: Day;
  /** "HH:MM" when the item has a time (hand-ins do). */
  time: string | null;
  /** Whole days from today; 0 = today. */
  inDays: number;
};

export const UPCOMING_DAYS = 42;

export function upcoming(semester: Pick<Semester, "courses" | "assignments" | "keyDates">, today: Day, days = UPCOMING_DAYS): UpcomingItem[] {
  const last = addDays(today, days);
  const name = (id: string) => semester.courses.find((c) => c.id === id)?.name ?? id;
  const items: UpcomingItem[] = [];
  for (const a of semester.assignments) {
    const [date, time] = a.dueAt.split("T");
    items.push({ id: `a:${a.id}`, kind: "homework", courseId: a.courseId, courseName: name(a.courseId), title: a.title, date, time: time ? time.slice(0, 5) : null, inDays: 0 });
  }
  for (const k of semester.keyDates) {
    items.push({ id: `k:${k.courseId}:${k.date}:${k.title}`, kind: k.kind, courseId: k.courseId, courseName: name(k.courseId), title: k.title, date: k.date, time: null, inDays: 0 });
  }
  return items
    .filter((i) => i.date >= today && i.date <= last)
    .map((i) => ({ ...i, inDays: daysBetween(today, i.date) }))
    .sort((a, b) => (a.date === b.date ? (a.time ?? "99").localeCompare(b.time ?? "99") : a.date < b.date ? -1 : 1));
}

/** "today", "tomorrow", "in 5 days". */
export function countdown(inDays: number): string {
  if (inDays <= 0) return "today";
  if (inDays === 1) return "tomorrow";
  return `in ${inDays} days`;
}
