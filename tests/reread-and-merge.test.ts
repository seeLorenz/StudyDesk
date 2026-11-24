// Risks from the agent-structure review: a re-read must keep skill ids and the
// student's own dates, and two devices saving must not lose each other's work.
import { describe, expect, it } from "vitest";
import { parseSetup } from "../src/onboarding/setup";
import { sheetSnapshot } from "../src/onboarding/agent";
import { applyOps, undoChange, type Desk } from "../src/orchestrator/changes";
import { emptyState, type Change, type OrchState } from "../src/orchestrator/types";
import { mergeState } from "../src/platform/orchestratorStore";
import { keepSemesterOnly } from "../src/platform/questStore";
import type { CourseSetup, DraftCourse, Profile, SemesterDraft } from "../src/onboarding/types";
import type { Semester } from "../src/quests/types";
import type { Skill } from "../src/mastery/types";

const profile: Profile = { level: "university", school: "TU", country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 }, program: "BSc Physics", year: "1", updatedAt: 0 };
const course: DraftCourse = { id: "c1", name: "Analysis 1", short: "Ana1", credits: 9, teachingLanguage: "German", targetGrade: 2, setupStatus: "ready" };
const skill = (id: string, name: string): Skill => ({ id, courseId: "c1", topicId: "c1-t-t1", name, difficulty: "normal", isFundamental: false, prereqSkillIds: [], tier: 3, weight: 1, estMinutes: 6 });

function result(): CourseSetup {
  return {
    courseId: "c1",
    summary: "",
    teachingLanguage: "German",
    topics: [{ id: "c1-t-t1", name: "Folgen", taught: true }],
    skills: [skill("c1-s1", "Grenzwerte von Folgen"), skill("c1-s2", "Quotientenkriterium")],
    gradeRules: null,
    keyDates: [{ courseId: "c1", date: "2027-01-28", kind: "exam", title: "Klausur", skillIds: [] }],
    assignments: [{ id: "a6", courseId: "c1", title: "Blatt 6", dueAt: "2026-11-25T10:00", tasks: [] }],
    catalog: [],
    conflicts: [],
    questions: [],
    basis: "materials",
    truncated: false,
    finishedAt: 1,
  };
}

function desk(): Desk {
  const draft = {
    id: "sem1",
    name: "WS",
    startDate: "2026-10-01",
    endDate: "2027-02-28",
    status: "active",
    setupStep: "done",
    courseIndex: 0,
    courses: [course],
    timetable: [],
    studyGoal: [0, 60, 60, 60, 60, 60, 0],
    uploads: [],
    facts: [],
    results: { c1: result() },
    createdAt: 0,
    updatedAt: 0,
  } as SemesterDraft;
  return { draft, profile };
}

const reply = (skills: string) => `=== SUMMARY ===\nRead again.\n\n=== TOPICS ===\nt1 | Folgen | taught\n\n=== SKILLS ===\n${skills}\n`;

describe("re-reading a course keeps skill ids", () => {
  const input = { course, profile, today: "2026-11-28", priorFundamentals: [], draft: desk().draft };

  it("keeps an id the agent reuses, and never gives an old id to a different skill", () => {
    // The agent kept c1-s2, but numbered a new skill s1, which used to be "Grenzwerte".
    const r = parseSetup(reply("c1-s2 | t1 | Quotientenkriterium | course | 3 | normal | 8 | 1 | s1\ns1 | t1 | Wurzelkriterium | course | 3 | normal | 8 | 1 | -"), input, new Map());
    expect(r.skills.map((s) => s.id)).toEqual(["c1-s2", "c1-s1-2"]);
    expect(r.skills[0].prereqSkillIds).toEqual(["c1-s1-2"]);
  });

  it("keeps a short id that still means the same skill", () => {
    const r = parseSetup(reply("s1 | t1 | Grenzwerte von Folgen | course | 3 | normal | 8 | 1 | -"), input, new Map());
    expect(r.skills.map((s) => s.id)).toEqual(["c1-s1"]);
  });

  it("changes nothing on a first reading", () => {
    const r = parseSetup(reply("s1 | t1 | Wurzelkriterium | course | 3 | normal | 8 | 1 | -"), { ...input, draft: { ...input.draft, results: {} } }, new Map());
    expect(r.skills.map((s) => s.id)).toEqual(["c1-s1"]);
  });
});

describe("re-reading a course keeps homework ids", () => {
  it("keeps the id of a sheet read before and gives a second sheet with the same title its own", () => {
    const d = desk().draft;
    const draft = { ...d, results: { c1: { ...d.results.c1, assignments: [{ ...d.results.c1.assignments[0], id: "as_mine" }] } } };
    const hw = "\n=== HOMEWORK ===\n### Blatt 6 | 2026-12-01\n#### 1 | s1 | 2\nTask.\n### Blatt 6 | 2026-12-08\n#### 1 | s1 | 2\nTask.\n";
    const r = parseSetup(reply("s1 | t1 | Grenzwerte von Folgen | course | 3 | normal | 8 | 1 | -") + hw, { course, profile, today: "2026-11-28", priorFundamentals: [], draft }, new Map());
    expect(r.assignments.map((a) => a.id)).toEqual(["as_mine", "as_mine-2"]);
  });
});

describe("the student's dates survive a re-read", () => {
  it("keeps a moved exam as the student's own word, replacing the older one, and undo takes it back", () => {
    const a = applyOps(desk(), [{ op: "set_exam_date", course: "c1", title: "Klausur", date: "2027-02-04" }], { studentWords: "", now: 1 });
    const b = applyOps(a.desk, [{ op: "set_exam_date", course: "c1", title: "Klausur", date: "2027-02-06" }], { studentWords: "", now: 2 });
    expect(b.desk.draft.facts.map((f) => f.text)).toEqual(['Exam "Klausur": 2027-02-06 (set by the student in StudyDesk)']);
    const u = undoChange(b.desk, b.change!);
    expect(u.ok && u.desk.draft.facts.map((f) => f.text)).toEqual(['Exam "Klausur": 2027-02-04 (set by the student in StudyDesk)']);
  });

  it("doesn't let the nightly check move a date the student set", () => {
    const a = applyOps(desk(), [{ op: "set_due", course: "c1", homework: "Blatt 6", dueAt: "2026-11-27T10:00" }], { studentWords: "", now: 1 });
    const night = applyOps(a.desk, [{ op: "set_due", course: "c1", homework: "Blatt 6", dueAt: "2026-11-25T10:00" }, { op: "set_exam_date", course: "c1", title: "Klausur", date: "2027-02-01" }], { studentWords: "", by: "organization", now: 2 });
    expect(night.desk.draft.results.c1.assignments[0].dueAt).toBe("2026-11-27T10:00");
    expect(night.errors).toHaveLength(1);
    // A date the student never touched still follows what the agent found, without becoming the student's word.
    expect(night.desk.draft.results.c1.keyDates[0].date).toBe("2027-02-01");
    expect(night.desk.draft.facts).toHaveLength(1);
  });
});

describe("two devices saving", () => {
  const change = (id: string, at: number) => ({ id, at }) as unknown as Change;
  const state = (over: Partial<OrchState>): OrchState => ({ ...emptyState(), ...over });

  it("keeps what the other device added and what this one removed stays removed", () => {
    const base = state({ changes: [change("a", 1), change("b", 2)], updatedAt: 2 });
    const ours = state({ changes: [change("a", 1), change("c", 4)], updatedAt: 4 });
    const theirs = state({ changes: [change("a", 1), change("b", 2), change("x", 3)], updatedAt: 3 });
    expect(mergeState(base, ours, theirs).changes.map((c) => c.id)).toEqual(["a", "x", "c"]);
  });

  it("writes ours as is when nobody else saved", () => {
    const base = state({ updatedAt: 2 });
    const ours = state({ changes: [change("a", 3)], updatedAt: 3 });
    expect(mergeState(base, ours, base)).toBe(ours);
  });

  it("keeps the placement check and a newer workload answer on the semester", () => {
    const sem = { id: "sem1", studyGoal: [0, 60, 60, 60, 60, 60, 0] } as Semester;
    const stored = { ...sem, placementQuestId: "q1", studyGoal: [0, 90, 90, 90, 90, 90, 0], studyGoalSource: "recommended", studyGoalDecidedAt: 5 } as Semester;
    expect(keepSemesterOnly(sem, stored)).toMatchObject({ placementQuestId: "q1", studyGoal: stored.studyGoal, studyGoalDecidedAt: 5 });
    expect(keepSemesterOnly(sem, { ...stored, id: "old" })).toBe(sem);
  });
});

describe("Organize sees the to-do list", () => {
  it("lists the to-do items and the course's questions while a course is being read again", () => {
    const d = desk().draft;
    const draft = { ...d, setupStep: "running", results: { c1: { ...d.results.c1, questions: ["How long is each Teilklausur?", "Which aids are allowed?"] } } } as SemesterDraft;
    const sheet = JSON.parse(sheetSnapshot(draft, profile, "2026-11-23"));
    expect(sheet.courses[0].questionsFromReading).toHaveLength(2);
    const q = sheet.toDo.find((t: { key: string }) => t.key === "q-c1");
    expect(q.parts.map((x: { text: string }) => x.text)).toEqual(["How long is each Teilklausur?", "Which aids are allowed?"]);
  });
});
