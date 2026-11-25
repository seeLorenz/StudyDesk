// Expected time per problem and how much fits in a day.
// design/grading-and-mastery.md, "Measuring time and sizing quests".

import { CONFIG } from "./config";
import { median } from "./days";
import { sortAttempts } from "./replay";
import type { Attempt, Day, Skill } from "./types";

const timed = (attempts: Attempt[]) => sortAttempts(attempts).filter((a) => a.part !== "assessment" && a.activeSeconds > 0);

/**
 * How much slower than the organization agent's guesses this student is:
 * median of actual ÷ estimate over the last 20 timed problems, starting at
 * 2.0 and kept between 1 and 4.
 */
export function slownessFactor(skills: Skill[], attempts: Attempt[]): number {
  const est = new Map(skills.map((s) => [s.id, s.estMinutes]));
  const ratios = timed(attempts)
    .filter((a) => (est.get(a.skillId) ?? 0) > 0)
    .slice(-CONFIG.timing.slownessWindow)
    .map((a) => a.activeSeconds / 60 / est.get(a.skillId)!);
  const m = median(ratios);
  if (m === null) return CONFIG.timing.slownessStart;
  return Math.min(CONFIG.timing.slownessMax, Math.max(CONFIG.timing.slownessMin, m));
}

/** Expected minutes for one problem on this skill. */
export function expectedMinutes(skill: Skill, attempts: Attempt[], slowness: number): number {
  const own = timed(attempts).filter((a) => a.skillId === skill.id);
  if (own.length >= CONFIG.timing.ownMedianMinAttempts) {
    return median(own.slice(-CONFIG.timing.ownMedianWindow).map((a) => a.activeSeconds / 60))!;
  }
  return skill.estMinutes * slowness;
}

/** Active minutes finished per study day, oldest first. Days without work aren't study days. */
export function activeMinutesByDay(attempts: Attempt[]): Array<{ day: Day; minutes: number }> {
  const m = new Map<Day, number>();
  for (const a of timed(attempts)) m.set(a.day, (m.get(a.day) ?? 0) + a.activeSeconds / 60);
  return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, minutes]) => ({ day, minutes }));
}

export type Budget = { freeMinutes: number; paceMinutes: number | null; budgetMinutes: number };

/**
 * Minutes for today's quest: the smaller of 80% of free time and 1.2 × the
 * recent pace. A new student without a pace starts at half of their free time.
 * Only days before today count toward the pace. `readByDay`: reading minutes,
 * which count toward the pace like problem time.
 */
export function questBudget(dailyGoalMinutes: number, busyMinutes: number, attempts: Attempt[], today: Day, readByDay?: Map<Day, number>): Budget {
  const freeMinutes = Math.max(0, dailyGoalMinutes - busyMinutes);
  const byDay = new Map(activeMinutesByDay(attempts).map((d) => [d.day, d.minutes]));
  for (const [day, m] of readByDay ?? []) byDay.set(day, (byDay.get(day) ?? 0) + m);
  const days = [...byDay].filter(([day]) => day < today).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-CONFIG.budget.paceDays);
  const paceMinutes = days.length ? days.reduce((s, [, m]) => s + m, 0) / days.length : null;
  const raw =
    paceMinutes === null
      ? freeMinutes * CONFIG.budget.newStudentShare
      : Math.min(freeMinutes * CONFIG.budget.shareOfFreeTime, paceMinutes * CONFIG.budget.paceFactor);
  return { freeMinutes, paceMinutes, budgetMinutes: Math.round(raw) };
}
