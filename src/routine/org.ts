// The organization agent's nightly work. design/scheduled-runs.md.
//
// Shallow run (every night, all courses in one call): look for anything that
// changed (dates, new homework sheets, a course page that moved) and answer in
// the Orchestrator's own typed operations, so code checks and applies them the
// same way as a change the student asked for. It also picks, per course, the
// date of the next deep sweep.
//
// Deep sweep (a course whose sweep date has come): the full setup run of that
// course again, with web access, as when the course was first set up.
//
// Claude decides what changed; code checks every operation (changes.ts).

import { addDays, daysBetween } from "../mastery/days";
import type { Day } from "../mastery/types";
import { isRealDay } from "../orchestrator/changes";
import type { Operation } from "../orchestrator/types";
import type { Turn } from "../platform/claude";
import type { Profile, SemesterDraft } from "../onboarding/types";
import { parseSections } from "../quests/write";

/** What the organization agent remembers between nights, per course. Kept in the routine document. */
export type OrgCourseState = {
  /** The next deep sweep. Null until the first shallow run sets one. */
  nextDeepSweep: Day | null;
  lastDeepSweep: Day | null;
  lastShallow: Day | null;
};

export type OrgState = Record<string, OrgCourseState>;

export const ORG_CONFIG = {
  /** A deep sweep is never further away than this, so no course goes unread for long. */
  maxDaysBetweenSweeps: 28,
  /** Nor sooner than this after the last one. */
  minDaysBetweenSweeps: 3,
  /** The first sweep after setup, when the shallow run doesn't pick a date. */
  firstSweepAfterDays: 7,
  maxQuestionsPerCourse: 3,
};

/** Operations the nightly run may apply on its own. Everything else waits for the student. */
export const NIGHTLY_OPS = new Set(["set_exam_date", "set_due", "add_homework", "add_fact", "set_language"]);

export type ShallowResult = {
  ops: Operation[];
  questions: Array<{ courseId: string; text: string }>;
  nextSweep: Record<string, Day>;
  note: string;
  /** Operations that were left out, and why (for the run log). */
  skipped: string[];
};

const fmtDue = (s: string) => s.replace("T", " ");

export function shallowTurns(draft: SemesterDraft, profile: Profile, org: OrgState, today: Day): Turn[] {
  const courses = draft.courses.map((c) => {
    const r = draft.results[c.id];
    const st = org[c.id];
    const homework = (r?.assignments ?? []).map((a) => `  - ${a.title} (id ${a.id}), due ${fmtDue(a.dueAt)}, ${a.tasks.length} tasks`).join("\n") || "  - none known";
    const dates = (r?.keyDates ?? []).map((k) => `  - ${k.kind} "${k.title}" on ${k.date}`).join("\n") || "  - none known";
    const facts = draft.facts.filter((f) => f.courseId === c.id).map((f) => `  - "${f.text}"`).join("\n") || "  - none";
    const files = draft.uploads.filter((u) => u.courseId === c.id).map((u) => `  - ${u.fileName}${u.studentNote ? ` (${u.studentNote})` : ""}`).join("\n") || "  - none";
    const skills = (r?.skills ?? []).map((s) => s.name).slice(0, 60).join("; ");
    return `### ${c.name} (id ${c.id}, short "${c.short}")
Taught in: ${c.teachingLanguage || "unknown"}
Summary from setup: ${r?.summary ?? "not read yet"}
Homework StudyDesk knows:
${homework}
Exams and quizzes StudyDesk knows:
${dates}
What the student said:
${facts}
Files the student gave:
${files}
Skills (names): ${skills || "none yet"}
Last deep sweep: ${st?.lastDeepSweep ?? "only the setup reading"}; next planned: ${st?.nextDeepSweep ?? "none yet"}${draft.sweepDates?.[c.id] ? `; the student asked for one on ${draft.sweepDates[c.id]} (keep that date)` : ""}`;
  });

  const user = `You are StudyDesk's organization agent, doing tonight's short check (${today}) for one student. Nobody reads this answer except code. You can't ask the student anything now.

The student: ${profile.level}, ${profile.program || "program unknown"}, year ${profile.year || "?"}, at ${profile.school || "an unknown school"} (${profile.country || "country unknown"}). Semester "${draft.name}", ${draft.startDate} to ${draft.endDate}.

## Your job tonight
For each course, check whether anything StudyDesk relies on has changed or is missing: a new homework sheet, a moved deadline, an exam date announced or moved. Use the web when the course has public pages (search the course name with the school and semester). Don't invent anything: only report what you found in a source, and say which.

Then pick, per course, the date of the next deep sweep (a full re-reading of the course's materials and pages): sooner when an exam phase or a new block of material is near, later in quiet weeks. Between ${ORG_CONFIG.minDaysBetweenSweeps} and ${ORG_CONFIG.maxDaysBetweenSweeps} days from today.

## Courses
${courses.join("\n\n")}

## Reply format (exactly these sections)
=== CHANGES ===
A JSON array of operations, [] when nothing changed. Only these:
- {"op":"set_exam_date","course":"<id>","title":"<title>","date":"YYYY-MM-DD","kind":"exam"|"quiz","source":"<url or where>"}
- {"op":"set_due","course":"<id>","homework":"<homework id or title>","dueAt":"YYYY-MM-DDTHH:MM","source":"..."}
- {"op":"add_homework","course":"<id>","title":"...","dueAt":"YYYY-MM-DDTHH:MM","tasks":[{"label":"1a","text":"<task word for word>","skill":"<skill name from the list>","points":null}],"source":"..."}
- {"op":"add_fact","course":"<id>","text":"<what you found, one sentence, with the source>"}
=== QUESTIONS ===
At most ${ORG_CONFIG.maxQuestionsPerCourse} per course, only what the student must answer and you couldn't find. One per line: "<course id>: <question>". Write "none" when there is nothing.
=== NEXT DEEP SWEEP ===
One line per course: "<course id>: YYYY-MM-DD".
=== NOTE ===
One or two plain sentences on what you checked and found, for the student's log.`;
  return [{ role: "user", content: user }];
}

export function parseShallow(reply: string, draft: SemesterDraft, today: Day): ShallowResult {
  const s = parseSections(reply);
  const errors: string[] = [];
  for (const key of ["CHANGES", "QUESTIONS", "NEXT DEEP SWEEP", "NOTE"]) if (!s.has(key)) errors.push(`The section === ${key} === is missing.`);
  let raw: unknown = [];
  const changes = (s.get("CHANGES") ?? "[]").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    raw = JSON.parse(changes || "[]");
  } catch {
    errors.push("CHANGES is not a JSON array.");
  }
  if (!Array.isArray(raw)) errors.push("CHANGES is not a JSON array.");
  if (errors.length) throw new Error(errors.join(" "));

  const ids = new Set(draft.courses.map((c) => c.id));
  const ops: Operation[] = [];
  const skipped: string[] = [];
  for (const o of raw as Array<Record<string, unknown>>) {
    const op = String(o?.op ?? "");
    if (!NIGHTLY_OPS.has(op)) {
      skipped.push(`${op || "an operation"} is left for the student to decide`);
      continue;
    }
    const { source, ...rest } = o;
    ops.push({ ...rest, op, ...(source ? { why: String(source) } : {}) } as Operation);
  }

  const questions: ShallowResult["questions"] = [];
  for (const line of (s.get("QUESTIONS") ?? "").split("\n")) {
    const m = /^\s*[-*]?\s*([^:]+):\s*(.+)$/.exec(line);
    if (!m || /^none$/i.test(line.trim())) continue;
    const cid = m[1].trim();
    if (!ids.has(cid)) continue;
    if (questions.filter((q) => q.courseId === cid).length >= ORG_CONFIG.maxQuestionsPerCourse) continue;
    questions.push({ courseId: cid, text: m[2].trim() });
  }

  const nextSweep: Record<string, Day> = {};
  for (const line of (s.get("NEXT DEEP SWEEP") ?? "").split("\n")) {
    const m = /^\s*[-*]?\s*([^:]+):\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (!m || !ids.has(m[1].trim()) || !isRealDay(m[2])) continue;
    nextSweep[m[1].trim()] = clampSweep(m[2], today);
  }
  return { ops, questions, nextSweep, note: (s.get("NOTE") ?? "").trim(), skipped };
}

/** Keeps a sweep date inside the allowed window. Pure, tested. */
export function clampSweep(day: Day, today: Day): Day {
  const d = daysBetween(today, day);
  if (d < ORG_CONFIG.minDaysBetweenSweeps) return addDays(today, ORG_CONFIG.minDaysBetweenSweeps);
  if (d > ORG_CONFIG.maxDaysBetweenSweeps) return addDays(today, ORG_CONFIG.maxDaysBetweenSweeps);
  return day;
}

/** Courses whose deep sweep is due tonight. Pure, tested. */
export function sweepsDue(draft: SemesterDraft, org: OrgState, today: Day): string[] {
  return draft.courses
    .filter((c) => c.setupStatus === "ready" || c.setupStatus === "needs_check")
    .filter((c) => {
      const asked = draft.sweepDates?.[c.id];
      const last = org[c.id]?.lastDeepSweep ?? null;
      if (asked && asked <= today && (!last || last < asked)) return true;
      const next = org[c.id]?.nextDeepSweep;
      return !!next && next <= today;
    })
    .map((c) => c.id);
}

/** The organization state after tonight: sweep dates moved on, run days recorded. Pure, tested. */
export function nextOrgState(org: OrgState, draft: SemesterDraft, today: Day, shallow: ShallowResult | null, swept: string[]): OrgState {
  const out: OrgState = {};
  for (const c of draft.courses) {
    const prev = org[c.id] ?? { nextDeepSweep: null, lastDeepSweep: null, lastShallow: null };
    const asked = draft.sweepDates?.[c.id];
    const picked = asked && asked > today ? asked : shallow?.nextSweep[c.id] ?? null;
    let next = prev.nextDeepSweep;
    if (swept.includes(c.id)) next = picked ?? addDays(today, ORG_CONFIG.firstSweepAfterDays);
    else if (picked) next = picked;
    else if (!next) next = addDays(today, ORG_CONFIG.firstSweepAfterDays);
    out[c.id] = {
      nextDeepSweep: next,
      lastDeepSweep: swept.includes(c.id) ? today : prev.lastDeepSweep,
      lastShallow: shallow ? today : prev.lastShallow,
    };
  }
  return out;
}
