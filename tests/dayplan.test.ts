import { describe, expect, it } from "vitest";
import { busySpans, freeWindows, hhmm, placeBlocks, toMinute } from "../src/plan/clock";
import { DAY_PLAN, dueLine, planDays, recordsOnDay, type PlannedBlock } from "../src/plan/day";
import { questsForDay } from "../src/plan/build";
import { today as todayLine } from "../src/plan/today";
import { emptyProgress } from "../src/quests/handin";
import type { Skill } from "../src/mastery/types";
import type { ProblemPart, Quest, QuestRecord, Semester, TimetableEntry } from "../src/quests/types";

const GERMAN = { name: "German 1–6", best: 1, worst: 6 };
const MONDAY = "2026-11-23";

const skill = (courseId: string, i: number, extra: Partial<Skill> = {}): Skill => ({
  id: `${courseId}-${i}`,
  courseId,
  topicId: `${courseId}-t`,
  name: `${courseId} skill ${i}`,
  difficulty: "normal",
  isFundamental: false,
  prereqSkillIds: [],
  tier: 4,
  weight: 1,
  estMinutes: 5,
  ...extra,
});

const lessons = (weekday: number): TimetableEntry[] =>
  [
    ["08:00", "09:00"],
    ["09:00", "10:00"],
    ["10:15", "11:15"],
    ["11:30", "12:30"],
    ["12:30", "13:10"],
  ].map(([start, end]) => ({ weekday, start, end, kind: "lecture", title: "Lesson", courseId: null }));

/** Four school subjects, three Klausuren in the next two weeks, homework due tomorrow morning. */
function school(over: Partial<Semester> = {}): Semester {
  const courses = ["M", "EK", "GE", "KU"].map((id) => ({ id, name: { M: "Mathe", EK: "Erdkunde", GE: "Geschichte", KU: "Kunst" }[id]!, short: id, teachingLanguage: "German", topics: [{ id: `${id}-t`, name: "Topic" }] }));
  const skills = ["M", "EK", "GE"].flatMap((c) => [1, 2, 3, 4, 5, 6].map((i) => skill(c, i)));
  return {
    id: "sem",
    name: "WS 2026/27",
    source: "onboarding",
    createdAt: 0,
    courses,
    targets: courses.map((c) => ({ courseId: c.id, targetGrade: 2, gradeScale: GERMAN })),
    skills,
    assignments: [
      {
        id: "hw1",
        courseId: "M",
        title: "Hausaufgabe",
        dueAt: "2026-11-24T08:00",
        tasks: [
          { id: "t1", label: "10a", skillId: "M-1", prompt: "a", maxPoints: 2 },
          { id: "t2", label: "10b", skillId: "M-2", prompt: "b", maxPoints: 2 },
        ],
      },
    ],
    keyDates: [
      { courseId: "EK", date: "2026-12-02", kind: "exam", title: "Klausur Erdkunde", skillIds: [] },
      { courseId: "GE", date: "2026-12-04", kind: "exam", title: "Klausur Geschichte", skillIds: [] },
      { courseId: "KU", date: "2026-12-04", kind: "exam", title: "Klausur Kunst", skillIds: [] },
      { courseId: "M", date: "2026-12-08", kind: "exam", title: "Klausur Mathe", skillIds: [] },
    ],
    timetable: [1, 2, 3, 4, 5].flatMap(lessons),
    // School is 280 min; the goal leaves 140 min, and a new student plans half of that.
    studyGoal: [0, 420, 420, 420, 420, 420, 60],
    ...over,
  };
}

const input = (semester: Semester, extra: Partial<Parameters<typeof planDays>[0]> = {}) => ({
  semester,
  today: MONDAY,
  nowLocal: `${MONDAY}T15:40`,
  attempts: [],
  reviews: [],
  records: [] as QuestRecord[],
  ...extra,
});

const quest = (id: string, courseId: string, date: string, over: Partial<Quest> = {}): Quest => ({
  id,
  date,
  courseId,
  budgetMinutes: 20,
  plannedMinutes: 20,
  reason: "r",
  notes: [],
  parts: [],
  createdAt: 0,
  ...over,
});

describe("the clock", () => {
  it("makes one stretch of school from lessons that follow each other, and keeps other appointments", () => {
    const spans = busySpans(lessons(1), 1, [
      { start: "09:00", end: "10:00", title: "Physik (calendar)" },
      { start: "17:00", end: "18:30", title: "Fußball" },
    ]);
    expect(spans.map((s) => [hhmm(s.start), hhmm(s.end), s.kind])).toEqual([
      ["08:00", "13:10", "school"],
      ["17:00", "18:30", "busy"],
    ]);
  });

  it("keeps the first hour after school free, works around appointments, and stops before the hand-in time", () => {
    const spans = busySpans(lessons(1), 1, [{ start: "17:00", end: "18:30", title: "Fußball" }]);
    expect(freeWindows(spans).map((w) => [hhmm(w.start), hhmm(w.end)])).toEqual([
      ["14:10", "17:00"],
      ["18:40", "21:30"],
    ]);
    expect(freeWindows(spans, toMinute("16:00")).map((w) => hhmm(w.start))).toEqual(["16:00", "18:40"]);
    expect(freeWindows(busySpans([], 6)).map((w) => hhmm(w.start))).toEqual(["10:00"]);
  });

  it("puts blocks in order, with a break between them, into the first window they fit", () => {
    const windows = [
      { start: toMinute("14:10"), end: toMinute("15:00") },
      { start: toMinute("15:30"), end: toMinute("21:30") },
    ];
    const placed = placeBlocks(windows, [
      { key: "a", minutes: 25 },
      { key: "b", minutes: 25 },
      { key: "c", minutes: 600 },
    ]);
    expect(placed.map((p) => [p.key, p.start === null ? null : hhmm(p.start)])).toEqual([
      ["a", "14:10"],
      ["b", "15:30"],
      ["c", null],
    ]);
  });
});

describe("the day plan", () => {
  it("shares a day between courses: homework due tomorrow first, then the nearest Klausur", () => {
    const [day] = planDays(input(school())).days;
    expect(day.budget).toBe(70);
    expect(day.blocks.map((b) => [b.courseId, b.kind])).toEqual([
      ["M", "homework"],
      ["EK", "exam"],
    ]);
    expect(dueLine(day.blocks[0].dueAt!, MONDAY)).toBe("Due tomorrow 08:00");
  });

  it("prepares every Klausur in the next weeks, spread backwards from its date, not only one course", () => {
    const p = planDays(input(school(), { days: 21 }));
    for (const c of ["EK", "GE", "M"]) {
      const exam = p.exams.find((e) => e.courseId === c)!;
      const before = p.days.flatMap((d) => d.blocks).filter((b) => b.courseId === c && b.day < exam.date && b.examKeys.length);
      expect(before.length, c).toBeGreaterThanOrEqual(2);
      // Never two prep blocks for one exam on one day.
      expect(new Set(before.map((b) => b.day)).size).toBe(before.length);
    }
    // A course with nothing to learn from yet needs the student.
    expect(p.exams.find((e) => e.courseId === "KU")!.status).toBe("needs_you");
    // No day is planned past its time, except homework that's due.
    for (const d of p.days) {
      const planned = d.blocks.filter((b) => b.kind !== "homework").reduce((s, b) => s + b.minutes, 0);
      expect(planned).toBeLessThanOrEqual(Math.ceil(d.budget * (1 + DAY_PLAN.overBudget)));
    }
    // Sunday has no study goal, so nothing is planned.
    expect(p.days.find((d) => d.day === "2026-11-29")!.blocks).toHaveLength(0);
  });

  it("says when the time isn't enough, instead of quietly dropping exam prep", () => {
    const p = planDays(input(school({ studyGoal: [0, 300, 300, 300, 300, 300, 0] }), { days: 14 }));
    expect(p.leftOut.some((b) => b.kind === "exam")).toBe(true);
    expect(p.neededPerDay).toBeGreaterThan(p.budgetPerDay);
    expect(p.exams.filter((e) => e.status === "behind" || e.status === "tight").length).toBeGreaterThan(0);
  });

  it("counts a block that exists already, and doesn't plan its course twice that day", () => {
    const rec: QuestRecord = { quest: quest("q-m", "M", MONDAY, { plannedMinutes: 30, block: { kind: "homework", tone: "due", rank: 1, examKeys: [], dueAt: "2026-11-24T08:00" } }), progress: emptyProgress("q-m") };
    const [day] = planDays(input(school(), { records: [rec] })).days;
    expect(day.blocks.filter((b) => b.courseId === "M")).toHaveLength(1);
    expect(day.blocks[0].recordId).toBe("q-m");
    expect(day.blocks.some((b) => b.courseId === "EK")).toBe(true);
  });

  it("moves a block to the day the student picked, and leaves out one they skipped", () => {
    const moved: QuestRecord = { quest: quest("q1", "EK", MONDAY), progress: { ...emptyProgress("q1"), deferredTo: "2026-11-24" } };
    const skipped: QuestRecord = { quest: quest("q2", "GE", MONDAY), progress: { ...emptyProgress("q2"), skippedOn: MONDAY } };
    expect(recordsOnDay([moved, skipped], MONDAY)).toHaveLength(0);
    expect(recordsOnDay([moved, skipped], "2026-11-24").map((r) => r.quest.id)).toEqual(["q1"]);
    // Moving or skipping doesn't make room for a new block of the same course that day.
    const [day] = planDays(input(school({ assignments: [] }), { records: [moved, skipped] })).days;
    expect(day.blocks.some((b) => b.courseId === "EK" || b.courseId === "GE")).toBe(false);
  });

  it("takes the placement check two courses a day, nearest Klausur first", () => {
    const part = (id: string, course: string): ProblemPart => ({
      kind: "practice",
      id,
      title: `${course}: where you stand`,
      gate: false,
      check: true,
      problems: [{ id: `${id}-p`, skillId: "M-1", prompt: "", answerKey: "", hints: [], similarSolved: null, expMinutes: 6, maxPoints: 2 }],
    });
    const placement: QuestRecord = {
      quest: quest("place", "M", "2026-11-22", { parts: [part("pm", "Mathe"), part("pek", "Erdkunde"), part("pge", "Geschichte")] }),
      progress: { ...emptyProgress("place"), partsNotBefore: { pge: "2026-11-24" } },
    };
    const p = planDays(input(school({ placementQuestId: "place", assignments: [] }), { records: [placement], days: 2 }));
    const checks = (d: number) => p.days[d].blocks.filter((b) => b.kind === "check").map((b) => b.courseId);
    // Geschichte was moved to tomorrow, so today checks Erdkunde (2 Dec) and Mathe.
    expect(checks(0)).toEqual(["EK", "M"]);
    expect(checks(1)).toEqual(["GE"]);
    // A check and prep for the same course don't share a day.
    expect(p.days[0].blocks.filter((b) => b.courseId === "EK")).toHaveLength(1);
  });

  it("plans nothing on a day off", () => {
    const p = planDays(input(school({ daysOff: [MONDAY] })));
    expect(p.days[0].blocks).toHaveLength(0);
  });

  it("turns each block into a normal quest for its course, sized to the block", () => {
    const [day] = planDays(input(school())).days;
    const quests = questsForDay(day, { semester: school(), nowLocal: `${MONDAY}T15:40`, attempts: [], reviews: [], records: [], now: 1 });
    expect(quests.map((q) => q.quest.courseId)).toEqual(["M", "EK"]);
    expect(quests[0].quest.parts.some((p) => p.kind === "assignment")).toBe(true);
    expect(quests[1].quest.block?.kind).toBe("exam");
    expect(quests[1].quest.reason).toMatch(/^Klausur Wed 2 Dec · in 9 days: this block starts/);
    expect(new Set(quests.map((q) => q.quest.id)).size).toBe(2);
  });
});

describe("today on the clock", () => {
  const block = (key: string, courseId: string, minutes: number, rank: number): PlannedBlock => ({ key, kind: "exam", courseId, minutes, day: MONDAY, rank, tone: "exam", examKeys: [] });
  const blocks = [block("m", "M", 25, 1), block("ek", "EK", 25, 2), block("ge", "GE", 20, 2.1)];

  it("places the blocks after school, says which is now, and when the day is done", () => {
    const t = todayLine({ blocks, state: () => ({ done: false, started: false }), timetable: lessons(1), weekday: 1, now: toMinute("15:42"), anchor: toMinute("15:42") });
    expect(t.blocks.map((b) => [b.block.key, hhmm(b.start!), b.status])).toEqual([
      ["m", "15:45", "now"],
      ["ek", "16:20", "later"],
      ["ge", "16:55", "later"],
    ]);
    expect(hhmm(t.doneBy!)).toBe("17:15");
    expect(t.items[0]).toMatchObject({ type: "busy", kind: "school", past: true });
  });

  it("moves what wasn't started to the next free time, and says where it was", () => {
    const t = todayLine({ blocks, state: (b) => ({ done: b.key === "m", started: false }), timetable: lessons(1), weekday: 1, now: toMinute("16:31") });
    expect(t.now?.block.key).toBe("ek");
    expect(hhmm(t.now!.start!)).toBe("16:35");
    expect(t.now!.movedFrom).not.toBeNull();
    expect(t.blocks.find((b) => b.block.key === "m")!.status).toBe("done");
  });

  it("keeps the block being worked on as now, and puts \"later today\" last", () => {
    const t = todayLine({
      blocks,
      state: (b) => ({ done: false, started: b.key === "ge", laterAt: b.key === "m" ? 5 : undefined }),
      timetable: lessons(1),
      weekday: 1,
      now: toMinute("16:00"),
    });
    expect(t.now?.block.key).toBe("ge");
    expect(t.blocks.map((b) => b.block.key)).toEqual(["ek", "ge", "m"]);
  });
});
