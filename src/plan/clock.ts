// When in the day a study block happens. Plain code: times have one right
// answer (design/guidelines.md, rule 3). design/day-plan.md, "On the clock".
//
// A day's busy time comes from the weekly timetable (school) and the student's
// calendar; study blocks go into what's left, after a free hour once school
// ends, with a short break between two blocks, and never after the hand-in
// time the nightly run grades from.

import type { TimetableEntry } from "../quests/types";

export const CLOCK = {
  /** First study time on a day without school. */
  freeDayStart: 10 * 60,
  /** Last minute a block may end: work is handed in before the nightly run at 22:00. */
  dayEnd: 21 * 60 + 30,
  /** The first hour after school stays free (lunch, getting home). */
  afterSchool: 60,
  /** Minutes between two blocks, and after any other appointment. */
  breakBetween: 10,
  /** Lessons closer together than this count as one stretch of school. */
  mergeGap: 30,
  /** A free window shorter than this isn't offered for a block. */
  minWindow: 10,
};

/** Minutes since midnight. */
export type Minute = number;

export type BusySpan = { start: Minute; end: Minute; title: string; kind: "school" | "busy" };
export type Window = { start: Minute; end: Minute };
export type CalendarSpan = { start: string; end: string; title: string };

export const toMinute = (hhmm: string): Minute => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const hhmm = (m: Minute): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

/** "1 h 20 min", "45 min". */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/**
 * The day's busy time, merged and sorted: lessons from the timetable (one
 * "school" stretch when they follow each other), fixed weekly slots, and the
 * calendar's timed events for that day.
 */
export function busySpans(timetable: TimetableEntry[], weekday: number, calendar: CalendarSpan[] = []): BusySpan[] {
  const school = timetable
    .filter((t) => t.weekday === weekday && t.kind !== "fixed")
    .map((t) => ({ start: toMinute(t.start), end: toMinute(t.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: BusySpan[] = [];
  for (const s of school) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < CLOCK.mergeGap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s, title: "School", kind: "school" });
  }
  const other: BusySpan[] = [
    ...timetable.filter((t) => t.weekday === weekday && t.kind === "fixed").map((t) => ({ start: toMinute(t.start), end: toMinute(t.end), title: t.title, kind: "busy" as const })),
    ...calendar.map((c) => ({ start: toMinute(c.start), end: toMinute(c.end), title: c.title, kind: "busy" as const })),
  ].filter((s) => s.end > s.start);
  for (const s of other) {
    // A calendar event inside school (the timetable is often in the calendar too) is school.
    if (out.some((x) => x.kind === "school" && s.start >= x.start && s.end <= x.end)) continue;
    out.push(s);
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * The free windows a study block may use: from the end of school (plus a free
 * hour) or from the morning on a free day, until the hand-in time, around
 * every other appointment (plus a short break after it). `from` cuts off what
 * has passed already.
 */
export function freeWindows(spans: BusySpan[], from: Minute | null = null): Window[] {
  const school = spans.filter((s) => s.kind === "school");
  let start = school.length ? Math.max(...school.map((s) => s.end)) + CLOCK.afterSchool : CLOCK.freeDayStart;
  if (from !== null) start = Math.max(start, from);
  const blocked = spans
    .filter((s) => s.kind === "busy")
    .map((s) => ({ start: s.start, end: s.end + CLOCK.breakBetween }))
    .sort((a, b) => a.start - b.start);
  const out: Window[] = [];
  let cursor = start;
  for (const b of blocked) {
    if (b.end <= cursor) continue;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, CLOCK.dayEnd) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < CLOCK.dayEnd) out.push({ start: cursor, end: CLOCK.dayEnd });
  return out.filter((w) => w.end - w.start >= CLOCK.minWindow);
}

export const freeMinutes = (windows: Window[]): number => windows.reduce((s, w) => s + (w.end - w.start), 0);

export type Placed<K> = { key: K; start: Minute | null; end: Minute | null };

/**
 * Puts blocks into the windows in the order given, each where it first fits,
 * with a break between two blocks. A block that fits nowhere gets no time
 * (the page offers it later or tomorrow instead).
 */
export function placeBlocks<K>(windows: Window[], blocks: Array<{ key: K; minutes: number }>): Array<Placed<K>> {
  const out: Array<Placed<K>> = [];
  let cursor = windows[0]?.start ?? 0;
  for (const b of blocks) {
    const minutes = Math.max(1, Math.round(b.minutes));
    let placed: Placed<K> = { key: b.key, start: null, end: null };
    for (const w of windows) {
      const start = Math.max(cursor, w.start);
      if (start + minutes <= w.end) {
        placed = { key: b.key, start, end: start + minutes };
        cursor = start + minutes + CLOCK.breakBetween;
        break;
      }
    }
    out.push(placed);
  }
  return out;
}

/** The next full five minutes, so "now" reads as a time a person would say. */
export const roundUp5 = (m: Minute): Minute => Math.ceil(m / 5) * 5;
