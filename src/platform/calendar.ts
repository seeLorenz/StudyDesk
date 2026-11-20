// The student's Google Calendar, read through their own claude.ai connector
// (the artifact `mcp` capability). Used by Start New Semester to import
// lectures and fixed commitments, and by quests to size today's quest from
// what is actually in the calendar today.

import { host } from "./host";
import type { Day } from "../mastery/types";

export const CALENDAR_SERVER = "Google Calendar";

export type CalendarEvent = {
  title: string;
  /** Local day and times in the viewer's time zone. All-day events have no times. */
  date: Day;
  weekday: number;
  start: string | null;
  end: string | null;
  recurring: boolean;
  location: string;
};

export type CalendarError = { code: string; message: string };

type RawTime = { dateTime?: string; date?: string };
type RawEvent = { summary?: string; start?: RawTime; end?: RawTime; recurringEventId?: string; location?: string; status?: string };

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "2026-11-20T00:00:00": local wall time without offset, as the connector expects. */
const wall = (day: Day, time = "00:00:00") => `${day}T${time}`;

/** Turns the connector's events into local, plain records. Cancelled events are dropped. */
export function toEvents(raw: RawEvent[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of raw) {
    if (e.status === "cancelled") continue;
    const title = (e.summary ?? "").trim() || "(no title)";
    if (e.start?.dateTime && e.end?.dateTime) {
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      if (isNaN(+s) || isNaN(+en)) continue;
      out.push({ title, date: localDay(s), weekday: s.getDay(), start: localTime(s), end: localDay(en) === localDay(s) ? localTime(en) : "23:59", recurring: !!e.recurringEventId, location: e.location ?? "" });
    } else if (e.start?.date) {
      const s = new Date(`${e.start.date}T12:00`);
      out.push({ title, date: e.start.date, weekday: s.getDay(), start: null, end: null, recurring: !!e.recurringEventId, location: e.location ?? "" });
    }
  }
  return out.sort((a, b) => (a.date + (a.start ?? "") < b.date + (b.start ?? "") ? -1 : 1));
}

async function mcp() {
  const c = host();
  return c?.use ? await c.use("mcp").catch(() => null) : null;
}

/** True when this view could reach the calendar connector (the viewer may still have to allow it). */
export async function calendarAvailable(): Promise<boolean> {
  return (await mcp()) !== null;
}

/** Calendars that are noise for a timetable: public holidays, contacts' birthdays, week numbers. */
const SKIP_CALENDAR = /#(holiday|contacts|weeknum)@/;

type RawCalendar = { id?: string; summary?: string };

/**
 * The calendars to read: every calendar the student owns or subscribed to
 * (a university's iCal feed, like a TUGonline timetable, is one of these),
 * not just the primary one. Falls back to the primary calendar when the list
 * can't be read (for example when the student hasn't allowed that tool yet).
 */
export async function calendarIds(m: NonNullable<Awaited<ReturnType<typeof mcp>>>, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await m.callTool(CALENDAR_SERVER, "list_calendars", { pageSize: 250 }, { signal });
    return pickCalendars(((res.payload ?? {}) as { calendars?: RawCalendar[] }).calendars ?? []);
  } catch (e) {
    if ((e as { code?: string })?.code === "cancelled") throw e;
    return ["primary"];
  }
}

/** Pure: the ids worth reading, primary first. */
export function pickCalendars(cals: RawCalendar[]): string[] {
  const ids = cals.map((c) => c.id ?? "").filter((id) => id && !SKIP_CALENDAR.test(id));
  return ids.length ? ids : ["primary"];
}

/** Every event from `from` for `days` days, across all the student's calendars. Rejects with a CalendarError. */
export async function readCalendar(from: Day, days: number, signal?: AbortSignal): Promise<CalendarEvent[]> {
  const m = await mcp();
  if (!m) throw { code: "unavailable", message: "The calendar can't be reached from this view." } satisfies CalendarError;
  const end = new Date(`${from}T12:00`);
  end.setDate(end.getDate() + days);
  const ids = await calendarIds(m, signal);
  const raw: RawEvent[] = [];
  let read = 0;
  let firstError: { code?: string } | null = null;
  for (const calendarId of ids) {
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < 5; page++) {
        const res = await m.callTool(
          CALENDAR_SERVER,
          "list_events",
          { ...(calendarId === "primary" ? {} : { calendarId }), startTime: wall(from), endTime: wall(localDay(end)), orderBy: "startTime", pageSize: 250, ...(pageToken ? { pageToken } : {}) },
          { signal },
        );
        const p = (res.payload ?? {}) as { events?: RawEvent[]; nextPageToken?: string };
        raw.push(...(p.events ?? []));
        pageToken = p.nextPageToken;
        if (!pageToken) break;
      }
      read++;
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "cancelled") throw { code: "cancelled", message: "Stopped." } satisfies CalendarError;
      // One unreadable calendar (a broken subscription) doesn't stop the others.
      firstError ??= err;
    }
  }
  if (!read) throw { code: firstError?.code ?? "unavailable", message: calendarErrorCopy(firstError?.code) } satisfies CalendarError;
  return dedupe(toEvents(raw));
}

/** The same event in two calendars (shared, or subscribed twice) counts once. */
export function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const k = `${e.title}|${e.date}|${e.start}|${e.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function calendarErrorCopy(code: string | undefined): string {
  switch (code) {
    case "server_not_connected":
      return "Google Calendar isn't connected to your Claude account. Connect it in claude.ai's connector settings, then try again.";
    case "needs_reauth":
      return "Your Google Calendar sign-in expired. Reconnect it in claude.ai's connector settings, then try again.";
    case "not_granted":
    case "approval_required":
      return "StudyDesk wasn't allowed to read your calendar. Allow it when asked, or in the artifact's permissions.";
    case "blocked_by_policy":
      return "Your organization doesn't allow StudyDesk to read the calendar.";
    default:
      return "The calendar couldn't be read just now. Try again in a moment.";
  }
}

/**
 * Weekly patterns: events that repeat on the same weekday and time, merged
 * into one line each. One-off events are kept separately (exams, trips).
 */
export function weeklyPattern(events: CalendarEvent[]): { weekly: Array<{ title: string; weekday: number; start: string; end: string; location: string; times: number }>; once: CalendarEvent[] } {
  const groups = new Map<string, { title: string; weekday: number; start: string; end: string; location: string; times: number }>();
  const once: CalendarEvent[] = [];
  for (const e of events) {
    if (!e.start || !e.end) {
      once.push(e);
      continue;
    }
    const k = `${e.title}|${e.weekday}|${e.start}|${e.end}`;
    const g = groups.get(k);
    if (g) g.times++;
    else groups.set(k, { title: e.title, weekday: e.weekday, start: e.start, end: e.end, location: e.location, times: 1 });
  }
  const weekly = [...groups.values()].filter((g) => g.times > 1 || events.some((e) => e.recurring && e.title === g.title && e.weekday === g.weekday && e.start === g.start));
  for (const e of events) if (e.start && !weekly.some((w) => w.title === e.title && w.weekday === e.weekday && w.start === e.start)) once.push(e);
  return { weekly, once };
}

/** Minutes of timed events on one day (overlaps counted once). */
export function busyMinutesFromEvents(events: CalendarEvent[], day: Day): number {
  const spans = events
    .filter((e) => e.date === day && e.start && e.end)
    .map((e) => [toMin(e.start!), toMin(e.end!)] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const [s, e] of spans) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curE > curS) total += curE - curS;
  return total;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
