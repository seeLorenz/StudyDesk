import { describe, expect, it } from "vitest";
import { planQuest, type PlanInput, doneTasks, recentBlockers, formatDue, busyMinutes } from "../src/quests/plan";
import { parseSections, writeQuest, QuestIncomplete, claudeWriter, type Ask } from "../src/quests/write";
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
  it("teaches in short cycles, one idea at a time, with the homework last", () => {
    const q = plan();
    expect(q.parts.map((p) => p.kind)).toEqual(["practice", "lesson", "lesson", "lesson", "assignment"]);
    const check = q.parts[0] as ProblemPart;
    expect(check.problems.map((p) => p.skillId)).toEqual(["sk_factorial-quotients", "sk_rational-limits", "sk_nth-root-limits"]);
    expect(q.parts.slice(1, 4).map((p) => (p as ProblemPart).skillIds![0])).toEqual(["sk_series-def", "sk_ratio-test", "sk_root-test"]);
    // each lesson has its own short problem right after the explanation
    const ratio = q.parts[2] as ProblemPart;
    expect(ratio.problems).toHaveLength(1);
    expect(ratio.problems[0].expMinutes).toBe(7);
    const hw = q.parts[4] as ProblemPart;
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
      else {
        if (p.kind === "lesson") expect(p.body).toContain("Worked example");
        for (const pr of p.problems) expect(pr.prompt && pr.answerKey).toBeTruthy();
      }
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
    expect(ungraded(q, { ...progress, handedIn: all }).map((x) => x.problem.label ?? x.part.kind)).toEqual(["lesson", "lesson", "lesson", "4.2a", "4.2b"]);
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

describe("points and the mistake review", () => {
  it("gives no finishing bonus when nothing was solved", async () => {
    const { questBonus } = await import("../src/mastery/replay");
    expect(questBonus(0, 7)).toBe(0);
    expect(questBonus(7, 7)).toBe(25);
    expect(questBonus(3, 6)).toBe(13);
  });

  it("lists not-understood problems and disputed slips, and opens with them", async () => {
    const { questMistakes, newReviewChat, reviewRules } = await import("../src/quests/review");
    const q = await writeQuest(plan(), sampleWriter(SAMPLE_SKILLS));
    const check = q.parts[0] as ProblemPart;
    const hw = q.parts.find((p) => p.kind === "assignment") as ProblemPart;
    const w = (verdict: "solved" | "slip" | "not_understood", slipAnswer: "confirmed" | "disputed" | null = null) => ({
      answerText: "x", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 1, startedAt: 1, attemptId: "a", verdict, points: 0, feedback: "f", slipAnswer,
    });
    const progress = {
      ...emptyProgress(q.id),
      work: { [check.problems[0].id]: w("solved"), [check.problems[1].id]: w("slip", "confirmed"), [check.problems[2].id]: w("slip", "disputed"), [hw.problems[0].id]: w("not_understood") },
    };
    const skills = new Map(SAMPLE_SKILLS.map((s) => [s.id, s]));
    const m = questMistakes(q, progress, skills, sem.assignments, `${TUE}T09:00`);
    expect(m.map((x) => x.problem.id)).toEqual([check.problems[2].id, hw.problems[0].id]);
    expect(m[1].homeworkOpen).toBe(true);
    expect(reviewRules(m, "Calculus 1", "English")).toContain("NEVER reveal it");
    expect(newReviewChat(q, m).messages[0].text).toContain("Task 4.2a");
  });
});

describe("round 4", () => {
  it("resolves a mistake only on a passed check problem, once", async () => {
    const { applyChecks, checkResults, questMistakes } = await import("../src/quests/review");
    const q = await writeQuest(plan(), sampleWriter(SAMPLE_SKILLS));
    const hw = q.parts.find((p) => p.kind === "assignment") as ProblemPart;
    const progress = {
      ...emptyProgress(q.id),
      work: Object.fromEntries(hw.problems.map((p, i) => [p.id, { answerText: "x", files: [], hintsShown: 0, sawSimilar: false, activeSeconds: 1, startedAt: 1, attemptId: `att${i}`, verdict: "not_understood" as const, points: 0, feedback: "f" }])),
    };
    const skills = new Map(SAMPLE_SKILLS.map((s) => [s.id, s]));
    const m = questMistakes(q, progress, skills, sem.assignments, `${TUE}T09:00`);
    const review = (attemptId: string) => ({ attemptId, kind: "real_error" as const, status: "open" as const, slipAnswer: null, slipQuestion: null, chatId: null, updatedAt: 0 });
    const chat = {
      id: "c", title: "", createdAt: 0, updatedAt: 0, notes: [],
      messages: [
        { id: "1", role: "assistant" as const, text: `Not quite. [[check:failed:${hw.problems[0].id}]]`, createdAt: 1 },
        { id: "2", role: "assistant" as const, text: `Right! [[check:passed:${hw.problems[0].id}]]`, createdAt: 2 },
        { id: "3", role: "assistant" as const, text: `Not yet [[check:failed:${hw.problems[1].id}]]`, createdAt: 3 },
      ],
    };
    const res = checkResults(chat);
    const out = applyChecks(m, res, [review("att0"), review("att1")], q.id, TUE, 5);
    expect(out.attempts.map((a) => [a.skillId, a.part, a.verdict])).toEqual([["sk_ratio-test", "review", "solved"]]);
    expect(out.reviews.map((r) => [r.attemptId, r.status])).toEqual([["att0", "resolved"]]);
    // already resolved: nothing new
    expect(applyChecks(m, res, [{ ...review("att0"), status: "resolved" }], q.id, TUE, 6).attempts).toHaveLength(0);
  });

  it("hides app markers from what the student sees", async () => {
    const { stripMarkers } = await import("../src/lib/markdown");
    expect(stripMarkers("Correct. [[check:passed:p3]]")).toBe("Correct.");
  });

  it("lessons come with a key rule, and lesson prompts ask for one", async () => {
    const { lessonTurns } = await import("../src/quests/write");
    const q = await writeQuest(plan(), sampleWriter(SAMPLE_SKILLS));
    const lesson = q.parts.find((p) => p.kind === "lesson") as ProblemPart;
    expect(lesson.keyRule).toBeTruthy();
    const ctx = { course: sem.courses[0], skills: new Map(SAMPLE_SKILLS.map((s) => [s.id, s])), known: [], feel: ["Ratio test: too hard (lesson, 2026-11-02)"] };
    const t = lessonTurns(q, lesson, ctx)[0].content;
    expect(t).toContain("=== KEY RULE ===");
    expect(t).toContain("Ratio test: too hard");
  });

  it("collects how parts felt and what was carried over", async () => {
    const { recentFeel, carriedOver } = await import("../src/quests/plan");
    const q1 = plan();
    const lesson = q1.parts.find((p) => p.kind === "lesson")!;
    const r1 = { quest: q1, progress: { ...emptyProgress(q1.id), ratings: { [lesson.id]: "hard" as const } } };
    const feel = recentFeel([r1], (id) => SAMPLE_SKILLS.find((s) => s.id === id)?.name, TUE);
    expect(feel[0]).toContain("too hard");
    const wed = "2026-11-04";
    const q2 = plan({ today: wed, nowLocal: `${wed}T08:00` });
    expect(carriedOver([r1], q2).map((c) => c.label)).toContain("4.2a");
  });
});

describe("writeQuest pacing", () => {
  it("writes at most two parts at once and keeps written parts when one fails", async () => {
    const base = sampleWriter(SAMPLE_SKILLS);
    let running = 0;
    let peak = 0;
    let calls = 0;
    const slow = <T,>(fn: () => Promise<T>) => async () => {
      running++;
      peak = Math.max(peak, running);
      calls++;
      const fail = calls === 3;
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (fail) throw { code: "rate_limited", message: "busy" };
      return fn();
    };
    const writer = {
      learn: (q: Quest, p: never) => slow(() => base.learn(q, p))(),
      lesson: (q: Quest, p: never) => slow(() => base.lesson(q, p))(),
      practice: (q: Quest, p: never) => slow(() => base.practice(q, p))(),
      assignment: (q: Quest, p: never) => slow(() => base.assignment(q, p))(),
    } as unknown as typeof base;
    const p = plan();
    let err: QuestIncomplete | null = null;
    try {
      await writeQuest(p, writer);
    } catch (e) {
      err = e as QuestIncomplete;
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(err).toBeInstanceOf(QuestIncomplete);
    expect(err!.code).toBe("rate_limited");
    const again = await writeQuest(err!.quest, base, undefined, { skip: new Set(err!.writtenIds) });
    expect(again.parts).toHaveLength(p.parts.length);
  });
});
