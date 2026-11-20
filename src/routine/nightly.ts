// The nightly run: grade the day, check the courses, write tomorrow's quest.
// design/scheduled-runs.md.
//
// Runs in a cloud session at 22:00 the student's time (src/routine/cli.ts),
// on a copy of the student's data. Uses the page's own code for everything
// that has one right answer (grading rules, mastery, planning, checks), and
// asks Claude, through `ask`, only for judging and writing. It returns the
// documents to write; it never writes anything itself.
//
// Order matters: tomorrow's quest is planned from tonight's grades and from
// whatever the organization agent found, so it comes last.

import { addDays } from "../mastery/days";
import { replay } from "../mastery/replay";
import type { Attempt, Day, ReviewItem, Skill } from "../mastery/types";
import type { MasteryData } from "../platform/masteryStore";
import type { Profile, SemesterDraft } from "../onboarding/types";
import { parseSetup, setupTurns, type FileForSetup, type SetupInput } from "../onboarding/setup";
import { syncSemester, type Desk } from "../orchestrator/changes";
import type { Turn } from "../platform/claude";
import { emptyProgress, handIn, ungraded } from "../quests/handin";
import { carriedOver, doneTasks, planQuest, recentBlockers, recentFeel } from "../quests/plan";
import type { QuestRecord, Semester } from "../quests/types";
import { claudeWriter, writeQuest } from "../quests/write";
import { applyShallow, applySweep, gradingFields, mergeGrading, outboxId, outboxOrder, type GradingOutbox, type OutboxDoc, type ShallowOutbox, type SweepOutbox } from "./apply";
import { isPending, type DeferredAsk } from "./deferred";
import { nextOrgState, parseShallow, shallowTurns, sweepsDue, type OrgState, type ShallowResult } from "./org";

/** What the page keeps about the nightly schedule, on the student's profile. */
export type ScheduleInfo = {
  /** The scheduled task in the student's Claude account. */
  triggerId: string;
  /** Written into the task's prompt; a task whose key isn't this one was replaced and does nothing. */
  key: string;
  timeZone: string;
  /** "22:00" */
  time: string;
  createdAt: number;
};

/** What the student can change about the nightly run (through the StudyDesk chat). */
export type NightlySettings = {
  /** "HH:MM" in the student's time zone. */
  time: string;
  /** Nothing runs while paused. */
  paused: boolean;
  /** Each part can be turned off on its own. */
  grading: boolean;
  check: boolean;
  quest: boolean;
};

export const NIGHTLY_DEFAULTS: NightlySettings = { time: "22:00", paused: false, grading: true, check: true, quest: true };

export const nightlySettings = (s: Partial<NightlySettings> | undefined): NightlySettings => ({ ...NIGHTLY_DEFAULTS, ...(s ?? {}) });

export type NightLog = {
  day: Day;
  status: "working" | "done" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number | null;
  lines: string[];
  /** The quest written for the next day, if any. */
  questId: string | null;
};

/** data/users/<uid>/routine: what the nightly run keeps between nights. */
export type RoutineDoc = {
  org: OrgState;
  /** The last 14 nights, newest last. */
  nights: NightLog[];
  updatedAt: number;
};

export const emptyRoutine = (): RoutineDoc => ({ org: {}, nights: [], updatedAt: 0 });

export type NightInput = {
  today: Day;
  /** Local time now, "YYYY-MM-DDTHH:MM". */
  nowLocal: string;
  now: number;
  profile: Profile | null;
  draft: SemesterDraft | null;
  semester: Semester | null;
  records: QuestRecord[];
  mastery: MasteryData;
  outbox: OutboxDoc[];
  routine: RoutineDoc | null;
  /** Answer photos by id, as data URLs. */
  images: Map<string, string>;
  /** Readable content of the student's files, by upload id. */
  uploads: Map<string, { text?: string; image?: string }>;
};

/** One document to write. Paths are relative to the student's own area, data/users/<uid>. */
export type Write = { path: string[]; data: Record<string, unknown>; mode: "create" | "replace" };

export type NightResult =
  | { kind: "pending"; log: string[] }
  | { kind: "done"; writes: Write[]; log: string[]; night: NightLog };

const plain = <T>(x: T) => JSON.parse(JSON.stringify(x)) as Record<string, unknown>;

function dataUrlToBlob(url: string): Blob {
  const [head, body] = url.split(",");
  const type = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
  const bin = atob(body ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayName = (day: Day) => {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

export async function runNightly(input: NightInput, d: DeferredAsk): Promise<NightResult> {
  const { today, now } = input;
  const tomorrow = addDays(today, 1);
  const log: string[] = [];
  const writes: Write[] = [];
  const routine = input.routine ?? emptyRoutine();
  const settings = nightlySettings(input.profile?.nightly);

  // ---- 0. What earlier nights left for the page, as if the page had opened ----
  let records = input.records.map((r) => r);
  let desk: Desk | null = input.draft && input.profile ? { draft: input.draft, profile: input.profile } : null;
  for (const box of outboxOrder(input.outbox)) {
    if (box.kind === "grading") records = records.map((r) => (r.quest.id === box.questId ? mergeGrading(r, box, now) : r));
    else if (desk && box.kind === "org-sweep") desk = applySweep(desk, box, now);
    else if (desk && box.kind === "org-shallow") desk = applyShallow(desk, box, now).desk;
  }
  let semester = input.semester;
  if (desk && desk.draft.status === "active" && semester && semester.id === desk.draft.id) semester = syncSemester(desk.draft, desk.profile, semester, now);

  const mastery: MasteryData = {
    skills: [...input.mastery.skills],
    targets: input.mastery.targets,
    attempts: [...input.mastery.attempts],
    reviews: [...input.mastery.reviews],
  };
  if (semester) for (const s of semester.skills) if (!mastery.skills.some((x) => x.id === s.id)) mastery.skills.push(s);

  // ---- 1. Grading and 2. the organization agent, side by side ----
  if (!settings.grading) log.push("Grading at night is turned off; use \"Grade me early\".");
  if (!settings.check) log.push("The courses' nightly check is turned off.");
  const grading = settings.grading ? gradeAll(input, records, semester, d, log) : Promise.resolve({ pending: false, attempts: [], reviews: [], boxes: [] as GradingOutbox[] });
  const org = settings.check && desk && desk.draft.status === "active" && desk.draft.courses.length ? organize(input, desk, routine.org, mastery, d, log) : Promise.resolve(null);
  const [g, o] = await Promise.all([grading, org]);
  if (g.pending || o?.pending) return { kind: "pending", log };

  // Grades: attempts and review items go straight to the mastery store (new
  // documents only); the quest's own record waits in the outbox for the page.
  for (const a of g.attempts) writes.push({ path: ["mastery", "attempts", a.id], data: plain(a), mode: "create" });
  for (const r of g.reviews) writes.push({ path: ["mastery", "reviews", r.attemptId], data: plain(r), mode: "create" });
  for (const box of g.boxes) writes.push({ path: ["routine", "outbox", box.id], data: plain(box), mode: "create" });
  mastery.attempts.push(...g.attempts);
  for (const r of g.reviews) {
    const i = mastery.reviews.findIndex((x) => x.attemptId === r.attemptId);
    if (i >= 0) mastery.reviews[i] = r;
    else mastery.reviews.push(r);
  }
  records = records.map((r) => {
    const box = g.boxes.find((b) => b.questId === r.quest.id);
    return box ? mergeGrading(r, box, now) : r;
  });

  let orgState = routine.org;
  if (o && desk) {
    for (const box of o.boxes) writes.push({ path: ["routine", "outbox", box.id], data: plain(box), mode: "create" });
    for (const box of o.boxes) {
      if (box.kind === "org-sweep") desk = applySweep(desk, box, now);
      else if (box.kind === "org-shallow") desk = applyShallow(desk, box, now).desk;
    }
    orgState = nextOrgState(routine.org, desk.draft, today, o.shallow, o.swept);
    if (semester && semester.id === desk.draft.id) semester = syncSemester(desk.draft, desk.profile, semester, now);
  }

  // ---- 3. Tomorrow's quest ----
  let questId: string | null = null;
  const q = settings.quest ? await writeTomorrow(semester, records, mastery, tomorrow, now, d, log) : { pending: false, record: null };
  if (!settings.quest) log.push("Writing the quest overnight is turned off; it's written when you open StudyDesk.");
  if (q.pending) return { kind: "pending", log };
  if (q.record) {
    questId = q.record.quest.id;
    writes.push({ path: ["quests", "records", questId], data: plain(q.record), mode: "create" });
  }

  const night: NightLog = { day: today, status: "done", startedAt: now, finishedAt: null, lines: log, questId };
  const nights = [...routine.nights.filter((n) => n.day !== today), night].slice(-14);
  writes.push({ path: ["routine"], data: plain({ org: orgState, nights, updatedAt: now } satisfies RoutineDoc), mode: "replace" });
  return { kind: "done", writes, log, night };
}

// ---------- grading ----------

async function gradeAll(input: NightInput, records: QuestRecord[], semester: Semester | null, d: DeferredAsk, log: string[]) {
  const out = { pending: false, attempts: [] as Attempt[], reviews: [] as ReviewItem[], boxes: [] as GradingOutbox[] };
  if (!semester) return out;
  const todo = records.filter((r) => !r.progress.replacedAt && r.quest.date <= input.today && ungraded(r.quest, r.progress).length);
  if (!todo.length) {
    log.push("Grading: nothing was handed in that still needed grading.");
    return out;
  }
  const results = await Promise.all(
    todo.map((r) =>
      settle(
        (async () => {
          const problems = ungraded(r.quest, r.progress);
          const images: Record<string, Blob[]> = {};
          for (const { problem } of problems) {
            const files = (r.progress.work[problem.id]?.files ?? []).filter((f) => f.kind === "image" && f.stored);
            const blobs = files.map((f) => input.images.get(f.id)).filter((u): u is string => !!u).map(dataUrlToBlob);
            if (blobs.length) images[problem.id] = blobs;
          }
          const res = await handIn({
            quest: r.quest,
            problems,
            work: r.progress.work,
            images,
            semester,
            today: input.today,
            nowLocal: input.nowLocal,
            ask: d.ask(`Grading ${weekdayName(r.quest.date)}'s quest (${r.quest.date})`),
            now: input.now,
          });
          return { r, res, count: problems.length };
        })(),
      ),
    ),
  );
  for (const x of results) {
    if (!x.ok) {
      if (isPending(x.e)) out.pending = true;
      else log.push(`Grading failed for one quest: ${(x.e as Error)?.message ?? String(x.e)} It stays ungraded; "Grade me early" can try again.`);
      continue;
    }
    const { r, res, count } = x.v;
    out.attempts.push(...res.attempts);
    out.reviews.push(...res.reviews);
    const work = Object.fromEntries(Object.entries(res.work).map(([pid, w]) => [pid, gradingFields(w)]));
    out.boxes.push({ kind: "grading", id: outboxId("grading", input.today, r.quest.id.slice(-6)), day: input.today, questId: r.quest.id, work, createdAt: input.now });
    const solved = res.attempts.filter((a) => a.verdict === "solved").length;
    log.push(`Graded ${weekdayName(r.quest.date)}'s quest: ${solved} of ${count} problems solved.`);
  }
  return out;
}

// ---------- the organization agent ----------

async function organize(input: NightInput, desk: Desk, org: OrgState, mastery: MasteryData, d: DeferredAsk, log: string[]) {
  const out = { pending: false, boxes: [] as OutboxDoc[], shallow: null as ShallowResult | null, swept: [] as string[] };
  const { draft, profile } = desk;
  const today = input.today;

  // Deep sweeps due tonight: the course's full setup reading, with the web.
  const due = sweepsDue(draft, org, today);
  const { states } = replay(mastery.skills, mastery.attempts, mastery.reviews);
  const prior = mastery.skills.filter((s): s is Skill => s.isFundamental && ["mastered", "retained"].includes(states.get(s.id)?.stage ?? ""));
  const sweeps = due.map((cid) =>
    settle(
      (async () => {
        const course = draft.courses.find((c) => c.id === cid)!;
        const files: FileForSetup[] = [];
        for (const u of draft.uploads.filter((x) => x.courseId === cid)) {
          const content = input.uploads.get(u.id);
          if (content?.text) files.push({ upload: u, text: content.text, image: null });
        }
        const si: SetupInput = { profile, draft, course, facts: draft.facts.filter((f) => f.courseId === cid), files, today, priorFundamentals: prior };
        const { turns, fileKeys } = setupTurns(si, { web: true });
        const ask = d.ask(`Deep sweep of ${course.name}: read its materials and pages again`, true);
        const reply = await ask(turns, { tier: "complex" });
        let setup;
        try {
          setup = parseSetup(reply, si, fileKeys, input.now);
        } catch (e) {
          const retry: Turn[] = [
            ...turns,
            { role: "assistant", content: reply },
            { role: "user", content: `That reply couldn't be used: ${(e as Error).message} Write the whole reply again in exactly the section format, with at least one line under SKILLS.` },
          ];
          setup = parseSetup(await ask(retry, { tier: "complex" }), si, fileKeys, input.now);
        }
        return { cid, name: course.name, setup, readIds: files.map((f) => f.upload.id) };
      })(),
    ),
  );

  // The short check, all courses in one call.
  const shallowAsk = d.ask("Tonight's short check of every course (dates, new homework, next deep sweep)", true);
  const shallow = settle(
    (async () => {
      const turns = shallowTurns(draft, profile, org, today);
      const reply = await shallowAsk(turns, { tier: "default" });
      try {
        return parseShallow(reply, draft, today);
      } catch (e) {
        const retry: Turn[] = [...turns, { role: "assistant", content: reply }, { role: "user", content: `That reply can't be used: ${(e as Error).message} Reply again in exactly the four sections.` }];
        return parseShallow(await shallowAsk(retry, { tier: "default" }), draft, today);
      }
    })(),
  );

  for (const x of await Promise.all(sweeps)) {
    if (!x.ok) {
      if (isPending(x.e)) out.pending = true;
      else log.push(`A deep sweep failed: ${(x.e as Error)?.message ?? String(x.e)} It runs again tomorrow night.`);
      continue;
    }
    const box: SweepOutbox = { kind: "org-sweep", id: outboxId("org-sweep", today, x.v.cid), day: today, semesterId: draft.id, courseId: x.v.cid, setup: x.v.setup, readIds: x.v.readIds, createdAt: input.now };
    out.boxes.push(box);
    out.swept.push(x.v.cid);
    log.push(`Deep sweep of ${x.v.name}: ${x.v.setup.skills.length} skills, ${x.v.setup.assignments.length} homework sheets, ${x.v.setup.keyDates.length} dates.`);
  }
  const s = await shallow;
  if (!s.ok) {
    if (isPending(s.e)) out.pending = true;
    else log.push(`The short check of the courses failed: ${(s.e as Error)?.message ?? String(s.e)}`);
    return out;
  }
  out.shallow = s.v;
  if (s.v.ops.length || s.v.questions.length || s.v.note) {
    const box: ShallowOutbox = { kind: "org-shallow", id: outboxId("org-shallow", today), day: today, semesterId: draft.id, ops: s.v.ops, questions: s.v.questions, note: s.v.note, createdAt: input.now };
    out.boxes.push(box);
  }
  log.push(`Checked the courses: ${s.v.note || "nothing new."}${s.v.ops.length ? ` ${s.v.ops.length} ${s.v.ops.length === 1 ? "change" : "changes"} to look at.` : ""}${s.v.questions.length ? ` ${s.v.questions.length} ${s.v.questions.length === 1 ? "question" : "questions"} for you.` : ""}`);
  for (const k of s.v.skipped) log.push(`Left for you: ${k}.`);
  return out;
}

// ---------- tomorrow's quest ----------

async function writeTomorrow(semester: Semester | null, records: QuestRecord[], mastery: MasteryData, tomorrow: Day, now: number, d: DeferredAsk, log: string[]) {
  const out = { pending: false, record: null as QuestRecord | null };
  if (!semester) {
    log.push("No semester yet, so no quest was written.");
    return out;
  }
  if (semester.source === "onboarding" && !semester.placementQuestId) {
    log.push("The placement check comes first, so tomorrow's quest is written when you open StudyDesk.");
    return out;
  }
  if (records.some((r) => r.quest.date === tomorrow && !r.progress.replacedAt)) {
    log.push("Tomorrow's quest already exists.");
    return out;
  }
  const res = planQuest({
    semester,
    today: tomorrow,
    nowLocal: `${tomorrow}T00:00`,
    attempts: mastery.attempts,
    reviews: mastery.reviews,
    doneTaskIds: doneTasks(records),
    blockerSkillIds: recentBlockers(records, tomorrow),
    questId: `qst_${tomorrow}_${now.toString(36)}`,
  });
  if (res.kind !== "quest") {
    log.push(res.kind === "no_time" ? "Tomorrow has no study time planned, so there's no quest." : "Nothing to do tomorrow, so there's no quest.");
    return out;
  }
  const { states } = replay(mastery.skills, mastery.attempts, mastery.reviews);
  const knownIds = [...states.values()].filter((s) => s.stage === "mastered" || s.stage === "retained").map((s) => s.skillId);
  const feel = recentFeel(records, (id) => semester.skills.find((s) => s.id === id)?.name, tomorrow);
  const carried = carriedOver(records, res.quest);
  if (carried.length) res.quest.notes.unshift(`Carried over from ${weekdayName(carried[0].from)}, when the quest wasn't finished: ${carried.map((c) => c.label).join(", ")}.`);
  const course = semester.courses.find((c) => c.id === res.quest.courseId);
  const writer = claudeWriter(semester, res.quest, knownIds, d.ask(`Writing tomorrow's quest (${course?.name ?? "quest"}, ${weekdayName(tomorrow)})`));
  try {
    // Every part at once: each call that still needs an answer is listed in one go.
    const quest = await writeQuest(res.quest, writer, undefined, { concurrency: res.quest.parts.length });
    out.record = { quest, progress: emptyProgress(quest.id) };
    const minutes = quest.plannedMinutes;
    log.push(`Wrote tomorrow's quest: ${course?.name ?? "quest"}, ${quest.parts.length} ${quest.parts.length === 1 ? "part" : "parts"}, about ${minutes} min. It goes by your weekly timetable; your calendar isn't read at night.`);
  } catch (e) {
    if (isPending(e)) out.pending = true;
    else log.push(`Tomorrow's quest couldn't be written (${(e as Error)?.message ?? String(e)}). StudyDesk writes it when you open it.`);
  }
  return out;
}
