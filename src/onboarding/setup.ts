// The setup run: a first, in-page version of the organization agent.
//
// For each course it reads the student's original files once, carefully, and
// writes topics, skills, grade rules, key dates, homework and the material
// catalog (which pages or lines cover which skill). Courses run one after the
// other and each result is saved as soon as it's done, so closing the page
// loses at most the course being read.
//
// The organization agent's own module will replace this prompt; the records it
// writes stay the same (design/onboarding.md, "What onboarding hands over").

import type { GradeRules } from "../mastery/grades";
import type { Difficulty, Skill } from "../mastery/types";
import type { Turn } from "../platform/claude";
import type { Assignment, AssignmentTask, KeyDate, Semester, Topic } from "../quests/types";
import type { Ask } from "../quests/write";
import { parseSections } from "../quests/write";
import type { CatalogEntry, CourseSetup, DraftCourse, Profile, SemesterDraft, StudentFact, Upload } from "./types";

/** At most this much file text goes into one course's run. */
export const MAX_COURSE_CHARS = 150_000;
/** The done screen is a to-do list, so each course asks at most this many questions. */
export const MAX_QUESTIONS = 3;

export type FileForSetup = { upload: Upload; text: string | null; image: Blob | null };

export type SetupInput = {
  profile: Profile;
  draft: Pick<SemesterDraft, "name" | "startDate" | "endDate">;
  course: DraftCourse;
  facts: StudentFact[];
  files: FileForSetup[];
  today: string;
  /** Fundamentals mastered in earlier semesters, so the run reuses their ids. */
  priorFundamentals: Skill[];
};

const CUT_SHORT = "The answer was cut short";

export function setupTurns(input: SetupInput): { turns: Turn[]; images: Blob[]; fileKeys: Map<string, string>; clipped: string[] } {
  const { profile, course, facts, files, today, draft } = input;
  const scale = profile.gradeScale;
  const fileKeys = new Map<string, string>();
  const clipped: string[] = [];
  const images: Blob[] = [];
  let budget = MAX_COURSE_CHARS;
  const fileBlocks = files.map((f, i) => {
    const key = `F${i + 1}`;
    fileKeys.set(key, f.upload.id);
    const head = `### ${key}: ${f.upload.fileName}${f.upload.studentNote ? ` (the student says: "${f.upload.studentNote}")` : ""}`;
    if (f.image) {
      images.push(f.image);
      return `${head}\nImage ${images.length} of the attached images. Refer to it as "${key}, image".`;
    }
    let text = f.text ?? "";
    if (text.length > budget) {
      clipped.push(f.upload.fileName);
      text = text.slice(0, Math.max(0, budget)) + "\n[…the rest of this file was not sent]";
    }
    budget -= text.length;
    return `${head}\nPages are marked "--- page N ---"; for text files, count lines.\n"""\n${text}\n"""`;
  });
  const prior = input.priorFundamentals.length
    ? `\nFundamentals this student already mastered in earlier semesters (reuse these exact ids when a fundamental here is the same skill; don't list them again otherwise):\n${input.priorFundamentals.map((p) => `- ${p.id}: ${p.name}`).join("\n")}\n`
    : "";

  const content = `You are StudyDesk's organization agent. You set up one course for one student: you turn their real course materials into the list of skills StudyDesk teaches, practices and tracks. Everything later (daily quests, grading) depends on this map, so be thorough and precise.

## The student
- ${profile.level === "school" ? "School" : "University"}: ${profile.school || "not given"}, ${profile.country || "country not given"}
- Program or school type: ${profile.program || "not given"}, year ${profile.year || "not given"}
- Grade scale: ${scale.name} (best ${scale.best}, worst ${scale.worst})
- Semester: ${draft.name}, ${draft.startDate} to ${draft.endDate}. Today is ${today}.

## The course
- Name: ${course.name}${course.credits ? `, ${course.credits} credits` : ""}
- Target grade: ${course.targetGrade ?? "not given"}

## What the student said about it (word for word; if a file disagrees, the student's word wins, and you list the disagreement under CONFLICTS)
${facts.length ? facts.map((f) => `- "${f.text}"`).join("\n") : "- nothing"}
${prior}
## Files
${files.length ? fileBlocks.join("\n\n") : "No files. Use what a course with this name usually covers in this program and country, and say so in the summary. Don't ask for files under QUESTIONS: StudyDesk asks for missing materials itself."}

## What to write

Skills are the unit of mastery: one kind of problem the student must be able to solve ("Decide convergence with the ratio test"), small enough to practice in 2 to 15 minutes. Typically 4 to 8 skills per topic. Also list the fundamentals from earlier schooling that the course's skills rely on (e.g. "Simplify fractions with powers"), marked fundamental; keep those to what this course really needs.

- tier: the least ambitious target grade on the scale above that still needs this skill. Core skills get the scale's worst passing grade; skills only needed for top grades get the best grade.
- difficulty: normal or hard.
- minutes: a first guess of how long one typical problem takes a student.
- weight: 1 normal, 2 for skills the exam weighs heavily, 0.5 for side topics.
- prereqs: ids of skills (or fundamentals) this one builds on.
- A topic is "taught" if, judging by the syllabus schedule, homework sheets or the student's words, it has already been covered in class by today. Otherwise "upcoming".
- Homework: only real sheets with a hand-in date that hasn't passed. Copy each task's text word for word (TeX for math: $...$). Give each task the one skill it practices.
- Catalog: for every skill, where the files cover it (file key and pages "p. 3-5" or lines "l. 40-80"). Several lines per skill are fine. Skills with no coverage get no line.
- Teaching language: the language the course is taught and examined in.

Reply with exactly these sections, in this order, and nothing else. Use "|" between fields. Leave a section empty if there's nothing for it.

=== LOG ===
The student watches this section appear live, so write it first, as you work through the material: 3 to 12 short lines in English, one per thing you look at and what you take from it. Name the file and pages, e.g.:
- Reading F1 (Skript.pdf), p. 1-40: limits and sequences, 3 worked examples per section
- F2 (Blatt 3.pdf): homework due 2026-11-27, 4 tasks on series
- Grading rules: F3 p. 2 says the exam counts 100 %
If there are no files, say plainly that you are estimating from the course name and your general knowledge, not from their materials and not from the internet.

=== SUMMARY ===
Two to four plain sentences in English for the student: what you read and what you found (how many topics and skills), and anything they should double-check.

=== LANGUAGE ===
English

=== TOPICS ===
t1 | Topic name | taught

=== SKILLS ===
id | topic id | skill name | fundamental or course | tier | normal or hard | minutes | weight | prereq ids separated by commas, or -
(ids: short lowercase, like s1, s2, f1 for fundamentals)

=== GRADING ===
component | exam | 60
threshold | ${scale.best} | 87.5
(components with their weight in percent; thresholds: minimum percent for each grade. Only what the files or the student say.)

=== DATES ===
YYYY-MM-DD | exam or quiz | title | topic ids separated by commas

=== HOMEWORK ===
### Sheet title | YYYY-MM-DDTHH:MM
#### task label | skill id | max points
The task text, word for word.

=== CATALOG ===
skill id | F1 | p. 3-5

=== CONFLICTS ===
- one line each

=== QUESTIONS ===
- at most 3, most important first: only what would change the skill map, the dates or the grading. One short line each. Never ask them to upload files.`;
  return { turns: [{ role: "user", content }], images, fileKeys, clipped };
}

export class SetupFailed extends Error {}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
const bullets = (s: string | undefined) =>
  (s ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l && !/^\(.*\)$/.test(l) && !/^(none|nothing|-)\.?$/i.test(l));
const rows = (s: string | undefined) =>
  (s ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.includes("|") && !/^\(/.test(l))
    .map((l) => l.split("|").map((x) => x.trim()));

/** Turns the agent's reply into records. Ids are made unique per course. */
export function parseSetup(reply: string, input: Pick<SetupInput, "course" | "profile" | "today" | "priorFundamentals">, fileKeys: Map<string, string>, now = Date.now()): CourseSetup {
  const { course, profile } = input;
  const sec = parseSections(reply);
  const cid = course.id;
  const priorIds = new Set(input.priorFundamentals.map((p) => p.id));
  const topicId = (id: string) => `${cid}-t-${slug(id)}`;
  const skillId = (id: string) => (priorIds.has(id) ? id : `${cid}-${slug(id)}`);

  const topics: Topic[] = [];
  for (const [id, name, taught] of rows(sec.get("TOPICS"))) {
    if (!id || !name || topics.some((t) => t.id === topicId(id))) continue;
    topics.push({ id: topicId(id), name, taught: /^taught|^yes/i.test(taught ?? "") });
  }
  const fundTopic: Topic = { id: `${cid}-t-fundamentals`, name: "Fundamentals" };

  const scale = profile.gradeScale;
  const lo = Math.min(scale.best, scale.worst);
  const hi = Math.max(scale.best, scale.worst);
  const skills: Skill[] = [];
  const rawPrereqs = new Map<string, string[]>();
  for (const r of rows(sec.get("SKILLS"))) {
    const [id, tid, name, kind, tier, diff, minutes, weight, prereqs] = r;
    if (!id || !name) continue;
    const sid = skillId(id);
    if (skills.some((s) => s.id === sid)) continue;
    if (priorIds.has(id)) {
      // A fundamental already mastered in an earlier semester: keep its record and history.
      skills.push(input.priorFundamentals.find((p) => p.id === id)!);
      continue;
    }
    const isFundamental = /^fund/i.test(kind ?? "");
    const t = topics.find((x) => x.id === topicId(tid ?? ""));
    const tierN = Number((tier ?? "").replace(",", "."));
    const min = Number(minutes);
    const w = Number((weight ?? "").replace(",", "."));
    skills.push({
      id: sid,
      courseId: cid,
      topicId: isFundamental || !t ? (isFundamental ? fundTopic.id : topics[0]?.id ?? fundTopic.id) : t.id,
      name,
      difficulty: (/hard/i.test(diff ?? "") ? "hard" : "normal") as Difficulty,
      isFundamental,
      prereqSkillIds: [],
      tier: Number.isFinite(tierN) ? Math.min(hi, Math.max(lo, tierN)) : scale.worst,
      weight: Number.isFinite(w) && w > 0 ? w : 1,
      estMinutes: Number.isFinite(min) && min > 0 ? Math.min(45, Math.round(min)) : 6,
    });
    rawPrereqs.set(sid, (prereqs ?? "").split(/[,\s]+/).filter((x) => x && x !== "-"));
  }
  if (!skills.length) throw new SetupFailed(`No skills came back for ${course.name}.`);
  const ids = new Set([...skills.map((s) => s.id), ...priorIds]);
  for (const s of skills) if (rawPrereqs.has(s.id)) s.prereqSkillIds = rawPrereqs.get(s.id)!.map(skillId).filter((p) => ids.has(p) && p !== s.id);
  if (skills.some((s) => s.isFundamental) && !topics.some((t) => t.id === fundTopic.id)) topics.unshift(fundTopic);
  if (!topics.length) topics.push({ id: `${cid}-t-main`, name: course.name });
  for (const s of skills) if (!priorIds.has(s.id) && !topics.some((t) => t.id === s.topicId)) s.topicId = topics[0].id;

  // Grade rules: only when there are components or thresholds.
  const components: GradeRules["components"] = [];
  const thresholds: GradeRules["thresholds"] = [];
  for (const [kind, a, b] of rows(sec.get("GRADING"))) {
    const n = Number((b ?? "").replace(",", ".").replace("%", ""));
    if (!Number.isFinite(n)) continue;
    if (/^comp/i.test(kind)) components.push({ id: slug(a), weight: n });
    if (/^thres/i.test(kind)) {
      const g = Number((a ?? "").replace(",", "."));
      if (Number.isFinite(g)) thresholds.push({ grade: g, minPercent: n });
    }
  }
  const gradeRules: GradeRules | null = components.length || thresholds.length ? { courseId: cid, scale, components, thresholds } : null;

  const keyDates: KeyDate[] = [];
  for (const [date, kind, title, tids] of rows(sec.get("DATES"))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    const tset = new Set((tids ?? "").split(/[,\s]+/).filter(Boolean).map(topicId));
    const covered = skills.filter((s) => tset.has(s.topicId)).map((s) => s.id);
    keyDates.push({
      courseId: cid,
      date,
      kind: /quiz|test/i.test(kind ?? "") && !/exam/i.test(kind ?? "") ? "quiz" : "exam",
      title: title || "Exam",
      skillIds: covered.length ? covered : skills.map((s) => s.id),
    });
  }

  const assignments: Assignment[] = [];
  const hw = sec.get("HOMEWORK") ?? "";
  for (const block of hw.split(/^###(?!#)\s*/m).slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [title, due] = head.split("|").map((x) => x.trim());
    const dueAt = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(due ?? "") ? (due.length === 10 ? `${due}T23:59` : due) : null;
    if (!title || !dueAt || dueAt.slice(0, 10) < input.today) continue;
    const aid = `${cid}-hw-${slug(title)}`;
    const tasks: AssignmentTask[] = [];
    for (const tb of rest.join("\n").split(/^####\s*/m).slice(1)) {
      const [th, ...body] = tb.split("\n");
      const [label, sk, pts] = th.split("|").map((x) => x.trim());
      const sid = skillId(sk ?? "");
      const prompt = body.join("\n").trim();
      if (!label || !prompt || !skills.some((s) => s.id === sid)) continue;
      const p = Number((pts ?? "").replace(",", "."));
      tasks.push({ id: `${aid}-${slug(label)}`, label, skillId: sid, prompt, maxPoints: Number.isFinite(p) && p > 0 ? p : 1 });
    }
    if (tasks.length) assignments.push({ id: aid, courseId: cid, title, dueAt, tasks });
  }

  const catalog: CatalogEntry[] = [];
  for (const [sk, key, where] of rows(sec.get("CATALOG"))) {
    const sid = skillId(sk ?? "");
    const uploadId = fileKeys.get((key ?? "").toUpperCase());
    if (!uploadId || !skills.some((s) => s.id === sid)) continue;
    catalog.push({ skillId: sid, uploadId, where: where || "whole file" });
  }

  const language = (sec.get("LANGUAGE") ?? "").split("\n")[0].trim();
  return {
    courseId: cid,
    summary: (sec.get("SUMMARY") ?? "").replace(new RegExp(`\\*?\\(?${CUT_SHORT}[\\s\\S]*$`), "").trim(),
    teachingLanguage: language && language.length < 30 ? language : course.teachingLanguage || "English",
    topics,
    skills,
    gradeRules,
    keyDates,
    assignments,
    catalog,
    conflicts: bullets(sec.get("CONFLICTS")),
    questions: bullets(sec.get("QUESTIONS")).map((q) => q.replace(new RegExp(`\\*?\\(?${CUT_SHORT}[\\s\\S]*$`), "").trim()).filter(Boolean).slice(0, MAX_QUESTIONS),
    basis: fileKeys.size ? "materials" : "general",
    truncated: reply.includes(CUT_SHORT),
    finishedAt: now,
  };
}

/** Runs one course. Retries once with the problem named if the reply can't be used. */
export async function runCourseSetup(
  input: SetupInput,
  ask: Ask,
  signal?: AbortSignal,
  onText?: (text: string) => void,
): Promise<CourseSetup & { clipped: string[] }> {
  const { turns, images, fileKeys, clipped } = setupTurns(input);
  const reply = await ask(turns, { images, tier: "complex", signal, onText });
  try {
    return { ...parseSetup(reply, input, fileKeys), clipped };
  } catch (e) {
    const retry: Turn[] = [
      ...turns,
      { role: "assistant", content: reply },
      { role: "user", content: `That reply couldn't be used: ${(e as Error).message} Write the whole reply again in exactly the section format, with at least one line under SKILLS.` },
    ];
    onText?.("=== LOG ===\n- The first answer couldn't be used, so I'm writing it again");
    const again = await ask(retry, { images, tier: "complex", signal, onText });
    return { ...parseSetup(again, input, fileKeys), clipped };
  }
}

/** What the student sees while one course is being read: the agent's own log, then what it is writing now. */
export type LiveProgress = { log: string[]; stage: string | null; topics: number; skills: number };

const STAGES: Record<string, string> = {
  LOG: "reading",
  SUMMARY: "writing the summary",
  LANGUAGE: "writing the summary",
  TOPICS: "listing topics",
  SKILLS: "listing skills",
  GRADING: "noting the grading rules",
  DATES: "noting exam dates",
  HOMEWORK: "copying homework",
  CATALOG: "noting which pages cover which skill",
  CONFLICTS: "checking for contradictions",
  QUESTIONS: "writing questions for you",
};

/** Reads the half-written reply as it streams in. Pure, so it can run on every update. */
export function liveProgress(text: string): LiveProgress {
  const sec = parseSections(text);
  const keys = [...text.matchAll(/^===\s*(.+?)\s*===\s*$/gm)].map((m) => m[1].toUpperCase());
  const last = keys[keys.length - 1] ?? null;
  const lines = (k: string) =>
    (sec.get(k) ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("("));
  // While LOG is still the last section, its final line may be half written.
  const logAll = lines("LOG").map((l) => l.replace(/^[-*]\s*/, ""));
  const log = last === "LOG" && !/\n\s*$/.test(text) ? logAll.slice(0, -1) : logAll;
  return {
    log,
    stage: last ? STAGES[last] ?? null : null,
    topics: lines("TOPICS").filter((l) => l.includes("|")).length,
    skills: lines("SKILLS").filter((l) => l.includes("|")).length,
  };
}

/** Local preview stand-in: a small generic map so the flow can be clicked through. */
export function localSetup(input: SetupInput, now = Date.now()): CourseSetup {
  const c = input.course;
  const reply = `=== SUMMARY ===
Local preview: inside claude.ai, StudyDesk reads your files for ${c.name} here. This is a made-up map with 2 topics and 6 skills.
=== LANGUAGE ===
English
=== TOPICS ===
t1 | Basics of ${c.name} | taught
t2 | Next chapter | upcoming
=== SKILLS ===
f1 | - | Fractions and powers | fundamental | ${input.profile.gradeScale.worst} | normal | 2 | 1 | -
f2 | - | Solving linear equations | fundamental | ${input.profile.gradeScale.worst} | normal | 3 | 1 | -
s1 | t1 | First core skill of ${c.name} | course | ${input.profile.gradeScale.worst} | normal | 6 | 2 | f1
s2 | t1 | Second core skill | course | ${input.profile.gradeScale.worst} | normal | 8 | 1 | s1
s3 | t2 | A later skill | course | ${input.profile.gradeScale.best} | hard | 10 | 1 | s1,f2
s4 | t2 | Another later skill | course | ${input.profile.gradeScale.worst} | normal | 7 | 1 | s2
=== DATES ===
${addMonths(input.today, 2)} | exam | Final exam (preview) | t1,t2
`;
  const keys = new Map(input.files.map((f, i) => [`F${i + 1}`, f.upload.id]));
  return parseSetup(reply, input, keys, now);
}

function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T12:00`);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Builds the quest module's semester from the draft and every finished course. */
export function buildSemester(draft: SemesterDraft, profile: Profile, now = Date.now()): Semester {
  const courses = draft.courses.filter((c) => draft.results[c.id]);
  const res = courses.map((c) => draft.results[c.id]);
  return {
    id: draft.id,
    name: draft.name,
    source: "onboarding",
    createdAt: now,
    startDate: draft.startDate,
    endDate: draft.endDate,
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      short: c.short,
      teachingLanguage: draft.results[c.id].teachingLanguage || c.teachingLanguage,
      topics: draft.results[c.id].topics,
    })),
    targets: courses
      .filter((c) => c.targetGrade !== null)
      .map((c) => ({ courseId: c.id, targetGrade: c.targetGrade!, gradeScale: profile.gradeScale })),
    skills: dedupe(res.flatMap((r) => r.skills)),
    assignments: res.flatMap((r) => r.assignments),
    keyDates: res.flatMap((r) => r.keyDates),
    timetable: draft.timetable,
    studyGoal: draft.studyGoal,
    studyGoalSource: "student",
    calendarSync: !!draft.calendarImportedAt,
    gradeRules: res.flatMap((r) => (r.gradeRules ? [r.gradeRules] : [])),
    uploads: draft.uploads,
    catalog: res.flatMap((r) => r.catalog),
  };
}

function dedupe(skills: Skill[]): Skill[] {
  const seen = new Set<string>();
  return skills.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}
