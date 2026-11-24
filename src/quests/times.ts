// Study times in the calendar. design/scheduled-runs.md, "Study times in the calendar".
//
// At night Claude picks when the student should do tomorrow's quest (it knows
// tomorrow's calendar and what the student said about themselves). The plan is
// saved as data/users/<uid>/calendarWant. Whoever can reach the calendar first
// writes the entries and records them in data/users/<uid>/calendarWritten: the
// page whenever it's open, or the student's own "StudyDesk calendar" task. Both
// delete their earlier entries by id, so a changed plan replaces the old one.

import { ENTRY_MARK, type StudyEntry } from "../platform/calendar";
import type { Turn } from "../platform/claude";
import type { Day } from "../mastery/types";
import type { Quest } from "./types";
import type { Ask } from "./write";

export type CalendarWant = { day: Day; key: string; entries: StudyEntry[]; instructions: string };
export type CalendarWritten = { key: string; day: Day; ids: string[]; taskSeenAt?: number };

export function timesTurns(o: { quest: Quest; courseName: string; weekday: string; events: string[]; notes: string }): Turn[] {
  return [
    {
      role: "user",
      content: `Pick when the student should study tomorrow (${o.weekday}). StudyDesk puts these times into their Google Calendar.

Tomorrow's quest: ${o.courseName}, about ${o.quest.plannedMinutes} min in total, in ${o.quest.parts.length} parts: ${o.quest.parts.map((p) => p.title).join("; ")}.

Tomorrow in their calendar:
${o.events.length ? o.events.join("\n") : "(nothing)"}

What the student has told StudyDesk about themselves:
${o.notes.trim() || "(nothing yet)"}

Rules: only free time; leave about 15 min between a commitment and study; one to three blocks, none shorter than 25 min, adding up to about the quest's time; follow anything the student said about when or where they like to study; otherwise prefer daytime and the gaps between commitments, and nothing after 22:00.
Reply with only the blocks, one per line, as HH:MM-HH:MM.`,
    },
  ];
}

const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const pad = (n: number) => String(n).padStart(2, "0");

/** Pure: the blocks in a reply, sorted, valid and not overlapping (at most three). */
export function parseTimes(reply: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const m of reply.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)) {
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
    const t = { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}` };
    if (hm(t.end) > hm(t.start)) out.push(t);
  }
  out.sort((a, b) => hm(a.start) - hm(b.start));
  return out.filter((t, i) => i === 0 || hm(t.start) >= hm(out[i - 1].end)).slice(0, 3);
}

/** Asks Claude for tomorrow's study times. An unusable reply gives none (the quest is fine without them). */
export async function pickTimes(ask: Ask, o: Parameters<typeof timesTurns>[0]): Promise<{ start: string; end: string }[]> {
  return parseTimes(await ask(timesTurns(o), { tier: "default" }));
}

/** Pure: the plan to save, with the steps the calendar task follows (kept in the data, so an update can change them). */
export function calendarWant(o: { day: Day; times: { start: string; end: string }[]; courseName: string; reason: string; timeZone: string; url: string | null }): CalendarWant {
  const entries: StudyEntry[] = o.times.map((t) => ({
    day: o.day,
    ...t,
    title: `Study · ${o.courseName}`,
    description: `${ENTRY_MARK} ${o.reason}${o.url ? `\nOpen StudyDesk: ${o.url}` : ""}`,
    timeZone: o.timeZone,
  }));
  const key = `${o.day}|${entries.map((e) => `${e.start}-${e.end} ${e.title}`).join("|")}`;
  const events = entries.map((e) => ({
    summary: e.title,
    description: e.description,
    startTime: `${e.day}T${e.start}:00`,
    endTime: `${e.day}T${e.end}:00`,
    timeZone: e.timeZone,
    overrideReminders: [{ method: "popup", minutes: 10 }],
    notificationLevel: "NONE",
  }));
  const instructions = `1. Get the document calendarWritten from the same collection (it may not exist). Get the time now in milliseconds with \`date +%s%3N\`.
2. If its key is ${JSON.stringify(key)}, only update calendarWritten with {"taskSeenAt": <now>} and end.
3. Delete every event id in its "ids" with mcp__Google_Calendar__delete_event (notificationLevel "NONE"). An event that is already gone is fine.
4. If ${o.day} is already over in ${o.timeZone}, create nothing. Otherwise create each of these events with mcp__Google_Calendar__create_event, using exactly these arguments: ${JSON.stringify(events)}
5. Set calendarWritten to {"key": ${JSON.stringify(key)}, "day": "${o.day}", "ids": [the ids you created], "taskSeenAt": <now>}. Never touch any other event.`;
  return { day: o.day, key, entries, instructions };
}

/**
 * Writes the plan if it isn't written yet: deletes the earlier entries, creates
 * the new ones. Returns the new record, or null when there's nothing to do. A
 * failure part-way is saved with no key, so the next try starts clean.
 */
export async function applyWant(
  want: CalendarWant | null,
  written: CalendarWritten | null,
  today: Day,
  cal: { create: (e: StudyEntry) => Promise<string>; remove: (ids: string[]) => Promise<void> },
): Promise<CalendarWritten | null> {
  if (!want || want.key === written?.key || want.day < today) return null;
  const seen = written?.taskSeenAt ? { taskSeenAt: written.taskSeenAt } : {};
  await cal.remove(written?.ids ?? []);
  const ids: string[] = [];
  try {
    for (const e of want.entries) ids.push(await cal.create(e));
  } catch {
    return { key: "", day: want.day, ids, ...seen };
  }
  return { key: want.key, day: want.day, ids, ...seen };
}

/** What the student pastes into a new Claude Code session to let the nightly plan reach the calendar while StudyDesk is closed. */
export function calendarTaskSetup(url: string, timeZone: string, nightlyTime: string): string {
  const [h, m] = nightlyTime.split(":").map(Number);
  const at = (h * 60 + m + 90) % 1440;
  const inner = `You are StudyDesk's calendar task. Nobody reads this session, so work on your own and don't ask anything. 1. Load tools with ToolSearch "select:ArtifactData,mcp__Google_Calendar__create_event,mcp__Google_Calendar__delete_event". 2. ArtifactData action "get", url "${url}", collection "data/users/me", doc_id "calendarWant". If it doesn't exist, ArtifactData action "update" on doc "calendarWritten" (same collection) with {"taskSeenAt": <the time now in ms, from \`date +%s%3N\`>} and end. 3. Otherwise do exactly what its "instructions" field says, with ArtifactData on that same url and collection, then end.`;
  return `Set up a scheduled task for my StudyDesk. Name it "StudyDesk calendar". It runs every day at ${pad(Math.floor(at / 60))}:${pad(at % 60)} in ${timeZone}, starts a fresh session each time, and uses my Google Calendar connector. Its prompt is exactly:

${inner}

When it's created, fire it once to test it and tell me whether it worked.`;
}
