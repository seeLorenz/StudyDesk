import { describe, expect, it, vi } from "vitest";
import { GradingFailed, gradeProblems, imageGroups, gradingTurns, parseGrading, recordResult, type GradingProblem } from "../src/mastery";
import { localMasteryStore } from "../src/platform/masteryStore";

const problem = (over: Partial<GradingProblem> = {}): GradingProblem => ({
  problemId: "p1",
  skillId: "chain",
  skillName: "Chain rule",
  fundamentals: [{ skillId: "pow", name: "Power rule" }],
  part: "practice",
  prompt: "Differentiate sin(x^2).",
  answerKey: "2x cos(x^2)",
  maxPoints: 5,
  answerText: "cos(x^2) * 2x",
  hintsUsed: 0,
  sawWorkedExample: false,
  homeworkNotHandedIn: false,
  ...over,
});

const good = {
  problemId: "p1",
  verdict: "solved",
  points: 5,
  maxPoints: 5,
  firstWrongStep: null,
  errorKind: "none",
  fundamentalSkillId: null,
  slipQuestion: null,
  feedback: "Right: outer derivative times inner derivative.",
};

describe("grading agent output", () => {
  it("accepts a fenced JSON array", () => {
    const r = parseGrading("Here you go:\n```json\n" + JSON.stringify([good]) + "\n```", [problem()]);
    expect(r.ok).toBe(true);
  });

  it("rejects a slip without a question, points above max, and an unknown fundamental", () => {
    const r = parseGrading(
      JSON.stringify([{ ...good, verdict: "slip", points: 7, errorKind: "missing_fundamental", fundamentalSkillId: "nope" }]),
      [problem()],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
  });

  it("rejects a missing problem", () => {
    const r = parseGrading("[]", [problem()]);
    expect(r.ok).toBe(false);
  });

  it("retries once with the errors, then gives up", async () => {
    const ask = vi.fn().mockResolvedValueOnce("not json").mockResolvedValueOnce(JSON.stringify([good]));
    await expect(gradeProblems([problem()], ask)).resolves.toHaveLength(1);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0].at(-1).content).toContain("can't be used");

    const bad = vi.fn().mockResolvedValue("still not json");
    await expect(gradeProblems([problem()], bad)).rejects.toBeInstanceOf(GradingFailed);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("tells the agent to hold back the answer on homework not handed in", () => {
    expect(gradingTurns([problem({ homeworkNotHandedIn: true })])[0].content).toContain("do NOT give the full answer");
  });

  it("a slip becomes an attempt plus an open review item", () => {
    const r = parseGrading(JSON.stringify([{ ...good, verdict: "slip", points: 4, errorKind: "slip", slipQuestion: "Typo?" }]), [problem()]);
    if (!r.ok) throw new Error("expected ok");
    const { attempt, review } = recordResult(problem(), r.results[0], {
      attemptId: "a1", questId: "q1", day: "2026-11-03", activeSeconds: 300, startedAt: 0, now: 1,
    });
    expect(attempt.verdict).toBe("slip");
    expect(review).toMatchObject({ kind: "slip", status: "open", slipAnswer: null, slipQuestion: "Typo?" });
  });
});

describe("local store", () => {
  it("never overwrites an attempt", async () => {
    const mem = new Map<string, string>();
    const store = localMasteryStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) });
    const a = { id: "a1", skillId: "s", questId: null, part: "practice" as const, day: "2026-11-01", verdict: "solved" as const,
      points: 1, maxPoints: 1, hintsUsed: 0, sawWorkedExample: false, activeSeconds: 60, startedAt: 0, gradedAt: 0 };
    await store.appendAttempts([a]);
    await store.appendAttempts([{ ...a, points: 0 }]);
    const d = await store.load();
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0].points).toBe(1);
  });
});

describe("grading with photos", () => {
  const photo = () => new Blob(["x"], { type: "image/jpeg" });
  const withPhotos = (id: string, n: number) => problem({ problemId: id, answerImages: Array.from({ length: n }, photo) });

  it("splits a hand-in so no call carries more photos than allowed, keeping the order", () => {
    const ps = [withPhotos("a", 2), withPhotos("b", 1), problem({ problemId: "c" }), withPhotos("d", 2)];
    expect(imageGroups(ps, 3).map((g) => g.map((p) => p.problemId))).toEqual([["a", "b", "c"], ["d"]]);
    expect(imageGroups(ps, 0)).toHaveLength(1);
  });

  it("fails visibly when one answer has more photos than one call can carry", () => {
    expect(() => imageGroups([withPhotos("a", 4)], 3)).toThrow();
    try {
      imageGroups([withPhotos("a", 4)], 3);
    } catch (e) {
      expect(e).toMatchObject({ code: "image_rejected" });
    }
  });

  it("grades each group in its own call with every photo attached, strictly", async () => {
    const ask = vi.fn(async (_turns, opts) => {
      const ids = opts.images.length === 2 ? ["a"] : ["b"];
      return JSON.stringify(ids.map((problemId) => ({ ...good, problemId })));
    });
    const res = await gradeProblems([withPhotos("a", 2), withPhotos("b", 1)], ask, undefined, 2);
    expect(res.map((r) => r.problemId)).toEqual(["a", "b"]);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls.every((c) => c[1].strictImages === true)).toBe(true);
  });
});
