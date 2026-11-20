import { describe, expect, it } from "vitest";
import { planQuest, type PlanInput, doneTasks, recentBlockers, formatDue, busyMinutes } from "../src/quests/plan";
import { parseSections, writeQuest, claudeWriter, type Ask } from "../src/quests/write";
import { handIn, lockedParts, gateFailed, emptyProgress, isFinished, ungraded } from "../src/quests/handin";
import { sampleSemester, sampleWriter, sampleGradingAsk, SAMPLE_SKILLS } from "../src/quests/seed";
import type { Attempt } from "../src/mastery/types";
import type { ProblemPart, Quest } from "../src/quests/types";

const TUE = "2026-11-03";
const sem = sampleSemester(TUE, 0);
const base: PlanInput = { semester: sem, today: TUE, nowLocal: `${TUE}T08:00`, attempts: [] as Attempt[], reviews: [], doneTaskIds: new Set<string>(), blockerSkillIds: [] };

function plan(over: Partial<PlanInput> = {}): Quest {
  const r = planQuest({ ...base, ...over });
  if (r.kind !== "quest") throw new Error(r.kind);
  return r.quest;
}

describe("planQuest", () => {
  it("builds the example shape for a new student with Sheet 4 due tomorrow", () => {
    const q = plan();
    expect(q.parts.map((p) => p.kind)).toEqual(["learn", "practice", "learn", "assignment"]);
    const gate = q.parts[1] as ProblemPart;
    expect(gate.gate).toBe(true);
    expect(gate.problems.map((p) => p.skillId)).toEqual(["sk_factorial-quotients", "sk_rational-limits", "sk_nth-root-limits"]);
    const hw = q.parts[3] as ProblemPart;
    expect(hw.problems.map((p) => p.label)).toEqual(["4.2a", "4.2b"]);
    // 210 goal − 90 lectures = 120 free; a new student gets half.
    expect(q.budgetMinutes).toBe(60);
    expect(q.plannedMinutes).toBeLessThanOrEqual(66);
    expect(q.reason).toContain("Sheet 4 is due tomorrow 11:00");
  });

  it("uses the student's own times once there are enough of them", () => {
    const quick = (skillId: string, i: number): Attempt => ({
      id: `a${skillId}${i}`, skillId, questId: null, part: "practice", day: `2026-11-0${i}`, verdict: "solved", points: 1, maxPoints: 1,
      hintsUsed: 0, sawWorkedExample: false, activeSeconds: 60, startedAt: 0, gradedAt: i,
    });
    const attempts = [1, 2].map((i) => quick("sk_geometric", i));
    const q = plan({ attempts });
    // slowness = median(1 min ÷ 4 min) clamped to 1, so a ratio-test task is 7 min.
    const hw = q.parts.find((p) => p.kind === "assignment") as ProblemPart;
    expect(hw.problems[0].expMinutes).toBe(7);
  });

  it("leaves out tasks that don't fit and warns when the sheet is due tomorrow", () => {
    const q = plan({ budgetOverride: 30 });
    const hw = q.parts.find((p) => p.kind === "assignment") as ProblemPart;
    expect(hw.problems.map((p) => p.label)).toEqual(["4.2a"]);
    expect(q.notes.join(" ")).toContain("4.2b doesn't fit today");
  });

  it("returns no_time on a day off", () => {
    const sun = "2026-11-08";
    const r = planQuest({ ...base, today: sun, nowLocal: `${sun}T08:00` });
    expect(r.kind).toBe("no_time");
  });

  it("moves on to the next sheet and brings back yesterday's skills", () => {
    const q1 = plan();
    const done = new Set(sem.assignments[0].tasks.map((t) => t.id));
    const solved = (skillId: string): Attempt => ({
      id: `a-${skillId}`, skillId, questId: q1.id, part: "practice", day: TUE, verdict: "solved", points: 1, maxPoints: 1,
      hintsUsed: 0, sawWorkedExample: false, activeSeconds: 300, startedAt: 0, gradedAt: 1,
    });
    const attempts = ["sk_ratio-test", "sk_root-test", "sk_factorial-quotients"].map(solved);
    const wed = "2026-11-04";
    const q = plan({ today: wed, nowLocal: `${wed}T08:00`, attempts, doneTaskIds: done, budgetOverride: 90 });
    expect(q.parts[0].kind).toBe("practice");
    expect((q.parts[0] as ProblemPart).problems.length).toBeGreaterThan(0);
    const hw = q.parts.find((p) => p.kind === "assignment") as ProblemPart;
    expect(hw.title).toContain("Sheet 5");
  });

  it("puts a blocker fundamental first", () => {
    const q = plan({ blockerSkillIds: ["sk_nth-root-limits"] });
    const gate = q.parts.find((p) => p.kind === "practice") as ProblemPart;
    expect(gate.problems[0].skillId).toBe("sk_nth-root-limits");
  });
});

describe("helpers", () => {
  it("formats due dates", () => {
    expect(formatDue("2026-11-04T11:00", "2026-11-03")).toBe("tomorrow 11:00");
    expect(formatDue("2026-11-06T11:00", "2026-11-03")).toBe("Friday 11:00");
  });
  it("counts lecture minutes", () => {
    expect(busyMinutes(sem.timetable, 2)).toBe(90);
    expect(busyMinutes(sem.timetable, 0)).toBe(0);
  });
  it("parses sections", () => {
    const s = parseSections("=== P1 PROMPT ===\nSimplify $\\frac{a}{b}$\n=== p1 answer ===\n42\n");
    expect(s.get("P1 PROMPT")).toBe("Simplify $\\frac{a}{b}$");
    expect(s.get("P1 ANSWER")).toBe("42");
  });
});

describe("writing", () => {
  it("fills every part through the writer", async () => {
    const q = await writeQuest(plan(), sampleWriter(SAMPLE_SKILLS));
    for (const p of q.parts) {
      if (p.kind === "learn") expect(p.body).not.toBe("");
      else for (const pr of p.problems) expect(pr.prompt && pr.answerKey).toBeTruthy();
    }
  });

  it("retries once when a section is missing, then fails", async () => {
    const q = plan();
    const part = q.parts.find((p) => p.kind === "practice") as ProblemPart;
    let calls = 0;
    const good = part.problems.map((p) => `=== ${p.id} PROMPT ===\nx\n=== ${p.id} ANSWER ===\ny`).join("\n");
    const ask: Ask = async () => (++calls === 1 ? "=== P1 PROMPT ===\nonly this" : good);
    const out = await claudeWriter(sem, q, [], ask).practice(q, part);
    expect(calls).toBe(2);
    expect(out[0].prompt).toBe("x");
    const bad: Ask = async () => "nothing";
    await expect(claudeWriter(sem, q, [], bad).practice(q, part)).rejects.toThrow(/Couldn't write/);
  });
});

describe("hand-in and the gate", () => {
  it("grades a gate, locks later parts when a fundamental isn't understood, and finishes", async () => {
    const q = await writeQuest(plan(), sampleWriter(SAMPLE_SKILLS));
    const gate = q.parts.find((p) => p.kind === "practice") as ProblemPart;
    const work = {
      [gate.problems[0].id]: { answerText: "n+1", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 120, startedAt: 1 },
      [gate.problems[1].id]: { answerText: "", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 30, startedAt: 1 },
    };
    const res = await handIn({
      quest: q, problems: gate.problems.map((problem) => ({ problem, part: gate })), work, images: {},
      semester: sem, today: TUE, nowLocal: `${TUE}T09:00`, ask: sampleGradingAsk, now: 1000,
    });
    expect(res.attempts).toHaveLength(3);
    expect(res.attempts[0].activeSeconds).toBe(120);
    expect(res.reviews.length).toBe(2);
    const progress = { ...emptyProgress(q.id), work: res.work, handedIn: [gate.id] };
    expect(gateFailed(gate, progress)).toBe(true);
    const hw = q.parts.find((p) => p.kind === "assignment")!;
    expect(lockedParts(q, progress).has(hw.id)).toBe(true);
    expect(lockedParts(q, { ...progress, gatesCleared: [gate.id] }).has(hw.id)).toBe(false);
    expect(isFinished(q, progress)).toBe(false);
    const all = q.parts.map((p) => p.id);
    expect(ungraded(q, { ...progress, handedIn: all }).map((x) => x.problem.label)).toEqual(["4.2a", "4.2b"]);
    expect(isFinished(q, { ...progress, handedIn: all })).toBe(false);
    expect(doneTasks([{ quest: q, progress }]).size).toBe(0);
  });

  it("tells grading that open homework must not reveal the answer", async () => {
    const q = await writeQuest(plan(), sampleWriter(SAMPLE_SKILLS));
    const hw = q.parts.find((p) => p.kind === "assignment") as ProblemPart;
    let prompt = "";
    const ask: Ask = async (turns) => {
      prompt = turns[0].content;
      return sampleGradingAsk(turns);
    };
    await handIn({
      quest: q, problems: hw.problems.map((problem) => ({ problem, part: hw })),
      work: Object.fromEntries(hw.problems.map((p) => [p.id, { answerText: "ratio → 2, diverges", files: [], hintsShown: 1, sawSimilar: false, activeSeconds: 600, startedAt: 1 }])),
      images: {}, semester: sem, today: TUE, nowLocal: `${TUE}T09:00`, ask,
    });
    expect(prompt).toContain("do NOT give the full answer");
    expect(prompt).toContain("Hints used: 1");
  });

  it("collects recent blockers", () => {
    const q = plan();
    const rec = { quest: q, progress: { work: { p1: { verdict: "not_understood", fundamentalSkillId: "sk_rational-limits" } } } };
    expect(recentBlockers([rec], TUE)).toEqual(["sk_rational-limits"]);
  });
});
