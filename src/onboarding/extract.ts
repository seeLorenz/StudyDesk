// Reads what the student dropped or typed in the "Your courses" and "Your
// time" steps (a timetable screenshot, a course list, plain text) and turns it
// into courses and weekly slots for the semester sheet. The student checks and
// fixes the result in the sheet; nothing here is final.

import type { Turn } from "../platform/claude";
import type { Ask } from "../quests/write";
import { parseSections } from "../quests/write";
import type { TimetableEntry } from "../quests/types";

export type FoundCourse = { name: string; short: string; credits: number | null };
export type Found = { courses: FoundCourse[]; timetable: Array<Omit<TimetableEntry, "courseId"> & { courseName: string | null }> };

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function weekdayIndex(s: string): number | null {
  const k = s.trim().toLowerCase().slice(0, 3);
  const de: Record<string, string> = { son: "sun", mo: "mon", mon: "mon", die: "tue", di: "tue", mit: "wed", mi: "wed", don: "thu", do: "thu", fre: "fri", fr: "fri", sam: "sat", sa: "sat", so: "sun" };
  const i = DAYS.indexOf(k in de ? de[k] : k);
  return i >= 0 ? i : null;
}

const TIME = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;
const hhmm = (s: string) => {
  const m = TIME.exec(s.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

export function extractTurns(kind: "courses" | "commitments", text: string, fileTexts: string[]): Turn[] {
  const what =
    kind === "courses"
      ? "the student's courses this semester (and their weekly lecture and exercise times, if shown)"
      : "the student's fixed weekly commitments outside their courses (job, sport, travel and the like)";
  const format =
    kind === "courses"
      ? `=== COURSES ===
One line per course: full name | short name (max 8 characters) | credits (ECTS or hours; "-" if not shown)

=== TIMETABLE ===
One line per weekly slot: weekday (Mon..Sun) | start HH:MM | end HH:MM | lecture or exercise | full course name exactly as in COURSES`
      : `=== TIMETABLE ===
One line per weekly slot: weekday (Mon..Sun) | start HH:MM | end HH:MM | fixed | short title`;
  const files = fileTexts.length ? `\n\nFiles the student attached:\n${fileTexts.map((t) => `"""\n${t}\n"""`).join("\n")}` : "";
  return [
    {
      role: "user",
      content: `You help a student set up their semester in StudyDesk. From what they gave you (text, screenshots, files), find ${what}.

Rules:
- Only list what is actually there. Don't invent courses, times or credits.
- Keep course names in the language they're written in.
- A slot that repeats on several weekdays gets one line per weekday.
- If nothing fits, write the section header with no lines under it.

Reply with exactly these sections and nothing else:

${format}

What the student gave you:
"""
${text || "(only attachments)"}
"""${files}`,
    },
  ];
}

export function parseFound(reply: string): Found {
  const sec = parseSections(reply);
  const lines = (k: string) =>
    (sec.get(k) ?? "")
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.includes("|"));
  const courses: FoundCourse[] = [];
  for (const l of lines("COURSES")) {
    const [name, short, credits] = l.split("|").map((x) => x.trim());
    if (!name) continue;
    const c = Number((credits ?? "").replace(",", ".").replace(/[^\d.]/g, ""));
    courses.push({ name, short: (short || name).slice(0, 8), credits: credits && Number.isFinite(c) && c > 0 ? c : null });
  }
  const timetable: Found["timetable"] = [];
  for (const l of lines("TIMETABLE")) {
    const [day, start, end, kind, title] = l.split("|").map((x) => x.trim());
    const weekday = weekdayIndex(day ?? "");
    const s = hhmm(start ?? "");
    const e = hhmm(end ?? "");
    if (weekday === null || !s || !e || s >= e) continue;
    const k = /exerc|übung|tutor/i.test(kind ?? "") ? "exercise" : /lect|vorl/i.test(kind ?? "") ? "lecture" : "fixed";
    timetable.push({ weekday, start: s, end: e, kind: k, title: title || "Commitment", courseName: k === "fixed" ? null : title || null });
  }
  return { courses, timetable };
}

/** Asks Claude, or reads the text line by line outside claude.ai. */
export async function extract(kind: "courses" | "commitments", text: string, fileTexts: string[], images: Blob[], ask: Ask | null): Promise<Found> {
  if (!ask) return localFound(kind, text);
  const reply = await ask(extractTurns(kind, text, fileTexts), { images, tier: "default" });
  return parseFound(reply);
}

/**
 * Local preview stand-in: each line is a course ("Analysis 1, 9 ECTS"), or a
 * slot ("Mon 10:00-11:30 Analysis 1").
 */
export function localFound(kind: "courses" | "commitments", text: string): Found {
  const out: Found = { courses: [], timetable: [] };
  for (const raw of text.split(/\n|;/)) {
    const l = raw.trim();
    if (!l) continue;
    const slot = /^(\w{2,3})\w*\s+(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})\s+(.+)$/.exec(l);
    const weekday = slot ? weekdayIndex(slot[1]) : null;
    if (slot && weekday !== null) {
      const s = hhmm(slot[2])!;
      const e = hhmm(slot[3])!;
      if (kind === "courses") out.timetable.push({ weekday, start: s, end: e, kind: "lecture", title: slot[4], courseName: slot[4] });
      else out.timetable.push({ weekday, start: s, end: e, kind: "fixed", title: slot[4], courseName: null });
      continue;
    }
    if (kind === "courses") {
      const m = /^(.*?)(?:[,(]\s*(\d+(?:[.,]\d+)?)\s*(?:ects|ec|cp|credits?)\)?)?$/i.exec(l)!;
      const name = m[1].trim();
      if (name) out.courses.push({ name, short: name.split(/\s+/).map((w) => (/\d/.test(w) ? w : w[0])).join("").slice(0, 8), credits: m[2] ? Number(m[2].replace(",", ".")) : null });
    }
  }
  return out;
}
