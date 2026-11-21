import { describe, expect, it } from "vitest";
import { parseSetup, buildSemester, localSetup, setupTurns, liveProgress, type SetupInput } from "../src/onboarding/setup";
import { setupTodo, staleCourses, asksForFiles } from "../src/onboarding/todo";
import { planPlacement, recommendWorkload, studyDaysUntil } from "../src/onboarding/placement";
import { gradeSteps } from "../src/onboarding/scales";
import { applySheetUpdate, chatTurns, setupReady, sheetSnapshot } from "../src/onboarding/agent";
import { aheadFromEvents, aheadIsStale, busyFromAhead, busyMinutesFromEvents, toEvents, weeklyPattern } from "../src/platform/calendar";
import type { DraftCourse, Profile, SemesterDraft } from "../src/onboarding/types";
import { replay } from "../src/mastery/replay";
import type { Attempt } from "../src/mastery/types";
import { questMistakes } from "../src/quests/review";
import { emptyProgress, gradingProblem, emptyWork } from "../src/quests/handin";

const TODAY = "2026-11-20"; // a Friday
const profile: Profile = { level: "university", school: "TU", country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 }, program: "BSc Physics", year: "1", updatedAt: 0 };
const course: DraftCourse = { id: "c1", name: "Analysis 1", short: "Ana1", credits: 9, teachingLanguage: "", targetGrade: 2, setupStatus: "waiting" };

const REPLY = `=== SUMMARY ===
I read the syllabus and Sheet 6. Found 2 topics and 4 skills.

=== LANGUAGE ===
German

=== TOPICS ===
t1 | Folgen | taught
t2 | Reihen | upcoming

=== SKILLS ===
f1 | - | Brüche mit Potenzen vereinfachen | fundamental | 4 | normal | 2 | 1 | -
s1 | t1 | Grenzwerte von Folgen bestimmen | course | 4 | normal | 6 | 2 | f1
s2 | t2 | Quotientenkriterium | course | 3 | normal | 8 | 2 | s1, f1
s3 | t2 | Leibniz-Kriterium | course | 1 | hard | 10 | 1 | s2, nope

=== GRADING ===
component | exam | 70
component | homework | 30
threshold | 1 | 87.5
threshold | 4 | 50

=== DATES ===
2027-01-28 | exam | Klausur | t1,t2
2027-12-01 | quiz | broken date line
not a date | exam | x | t1

=== HOMEWORK ===
### Blatt 6 | 2026-11-25T10:00
#### 6.1 | s1 | 4
Bestimme $\\lim_{n\\to\\infty} \\frac{2n+1}{3n+5}$.
#### 6.2 | s9 | 4
Unknown skill, dropped.
### Blatt 2 | 2026-10-01T10:00
#### 2.1 | s1 | 4
Already past.

=== CATALOG ===
s1 | F1 | p. 3-5
s2 | F2 | p. 1
s3 | F9 | p. 2

=== CONFLICTS ===
- The syllabus says the exam is on 27 Jan; you said 28 Jan.

=== QUESTIONS ===
- none
`;

const input = { course, profile, today: TODAY, priorFundamentals: [] };

describe("parseSetup", () => {
  const keys = new Map([
    ["F1", "up_a"],
    ["F2", "up_b"],
  ]);
  const r = parseSetup(REPLY, input, keys, 1);

  it("makes ids unique per course and keeps known prerequisites only", () => {
    expect(r.skills.map((s) => s.id)).toEqual(["c1-f1", "c1-s1", "c1-s2", "c1-s3"]);
    expect(r.skills[2].prereqSkillIds).toEqual(["c1-s1", "c1-f1"]);
    expect(r.skills[3].prereqSkillIds).toEqual(["c1-s2"]);
    expect(r.skills[0]).toMatchObject({ isFundamental: true, topicId: "c1-t-fundamentals" });
    expect(r.skills[3]).toMatchObject({ difficulty: "hard", tier: 1, estMinutes: 10 });
  });
  it("marks taught topics, reads grade rules, dates, homework and the catalog", () => {
    expect(r.topics.map((t) => [t.name, !!t.taught])).toEqual([
      ["Fundamentals", false],
      ["Folgen", true],
      ["Reihen", false],
    ]);
    expect(r.teachingLanguage).toBe("German");
    expect(r.gradeRules?.components).toEqual([
      { id: "exam", weight: 70 },
      { id: "homework", weight: 30 },
    ]);
    expect(r.keyDates.map((k) => [k.date, k.kind])).toEqual([
      ["2027-01-28", "exam"],
      ["2027-12-01", "quiz"],
    ]);
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0].tasks.map((t) => t.label)).toEqual(["6.1"]);
    expect(r.assignments[0].tasks[0].prompt).toContain("\\frac{2n+1}{3n+5}");
    expect(r.catalog).toEqual([
      { skillId: "c1-s1", uploadId: "up_a", where: "p. 3-5" },
      { skillId: "c1-s2", uploadId: "up_b", where: "p. 1" },
    ]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.questions).toEqual([]);
    expect(r.basis).toBe("materials");
  });
  it("reuses a fundamental mastered in an earlier semester", () => {
    const prior = { ...r.skills[0], id: "old-frac", courseId: "old" };
    const again = parseSetup(REPLY.replace("f1 | - | Brüche", "old-frac | - | Brüche").replace("| s1, f1", "| s1, old-frac"), { ...input, priorFundamentals: [prior] }, keys);
    expect(again.skills.find((s) => s.id === "old-frac")).toBe(prior);
    expect(again.skills.find((s) => s.id === "c1-s2")!.prereqSkillIds).toContain("old-frac");
  });
  it("fails without skills", () => {
    expect(() => parseSetup("=== SUMMARY ===\nnothing", input, keys)).toThrow();
  });
  it("labels files and leaves images out of the text", () => {
    const si: SetupInput = {
      profile,
      draft: { name: "WS", startDate: "2026-10-01", endDate: "2027-02-28" },
      course,
      facts: [{ id: "x", courseId: "c1", text: "exam on 28 Jan", addedAt: 0 }],
      files: [
        { upload: { id: "up_a", courseId: "c1", fileName: "syllabus.pdf", type: "pdf", studentNote: "", addedAt: 0, cataloguedAt: null, assetId: null, pages: 2 }, text: "--- page 1 ---\nhi", image: null },
        { upload: { id: "up_b", courseId: "c1", fileName: "sheet.png", type: "image", studentNote: "sheet 6", addedAt: 0, cataloguedAt: null, assetId: null, pages: null }, text: null, image: new Blob(["x"]) },
      ],
      today: TODAY,
      priorFundamentals: [],
    };
    const t = setupTurns(si);
    expect(t.images).toHaveLength(1);
    expect(t.fileKeys.get("F2")).toBe("up_b");
    expect(t.turns[0].content).toContain('"exam on 28 Jan"');
    expect(t.turns[0].content).toContain('### F2: sheet.png (the student says: "sheet 6")');
  });
});

function draftWith(): SemesterDraft {
  const result = parseSetup(REPLY, input, new Map(), 1);
  return {
    id: "sem_x",
    name: "WS 2026/27",
    startDate: "2026-10-01",
    endDate: "2027-02-28",
    status: "setting_up",
    setupStep: "running",
    courseIndex: 0,
    courses: [{ ...course, setupStatus: "ready" }, { ...course, id: "c2", name: "No result", setupStatus: "failed" }],
    timetable: [{ weekday: 1, start: "10:00", end: "12:00", kind: "lecture", title: "Ana", courseId: "c1" }],
    studyGoal: [0, 180, 180, 180, 180, 180, 0],
    uploads: [],
    facts: [],
    results: { c1: result },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("buildSemester", () => {
  it("writes the records the quest module reads, for finished courses only", () => {
    const s = buildSemester(draftWith(), profile, 5);
    expect(s.source).toBe("onboarding");
    expect(s.courses.map((c) => c.id)).toEqual(["c1"]);
    expect(s.courses[0].teachingLanguage).toBe("German");
    expect(s.targets).toEqual([{ courseId: "c1", targetGrade: 2, gradeScale: profile.gradeScale }]);
    expect(s.skills).toHaveLength(4);
    expect(s.gradeRules).toHaveLength(1);
    expect(s.studyGoalSource).toBe("student");
  });
});

describe("placement check", () => {
  const semester = buildSemester(draftWith(), profile, 5);

  it("checks the fundamentals and the taught topics, required skills only", () => {
    const { quest, partCourse } = planPlacement(semester, [], [], TODAY, 1);
    expect(quest.id).toBe(`qst_${TODAY}_placement`);
    expect(quest.parts).toHaveLength(1);
    const part = quest.parts[0];
    if (part.kind === "learn") throw new Error("learn");
    expect(part.check).toBe(true);
    expect(part.gate).toBe(false);
    expect(partCourse[part.id]).toBe("c1");
    // fundamental f1 and s1 from the taught topic; s2 and s3 are upcoming
    expect(part.problems.map((p) => p.skillId)).toEqual(["c1-f1", "c1-s1"]);
  });

  it("records check attempts, and a clean solve there masters the skill at once", () => {
    const { quest } = planPlacement(semester, [], [], TODAY, 1);
    const part = quest.parts[0];
    if (part.kind === "learn") throw new Error("learn");
    const skills = new Map(semester.skills.map((s) => [s.id, s]));
    expect(gradingProblem(part.problems[0], part, emptyWork(), skills, [], false).part).toBe("check");
    const at = (skillId: string, verdict: Attempt["verdict"], part: Attempt["part"]): Attempt => ({
      id: `${skillId}-${part}`,
      skillId,
      questId: quest.id,
      part,
      day: TODAY,
      verdict,
      points: 0,
      maxPoints: 2,
      hintsUsed: 0,
      sawWorkedExample: false,
      activeSeconds: 120,
      startedAt: 0,
      gradedAt: 0,
    });
    const { states } = replay(semester.skills, [at("c1-f1", "solved", "check"), at("c1-s1", "not_understood", "check"), at("c1-s2", "solved", "practice")], []);
    expect(states.get("c1-f1")!.stage).toBe("mastered");
    expect(states.get("c1-s1")!.stage).toBe("learning");
    expect(states.get("c1-s2")!.stage).toBe("learning"); // the exception is for the placement check only
  });

  it("leaves placement misses out of the mistake review", () => {
    const { quest } = planPlacement(semester, [], [], TODAY, 1);
    const part = quest.parts[0];
    if (part.kind === "learn") throw new Error("learn");
    const progress = emptyProgress(quest.id);
    progress.work[part.problems[0].id] = { ...emptyWork(), verdict: "not_understood" };
    expect(questMistakes(quest, progress, new Map(semester.skills.map((s) => [s.id, s])), [], `${TODAY}T20:00`)).toEqual([]);
  });

  it("recommends a workload from what's left until the exam", () => {
    const rec = recommendWorkload(semester, [], [], TODAY);
    const c = rec.perCourse[0];
    // target 2 on 1–5 needs tiers 2..5: f1, s1, s2 (s3 is tier 1)
    expect(c.remainingSkills).toBe(3);
    expect(c.deadline).toBe("2027-12-01"); // the last exam or quiz
    expect(c.studyDays).toBe(studyDaysUntil(semester.studyGoal, TODAY, c.deadline));
    expect(rec.dailyQuestMinutes % 15).toBe(0);
    expect(rec.dailyQuestMinutes).toBeGreaterThanOrEqual(15);
    expect(rec.studyGoal[0]).toBe(0); // Sunday stays off
    expect(rec.studyGoal[1]).toBeGreaterThan(rec.studyGoal[2]); // Monday has a lecture on top
  });
});

describe("scales", () => {
  it("offers whole grades in the scale's direction", () => {
    expect(gradeSteps({ name: "AT", best: 1, worst: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(gradeSteps({ name: "CH", best: 6, worst: 1 })).toEqual([6, 5, 4, 3, 2, 1]);
    expect(gradeSteps({ name: "%", best: 100, worst: 0 })).toBeNull();
  });
  it("builds a usable local preview map", () => {
    const r = localSetup({ profile, draft: { name: "x", startDate: TODAY, endDate: TODAY }, course, facts: [], files: [], today: TODAY, priorFundamentals: [] });
    expect(r.skills.length).toBe(6);
    expect(r.keyDates).toHaveLength(1);
  });
});

function emptyDraft(): SemesterDraft {
  return { id: "s", name: "", startDate: "", endDate: "", status: "setting_up", setupStep: "chat", courseIndex: 0, courses: [], timetable: [], studyGoal: [0, 0, 0, 0, 0, 0, 0], uploads: [], facts: [], results: {}, chat: [], createdAt: 0, updatedAt: 0 };
}

describe("setup chat: update_sheet", () => {
  it("fills the sheet from one call and reports course ids and what's missing", () => {
    const d0 = { ...emptyDraft(), uploads: [{ id: "up1", courseId: null, fileName: "syllabus.pdf", type: "pdf" as const, studentNote: "", addedAt: 0, cataloguedAt: null, assetId: null, pages: 3 }] };
    const r = applySheetUpdate(d0, { ...profile, gradeScale: { name: "", best: 1, worst: 5 } }, {
      profile: { country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 }, level: "university" },
      semester: { name: "WS 2026/27", startDate: "2026-10-01", endDate: "bad" },
      addCourses: [{ name: "Analysis 1", short: "Ana1", credits: 9, targetGrade: 2 }, { name: "Physics", targetGrade: 9 }],
      addSlots: [
        { weekday: "Mon", start: "10:00", end: "11:30", kind: "lecture", title: "Analysis 1 lecture", course: "Analysis 1" },
        { weekday: "Tue", start: "18:00", end: "17:00", kind: "fixed", title: "broken" },
        { weekday: "Tue", start: "18:00", end: "20:00", kind: "fixed", title: "Volleyball" },
      ],
      facts: [{ course: "Ana1", text: "exam on 28 Jan" }],
      files: [{ uploadId: "up1", course: "Analysis 1", note: "syllabus" }],
      studyGoalMinutes: { Mon: 180, Sun: 0 },
    }, 7);
    const d = r.draft;
    expect(r.profile.gradeScale.name).toBe("Austrian 1–5");
    expect(d.name).toBe("WS 2026/27");
    expect(d.endDate).toBe("");
    expect(d.courses.map((c) => [c.name, c.targetGrade])).toEqual([["Analysis 1", 2], ["Physics", null]]);
    expect(r.result).toContain("Target 9 is outside");
    expect(r.result).toMatch(/Analysis 1 = c/);
    expect(d.timetable).toHaveLength(2);
    expect(d.timetable[0].courseId).toBe(d.courses[0].id);
    expect(d.timetable[1]).toMatchObject({ kind: "fixed", courseId: null });
    expect(d.facts[0]).toMatchObject({ courseId: d.courses[0].id, text: "exam on 28 Jan" });
    expect(d.uploads[0]).toMatchObject({ courseId: d.courses[0].id, studentNote: "syllabus" });
    expect(d.studyGoal[1]).toBe(180);
    expect(setupReady(d).ok).toBe(true);
    expect(r.result).toContain("Ready to start");
  });
  it("removes courses with their slots and facts, and frees their files", () => {
    const a = applySheetUpdate(emptyDraft(), profile, { addCourses: [{ name: "Chem" }], addSlots: [{ weekday: "Wed", start: "8:00", end: "9:00", kind: "lecture", title: "Chem", course: "Chem" }], facts: [{ course: "Chem", text: "x" }] });
    const id = a.draft.courses[0].id;
    const b = applySheetUpdate(a.draft, profile, { removeCourseIds: [id] });
    expect(b.draft.courses).toEqual([]);
    expect(b.draft.timetable).toEqual([]);
    expect(b.draft.facts).toEqual([]);
    expect(setupReady(b.draft).missing).toHaveLength(2);
  });
  it("sends the chat with the sheet on the newest message", () => {
    const d = emptyDraft();
    const turns = chatTurns(
      [
        { id: "1", role: "assistant", text: "Hi", createdAt: 0 },
        { id: "2", role: "user", text: "I study at TU", files: ["plan.png"], createdAt: 0 },
      ],
      sheetSnapshot(d, profile, TODAY),
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[2].content).toContain("[Dropped: plan.png]");
    expect(turns[2].content).toContain("<sheet>");
    expect(turns[2].content).toContain(TODAY);
  });
});

describe("calendar", () => {
  const raw = [0, 7].flatMap((off) => {
    const day = new Date(`2026-11-23T12:00`);
    day.setDate(day.getDate() + off);
    const iso = (h: number, m: number) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d.toISOString(); };
    return [
      { summary: "Analysis lecture", start: { dateTime: iso(10, 0) }, end: { dateTime: iso(11, 30) }, recurringEventId: "r1" },
      ...(off === 0 ? [{ summary: "Overlap", start: { dateTime: iso(11, 0) }, end: { dateTime: iso(12, 0) } }] : []),
    ];
  });
  const events = toEvents([...raw, { summary: "Exam", start: { date: "2027-01-28" }, end: { date: "2027-01-29" } }, { summary: "gone", status: "cancelled", start: { dateTime: "2026-11-24T10:00:00Z" }, end: { dateTime: "2026-11-24T11:00:00Z" } }]);
  it("reads events in local time and finds the weekly pattern", () => {
    expect(events).toHaveLength(4);
    const p = weeklyPattern(events);
    expect(p.weekly).toEqual([expect.objectContaining({ title: "Analysis lecture", weekday: 1, start: "10:00", end: "11:30", times: 2 })]);
    expect(p.once.some((e) => e.title === "Exam")).toBe(true);
  });
  it("counts busy minutes once where events overlap", () => {
    expect(busyMinutesFromEvents(events, "2026-11-23")).toBe(120);
  });
  it("keeps the latest read of the coming days, which the nightly run sizes from", () => {
    const ahead = aheadFromEvents(events, "2026-11-22", 14, 1000);
    expect(busyFromAhead(ahead, "2026-11-23")).toBe(120);
    expect(busyFromAhead(ahead, "2026-11-22")).toBe(0); // read, and free
    expect(busyFromAhead(ahead, "2026-12-10")).toBeUndefined(); // not covered by the read
    expect(aheadIsStale(ahead, "2026-11-22", 1000 + 60_000)).toBe(false);
    expect(aheadIsStale(ahead, "2026-11-23", 1000 + 60_000)).toBe(true); // a new day
    expect(aheadIsStale(ahead, "2026-11-22", 1000 + 4 * 3_600_000)).toBe(true);
  });
});

describe("liveProgress", () => {
  it("shows finished log lines while the log is still being written", () => {
    const p = liveProgress("=== LOG ===\n- Reading F1 (Skript.pdf), p. 1-40: limits\n- F2 (Blatt");
    expect(p.log).toEqual(["Reading F1 (Skript.pdf), p. 1-40: limits"]);
    expect(p.stage).toBe("reading");
  });
  it("counts topics and skills as they stream in", () => {
    const p = liveProgress("=== LOG ===\n- a\n- b\n=== SUMMARY ===\nx\n=== TOPICS ===\nt1 | A | taught\n=== SKILLS ===\ns1 | t1 | One | course | 4 | normal | 5 | 1 | -\ns2 | t1 | Two");
    expect(p.log).toEqual(["a", "b"]);
    expect(p.stage).toBe("listing skills");
    expect(p.topics).toBe(1);
    expect(p.skills).toBe(2);
  });
  it("asks the agent to write its log first and to say when it is only estimating", () => {
    const c = setupTurns({ ...input, draft: { name: "WS", startDate: "2026-10-01", endDate: "2027-02-28" }, facts: [], files: [] }).turns[0].content;
    expect(c.indexOf("=== LOG ===")).toBeLessThan(c.indexOf("=== SUMMARY ==="));
    expect(c).toContain("not from the internet");
  });
});

describe("setup to-do list", () => {
  const withQuestions = (qs: string[], basis: "materials" | "general" = "materials") => {
    const d = draftWith();
    d.results.c1 = { ...d.results.c1, questions: qs, basis };
    return d;
  };
  it("merges file requests into one upload item and keeps at most 3 questions per course", () => {
    const d = withQuestions(["Please upload the syllabus", "When is the exam?", "How is it graded?", "Which language?", "Is a calculator allowed?"]);
    const items = setupTodo(d).filter((i) => i.key === "upload" || i.key.startsWith("q-"));
    expect(items.map((i) => i.key)).toEqual(["upload", "q-c1"]);
    expect(items[1].body.split("\n")).toHaveLength(3);
    expect(items[1].chatPrompt).toContain("1. When is the exam?");
  });
  it("asks for materials when a course was only estimated", () => {
    expect(setupTodo(withQuestions([], "general")).map((i) => i.key)).toEqual(["upload", "dates", "conflicts"]);
    expect(asksForFiles("Could you share the current UE sheets?")).toBe(true);
    expect(asksForFiles("When is the exam?")).toBe(false);
  });
  it("lists the dates and file conflicts for the student to check", () => {
    const d = withQuestions([]);
    const items = setupTodo(d);
    const dates = items.find((i) => i.key === "dates")!;
    expect(dates.title).toMatch(/^Check \d+ important dates?$/);
    expect(dates.body).toContain("Say if any is wrong");
    expect(items.find((i) => i.key === "conflicts")!.body).toContain("Your word was used");
  });
  it("lets the setup chat tick items off itself", () => {
    const d = { ...withQuestions(["When is the exam?"]), setupStep: "done" as const };
    const r = applySheetUpdate(d, profile, { facts: [{ course: "c1", text: "exam on 28 Jan" }], todoDone: ["q-c1", "nope"] });
    expect(setupTodo(r.draft).find((t) => t.key === "q-c1")?.done).toBe(true);
    expect(r.result).toContain("Ticked off: q-c1");
    expect(r.result).toContain('To-do "nope" not found');
    expect(JSON.parse(sheetSnapshot(r.draft, profile, TODAY)).toDo.find((t: { key: string }) => t.key === "q-c1").done).toBe(true);
    const back = applySheetUpdate(r.draft, profile, { todoOpen: ["q-c1"] });
    expect(setupTodo(back.draft).find((t) => t.key === "q-c1")?.done).toBe(false);
  });
  it("marks ticked items done and finds courses with new answers", () => {
    const d = { ...withQuestions(["When is the exam?"]), todoDone: ["q-c1"] };
    expect(setupTodo(d).find((i) => i.key === "q-c1")?.done).toBe(true);
    expect(staleCourses(d)).toHaveLength(0);
    d.facts = [{ id: "f", courseId: "c1", text: "exam on 28 Jan", addedAt: d.results.c1.finishedAt + 1 }];
    expect(staleCourses(d).map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("setup in a cloud session", () => {
  it("asks for web research and caps file text", () => {
    const si = { ...input, draft: { name: "WS", startDate: "2026-10-01", endDate: "2027-02-28" }, facts: [], files: [] };
    const web = setupTurns(si, { web: true }).turns[0].content;
    expect(web).toContain("## Web research");
    expect(web).toContain("Search the web for the official description");
    expect(setupTurns(si).turns[0].content).not.toContain("## Web research");
  });
});
