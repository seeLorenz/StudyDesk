import { describe, expect, it } from "vitest";
import { applyOps, canUndo, isRealDay, syncSemester, undoChange, type Desk } from "../src/orchestrator/changes";
import { advanceJobs, startJob } from "../src/orchestrator/jobs";
import { checkinTriggers, speed } from "../src/orchestrator/signals";
import { needsSummary, orchTurns, questStarted, todaysQuest } from "../src/orchestrator/agent";
import { applyQuestSettings, QUEST_CONFIG } from "../src/quests/config";
import { emptyState, type OrchMessage } from "../src/orchestrator/types";
import type { CourseSetup, Profile, SemesterDraft } from "../src/onboarding/types";
import type { QuestRecord } from "../src/quests/types";
import { planQuest } from "../src/quests/plan";
import { buildSemester } from "../src/onboarding/setup";
import { setupTodo } from "../src/onboarding/todo";

const TODAY = "2026-11-20"; // a Friday
const profile: Profile = { level: "university", school: "TU", country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 }, program: "BSc Physics", year: "1", updatedAt: 0 };

function result(courseId: string, finishedAt = 1): CourseSetup {
  return {
    courseId,
    summary: "",
    teachingLanguage: "German",
    topics: [{ id: "t1", name: "Folgen", taught: true }],
    skills: [
      { id: `${courseId}-s1`, courseId, topicId: "t1", name: "Grenzwerte", difficulty: "normal", isFundamental: false, prereqSkillIds: [], tier: 4, weight: 2, estMinutes: 6 },
      { id: `${courseId}-s2`, courseId, topicId: "t1", name: "Quotientenkriterium", difficulty: "normal", isFundamental: false, prereqSkillIds: [], tier: 2, weight: 1, estMinutes: 8 },
    ],
    gradeRules: null,
    keyDates: [{ courseId, date: "2027-01-28", kind: "exam", title: "Klausur", skillIds: [] }],
    assignments: [{ id: "a6", courseId, title: "Blatt 6", dueAt: "2026-11-25T10:00", tasks: [{ id: "a6_1", label: "6.1", skillId: `${courseId}-s1`, prompt: "Bestimme den Grenzwert.", maxPoints: 4 }] }],
    catalog: [],
    conflicts: [],
    questions: [],
    basis: "materials",
    truncated: false,
    finishedAt,
  };
}

function desk(): Desk {
  const draft: SemesterDraft = {
    id: "sem1",
    name: "WS 2026/27",
    startDate: "2026-10-01",
    endDate: "2027-02-28",
    status: "active",
    setupStep: "done",
    courseIndex: 0,
    courses: [
      { id: "c1", name: "Analysis 1", short: "Ana1", credits: 9, teachingLanguage: "German", targetGrade: 2, setupStatus: "ready" },
      { id: "c2", name: "Linear Algebra", short: "LinAlg", credits: 6, teachingLanguage: "German", targetGrade: 3, setupStatus: "ready" },
    ],
    timetable: [{ weekday: 1, start: "08:00", end: "10:00", kind: "lecture", title: "Analysis", courseId: "c1" }],
    studyGoal: [0, 180, 180, 180, 180, 180, 240],
    uploads: [{ id: "up1", courseId: null, fileName: "Blatt7.pdf", type: "pdf", studentNote: "", addedAt: 5, cataloguedAt: null, assetId: null, pages: 2 }],
    facts: [],
    results: { c1: result("c1"), c2: result("c2") },
    createdAt: 0,
    updatedAt: 0,
  };
  return { draft, profile };
}

describe("changes", () => {
  it("checks real dates", () => {
    expect(isRealDay("2027-02-04")).toBe(true);
    expect(isRealDay("2027-02-30")).toBe(false);
    expect(isRealDay("4 Feb")).toBe(false);
  });

  it("moves an exam date, logs before and after, and undoes it", () => {
    const d = desk();
    const r = applyOps(d, [{ op: "set_exam_date", course: "Analysis 1", title: "Klausur", date: "2027-02-04" }], { studentWords: "exam moved to 4 Feb", now: 10 });
    expect(r.errors).toEqual([]);
    expect(r.change!.lines).toEqual(["Analysis 1, Klausur: 28 Jan → 4 Feb"]);
    expect(r.desk.draft.results.c1.keyDates[0].date).toBe("2027-02-04");
    expect(d.draft.results.c1.keyDates[0].date).toBe("2027-01-28"); // pure
    expect(canUndo(r.desk, r.change!)).toBe(true);
    const u = undoChange(r.desk, r.change!);
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.desk.draft.results.c1.keyDates[0].date).toBe("2027-01-28");
  });

  it("refuses an undo when something changed the same part since", () => {
    const a = applyOps(desk(), [{ op: "set_target_grade", course: "c1", grade: 1 }], { studentWords: "", now: 1 });
    const b = applyOps(a.desk, [{ op: "set_target_grade", course: "c1", grade: 3 }], { studentWords: "", now: 2 });
    expect(canUndo(b.desk, a.change!)).toBe(false);
    expect(undoChange(b.desk, a.change!).ok).toBe(false);
    expect(canUndo(b.desk, b.change!)).toBe(true);
  });

  it("rejects grades off the scale and unknown courses, and applies the rest", () => {
    const r = applyOps(desk(), [
      { op: "set_target_grade", course: "c1", grade: 7 },
      { op: "set_target_grade", course: "Physics", grade: 2 },
      { op: "set_study_goal", minutes: { Sat: 0, Sun: 60 } },
    ], { studentWords: "", now: 1 });
    expect(r.errors).toHaveLength(2);
    expect(r.change!.lines).toEqual(["Study goal: Sat 4 h → off, Sun off → 1 h"]);
    expect(r.desk.draft.studyGoal[6]).toBe(0);
    expect(r.targets).toEqual([]);
  });

  it("sets a target grade for the mastery store too", () => {
    const r = applyOps(desk(), [{ op: "set_target_grade", course: "LinAlg", grade: 1 }], { studentWords: "", now: 1 });
    expect(r.targets).toEqual([{ courseId: "c2", targetGrade: 1, gradeScale: profile.gradeScale }]);
  });

  it("adds homework only with existing skills, and moves its due date", () => {
    const bad = applyOps(desk(), [{ op: "add_homework", course: "c1", title: "Blatt 7", dueAt: "2026-12-02", tasks: [{ label: "7.1", text: "x", skill: "nope" }] }], { studentWords: "", now: 1 });
    expect(bad.change).toBeNull();
    expect(bad.errors[0]).toMatch(/existing skill/);
    const ok = applyOps(desk(), [
      { op: "add_homework", course: "c1", title: "Blatt 7", dueAt: "2026-12-02T10:00", tasks: [{ label: "7.1", text: "Zeige ...", skill: "Quotientenkriterium" }] },
      { op: "set_due", course: "c1", homework: "Blatt 6", dueAt: "2026-11-26" },
    ], { studentWords: "", now: 1 });
    expect(ok.errors).toEqual([]);
    const as = ok.desk.draft.results.c1.assignments;
    expect(as.map((a) => [a.title, a.dueAt])).toEqual([["Blatt 6", "2026-11-26T23:59"], ["Blatt 7", "2026-12-02T10:00"]]);
    expect(as[1].tasks[0].skillId).toBe("c1-s2");
  });

  it("keeps an exam date for a course not read yet as a fact", () => {
    const d = desk();
    d.draft.courses.push({ id: "c3", name: "Physics", short: "Phys", credits: 6, teachingLanguage: "", targetGrade: 2, setupStatus: "waiting" });
    const r = applyOps(d, [{ op: "set_exam_date", course: "Physics", title: "Final", date: "2027-02-10" }], { studentWords: "", now: 1 });
    expect(r.desk.draft.facts.map((f) => [f.courseId, f.text])).toEqual([["c3", "Final: 2027-02-10"]]);
  });

  it("asks before dropping a course, and drops it on yes", () => {
    const r = applyOps(desk(), [{ op: "drop_course", course: "c2" }], { studentWords: "drop linalg", now: 1 });
    expect(r.change).toBeNull();
    expect(r.needsConfirm).toHaveLength(1);
    const yes = applyOps(desk(), r.needsConfirm, { studentWords: "drop linalg", confirmed: true, now: 2 });
    expect(yes.desk.draft.courses.map((c) => c.id)).toEqual(["c1"]);
    expect(yes.desk.draft.results.c2).toBeDefined(); // kept
    expect(canUndo(yes.desk, yes.change!)).toBe(true);
  });

  it("records a result as attempts and can't undo it", () => {
    const r = applyOps(desk(), [{ op: "add_result", course: "c1", component: "Quiz 1", points: 18, maxPoints: 24, date: "2026-11-18", skills: ["c1-s1", "x"] }], { studentWords: "", now: 1 });
    expect(r.attempts.map((a) => [a.skillId, a.verdict, a.part])).toEqual([["c1-s1", "solved", "assessment"]]);
    expect(r.change!.undoable).toBe(false);
    expect(undoChange(r.desk, r.change!).ok).toBe(false);
  });

  it("a day off empties that day's quest budget", () => {
    const r = applyOps(desk(), [{ op: "set_day_off", date: TODAY, reason: "sick" }], { studentWords: "", now: 1 });
    const sem = syncSemester(r.desk.draft, profile, null);
    expect(sem.daysOff).toEqual([TODAY]);
    const plan = planQuest({ semester: sem, today: TODAY, nowLocal: `${TODAY}T09:00`, attempts: [], reviews: [], doneTaskIds: new Set(), blockerSkillIds: [] });
    expect(plan.kind).toBe("no_time");
  });

  it("keeps the placement check and the workload decision when rebuilding the semester", () => {
    const d = desk();
    const current = { ...buildSemester(d.draft, profile, 1), placementQuestId: "q1", studyGoalSource: "recommended" as const, studyGoalDecidedAt: 5 };
    const r = applyOps(d, [{ op: "set_language", course: "c1", language: "English" }], { studentWords: "", now: 9 });
    const s = syncSemester(r.desk.draft, profile, current, 9);
    expect(s).toMatchObject({ placementQuestId: "q1", studyGoalSource: "recommended", studyGoalDecidedAt: 5, createdAt: 1 });
    expect(s.courses.find((c) => c.id === "c1")!.teachingLanguage).toBe("English");
  });
});

describe("files StudyDesk isn't sure about", () => {
  it("are one to-do item, and confirming or moving a file clears the doubt", () => {
    const d = desk();
    d.draft.uploads = [{ ...d.draft.uploads[0], courseId: "c1", courseUnsure: "name fits two courses" }];
    expect(setupTodo(d.draft).find((t) => t.key === "unsure")?.title).toBe("1 file StudyDesk isn't sure about");
    const r = applyOps(d, [{ op: "set_file_course", file: "up1", course: "c1" }], { studentWords: "", now: 9 });
    expect(r.desk.draft.uploads[0]).toMatchObject({ courseId: "c1", courseUnsure: undefined });
    expect(setupTodo(r.desk.draft).some((t) => t.key === "unsure")).toBe(false);
    expect(applyOps(d, [{ op: "set_file_course", file: "nope", course: "c1" }], { studentWords: "" }).errors[0]).toContain("no file");
  });
});

describe("jobs", () => {
  it("assigns files, records the student's words, and marks the course for reading", () => {
    const r = startJob(desk(), { kind: "new_material", courses: ["Analysis 1"], files: [{ uploadId: "up1", course: "c1", note: "sheet 7" }], studentWords: "new sheet, due Thursday" }, [], 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.desk.draft.uploads[0]).toMatchObject({ courseId: "c1", studentNote: "sheet 7" });
    expect(r.desk.draft.facts.map((f) => f.text)).toEqual(["new sheet, due Thursday"]);
    expect(r.desk.draft.courses[0].setupStatus).toBe("waiting");
    expect(r.desk.draft.setupStep).toBe("running");
    expect(r.job).toMatchObject({ status: "running", courseIds: ["c1"], uploadIds: ["up1"] });
  });

  it("queues a job for a course that's being read, and starts it after", () => {
    const first = startJob(desk(), { kind: "remap", courses: ["c1"], studentWords: "chapter 7 isn't in the exam" }, [], 100);
    if (!first.ok) throw new Error();
    const second = startJob(first.desk, { kind: "remap", courses: ["c1"], studentWords: "the exam is oral" }, [first.job], 110);
    if (!second.ok) throw new Error();
    expect(second.job.status).toBe("queued");
    // The setup run reads c1 and finishes with one more skill.
    const read = { ...second.desk.draft, courses: second.desk.draft.courses.map((c) => (c.id === "c1" ? { ...c, setupStatus: "ready" as const } : c)), results: { ...second.desk.draft.results, c1: { ...result("c1", 200), skills: [...result("c1").skills, { ...result("c1").skills[0], id: "c1-s3" }], questions: ["Is the exam oral?"] } } };
    const adv = advanceJobs(read, [first.job, second.job], 300);
    expect(adv.jobs[0]).toMatchObject({ status: "done", result: ["Analysis 1: 1 new skills, 1 question for you"] });
    expect(adv.jobs[1].status).toBe("running");
    expect(adv.draft.courses[0].setupStatus).toBe("waiting");
  });

  it("refuses unknown courses", () => {
    expect(startJob(desk(), { kind: "remap", courses: ["Chemistry"], studentWords: "" }, []).ok).toBe(false);
  });
});

describe("check-ins", () => {
  function record(date: string, planned: number, actualMin: number): QuestRecord {
    return {
      quest: { id: `q${date}`, date, courseId: "c1", budgetMinutes: 30, plannedMinutes: planned, reason: "", notes: [], createdAt: 0, parts: [{ kind: "practice", id: "p", title: "", gate: false, problems: [{ id: `x${date}`, skillId: "c1-s1", prompt: "", answerKey: "", hints: [], similarSolved: null, expMinutes: planned, maxPoints: 2 }] }] },
      progress: { questId: `q${date}`, work: { [`x${date}`]: { answerText: "", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: actualMin * 60, startedAt: 0 } }, handedIn: ["p"], fixIts: [], gatesCleared: [], finishedAt: null, updatedAt: 0 },
    };
  }

  it("measures planned against actual time over the last quests", () => {
    const rs = [record("2026-11-17", 10, 14), record("2026-11-18", 10, 13), record("2026-11-19", 10, 12), record("2026-11-10", 10, 100)];
    expect(speed(rs, TODAY)).toMatchObject({ quests: 3, planned: 30, actual: 39 });
  });

  it("fires too slow, exam-date and to-do check-ins once", () => {
    const d = desk();
    d.draft.results.c1 = { ...d.draft.results.c1, keyDates: [{ courseId: "c1", date: "2026-11-30", kind: "exam", title: "Midterm", skillIds: [] }], questions: ["Does homework count?"] };
    const semester = buildSemester(d.draft, profile, 1);
    const records = [record("2026-11-17", 10, 14), record("2026-11-18", 10, 14), record("2026-11-19", 10, 14)];
    const input = { semester, draft: d.draft, attempts: [], reviews: [], records, jobs: [], sent: [], today: TODAY };
    const t = checkinTriggers(input);
    expect(t.map((x) => x.kind).sort()).toEqual(["check_date", "needs_answer", "needs_answer", "too_slow"]);
    const sent = t.map((x) => ({ key: x.key, kind: x.kind, day: TODAY, at: 0, courseId: x.courseId, facts: x.facts, messageId: null, seenAt: null }));
    expect(checkinTriggers({ ...input, sent })).toEqual([]);
    // Too slow comes back after a few days, not the next day.
    expect(checkinTriggers({ ...input, sent, today: "2026-11-21" }).map((x) => x.kind)).toEqual([]);
    expect(checkinTriggers({ ...input, sent, today: "2026-11-23" }).map((x) => x.kind)).toContain("too_slow");
  });
});

describe("memory", () => {
  const msg = (text: string, createdAt: number): OrchMessage => ({ id: String(createdAt), role: "user", text, createdAt });
  it("summarizes after enough words or on a new day", () => {
    const mem = { ...emptyState().memory, coversUpTo: 0, day: TODAY };
    const t = new Date(`${TODAY}T10:00`).getTime();
    expect(needsSummary([msg("short", t)], mem, TODAY)).toBe(false);
    expect(needsSummary([msg("word ".repeat(6000), t)], mem, TODAY)).toBe(true);
    expect(needsSummary([msg("short", t)], mem, "2026-11-21")).toBe(true);
  });

  it("sends the memory, the last 30 messages and the desk", () => {
    const ms = Array.from({ length: 40 }, (_, i) => ({ ...msg(`m${i}`, i), role: (i % 2 ? "assistant" : "user") as "user" | "assistant" }));
    const turns = orchTurns({ ...emptyState().memory, text: "Prefers evenings." }, ms, "{}");
    expect(turns[0].content).toContain("Prefers evenings.");
    const all = turns.map((t) => t.content).join("\n");
    expect(all).not.toContain("m9\n");
    expect(all).toContain("m10");
    expect(turns[turns.length - 1].content).toContain("<desk>");
  });
});

describe("quest settings and rebuilding", () => {
  it("changes hints, lesson length and new skills per quest within limits, from the next quest", () => {
    const r = applyOps(desk(), [{ op: "set_quest_settings", hints: 1, lessonMinutes: 8, newSkillsPerQuest: 9 }], { studentWords: "", now: 1 });
    expect(r.errors[0]).toMatch(/newSkillsPerQuest/);
    expect(r.change!.lines).toEqual(["Quests: hints per task 3 → 1, lesson reading minutes 4 → 8 (from the next quest)"]);
    const sem = syncSemester(r.desk.draft, profile, null);
    expect(sem.questSettings).toEqual({ hints: 1, lessonMinutes: 8 });
    applyQuestSettings(sem.questSettings);
    expect([QUEST_CONFIG.hints, QUEST_CONFIG.lesson.readMinutes, QUEST_CONFIG.maxNewSkills]).toEqual([1, 8, 2]);
    applyQuestSettings(undefined);
    expect([QUEST_CONFIG.hints, QUEST_CONFIG.lesson.readMinutes]).toEqual([3, 4]);
    expect(canUndo(r.desk, r.change!)).toBe(true);
  });

  it("finds today's quest, skipping replaced ones, and tells whether it was started", () => {
    const mk = (id: string, createdAt: number, replacedAt?: number): QuestRecord => ({
      quest: { id, date: TODAY, courseId: "c1", budgetMinutes: 30, plannedMinutes: 30, reason: "", notes: [], createdAt, parts: [] },
      progress: { questId: id, work: {}, handedIn: [], fixIts: [], gatesCleared: [], finishedAt: null, replacedAt, updatedAt: 0 },
    });
    const a = mk("a", 1);
    const b = mk("b", 2, 5);
    expect(todaysQuest([a, b], TODAY)?.quest.id).toBe("a");
    expect(questStarted(a)).toBe(false);
    expect(questStarted({ ...a, progress: { ...a.progress, work: { p: { answerText: "x", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 0, startedAt: null } } } })).toBe(true);
  });
});
