// Small changes to the student's semester, made through the Orchestrator.
// design/orchestrator.md, "How a change works".
//
// Claude turns what the student said into typed operations; this file checks
// each one and applies it to the semester draft (the source the quest module's
// semester is rebuilt from). Pure, so it is tested. Every applied change keeps
// what it touched before and after, so it can be undone.

import { wishLink } from "../agents/capabilities";
import { uid } from "../chat/types";
import { toDay } from "../mastery/days";
import { assessmentAttempts } from "../mastery/grades";
import type { AssessmentResult, Attempt, CourseTarget } from "../mastery/types";
import { buildSemester } from "../onboarding/setup";
import { setupTodo } from "../onboarding/todo";
import { filesOf } from "../lib/keep";
import type { CourseSetup, DraftCourse, Profile, SemesterDraft, StudentFact } from "../onboarding/types";
import type { Assignment, KeyDate, Semester, TimetableEntry } from "../quests/types";
import { QUEST_SETTING_LIMITS, questSettingsNow } from "../quests/config";
import type { Change, Operation } from "./types";
import { nightlySettings } from "../routine/nightly";

export type Desk = { draft: SemesterDraft; profile: Profile };

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Operations that only run after the student said yes on a card. */
export const CONFIRM_FIRST = new Set(["drop_course"]);

const str = (x: unknown) => (typeof x === "string" ? x.trim() : x === undefined || x === null ? "" : String(x).trim());
const num = (x: unknown) => {
  const n = typeof x === "number" ? x : Number(String(x ?? "").replace(",", "."));
  return x === undefined || x === null || x === "" || !Number.isFinite(n) ? null : n;
};

/** A real calendar day "YYYY-MM-DD". */
export function isRealDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const hhmm = (s: string) => {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(s);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

/** "2026-12-03" or "2026-12-03T10:00" → "2026-12-03T10:00" (end of day when no time). */
function dueAt(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}[:.]\d{2}))?$/.exec(s);
  if (!m || !isRealDay(m[1])) return null;
  const t = m[2] ? hhmm(m[2]) : "23:59";
  return t ? `${m[1]}T${t}` : null;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "4 Feb" for display in change cards. */
export function shortDate(day: string): string {
  const [, m, d] = day.slice(0, 10).split("-").map(Number);
  const time = day.length > 10 && !day.endsWith("23:59") ? ` ${day.slice(11, 16)}` : "";
  return `${d} ${MONTH[m - 1]}${time}`;
}

const minutesText = (m: number) => (m === 0 ? "off" : m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ""}${m % 60} min` : `${m / 60} h`);

export function findCourse(draft: SemesterDraft, ref: unknown): DraftCourse | undefined {
  const r = str(ref).toLowerCase();
  if (!r) return undefined;
  return (
    draft.courses.find((c) => c.id.toLowerCase() === r) ??
    draft.courses.find((c) => c.name.toLowerCase() === r) ??
    draft.courses.find((c) => c.short.toLowerCase() === r) ??
    (draft.courses.filter((c) => c.name.toLowerCase().includes(r)).length === 1 ? draft.courses.find((c) => c.name.toLowerCase().includes(r)) : undefined)
  );
}

// ---------- reading and writing parts of the desk by key ----------
// Keys: "courses", "uploads", "zips", "timetable", "studyGoal", "facts", "daysOff", "assessments", "questSettings",
// "profile", and "results.<courseId>.<keyDates|assignments|teachingLanguage>".

function getPart(desk: Desk, key: string): unknown {
  if (key === "profile") return desk.profile;
  const r = /^results\.([^.]+)\.(\w+)$/.exec(key);
  if (r) return (desk.draft.results[r[1]] as Record<string, unknown> | undefined)?.[r[2]];
  return (desk.draft as unknown as Record<string, unknown>)[key];
}

function setPart(desk: Desk, key: string, value: unknown): Desk {
  if (key === "profile") return { ...desk, profile: value as Profile };
  const r = /^results\.([^.]+)\.(\w+)$/.exec(key);
  if (r) {
    const cur = desk.draft.results[r[1]];
    if (!cur) return desk;
    return { ...desk, draft: { ...desk.draft, results: { ...desk.draft.results, [r[1]]: { ...cur, [r[2]]: value } as CourseSetup } } };
  }
  return { ...desk, draft: { ...desk.draft, [key]: value } };
}

const OWN_WORD = " (set by the student in StudyDesk)";
const dateLabel = (k: Pick<KeyDate, "kind" | "title">) => `${k.kind === "quiz" ? "Quiz" : "Exam"} "${k.title}"`;

const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- applying operations ----------

export type ApplyResult = {
  desk: Desk;
  /** The logged change, or null when nothing was applied. */
  change: Change | null;
  /** Operations that need the student's yes first. Not applied. */
  needsConfirm: Operation[];
  /** Why some operations weren't applied, to tell Claude. */
  errors: string[];
  /** New course ids, for start_job. */
  newCourses: Array<{ id: string; name: string }>;
  /** For the mastery store. */
  attempts: Attempt[];
  targets: CourseTarget[];
};

export function applyOps(
  desk0: Desk,
  ops: Operation[],
  o: { studentWords: string; by?: Change["by"]; confirmed?: boolean; now?: number },
): ApplyResult {
  const now = o.now ?? Date.now();
  let desk: Desk = { draft: { ...desk0.draft }, profile: { ...desk0.profile } };
  const lines: string[] = [];
  const errors: string[] = [];
  const touched = new Set<string>();
  const needsConfirm: Operation[] = [];
  const newCourses: ApplyResult["newCourses"] = [];
  const attempts: Attempt[] = [];
  const targets: CourseTarget[] = [];
  let undoable = true;

  const touch = (key: string, value: unknown) => {
    touched.add(key);
    desk = setPart(desk, key, value);
  };
  const course = (op: Operation): DraftCourse | null => {
    const c = findCourse(desk.draft, op.course);
    if (!c) errors.push(`${op.op}: no course "${str(op.course)}". Courses: ${desk.draft.courses.map((x) => `${x.name} (${x.id})`).join(", ") || "none"}.`);
    return c ?? null;
  };
  const result = (c: DraftCourse) => desk.draft.results[c.id] as CourseSetup | undefined;
  const scale = () => desk.profile.gradeScale;
  const inScale = (g: number) => {
    const lo = Math.min(scale().best, scale().worst);
    const hi = Math.max(scale().best, scale().worst);
    return g >= lo && g <= hi;
  };
  const fact = (c: DraftCourse | null, text: string) =>
    touch("facts", [...desk.draft.facts, { id: uid(), courseId: c?.id ?? null, text, addedAt: now }]);
  // Dates the student sets are also kept as their own word (replacing the older one), so a re-read
  // or the nightly check can't undo them; the organization agent may not change them.
  const isOwn = (c: DraftCourse, label: string) => (f: StudentFact) => f.courseId === c.id && f.text.startsWith(`${label}:`) && f.text.endsWith(OWN_WORD);
  const studentSet = (c: DraftCourse, label: string) => o.by === "organization" && desk.draft.facts.some(isOwn(c, label));
  const ownWord = (c: DraftCourse, label: string, value: string) => {
    if (o.by === "organization") return;
    touch("facts", [...desk.draft.facts.filter((f) => !isOwn(c, label)(f)), { id: uid(), courseId: c.id, text: `${label}: ${value}${OWN_WORD}`, addedAt: now }]);
  };

  for (const op of ops) {
    if (CONFIRM_FIRST.has(op.op) && !o.confirmed) {
      needsConfirm.push(op);
      continue;
    }
    switch (op.op) {
      case "set_target_grade": {
        const c = course(op);
        const g = num(op.grade);
        if (!c) break;
        if (g === null || !inScale(g)) {
          errors.push(`set_target_grade: ${str(op.grade)} isn't on the scale ${scale().name} (${scale().best} best, ${scale().worst} worst).`);
          break;
        }
        touch("courses", desk.draft.courses.map((x) => (x.id === c.id ? { ...x, targetGrade: g } : x)));
        targets.push({ courseId: c.id, targetGrade: g, gradeScale: scale() });
        lines.push(`${c.name}, target grade: ${c.targetGrade ?? "none"} → ${g}`);
        break;
      }
      case "set_exam_date": {
        const c = course(op);
        const date = str(op.date);
        if (!c) break;
        if (!isRealDay(date)) {
          errors.push(`set_exam_date: "${date}" isn't a real date (YYYY-MM-DD).`);
          break;
        }
        const kind: KeyDate["kind"] = op.kind === "quiz" ? "quiz" : "exam";
        const title = str(op.title) || (kind === "exam" ? "Exam" : "Quiz");
        const r = result(c);
        if (!r) {
          fact(c, `${title}: ${date}`);
          lines.push(`${c.name}, ${title}: ${shortDate(date)} (noted; used once the course is read)`);
          break;
        }
        const list = r.keyDates;
        const i = list.findIndex((k) => k.title.toLowerCase() === title.toLowerCase());
        const j = i >= 0 ? i : list.filter((k) => k.kind === kind).length === 1 && !op.title ? list.findIndex((k) => k.kind === kind) : -1;
        if (j >= 0) {
          if (list[j].date === date) break;
          if (studentSet(c, dateLabel(list[j]))) {
            errors.push(`set_exam_date: the student set ${c.name}, ${list[j].title} to ${list[j].date} themselves; not changed.`);
            break;
          }
          touch(`results.${c.id}.keyDates`, list.map((k, n) => (n === j ? { ...k, date } : k)));
          ownWord(c, dateLabel(list[j]), date);
          lines.push(`${c.name}, ${list[j].title}: ${shortDate(list[j].date)} → ${shortDate(date)}`);
        } else {
          touch(`results.${c.id}.keyDates`, [...list, { courseId: c.id, date, kind, title, skillIds: [] }]);
          ownWord(c, dateLabel({ kind, title }), date);
          lines.push(`${c.name}, ${title}: added on ${shortDate(date)}`);
        }
        break;
      }
      case "remove_exam_date": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const title = str(op.title).toLowerCase();
        const k = r?.keyDates.find((x) => x.title.toLowerCase() === title);
        if (!r || !k) {
          errors.push(`remove_exam_date: ${c.name} has no date called "${str(op.title)}".`);
          break;
        }
        touch(`results.${c.id}.keyDates`, r.keyDates.filter((x) => x !== k));
        ownWord(c, dateLabel(k), "removed, there is no such date");
        lines.push(`${c.name}, ${k.title} on ${shortDate(k.date)}: removed`);
        break;
      }
      case "set_due": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const ref = str(op.homework).toLowerCase();
        const a = r?.assignments.find((x) => x.id.toLowerCase() === ref || x.title.toLowerCase() === ref);
        const due = dueAt(str(op.dueAt));
        if (!r || !a) {
          errors.push(`set_due: ${c.name} has no homework "${str(op.homework)}". Homework: ${r?.assignments.map((x) => x.title).join(", ") || "none"}.`);
          break;
        }
        if (!due) {
          errors.push(`set_due: "${str(op.dueAt)}" isn't a date (YYYY-MM-DD or YYYY-MM-DDTHH:MM).`);
          break;
        }
        if (studentSet(c, `Homework "${a.title}"`)) {
          errors.push(`set_due: the student set ${c.name}, ${a.title} themselves; not changed.`);
          break;
        }
        touch(`results.${c.id}.assignments`, r.assignments.map((x) => (x.id === a.id ? { ...x, dueAt: due } : x)));
        ownWord(c, `Homework "${a.title}"`, `due ${due}`);
        lines.push(`${c.name}, ${a.title} due: ${shortDate(a.dueAt)} → ${shortDate(due)}`);
        break;
      }
      case "add_homework": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const due = dueAt(str(op.dueAt));
        const title = str(op.title);
        if (!r) {
          errors.push(`add_homework: ${c.name} hasn't been read yet, so there are no skills to link the tasks to. Start a job with the sheet instead.`);
          break;
        }
        if (!title || !due) {
          errors.push(`add_homework: needs a title and a due date (YYYY-MM-DD or YYYY-MM-DDTHH:MM).`);
          break;
        }
        const tasksIn = Array.isArray(op.tasks) ? (op.tasks as Array<Record<string, unknown>>) : [];
        const skills = r.skills.filter((s) => s.courseId === c.id);
        const bad: string[] = [];
        const id = `as_${uid().slice(0, 8)}`;
        const tasks = tasksIn.flatMap((t, n) => {
          const sk = str(t.skill).toLowerCase();
          const skill = skills.find((s) => s.id.toLowerCase() === sk) ?? skills.find((s) => s.name.toLowerCase() === sk);
          const text = str(t.text);
          if (!skill || !text) {
            bad.push(str(t.label) || String(n + 1));
            return [];
          }
          return [{ id: `${id}_${n + 1}`, label: str(t.label) || String(n + 1), skillId: skill.id, prompt: text, maxPoints: Math.max(1, num(t.points) ?? 1) }];
        });
        if (!tasks.length || bad.length) {
          errors.push(`add_homework: ${bad.length ? `tasks ${bad.join(", ")} need the task text and an existing skill of ${c.name} (look_up skills)` : "no tasks given"}. If the sheet is new material, start a job with it instead.`);
          break;
        }
        const a: Assignment = { id, courseId: c.id, title, dueAt: due, tasks };
        touch(`results.${c.id}.assignments`, [...r.assignments, a]);
        ownWord(c, `Homework "${title}"`, `due ${due}, ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`);
        lines.push(`${c.name}, ${title}: added, ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}, due ${shortDate(due)}`);
        break;
      }
      case "remove_homework": {
        const c = course(op);
        if (!c) break;
        const r = result(c);
        const ref = str(op.homework).toLowerCase();
        const a = r?.assignments.find((x) => x.id.toLowerCase() === ref || x.title.toLowerCase() === ref);
        if (!r || !a) {
          errors.push(`remove_homework: ${c.name} has no homework "${str(op.homework)}".`);
          break;
        }
        touch(`results.${c.id}.assignments`, r.assignments.filter((x) => x.id !== a.id));
        ownWord(c, `Homework "${a.title}"`, "removed, it doesn't count");
        lines.push(`${c.name}, ${a.title}: removed`);
        break;
      }
      case "set_study_goal": {
        const goal = (op.minutes ?? {}) as Record<string, unknown>;
        const next = [...desk.draft.studyGoal];
        const changed: string[] = [];
        for (const [k, v] of Object.entries(goal)) {
          const wd = DAY.findIndex((d) => d.toLowerCase() === k.slice(0, 3).toLowerCase());
          const m = num(v);
          if (wd < 0 || m === null || m < 0 || m > 16 * 60) {
            errors.push(`set_study_goal: "${k}: ${str(v)}" needs a weekday and 0 to 960 minutes.`);
            continue;
          }
          if (next[wd] === Math.round(m)) continue;
          changed.push(`${DAY[wd]} ${minutesText(next[wd] ?? 0)} → ${minutesText(Math.round(m))}`);
          next[wd] = Math.round(m);
        }
        if (changed.length) {
          touch("studyGoal", next);
          lines.push(`Study goal: ${changed.join(", ")}`);
        }
        break;
      }
      case "set_day_off": {
        const date = str(op.date);
        if (!isRealDay(date)) {
          errors.push(`set_day_off: "${date}" isn't a real date (YYYY-MM-DD).`);
          break;
        }
        const list = desk.draft.daysOff ?? [];
        if (list.some((d) => d.date === date)) break;
        touch("daysOff", [...list, { date, reason: str(op.reason) }].sort((a, b) => (a.date < b.date ? -1 : 1)));
        lines.push(`Day off: ${shortDate(date)}${str(op.reason) ? ` (${str(op.reason)})` : ""}, no quest that day`);
        break;
      }
      case "remove_day_off": {
        const date = str(op.date);
        const list = desk.draft.daysOff ?? [];
        if (!list.some((d) => d.date === date)) {
          errors.push(`remove_day_off: ${date} isn't a day off.`);
          break;
        }
        touch("daysOff", list.filter((d) => d.date !== date));
        lines.push(`Day off on ${shortDate(date)}: removed`);
        break;
      }
      case "add_slot": {
        const weekday = DAY.findIndex((d) => d.toLowerCase() === str(op.weekday).slice(0, 3).toLowerCase());
        const start = hhmm(str(op.start));
        const end = hhmm(str(op.end));
        if (weekday < 0 || !start || !end || start >= end) {
          errors.push(`add_slot: needs a weekday and a start before the end (HH:MM).`);
          break;
        }
        const kind: TimetableEntry["kind"] = op.kind === "lecture" || op.kind === "exercise" ? op.kind : "fixed";
        const c = kind === "fixed" ? undefined : findCourse(desk.draft, op.course);
        const entry: TimetableEntry = { weekday, start, end, kind, title: str(op.title) || c?.name || "Commitment", courseId: c?.id ?? null };
        touch("timetable", [...desk.draft.timetable, entry]);
        lines.push(`Weekly: ${DAY[weekday]} ${start}–${end} ${entry.title} added`);
        break;
      }
      case "remove_slot": {
        const weekday = DAY.findIndex((d) => d.toLowerCase() === str(op.weekday).slice(0, 3).toLowerCase());
        const start = hhmm(str(op.start));
        const t = desk.draft.timetable.find((x) => x.weekday === weekday && x.start === start);
        if (!t) {
          errors.push(`remove_slot: nothing on ${str(op.weekday)} at ${str(op.start)}.`);
          break;
        }
        touch("timetable", desk.draft.timetable.filter((x) => x !== t));
        lines.push(`Weekly: ${DAY[t.weekday]} ${t.start}–${t.end} ${t.title} removed`);
        break;
      }
      case "set_language": {
        const c = course(op);
        const lang = str(op.language);
        if (!c) break;
        if (!lang) {
          errors.push("set_language: needs a language.");
          break;
        }
        const old = result(c)?.teachingLanguage || c.teachingLanguage || "not set";
        touch("courses", desk.draft.courses.map((x) => (x.id === c.id ? { ...x, teachingLanguage: lang } : x)));
        if (result(c)) touch(`results.${c.id}.teachingLanguage`, lang);
        lines.push(`${c.name}, language of explanations: ${old} → ${lang}`);
        break;
      }
      case "set_quest_settings": {
        const cur = { ...(desk.draft.questSettings ?? {}) };
        const now_ = questSettingsNow(cur);
        const labels = { hints: "hints per task", lessonMinutes: "lesson reading minutes", newSkillsPerQuest: "new skills per quest", newSkillsBeforeExams: "new skills per quest in exam weeks" } as const;
        const changed: string[] = [];
        for (const k of Object.keys(QUEST_SETTING_LIMITS) as Array<keyof typeof QUEST_SETTING_LIMITS>) {
          if (op[k] === undefined) continue;
          const v = num(op[k]);
          const [lo, hi] = QUEST_SETTING_LIMITS[k];
          if (v === null || v < lo || v > hi || Math.round(v) !== v) {
            errors.push(`set_quest_settings: ${k} must be a whole number from ${lo} to ${hi}.`);
            continue;
          }
          if (now_[k] === v) continue;
          changed.push(`${labels[k]} ${now_[k]} → ${v}`);
          cur[k] = v;
        }
        if (typeof op.anki === "boolean" && op.anki !== cur.anki) {
          changed.push(`Anki decks ${op.anki ? "on" : "off"}`);
          cur.anki = op.anki;
        }
        if (changed.length) {
          touch("questSettings", cur);
          lines.push(`Quests: ${changed.join(", ")} (from the next quest)`);
        }
        break;
      }
      case "add_fact": {
        const text = str(op.text);
        const c = op.course ? course(op) : null;
        if (!text || (op.course && !c)) {
          if (!text) errors.push("add_fact: needs the text.");
          break;
        }
        fact(c, text);
        lines.push(`Noted${c ? ` for ${c.name}` : ""}: "${text}"`);
        break;
      }
      case "set_calendar_live": {
        const v = op.on === true || op.on === "true" ? true : op.on === false || op.on === "false" ? false : null;
        if (v === null) {
          errors.push("set_calendar_live: on must be true or false.");
          break;
        }
        if (!desk.draft.calendarImportedAt) {
          errors.push("set_calendar_live: no calendar was imported; use read_calendar first.");
          break;
        }
        if ((desk.draft.calendarLive !== false) === v) break;
        touch("calendarLive", v);
        lines.push(v ? "Calendar: followed live again, each day's quest is sized from it" : "Calendar: no longer followed day by day, quests go by the weekly timetable");
        break;
      }
      case "set_file_course": {
        const c = course(op);
        const ref = str(op.file);
        const ids = new Set(filesOf(ref, desk.draft.uploads));
        if (!c) break;
        if (!ids.size) {
          errors.push(`set_file_course: no file or zip "${ref}" (look_up files).`);
          break;
        }
        touch("uploads", desk.draft.uploads.map((u) => (ids.has(u.id) ? { ...u, courseId: c.id, courseUnsure: undefined } : u)));
        if (ref.startsWith("zip_")) touch("zips", (desk.draft.zips ?? []).map((z) => (z.id === ref ? { ...z, courseId: c.id } : z)));
        lines.push(`${ids.size === 1 ? desk.draft.uploads.find((u) => ids.has(u.id))!.fileName : `${ids.size} files`} → ${c.name}`);
        break;
      }
      case "tick_todo": {
        const key = str(op.key);
        const todo = setupTodo(desk.draft, toDay(new Date(now)));
        const item = todo.find((t) => t.key === key || t.title === key);
        const sub = item ? undefined : todo.flatMap((t) => t.subs ?? []).find((x) => x.key === key);
        if (!item && !sub) {
          errors.push(`tick_todo: no to-do "${key}"; use a key from openToDo (an item or one of its parts).`);
          break;
        }
        const target = item ? { key: item.key, label: item.title, done: item.done } : { key: sub!.key, label: sub!.text.replace(/\*\*/g, ""), done: sub!.done };
        const on = !(op.done === false || op.done === "false");
        if (target.done === on) break;
        const list = desk.draft.todoDone ?? [];
        // Opening a part again also opens its item when the whole item was ticked.
        const parent = target.key.split(":")[0];
        touch("todoDone", on ? [...new Set([...list, target.key])] : list.filter((k) => k !== target.key && k !== parent));
        if (on) touch("todoDoneOn", { ...desk.draft.todoDoneOn, [target.key]: toDay(new Date(now)) });
        lines.push(on ? `To do: ticked off "${target.label}"` : `To do: "${target.label}" is open again`);
        break;
      }
      case "set_nightly": {
        const cur = nightlySettings(desk.profile.nightly);
        const next = { ...cur };
        const changed: string[] = [];
        if (op.time !== undefined) {
          const t = hhmm(str(op.time));
          if (!t) errors.push("set_nightly: time must be HH:MM.");
          else if (t !== cur.time) {
            changed.push(`time ${cur.time} → ${t}`);
            next.time = t;
          }
        }
        const flags = { paused: "paused", grading: "grading at night", check: "the courses' nightly check", quest: "writing tomorrow's quest at night" } as const;
        for (const k of Object.keys(flags) as Array<keyof typeof flags>) {
          if (op[k] === undefined) continue;
          const v = op[k] === true || op[k] === "true" ? true : op[k] === false || op[k] === "false" ? false : null;
          if (v === null) {
            errors.push(`set_nightly: ${k} must be true or false.`);
            continue;
          }
          if (v === cur[k]) continue;
          changed.push(k === "paused" ? (v ? "paused" : "running again") : `${flags[k]} ${v ? "on" : "off"}`);
          next[k] = v;
        }
        if (changed.length) {
          touch("profile", { ...desk.profile, nightly: next, updatedAt: now });
          lines.push(`Nightly run: ${changed.join(", ")}`);
        }
        break;
      }
      case "set_sweep": {
        const c = course(op);
        if (!c) break;
        const date = str(op.date);
        const cur = { ...(desk.draft.sweepDates ?? {}) };
        if (date === "" || date === "none") {
          if (!cur[c.id]) break;
          delete cur[c.id];
          touch("sweepDates", cur);
          lines.push(`${c.name}: your deep sweep date removed (StudyDesk picks one again)`);
          break;
        }
        if (!isRealDay(date)) {
          errors.push("set_sweep: date must be YYYY-MM-DD (or \"none\").");
          break;
        }
        if (cur[c.id] === date) break;
        cur[c.id] = date;
        touch("sweepDates", cur);
        lines.push(`${c.name}: deep sweep (full re-read) on the night of ${shortDate(date)}`);
        break;
      }
      case "add_wish": {
        const text = str(op.text);
        if (!text) break;
        touch("profile", { ...desk.profile, wishes: [...(desk.profile.wishes ?? []), { text, at: now }] });
        lines.push(`Wish saved: "${text}" ${wishLink(text)}`);
        break;
      }
      case "set_profile": {
        const p = { ...desk.profile };
        const changed: string[] = [];
        for (const k of ["school", "country", "program", "year"] as const) {
          if (op[k] === undefined || str(op[k]) === p[k]) continue;
          changed.push(`${k} ${p[k] || "–"} → ${str(op[k])}`);
          p[k] = str(op[k]);
        }
        if (changed.length) {
          touch("profile", { ...p, updatedAt: now });
          lines.push(`Profile: ${changed.join(", ")}`);
        }
        break;
      }
      case "add_result": {
        const c = course(op);
        if (!c) break;
        const points = num(op.points);
        const max = num(op.maxPoints);
        const date = str(op.date);
        if (points === null || max === null || max <= 0 || points < 0 || points > max || !isRealDay(date)) {
          errors.push("add_result: needs points between 0 and maxPoints, maxPoints above 0, and a date (YYYY-MM-DD).");
          break;
        }
        const known = new Set((result(c)?.skills ?? []).map((s) => s.id));
        const skillIds = (Array.isArray(op.skills) ? (op.skills as unknown[]) : []).map(str).filter((s) => known.has(s));
        const r: AssessmentResult = { assessmentId: `res_${uid().slice(0, 8)}`, courseId: c.id, component: str(op.component) || "Result", points, maxPoints: max, date, skillIds };
        touch("assessments", [...(desk.draft.assessments ?? []), r]);
        attempts.push(...assessmentAttempts(r, now));
        undoable = false;
        lines.push(`${c.name}, ${r.component}: ${points} of ${max} on ${shortDate(date)}`);
        break;
      }
      case "add_course": {
        const name = str(op.name);
        if (!name) {
          errors.push("add_course: needs a name.");
          break;
        }
        const existing = findCourse(desk.draft, name);
        if (existing) {
          errors.push(`add_course: ${existing.name} (${existing.id}) is already there.`);
          break;
        }
        const g = num(op.targetGrade);
        const c: DraftCourse = {
          id: `c${uid().slice(0, 6)}`,
          name,
          short: (str(op.short) || name).slice(0, 8),
          credits: num(op.credits),
          teachingLanguage: "",
          targetGrade: g !== null && inScale(g) ? g : null,
          setupStatus: "waiting",
        };
        touch("courses", [...desk.draft.courses, c]);
        if (c.targetGrade !== null) targets.push({ courseId: c.id, targetGrade: c.targetGrade, gradeScale: scale() });
        newCourses.push({ id: c.id, name: c.name });
        lines.push(`New course: ${name}${c.targetGrade !== null ? `, target ${c.targetGrade}` : ""}`);
        break;
      }
      case "drop_course": {
        const c = course(op);
        if (!c) break;
        // Its setup results stay in the draft (archived): undo brings it back.
        touch("courses", desk.draft.courses.filter((x) => x.id !== c.id));
        touch("timetable", desk.draft.timetable.filter((t) => t.courseId !== c.id));
        lines.push(`${c.name}: dropped. Its quests stop; its data is kept`);
        break;
      }
      default:
        errors.push(`Unknown operation "${op.op}".`);
    }
  }

  if (!touched.size) return { desk: desk0, change: null, needsConfirm, errors, newCourses, attempts, targets };
  const keys = [...touched];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of keys) {
    before[k] = clone(getPart(desk0, k));
    after[k] = clone(getPart(desk, k));
  }
  desk = { ...desk, draft: { ...desk.draft, updatedAt: now } };
  const change: Change = { id: `ch_${uid()}`, at: now, by: o.by ?? "orchestrator", studentWords: o.studentWords, ops, lines, touched: keys, before, after, status: "applied", undoable };
  return { desk, change, needsConfirm, errors, newCourses, attempts, targets };
}

/**
 * Takes a change back: restores every part it touched. Refused when a part
 * changed since (a later change, or a re-read of the course), so undo never
 * throws away newer work.
 */
export function undoChange(desk: Desk, change: Change): { desk: Desk; ok: true } | { ok: false; reason: string } {
  if (change.status !== "applied") return { ok: false, reason: "It was already undone." };
  if (!change.undoable) return { ok: false, reason: "Results can't be undone. Tell me what's wrong and I'll add a correction." };
  for (const k of change.touched) {
    if (!same(getPart(desk, k), change.after[k])) return { ok: false, reason: "Something changed it again since, so undoing would lose newer changes." };
  }
  let next = desk;
  for (const k of change.touched) next = setPart(next, k, clone(change.before[k]));
  return { desk: { ...next, draft: { ...next.draft, updatedAt: Date.now() } }, ok: true };
}

/** True when undo would still work right now. */
export function canUndo(desk: Desk, change: Change): boolean {
  return change.status === "applied" && change.undoable && change.touched.every((k) => same(getPart(desk, k), change.after[k]));
}

/**
 * The quest module's semester rebuilt from the changed draft. Keeps what only
 * the semester knows: the placement check and the workload decision.
 */
export function syncSemester(draft: SemesterDraft, profile: Profile, current: Semester | null, now = Date.now()): Semester {
  const built = buildSemester(draft, profile, now);
  if (!current || current.id !== built.id) return built;
  const goalChanged = !same(current.studyGoal, built.studyGoal);
  return {
    ...built,
    createdAt: current.createdAt,
    placementQuestId: current.placementQuestId,
    studyGoalSource: goalChanged ? "student" : current.studyGoalSource ?? "student",
    studyGoalDecidedAt: current.studyGoalDecidedAt ?? (goalChanged ? now : undefined),
  };
}

