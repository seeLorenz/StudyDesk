// Study times in the calendar. design/scheduled-runs.md, "Study times in the calendar".
//
// Claude picks when the student should do the quest: at night for tomorrow's,
// or on the page for a quest the page writes (or a replacement) for the rest of
// today. It knows that day's calendar and what the student said about
// themselves. The plan is saved as data/users/<uid>/calendarWant. Whoever can
// reach the calendar first writes the entries and records them in
// data/users/<uid>/calendarWritten: the page whenever it's open, or the
// student's own "StudyDesk calendar" task. A changed plan replaces the old
// entries; a quest finished early drops its entries still ahead.

import { ENTRY_MARK, type StudyEntry } from "../platform/calendar";
import type { Turn } from "../platform/claude";
import type { Day } from "../mastery/types";
import { partMinutes } from "./config";
import { allHandedIn } from "./handin";
import type { Quest, QuestRecord, TimetableEntry } from "./types";
import type { Ask } from "./write";

/** Window event when today's quest was written or a part handed in; from the Orchestrator (parts dismissed) it carries the saved record. */
export const QUEST_CHANGED = "studydesk:quest-changed";

export type CalendarWant = { day: Day; questId: string; key: string; entries: StudyEntry[]; instructions: string };
/** ids[i] is the event written for sigs[i]. */
export type CalendarWritten = { key: string; day: Day; ids: string[]; sigs?: string[]; taskSeenAt?: number };

/** `after`: the time now, when the quest is for today. */
export function timesTurns(o: { quest: Quest; courseName: string; weekday: string; events: string[]; notes: string; after?: string }): Turn[] {
  const when = o.after ? "today" : "tomorrow";
  return [
    {
      role: "user",
      content: `Pick when the student should study ${when} (${o.weekday}). StudyDesk puts these times into their Google Calendar.${o.after ? ` It's already ${o.after}, so only times after that.` : ""}

The quest: ${o.courseName}, about ${o.quest.plannedMinutes} min in total, in ${o.quest.parts.length} parts: ${o.quest.parts.map((p) => p.title).join("; ")}.

${when === "today" ? "Today" : "Tomorrow"} in their calendar:
${o.events.length ? o.events.join("\n") : "(nothing)"}

What the student has told StudyDesk about themselves:
${o.notes.trim() || "(nothing yet)"}

Rules: only free time; leave about 15 min between a commitment and study; one to three blocks, none shorter than 25 min, adding up to about the quest's time; follow anything the student said about when or where they like to study; otherwise prefer daytime and the gaps between commitments, and nothing after 22:00.
Reply with only the blocks, one per line, as HH:MM-HH:MM, each followed by where the student will study then if they've said where they study (for example "16:00-17:00 library"; a commitment just before it can decide which of their places), or "none" if there's no good time left.`,
    },
  ];
}

const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const pad = (n: number) => String(n).padStart(2, "0");

export type Block = { start: string; end: string; place?: string };

/** Pure: the blocks in a reply, sorted, valid and not overlapping (at most three), each with its place if named. */
export function parseTimes(reply: string): Block[] {
  const out: Block[] = [];
  for (const line of reply.split("\n")) {
    const ms = [...line.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)];
    for (const m of ms) {
      const [h1, m1, h2, m2] = m.slice(1).map(Number);
      if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
      // A place only on a line with one block: "16:00-17:00 library".
      const place = ms.length === 1 ? line.slice(m.index! + m[0].length).replace(/^[\s:,|–-]+/, "").trim().slice(0, 60) : "";
      const t = { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}`, ...(place && { place }) };
      if (hm(t.end) > hm(t.start)) out.push(t);
    }
  }
  out.sort((a, b) => hm(a.start) - hm(b.start));
  return out.filter((t, i) => i === 0 || hm(t.start) >= hm(out[i - 1].end)).slice(0, 3);
}

/**
 * Pure: what's fixed on that day: the calendar's timed events plus the weekly
 * timetable's slots (lectures not in the calendar still count), once each.
 */
export function busyLines(events: string[], timetable: TimetableEntry[], weekday: number): string[] {
  const slots = timetable.filter((t) => t.weekday === weekday).map((t) => `${t.start}-${t.end} ${t.title}`);
  return [...events, ...slots.filter((l) => !events.some((e) => e.slice(0, 11) === l.slice(0, 11)))].sort();
}

/**
 * Asks Claude for the study times. Code then drops any block that overlaps
 * something fixed or starts before `after`: Claude chooses, code checks. An
 * unusable reply gives none (the quest is fine without them).
 */
export async function pickTimes(ask: Ask, o: Parameters<typeof timesTurns>[0]): Promise<Block[]> {
  const busy = o.events.map((l) => /^(\d\d:\d\d)-(\d\d:\d\d)/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [hm(m[1]), hm(m[2])]);
  return parseTimes(await ask(timesTurns(o), { tier: "default" })).filter(
    (t) => (!o.after || t.start >= o.after) && !busy.some(([s, e]) => hm(t.start) < e && hm(t.end) > s),
  );
}

/**
 * Pure: the calendar entries for the picked times. Each one is an if-then plan:
 * its time, its place and the part to open first, the part the quest reaches
 * after the earlier blocks' minutes (`done`: part ids already handed in).
 */
export function studyEntries(o: { day: Day; times: Block[]; courseName: string; quest: Quest; done?: string[]; timeZone: string; url: string | null }): StudyEntry[] {
  let used = 0;
  return o.times.map(({ place, ...t }) => {
    let left = used;
    const i = o.quest.parts.findIndex((p) => !o.done?.includes(p.id) && (left -= partMinutes(p)) < 0);
    used += hm(t.end) - hm(t.start);
    const part = i < 0 ? "" : `open part ${i + 1}, "${o.quest.parts[i].title}"`;
    const plan = part && `${t.start}${place ? `, ${place}` : ""}: ${part}. `;
    return {
      day: o.day,
      ...t,
      title: `Study · ${o.courseName}${i < 0 ? "" : ` · part ${i + 1}`}`,
      description: `${ENTRY_MARK} ${plan}${short(o.quest.reason)}${o.url ? `\nOpen StudyDesk: ${o.url}` : ""}`,
      ...(place && { location: place }),
      timeZone: o.timeZone,
    };
  });
}

/** The quest's reason can run long; the entry keeps its first sentence. */
const short = (t: string) => (/^.{1,200}?[.!?](\s|$)/.exec(t)?.[0] ?? t.slice(0, 200)).trim();

const sig = (e: StudyEntry) => `${e.day} ${e.start}-${e.end} ${e.title}${e.location ? ` @ ${e.location}` : ""}`;

/** Pure: the plan to save, with the steps the calendar task follows (kept in the data, so an update can change them). */
export function calendarWant(day: Day, questId: string, entries: StudyEntry[]): CalendarWant {
  const sigs = entries.map(sig);
  const key = `${day}|${sigs.join("|")}`;
  const events = entries.map((e) => ({
    summary: e.title,
    description: e.description,
    ...(e.location && { location: e.location }),
    startTime: `${e.day}T${e.start}:00`,
    endTime: `${e.day}T${e.end}:00`,
    timeZone: e.timeZone,
    overrideReminders: [{ method: "popup", minutes: 10 }],
    notificationLevel: "NONE",
  }));
  const instructions = `1. Get the document calendarWritten from the same collection (it may not exist). Get the time now in milliseconds with \`date +%s%3N\`.
2. If its key is ${JSON.stringify(key)}, only update calendarWritten with {"taskSeenAt": <now>} and end.
3. Delete every event id in its "ids" with mcp__Google_Calendar__delete_event (notificationLevel "NONE"). An event that is already gone is fine.
4. Create each of these events with mcp__Google_Calendar__create_event, in this order, using exactly these arguments: ${JSON.stringify(events)}
5. Set calendarWritten to {"key": ${JSON.stringify(key)}, "day": "${day}", "ids": [the ids you created, in order], "sigs": ${JSON.stringify(sigs)}, "taskSeenAt": <now>}. Never touch any other event.`;
  return { day, questId, key, entries, instructions };
}

/**
 * Pure: what today's quest needs from the plan. "pick" when the plan isn't
 * for this quest (the page wrote it, or it replaced another); a trimmed plan
 * when the quest is finished and entries are still ahead; otherwise null.
 * Tomorrow's plan, once the nightly run made it, is never touched.
 */
export function planStep(want: CalendarWant | null, rec: QuestRecord | null, today: Day, now: string): "pick" | CalendarWant | null {
  if (!rec || (want && want.day > today)) return null;
  const done = allHandedIn(rec.quest, rec.progress);
  if (want?.day !== today || want.questId !== rec.quest.id) return done ? null : "pick";
  const left = want.entries.filter((e) => e.start <= now);
  return done && left.length < want.entries.length ? calendarWant(today, rec.quest.id, left) : null;
}

/**
 * Writes the plan if it isn't written yet: entries that stay keep their event,
 * the rest are deleted, new ones are created. Returns the new record, or null
 * when there's nothing to do. A failure part-way is saved with no key, so the
 * next try finishes the job.
 */
export async function applyWant(
  want: CalendarWant | null,
  written: CalendarWritten | null,
  today: Day,
  cal: { create: (e: StudyEntry) => Promise<string>; remove: (ids: string[]) => Promise<void> },
): Promise<CalendarWritten | null> {
  if (!want || want.key === written?.key || want.day < today) return null;
  const seen = written?.taskSeenAt ? { taskSeenAt: written.taskSeenAt } : {};
  const had = new Map((written?.sigs ?? []).map((s, i) => [s, written!.ids[i]]));
  const sigs = want.entries.map(sig);
  await cal.remove((written?.ids ?? []).filter((id, i) => !sigs.includes(written?.sigs?.[i] ?? "")));
  const ids: string[] = [];
  try {
    for (const e of want.entries) ids.push(had.get(sig(e)) ?? (await cal.create(e)));
  } catch {
    return { key: "", day: want.day, ids, sigs: sigs.slice(0, ids.length), ...seen };
  }
  return { key: want.key, day: want.day, ids, sigs, ...seen };
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
