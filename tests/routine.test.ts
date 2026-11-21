import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callId, deferredAsk, isPending } from "../src/routine/deferred";
import { runNightly, type NightInput, type NightResult } from "../src/routine/nightly";
import { applyShallow, applySweep, mergeGrading, outboxOrder, type GradingOutbox, type OutboxDoc, type ShallowOutbox } from "../src/routine/apply";
import { clampSweep, nextOrgState, parseShallow, shallowTurns, sweepsDue } from "../src/routine/org";
import { nightlyCron, scheduleFits, schedulePrompt } from "../src/platform/schedule";
import { applyOps } from "../src/orchestrator/changes";
import { setupTodo } from "../src/onboarding/todo";
import { sampleGradingAsk, sampleSemester } from "../src/quests/seed";
import { planQuest } from "../src/quests/plan";
import { emptyProgress } from "../src/quests/handin";
import { QuestIncomplete } from "../src/quests/write";
import type { Turn } from "../src/platform/claude";
import type { ProblemPart, QuestRecord } from "../src/quests/types";
import type { CourseSetup, Profile, SemesterDraft } from "../src/onboarding/types";

const TUE = "2026-11-03";
const NOW = Date.UTC(2026, 10, 3, 21, 0);

/** Answers like the cloud session would, in the format each call asks for. */
async function answer(label: string, turns: Turn[]): Promise<string> {
  const last = turns[turns.length - 1].content;
  if (label.startsWith("Grading")) return sampleGradingAsk(turns);
  if (label.startsWith("Tonight's short check"))
    return `=== CHANGES ===\n[{"op":"set_exam_date","course":"c1","title":"Final exam","date":"2027-02-12","kind":"exam","source":"course page"}]\n=== QUESTIONS ===\nnone\n=== NEXT DEEP SWEEP ===\nc1: 2026-11-20\n=== NOTE ===\nThe final exam moved to 12 Feb.`;
  const keys = [...new Set([...turns[0].content.matchAll(/^===\s*(.+?)\s*===\s*$/gm)].map((m) => m[1]))];
  void last;
  return keys.map((k) => `=== ${k} ===\nWritten by the session for ${k}.`).join("\n");
}

// The CLI fixes the clock and the random ids for the night; so do the tests.
function freeze() {
  vi.restoreAllMocks();
  let seed = 42;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
}
beforeEach(freeze);
afterEach(() => {
  vi.restoreAllMocks();
});

/** Plays the session: run, answer what's pending, run again, until done. */
async function playNight(input: NightInput, maxRounds = 6): Promise<{ result: NightResult; rounds: number; calls: number }> {
  freeze();
  const answers = new Map<string, string>();
  let calls = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const d = deferredAsk(answers);
    const result = await runNightly(input, d);
    if (result.kind === "done") return { result, rounds: round, calls };
    expect(d.pending.length).toBeGreaterThan(0);
    for (const p of d.pending) {
      answers.set(p.id, await answer(p.label, p.turns));
      calls++;
    }
  }
  throw new Error("The night never finished.");
}

function handedInRecord(): QuestRecord {
  const sem = sampleSemester(TUE, 0);
  const r = planQuest({ semester: sem, today: TUE, nowLocal: `${TUE}T08:00`, attempts: [], reviews: [], doneTaskIds: new Set(), blockerSkillIds: [], questId: "qst_tue" });
  if (r.kind !== "quest") throw new Error(r.kind);
  const quest = r.quest;
  for (const p of quest.parts) if (p.kind !== "learn") for (const q of p.problems) Object.assign(q, { prompt: `Problem ${q.id}`, answerKey: "key" });
  const progress = emptyProgress(quest.id);
  const practice = quest.parts.find((p) => p.kind === "practice") as ProblemPart;
  progress.handedIn = [practice.id];
  for (const q of practice.problems) progress.work[q.id] = { answerText: q === practice.problems[0] ? "my answer" : "", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 60, startedAt: NOW - 3_600_000 };
  return { quest, progress };
}

function input(over: Partial<NightInput> = {}): NightInput {
  const semester = sampleSemester(TUE, 0);
  return {
    today: TUE,
    nowLocal: `${TUE}T22:00`,
    now: NOW,
    profile: null,
    draft: null,
    semester,
    records: [handedInRecord()],
    mastery: { skills: semester.skills, targets: semester.targets, attempts: [], reviews: [] },
    outbox: [],
    routine: null,
    images: new Map(),
    uploads: new Map(),
    ...over,
  };
}

describe("deferred Claude calls", () => {
  it("fingerprints calls by their turns", () => {
    const a: Turn[] = [{ role: "user", content: "hi" }];
    expect(callId(a)).toBe(callId([{ role: "user", content: "hi" }]));
    expect(callId(a)).not.toBe(callId([{ role: "user", content: "hi!" }]));
    expect(callId(a, 1)).not.toBe(callId(a));
  });

  it("lists a missing answer and stops; answers it once it's there", async () => {
    const d = deferredAsk(new Map());
    const ask = d.ask("Test");
    await expect(ask([{ role: "user", content: "q" }])).rejects.toSatisfy(isPending);
    expect(d.pending).toHaveLength(1);
    const d2 = deferredAsk(new Map([[d.pending[0].id, "the answer"]]));
    expect(await d2.ask("Test")([{ role: "user", content: "q" }])).toBe("the answer");
  });

  it("sees a pending call behind a quest that couldn't be finished", async () => {
    const d = deferredAsk(new Map());
    const e = await d.ask("x")([{ role: "user", content: "q" }]).catch((x) => x);
    expect(isPending(new QuestIncomplete({} as never, [], e))).toBe(true);
    expect(isPending(new Error("real failure"))).toBe(false);
  });
});

describe("the nightly run", () => {
  it("grades the day, then writes tomorrow's quest from those grades", async () => {
    const { result, rounds } = await playNight(input());
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    // Round 1: grading. Round 2: tomorrow's parts, all at once.
    expect(rounds).toBe(3);
    const paths = result.writes.map((w) => w.path.join("/"));
    expect(paths.filter((p) => p.startsWith("mastery/attempts/"))).toHaveLength(3);
    const box = result.writes.find((w) => w.path[1] === "outbox")!.data as unknown as GradingOutbox;
    expect(box.kind).toBe("grading");
    expect(Object.values(box.work).map((w) => w.verdict)).toEqual(["solved", "not_understood", "not_understood"]);
    // answers are never in the outbox, only grades
    expect(Object.values(box.work).some((w) => "answerText" in w)).toBe(false);
    const quest = result.writes.find((w) => w.path[1] === "records")!.data as unknown as QuestRecord;
    expect(quest.quest.date).toBe("2026-11-04");
    expect(quest.quest.parts.every((p) => (p.kind === "learn" ? p.body : p.problems.every((q) => q.prompt || q.answerKey)))).toBe(true);
    // the routine document comes last, and marks the night done
    expect(paths[paths.length - 1]).toBe("routine");
    expect(result.night.questId).toBe(quest.quest.id);
    expect(result.log.join(" ")).toContain("Graded Tuesday's quest: 1 of 3 problems solved.");
  });

  it("comes out the same on every run of the same night", async () => {
    const a = await playNight(input());
    const b = await playNight(input());
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });

  it("uses grades left in the outbox when the page wasn't opened", async () => {
    const rec = handedInRecord();
    const practice = rec.quest.parts.find((p) => p.kind === "practice") as ProblemPart;
    const box: GradingOutbox = {
      kind: "grading", id: "b1", day: "2026-11-02", questId: rec.quest.id, createdAt: NOW - 86_400_000,
      work: Object.fromEntries(practice.problems.map((q) => [q.id, { verdict: "solved" as const, points: 2, attemptId: `a_${q.id}` }])),
    };
    const { result } = await playNight(input({ records: [rec], outbox: [box] }));
    if (result.kind !== "done") throw new Error("not done");
    expect(result.writes.some((w) => w.path[0] === "mastery")).toBe(false);
    expect(result.log[0]).toContain("nothing was handed in");
  });

  it("doesn't write a second quest for tomorrow, and nothing before the placement check", async () => {
    const tomorrow = handedInRecord();
    tomorrow.quest = { ...tomorrow.quest, id: "qst_wed", date: "2026-11-04" };
    tomorrow.progress = emptyProgress("qst_wed");
    const a = await playNight(input({ records: [handedInRecord(), tomorrow] }));
    if (a.result.kind !== "done") throw new Error("not done");
    expect(a.result.writes.some((w) => w.path[1] === "records")).toBe(false);

    const sem = { ...sampleSemester(TUE, 0), source: "onboarding" as const };
    const b = await playNight(input({ semester: sem, records: [] }));
    if (b.result.kind !== "done") throw new Error("not done");
    expect(b.result.writes.some((w) => w.path[1] === "records")).toBe(false);
    expect(b.result.log.join(" ")).toContain("placement check");
  });
});

describe("merging the outbox", () => {
  it("adds grades without touching answers, and keeps grades given in the meantime", () => {
    const rec = handedInRecord();
    const [p1, p2] = (rec.quest.parts.find((p) => p.kind === "practice") as ProblemPart).problems;
    rec.progress.work[p2.id] = { ...rec.progress.work[p2.id], verdict: "solved", points: 2 };
    const box: GradingOutbox = { kind: "grading", id: "b", day: TUE, questId: rec.quest.id, createdAt: 0, work: { [p1.id]: { verdict: "slip", points: 1 }, [p2.id]: { verdict: "not_understood", points: 0 } } };
    const out = mergeGrading(rec, box, 5);
    expect(out.progress.work[p1.id].verdict).toBe("slip");
    expect(out.progress.work[p1.id].answerText).toBe("my answer");
    expect(out.progress.work[p2.id].verdict).toBe("solved");
    expect(mergeGrading(out, box, 6)).toBe(out);
  });

  it("orders a night's documents: grades, sweeps, then the check", () => {
    const g = { kind: "grading", day: "d2", createdAt: 3 } as OutboxDoc;
    const s = { kind: "org-sweep", day: "d2", createdAt: 1 } as OutboxDoc;
    const c = { kind: "org-shallow", day: "d2", createdAt: 0 } as OutboxDoc;
    const old = { kind: "org-shallow", day: "d1", createdAt: 9 } as OutboxDoc;
    expect(outboxOrder([c, s, g, old])).toEqual([old, g, s, c]);
  });
});

// ---------- the organization agent ----------

const profile: Profile = { level: "university", school: "Example University", country: "Germany", gradeScale: { kind: "de_1_5" } as never, program: "Physics", year: "1", updatedAt: 0 };

function draft(): SemesterDraft {
  const setup: CourseSetup = {
    courseId: "c1", summary: "Calculus", teachingLanguage: "English", topics: [], skills: [], gradeRules: null,
    keyDates: [{ courseId: "c1", date: "2027-02-10", kind: "exam", title: "Final exam", skillIds: [] }],
    assignments: [{ id: "as1", courseId: "c1", title: "Sheet 5", dueAt: "2026-11-10T11:00", tasks: [] }],
    catalog: [], conflicts: [], questions: [], basis: "materials", truncated: false, finishedAt: 0,
  };
  return {
    id: "sem1", name: "WS 26/27", startDate: "2026-10-12", endDate: "2027-02-20", status: "active", setupStep: "done", courseIndex: 0,
    courses: [{ id: "c1", name: "Calculus 1", short: "Calc", credits: 9, teachingLanguage: "English", targetGrade: 2, setupStatus: "ready" }],
    timetable: [], studyGoal: [0, 120, 120, 120, 120, 120, 0], uploads: [], facts: [], results: { c1: setup }, todoDone: ["q-c1"], createdAt: 0, updatedAt: 0,
  };
}

describe("the organization agent's nightly check", () => {
  it("asks about every course, with what StudyDesk already knows", () => {
    const t = shallowTurns(draft(), profile, {}, TUE)[0].content;
    expect(t).toContain("Calculus 1 (id c1");
    expect(t).toContain("Sheet 5 (id as1), due 2026-11-10 11:00");
    expect(t).toContain('exam "Final exam" on 2027-02-10');
  });

  it("keeps only the operations it may apply alone, and clamps the sweep date", () => {
    const reply = `=== CHANGES ===
[{"op":"set_exam_date","course":"c1","title":"Final exam","date":"2027-02-12","kind":"exam","source":"course page"},{"op":"drop_course","course":"c1"}]
=== QUESTIONS ===
c1: Is the midterm optional?
cX: not a course
=== NEXT DEEP SWEEP ===
c1: 2026-11-04
=== NOTE ===
The exam moved by two days.`;
    const r = parseShallow(reply, draft(), TUE);
    expect(r.ops).toEqual([{ op: "set_exam_date", course: "c1", title: "Final exam", date: "2027-02-12", kind: "exam", why: "course page" }]);
    expect(r.skipped[0]).toContain("drop_course");
    expect(r.questions).toEqual([{ courseId: "c1", text: "Is the midterm optional?" }]);
    expect(r.nextSweep.c1).toBe("2026-11-06");
    expect(() => parseShallow("nothing", draft(), TUE)).toThrow();
  });

  it("applies a check through the normal change rules, and re-opens questions", () => {
    const box: ShallowOutbox = {
      kind: "org-shallow", id: "x", day: TUE, semesterId: "sem1", createdAt: 0, note: "The exam moved.",
      ops: [{ op: "set_exam_date", course: "c1", title: "Final exam", date: "2027-02-12", kind: "exam" }],
      questions: [{ courseId: "c1", text: "Is the midterm optional?" }],
    };
    const r = applyShallow({ draft: draft(), profile }, box, 1);
    expect(r.change?.by).toBe("organization");
    expect(r.change?.undoable).toBe(true);
    expect(r.desk.draft.results.c1.keyDates[0].date).toBe("2027-02-12");
    expect(r.desk.draft.results.c1.questions).toEqual(["Is the midterm optional?"]);
    expect(r.desk.draft.todoDone).toEqual([]);
    // another semester: left alone
    expect(applyShallow({ draft: { ...draft(), id: "other" }, profile }, box, 1).change).toBeNull();
  });

  it("puts a deep sweep's reading in place of the old one", () => {
    const d = draft();
    const setup = { ...d.results.c1, summary: "Read again", questions: ["Which chapters?"] };
    const r = applySweep({ draft: d, profile }, { kind: "org-sweep", id: "s", day: TUE, semesterId: "sem1", courseId: "c1", setup, readIds: [], createdAt: 0 }, 1);
    expect(r.draft.results.c1.summary).toBe("Read again");
    expect(r.draft.courses[0].setupStatus).toBe("needs_check");
  });

  it("schedules sweeps: first a week after setup, then the date the agent picked", () => {
    const d = draft();
    let org = nextOrgState({}, d, TUE, null, []);
    expect(org.c1.nextDeepSweep).toBe("2026-11-10");
    expect(sweepsDue(d, org, "2026-11-09")).toEqual([]);
    expect(sweepsDue(d, org, "2026-11-10")).toEqual(["c1"]);
    org = nextOrgState(org, d, "2026-11-10", { ops: [], questions: [], nextSweep: { c1: "2026-11-24" }, note: "", skipped: [] }, ["c1"]);
    expect(org.c1).toEqual({ nextDeepSweep: "2026-11-24", lastDeepSweep: "2026-11-10", lastShallow: "2026-11-10" });
    expect(clampSweep("2027-06-01", TUE)).toBe("2026-12-01");
  });

  it("runs the check and a due sweep in the same night as the quest", async () => {
    const d = draft();
    const routine = { org: { c1: { nextDeepSweep: TUE, lastDeepSweep: null, lastShallow: null } }, nights: [], updatedAt: 0 };
    const { result } = await playNight(input({ profile, draft: d, routine }));
    if (result.kind !== "done") throw new Error("not done");
    // The stand-in can't write a whole course reading, so the sweep fails and stays due; the check still counts.
    expect(result.log.join(" ")).toContain("A deep sweep failed");
    expect(result.log.join(" ")).toContain("The final exam moved to 12 Feb.");
    const box = result.writes.find((w) => (w.data as { kind?: string }).kind === "org-shallow")!.data as unknown as ShallowOutbox;
    expect(box.ops[0]).toMatchObject({ op: "set_exam_date", date: "2027-02-12" });
    const saved = result.writes[result.writes.length - 1].data as { org: Record<string, { lastShallow: string | null; nextDeepSweep: string }> };
    expect(saved.org.c1.lastShallow).toBe(TUE);
    expect(saved.org.c1.nextDeepSweep).toBe("2026-11-20");
  });
});

describe("changing the nightly run through the StudyDesk chat", () => {
  it("sets the time, pauses, and turns parts off, with Undo", () => {
    const r = applyOps({ draft: draft(), profile }, [{ op: "set_nightly", time: "21:30", quest: false }], { studentWords: "run at half nine, and don't write quests at night" });
    expect(r.errors).toEqual([]);
    expect(r.desk.profile.nightly).toMatchObject({ time: "21:30", paused: false, grading: true, quest: false });
    expect(r.change?.lines[0]).toBe("Nightly run: time 22:00 → 21:30, writing tomorrow's quest at night off");
    expect(r.change?.undoable).toBe(true);
    expect(applyOps(r.desk, [{ op: "set_nightly", time: "25:00" }], { studentWords: "" }).errors[0]).toContain("HH:MM");
    // the new time needs a new scheduled task; the old one stops by its key
    expect(scheduleFits({ triggerId: "t", key: "k", timeZone: "Europe/Berlin", time: "22:00", createdAt: 0 }, "Europe/Berlin", "21:30")).toBe(false);
  });

  it("ticks a setup to-do item off itself", () => {
    const d = draft();
    const key = setupTodo(d)[0]?.key;
    expect(key).toBeDefined();
    const r = applyOps({ draft: d, profile }, [{ op: "tick_todo", key }], { studentWords: "here are the dates, they're right" });
    expect(r.errors).toEqual([]);
    expect(setupTodo(r.desk.draft).find((t) => t.key === key)?.done).toBe(true);
    expect(r.change?.lines[0]).toMatch(/^To do: ticked off/);
    expect(applyOps({ draft: d, profile }, [{ op: "tick_todo", key: "nope" }], { studentWords: "" }).errors[0]).toContain("no to-do");
  });

  it("treats the calendar as live unless the student says otherwise", () => {
    const d = { ...draft(), calendarImportedAt: 1 };
    const r = applyOps({ draft: d, profile }, [{ op: "set_calendar_live", on: false }], { studentWords: "stop following my calendar" });
    expect(r.errors).toEqual([]);
    expect(r.desk.draft.calendarLive).toBe(false);
    expect(applyOps(r.desk, [{ op: "set_calendar_live", on: true }], { studentWords: "" }).desk.draft.calendarLive).toBe(true);
    expect(applyOps({ draft: draft(), profile }, [{ op: "set_calendar_live", on: false }], { studentWords: "" }).errors[0]).toContain("no calendar");
  });

  it("sets a course's deep sweep date, which wins over the agent's own", () => {
    const r = applyOps({ draft: draft(), profile }, [{ op: "set_sweep", course: "Calculus 1", date: "2026-11-05" }], { studentWords: "read calculus again on thursday" });
    expect(r.desk.draft.sweepDates).toEqual({ c1: "2026-11-05" });
    const org = { c1: { nextDeepSweep: "2026-11-20", lastDeepSweep: null, lastShallow: null } };
    expect(sweepsDue(r.desk.draft, org, "2026-11-04")).toEqual([]);
    expect(sweepsDue(r.desk.draft, org, "2026-11-05")).toEqual(["c1"]);
    // once done, the same date doesn't sweep again
    expect(sweepsDue(r.desk.draft, { c1: { ...org.c1, lastDeepSweep: "2026-11-05" } }, "2026-11-06")).toEqual([]);
    const cleared = applyOps(r.desk, [{ op: "set_sweep", course: "c1", date: "none" }], { studentWords: "" });
    expect(cleared.desk.draft.sweepDates).toEqual({});
  });

  it("skips the parts the student turned off", async () => {
    const { result } = await playNight(input({ profile: { ...profile, nightly: { time: "22:00", paused: false, grading: false, check: true, quest: false } } }));
    if (result.kind !== "done") throw new Error("not done");
    expect(result.writes.map((w) => w.path.join("/"))).toEqual(["routine"]);
    expect(result.log.join(" ")).toContain("Grading at night is turned off");
  });
});

describe("the schedule", () => {
  it("runs at 22:00 in the student's own time zone", () => {
    expect(nightlyCron("Europe/Berlin")).toBe("CRON_TZ=Europe/Berlin 0 22 * * *");
    expect(nightlyCron("America/New_York", "21:30")).toBe("CRON_TZ=America/New_York 30 21 * * *");
  });

  it("carries its key, so a replaced task does nothing", () => {
    const p = schedulePrompt("k123", "https://claude.ai/artifact/abc");
    expect(p).toContain("--key k123");
    expect(p).toContain("routine.mjs");
    expect(p).toContain("https://claude.ai/artifact/abc");
  });
});
