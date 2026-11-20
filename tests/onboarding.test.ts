import { describe, expect, it } from "vitest";
import { localFound, parseFound, weekdayIndex } from "../src/onboarding/extract";
import { parseSetup, buildSemester, localSetup, setupTurns, type SetupInput } from "../src/onboarding/setup";
import { planPlacement, recommendWorkload, studyDaysUntil } from "../src/onboarding/placement";
import { defaultSemester, gradeSteps, scaleFor } from "../src/onboarding/scales";
import type { DraftCourse, Profile, SemesterDraft } from "../src/onboarding/types";
import { replay } from "../src/mastery/replay";
import type { Attempt } from "../src/mastery/types";
import { questMistakes } from "../src/quests/review";
import { emptyProgress, gradingProblem, emptyWork } from "../src/quests/handin";

const TODAY = "2026-11-20"; // a Friday
const profile: Profile = { level: "university", school: "TU", country: "Austria", gradeScale: scaleFor("Austria", "university"), program: "BSc Physics", year: "1", updatedAt: 0 };
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

describe("extract", () => {
  it("reads courses and slots from Claude's reply", () => {
    const f = parseFound(`=== COURSES ===
Analysis 1 | Ana1 | 9 ECTS
Physik Labor | Lab | -
=== TIMETABLE ===
Mon | 10:00 | 11:30 | lecture | Analysis 1
Mi | 8.15 | 9:45 | Übung | Analysis 1
Fri | 12:00 | 11:00 | lecture | broken`);
    expect(f.courses).toEqual([
      { name: "Analysis 1", short: "Ana1", credits: 9 },
      { name: "Physik Labor", short: "Lab", credits: null },
    ]);
    expect(f.timetable).toHaveLength(2);
    expect(f.timetable[1]).toMatchObject({ weekday: 3, start: "08:15", end: "09:45", kind: "exercise" });
  });
  it("reads typed lines in the local preview", () => {
    const f = localFound("courses", "Analysis 1, 9 ECTS\nLinear Algebra\nTue 10:00-12:00 Linear Algebra");
    expect(f.courses.map((c) => c.name)).toEqual(["Analysis 1", "Linear Algebra"]);
    expect(f.courses[0].credits).toBe(9);
    expect(f.timetable[0]).toMatchObject({ weekday: 2, start: "10:00", end: "12:00" });
    expect(weekdayIndex("Donnerstag")).toBe(4);
  });
});

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

describe("scales and defaults", () => {
  it("picks a scale per country and offers whole grades", () => {
    expect(scaleFor("Germany", "school").name).toBe("German 1–6");
    expect(gradeSteps(scaleFor("Austria", "school"))).toEqual([1, 2, 3, 4, 5]);
    expect(gradeSteps(scaleFor("Switzerland", "school"))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(gradeSteps(scaleFor("", "school"))).toBeNull();
    expect(defaultSemester(TODAY, "university").name).toBe("WS 2026/27");
    expect(defaultSemester("2027-04-02", "university").name).toBe("SS 2027");
  });
  it("builds a usable local preview map", () => {
    const r = localSetup({ profile, draft: { name: "x", startDate: TODAY, endDate: TODAY }, course, facts: [], files: [], today: TODAY, priorFundamentals: [] });
    expect(r.skills.length).toBe(6);
    expect(r.keyDates).toHaveLength(1);
  });
});
