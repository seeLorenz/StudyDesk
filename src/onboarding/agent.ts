// The setup conversation: the Orchestrator's Start New Semester part.
//
// The student talks, pastes and drops files. Claude asks the questions and
// keeps the semester sheet up to date through one page tool (update_sheet),
// reads the student's Google Calendar on request (read_calendar), and starts
// the setup run when the student confirms (start_setup). Everything Claude
// changes is visible and editable in the sheet beside the chat.

import { courseFileList, filesOf, unsortedList } from "../lib/keep";
import { uid } from "../chat/types";
import type { Turn } from "../platform/claude";
import type { TimetableEntry } from "../quests/types";
import type { DraftCourse, Profile, SemesterDraft, SetupMessage } from "./types";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function setupReady(d: SemesterDraft): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!d.courses.some((c) => c.targetGrade !== null)) missing.push("at least one course with a target grade");
  if (!d.studyGoal.some((m) => m > 0)) missing.push("a study goal for at least one day");
  return { ok: missing.length === 0, missing };
}

/** The sheet as Claude sees it each turn: small and plain. */
export function sheetSnapshot(d: SemesterDraft, p: Profile, today: string, cloudSessions: "on" | "off" | "unknown" = "unknown"): string {
  const slots = d.timetable.map((t, i) => `#${i} ${DAY[t.weekday]} ${t.start}-${t.end} ${t.kind}: ${t.title}${t.courseId ? ` [course ${t.courseId}]` : ""}`);
  return JSON.stringify(
    {
      today,
      profile: { level: p.level, school: p.school, country: p.country, gradeScale: p.gradeScale, program: p.program, year: p.year },
      semester: { name: d.name, startDate: d.startDate, endDate: d.endDate },
      courses: d.courses.map((c) => ({
        id: c.id,
        name: c.name,
        short: c.short,
        credits: c.credits,
        targetGrade: c.targetGrade,
        facts: d.facts.filter((f) => f.courseId === c.id).map((f) => f.text),
        files: courseFileList(d.uploads, d.zips, c.id),
      })),
      unsortedFiles: unsortedList(d.uploads, d.zips),
      generalFacts: d.facts.filter((f) => !f.courseId).map((f) => f.text),
      weeklySlots: slots,
      studyGoalMinutes: Object.fromEntries([1, 2, 3, 4, 5, 6, 0].map((wd) => [DAY[wd], d.studyGoal[wd] ?? 0])),
      calendarImported: !!d.calendarImportedAt,
      readyToStart: setupReady(d),
      setupDone: d.setupStep === "done",
      cloudSessions,
    },
    null,
    1,
  );
}

export function rules(returning: boolean): string {
  return `You are StudyDesk's Orchestrator, the one assistant a student talks to. Right now you are setting up their ${returning ? "new " : ""}semester in a chat. Beside the chat the student sees the semester sheet, which you fill with the update_sheet tool and which they can also edit by hand.

What setup needs (in this order, but follow the student's lead):
1. Who they are${returning ? " (already known from last semester: just confirm if anything changed)" : ""}: school or university, country, the grade scale used there (name, best grade, worst grade, e.g. Austria: 1 best, 5 worst), program or school type, and year. Work the grade scale out yourself from the country and school; ask only if unsure.
2. The semester: a name (e.g. "WS 2026/27") and start and end dates. Propose them yourself from today's date and the school system.
3. Their courses: they may drop a timetable screenshot, a course list, or just type. Pull out course names, short names, credits, and weekly lecture and exercise times.
4. For each course: the target grade (required) on their scale, then optionally how it's graded, known exam and hand-in dates, and materials. Ask for materials in order of value: the syllabus or course overview first, then homework sheets, past exams, slides. Many files at once is fine.
5. Their time: how much they want to study per weekday, lectures included. Their Google Calendar is the main source for lectures and fixed commitments: offer to import it, and when they agree or ask, call read_calendar, then turn the repeating events into weekly slots (lecture or exercise linked to a course, or fixed for jobs, sport and the like). Exams found in the calendar become facts of their course.
6. When readyToStart is ok, show a short summary of what's set up and ask if you should start. Only when they say yes, call start_setup.
   Before that, if cloudSessions is "off": remind them once, in one or two lines, that turning on Claude Code on the web (the card above the chat explains how) lets setup look their courses up online and keep working with the page closed. Starting without it is fine.

How to talk:
- Short messages, one or two questions at a time, friendly and plain. Use real line breaks and short lists, not walls of text.
- Reply in the language the student writes in.
- Never invent courses, dates, grades or numbers. If something is unclear, ask.
- Anything can be skipped and added later. If they want to skip, move on.
- Setup counts as done with one course that has a target grade and a study goal; everything else is optional.

How to use update_sheet:
- Record what you learn right away, in the same reply, before you answer. Several changes go in one call.
- Things the student says about a course (dates, how it's graded, what a file is) go into facts, word for word as they said them.
- Files the student drops are saved by the page as unsortedFiles. Assign each one to its course with a short note on what it is (from what they said, or what you can see).
- The sheet below each message is the current state: trust it over your memory, the student may have edited it.

After setup (setupDone is true):
- The student works through a short to-do list below the chat, one item at a time; an item's questions appear in the chat as your message. Record every answer right away as a fact of its course, word for word, and assign new files to their course.
- Don't ask the next item yourself; when one is answered, say in one line that they can tick it off.
- Once answers or files changed something, offer to update those courses. Only when they say yes, call start_setup: it re-reads just the courses that changed.`
}

const SHEET_SCHEMA = {
  type: "object",
  properties: {
    profile: {
      type: "object",
      description: "Only the fields that changed.",
      properties: {
        level: { enum: ["school", "university"] },
        school: { type: "string" },
        country: { type: "string" },
        gradeScale: { type: "object", properties: { name: { type: "string" }, best: { type: "number" }, worst: { type: "number" } }, required: ["name", "best", "worst"] },
        program: { type: "string" },
        year: { type: "string" },
      },
    },
    semester: { type: "object", properties: { name: { type: "string" }, startDate: { type: "string", description: "YYYY-MM-DD" }, endDate: { type: "string", description: "YYYY-MM-DD" } } },
    addCourses: { type: "array", items: { type: "object", properties: { name: { type: "string" }, short: { type: "string" }, credits: { type: "number" }, targetGrade: { type: "number" } }, required: ["name"] } },
    updateCourses: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, short: { type: "string" }, credits: { type: "number" }, targetGrade: { type: "number" } }, required: ["id"] } },
    removeCourseIds: { type: "array", items: { type: "string" } },
    addSlots: {
      type: "array",
      description: "Weekly slots. course: a course id or exact course name (for lectures and exercises).",
      items: { type: "object", properties: { weekday: { enum: DAY }, start: { type: "string" }, end: { type: "string" }, kind: { enum: ["lecture", "exercise", "fixed"] }, title: { type: "string" }, course: { type: "string" } }, required: ["weekday", "start", "end", "kind", "title"] },
    },
    removeSlots: { type: "array", description: "Slot numbers (#n) from weeklySlots.", items: { type: "number" } },
    facts: { type: "array", items: { type: "object", properties: { course: { type: "string", description: "Course id or name; omit for general facts." }, text: { type: "string" } }, required: ["text"] } },
    files: { type: "array", description: "Assign files to courses: uploadId is a file's id, or a zip's id (zip_…) for all files of that zip.", items: { type: "object", properties: { uploadId: { type: "string" }, course: { type: "string" }, note: { type: "string" } }, required: ["uploadId", "course"] } },
    studyGoalMinutes: { type: "object", description: "Minutes per weekday, lectures included, e.g. {Mon: 180, Sun: 0}. Only days that change.", properties: Object.fromEntries(DAY.map((d) => [d, { type: "number" }])) },
  },
} as const;

const str = (x: unknown) => (typeof x === "string" ? x.trim() : x === undefined || x === null ? "" : String(x).trim());
const num = (x: unknown) => {
  const n = typeof x === "number" ? x : Number(String(x ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const hhmm = (s: string) => {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(s);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

/** Applies one update_sheet call. Pure: returns the new sheet and what to tell Claude. */
export function applySheetUpdate(d: SemesterDraft, p: Profile, input: Record<string, unknown>, now = Date.now()): { draft: SemesterDraft; profile: Profile; result: string } {
  const notes: string[] = [];
  let draft: SemesterDraft = { ...d, courses: [...d.courses], timetable: [...d.timetable], facts: [...d.facts], uploads: [...d.uploads], studyGoal: [...d.studyGoal] };
  let profile = { ...p };
  const findCourse = (ref: unknown): DraftCourse | undefined => {
    const r = str(ref).toLowerCase();
    if (!r) return undefined;
    return draft.courses.find((c) => c.id.toLowerCase() === r) ?? draft.courses.find((c) => c.name.toLowerCase() === r) ?? draft.courses.find((c) => c.short.toLowerCase() === r);
  };
  const inScale = (g: number | null) => {
    if (g === null) return null;
    const lo = Math.min(profile.gradeScale.best, profile.gradeScale.worst);
    const hi = Math.max(profile.gradeScale.best, profile.gradeScale.worst);
    if (g < lo || g > hi) {
      notes.push(`Target ${g} is outside the scale ${profile.gradeScale.name}; not set.`);
      return null;
    }
    return g;
  };

  const pr = input.profile as Record<string, unknown> | undefined;
  if (pr && typeof pr === "object") {
    if (pr.level === "school" || pr.level === "university") profile.level = pr.level;
    for (const k of ["school", "country", "program", "year"] as const) if (pr[k] !== undefined) profile[k] = str(pr[k]);
    const gs = pr.gradeScale as Record<string, unknown> | undefined;
    if (gs && num(gs.best) !== null && num(gs.worst) !== null && num(gs.best) !== num(gs.worst)) profile.gradeScale = { name: str(gs.name) || "Grades", best: num(gs.best)!, worst: num(gs.worst)! };
    profile = { ...profile, updatedAt: now };
  }
  const se = input.semester as Record<string, unknown> | undefined;
  if (se && typeof se === "object") {
    if (str(se.name)) draft.name = str(se.name);
    if (isDay(str(se.startDate))) draft.startDate = str(se.startDate);
    if (isDay(str(se.endDate))) draft.endDate = str(se.endDate);
  }
  const added: string[] = [];
  for (const c of (input.addCourses as Array<Record<string, unknown>>) ?? []) {
    const name = str(c.name);
    if (!name) continue;
    const existing = findCourse(name);
    if (existing) {
      added.push(`${existing.name} = ${existing.id} (already there)`);
      continue;
    }
    const course: DraftCourse = {
      id: `c${uid().slice(0, 6)}`,
      name,
      short: (str(c.short) || name).slice(0, 8),
      credits: num(c.credits),
      teachingLanguage: "",
      targetGrade: inScale(num(c.targetGrade)),
      setupStatus: "waiting",
    };
    draft.courses.push(course);
    added.push(`${name} = ${course.id}`);
  }
  for (const u of (input.updateCourses as Array<Record<string, unknown>>) ?? []) {
    const c = findCourse(u.id);
    if (!c) {
      notes.push(`No course ${str(u.id)}.`);
      continue;
    }
    const next = { ...c };
    if (str(u.name)) next.name = str(u.name);
    if (str(u.short)) next.short = str(u.short).slice(0, 8);
    if (u.credits !== undefined) next.credits = num(u.credits);
    if (u.targetGrade !== undefined) next.targetGrade = inScale(num(u.targetGrade)) ?? c.targetGrade;
    draft.courses = draft.courses.map((x) => (x.id === c.id ? next : x));
  }
  for (const id of (input.removeCourseIds as unknown[]) ?? []) {
    const c = findCourse(id);
    if (!c) continue;
    draft.courses = draft.courses.filter((x) => x.id !== c.id);
    draft.timetable = draft.timetable.filter((t) => t.courseId !== c.id);
    draft.facts = draft.facts.filter((f) => f.courseId !== c.id);
    draft.uploads = draft.uploads.map((u) => (u.courseId === c.id ? { ...u, courseId: null } : u));
  }
  const remove = new Set(((input.removeSlots as unknown[]) ?? []).map(num).filter((n): n is number => n !== null));
  if (remove.size) draft.timetable = draft.timetable.filter((_, i) => !remove.has(i));
  for (const s of (input.addSlots as Array<Record<string, unknown>>) ?? []) {
    const weekday = DAY.findIndex((x) => x.toLowerCase() === str(s.weekday).slice(0, 3).toLowerCase());
    const start = hhmm(str(s.start));
    const end = hhmm(str(s.end));
    if (weekday < 0 || !start || !end || start >= end) {
      notes.push(`Slot "${str(s.title)}" skipped: needs a weekday and start before end.`);
      continue;
    }
    const kind: TimetableEntry["kind"] = s.kind === "lecture" || s.kind === "exercise" ? s.kind : "fixed";
    const course = kind === "fixed" ? undefined : findCourse(s.course);
    const entry: TimetableEntry = { weekday, start, end, kind, title: str(s.title) || course?.name || "Commitment", courseId: course?.id ?? null };
    if (draft.timetable.some((t) => t.weekday === weekday && t.start === start && t.end === end && t.title === entry.title)) continue;
    draft.timetable.push(entry);
  }
  for (const f of (input.facts as Array<Record<string, unknown>>) ?? []) {
    const text = str(f.text);
    if (!text) continue;
    const c = f.course ? findCourse(f.course) : undefined;
    if (f.course && !c) notes.push(`Fact "${text}" saved without a course: no course ${str(f.course)}.`);
    draft.facts.push({ id: uid(), courseId: c?.id ?? null, text, addedAt: now });
  }
  for (const f of (input.files as Array<Record<string, unknown>>) ?? []) {
    const c = findCourse(f.course);
    const ref = str(f.uploadId);
    const ids = new Set(filesOf(ref, draft.uploads));
    if (!ids.size || !c) {
      notes.push(`File ${ref} not assigned: ${!ids.size ? "no such file" : "no such course"}.`);
      continue;
    }
    const isZip = ref.startsWith("zip_");
    draft.uploads = draft.uploads.map((x) => (ids.has(x.id) ? { ...x, courseId: c.id, studentNote: (!isZip && str(f.note)) || x.studentNote } : x));
    if (isZip) draft.zips = (draft.zips ?? []).map((z) => (z.id === ref ? { ...z, courseId: c.id } : z));
    draft.courses = draft.courses.map((x) => (x.id === c.id && x.setupStatus !== "waiting" ? { ...x, setupStatus: "waiting" } : x));
  }
  const goal = input.studyGoalMinutes as Record<string, unknown> | undefined;
  if (goal && typeof goal === "object") {
    for (const [k, v] of Object.entries(goal)) {
      const wd = DAY.findIndex((x) => x.toLowerCase() === k.slice(0, 3).toLowerCase());
      const m = num(v);
      if (wd >= 0 && m !== null) draft.studyGoal[wd] = Math.max(0, Math.min(16 * 60, Math.round(m)));
    }
  }
  draft = { ...draft, updatedAt: now };
  const parts = ["Saved."];
  if (added.length) parts.push(`Course ids: ${added.join("; ")}.`);
  parts.push(...notes);
  const ready = setupReady(draft);
  parts.push(ready.ok ? "Ready to start setup once the student confirms." : `Still missing: ${ready.missing.join(", ")}.`);
  return { draft, profile, result: parts.join(" ") };
}

export const SHEET_TOOL_DESCRIPTION = "Changes the semester sheet the student sees: profile, semester dates, courses (with target grades), weekly slots, facts said word for word, file assignments and the study goal. Send only what changed. Returns the new course ids and what's still missing.";
export const SHEET_TOOL_SCHEMA = SHEET_SCHEMA;

/** The conversation as turns for Claude. The sheet rides along with the newest message. */
export function chatTurns(messages: SetupMessage[], sheet: string, returning: boolean, extra = ""): Turn[] {
  const turns: Turn[] = [{ role: "user", content: `${rules(returning)}\n\nThe chat so far follows. Your first message was already shown to the student.` }];
  for (const m of messages) {
    if (m.error && m.role === "assistant") continue;
    const text = m.role === "user" ? `${m.text}${m.files?.length ? `\n[Dropped: ${m.files.join(", ")}]` : ""}` : m.text;
    if (!text.trim()) continue;
    const last = turns[turns.length - 1];
    if (last.role === m.role) last.content += `\n\n${text}`;
    else turns.push({ role: m.role, content: text });
  }
  const last = turns[turns.length - 1];
  const tail = `${extra ? `\n\n${extra}` : ""}\n\n<sheet>\n${sheet}\n</sheet>`;
  if (last.role === "user") last.content += tail;
  else turns.push({ role: "user", content: `(The student hasn't written yet.)${tail}` });
  return turns;
}

export function greeting(returning: boolean, name: string | null): string {
  if (returning)
    return `Welcome back! Let's set up your new semester.\n\nI still know your school and grade scale. Everything you mastered last semester is kept, so I won't ask about it again.\n\nWhich courses do you have this time? Drop your timetable, a screenshot of your course list, or just type them.`;
  return `Hi${name ? ` ${name}` : ""}! I'm StudyDesk. Before I can build your daily quests, I need a short setup. It takes about ten minutes, and I save as we go, so you can stop and come back anytime.\n\nI need three things:\n\n- who you are,\n- your courses, with the grade you're aiming for in each,\n- how much time you want to study.\n\nLet's start with you. Where do you study, and what's your program or school type and year?`;
}

/**
 * Local preview stand-in (no Claude): understands a few plain lines so the
 * flow can be clicked through. "Analysis 1, 9 ECTS", "Analysis 1 target 2",
 * "Mon 3h", "start".
 */
export function localReply(text: string, d: SemesterDraft, p: Profile): { input: Record<string, unknown> | null; reply: string; start: boolean } {
  const lines = text.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
  const input: Record<string, unknown> = {};
  const addCourses: Array<Record<string, unknown>> = [];
  const updateCourses: Array<Record<string, unknown>> = [];
  const goal: Record<string, number> = {};
  for (const l of lines) {
    const t = /^(.*?)\s+target\s+(\d+(?:[.,]\d+)?)$/i.exec(l);
    if (t) {
      const c = d.courses.find((x) => x.name.toLowerCase() === t[1].toLowerCase());
      if (c) updateCourses.push({ id: c.id, targetGrade: Number(t[2].replace(",", ".")) });
      else addCourses.push({ name: t[1], targetGrade: Number(t[2].replace(",", ".")) });
      continue;
    }
    const g = /^(mon|tue|wed|thu|fri|sat|sun)\w*\s+(\d+(?:[.,]\d+)?)\s*h$/i.exec(l);
    if (g) {
      goal[g[1].slice(0, 1).toUpperCase() + g[1].slice(1, 3).toLowerCase()] = Math.round(Number(g[2].replace(",", ".")) * 60);
      continue;
    }
    if (/^(start|yes|go)\b/i.test(l)) continue;
    const c = /^(.*?)(?:,\s*(\d+)\s*ects)?$/i.exec(l)!;
    if (c[1] && c[1].length < 60) addCourses.push({ name: c[1], credits: c[2] ? Number(c[2]) : undefined });
  }
  if (addCourses.length) input.addCourses = addCourses;
  if (updateCourses.length) input.updateCourses = updateCourses;
  if (Object.keys(goal).length) input.studyGoalMinutes = goal;
  if (!p.country) input.profile = { country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 } };
  const start = /^(start|yes|go)\b/i.test(text.trim()) && setupReady(d).ok;
  return {
    input: Object.keys(input).length ? input : null,
    start,
    reply: start
      ? "Starting the setup now."
      : "*Local preview: inside claude.ai, Claude answers here and fills the sheet from anything you write or drop.* Type course names (one per line), \"Analysis 1 target 2\", \"Mon 3h\", or \"start\".",
  };
}
