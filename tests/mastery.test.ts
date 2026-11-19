import { describe, expect, it } from "vitest";
import {
  addDays,
  answerSlip,
  assessmentAttempts,
  courseMastery,
  dueSkills,
  examReadiness,
  expectedMinutes,
  gradeFor,
  gradeStanding,
  questBudget,
  replay,
  slownessFactor,
  type Attempt,
  type CourseTarget,
  type GradeRules,
  type ReviewItem,
  type Skill,
} from "../src/mastery";

const D = (n: number) => addDays("2026-11-01", n - 1); // day 1 = Nov 1

const AT: CourseTarget = { courseId: "ana", targetGrade: 2, gradeScale: { name: "Austrian", best: 1, worst: 5 } };

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: "chain",
    courseId: "ana",
    topicId: "deriv",
    name: "Differentiate with the chain rule",
    difficulty: "hard",
    isFundamental: false,
    prereqSkillIds: [],
    tier: 4,
    weight: 2,
    estMinutes: 5,
    ...over,
  };
}

let seq = 0;
function att(day: number, over: Partial<Attempt> = {}): Attempt {
  seq += 1;
  return {
    id: `a${seq}`,
    skillId: "chain",
    questId: null,
    part: "practice",
    day: D(day),
    verdict: "solved",
    points: 5,
    maxPoints: 5,
    hintsUsed: 0,
    sawWorkedExample: false,
    activeSeconds: 0,
    startedAt: seq,
    gradedAt: seq,
    ...over,
  };
}

const slipReview = (a: Attempt, answer: "confirmed" | "disputed" | null): ReviewItem => ({
  attemptId: a.id,
  kind: answer === "disputed" ? "real_error" : "slip",
  status: answer ? "answered" : "open",
  slipAnswer: answer,
  slipQuestion: "Typo?",
  chatId: null,
  updatedAt: 0,
});

describe("worked example from the spec (hard skill, 15 days)", () => {
  const s = skill();
  const d1a = att(1, { hintsUsed: 2, activeSeconds: 14 * 60 });
  const d1b = att(1, { activeSeconds: 11 * 60 });
  const d2a = att(2, { activeSeconds: 9 * 60 });
  const d2b = att(2);
  const d3 = att(3, { verdict: "slip", points: 4 });
  const d4 = att(4);
  const d6 = att(6, { part: "review" });
  const d10 = att(10, { part: "review", verdict: "not_understood", points: 1 });
  const d11 = att(11);
  const d12 = att(12);
  const d13 = att(13);
  const all = [d1a, d1b, d2a, d2b, d3, d4, d6, d10, d11, d12, d13];
  const reviews = [slipReview(d3, "confirmed"), slipReview(d10, null)];

  const upTo = (day: number) => {
    const r = replay([s], all.filter((a) => a.day <= D(day)), reviews);
    const st = r.states.get("chain")!;
    const pts = r.points.filter((p) => p.day === D(day)).reduce((n, p) => n + p.points, 0);
    const credit = courseMastery([s], r.states, AT, D(day)).value;
    return { st, pts, credit };
  };

  const rows: Array<[number, number, string, number, number, number]> = [
    // day, streak, stage, credit, next due, points that day
    [1, 1, "learning", 1 / 6, 2, 15],
    [2, 2, "learning", 2 / 6, 3, 30],
    [3, 2, "learning", 2 / 6, 4, 5],
    [4, 3, "mastered", 1, 6, 65],
    [6, 3, "mastered", 1, 10, 20],
    [10, 0, "lapsed", 0, 11, 0],
    [13, 3, "mastered", 1, 15, 15 + 50],
  ];
  it.each(rows)("day %i", (day, streak, stage, credit, due, pts) => {
    const r = upTo(day);
    expect(r.st.streak).toBe(streak);
    expect(r.st.stage).toBe(stage);
    expect(r.credit).toBeCloseTo(credit, 5);
    expect(r.st.dueAt).toBe(D(due));
    expect(r.pts).toBe(pts);
  });

  it("ladder steps: step 1 at day 4, step 2 at day 6, restart at step 1 after the lapse", () => {
    expect(upTo(4).st.ladderStep).toBe(1);
    expect(upTo(6).st.ladderStep).toBe(2);
    expect(upTo(13).st.ladderStep).toBe(1);
    expect(upTo(13).st.lapses).toBe(1);
  });

  it("days 11 to 13 earn 45 + 50 points", () => {
    const r = replay([s], all, reviews);
    const pts = r.points.filter((p) => p.day >= D(11)).reduce((n, p) => n + p.points, 0);
    expect(pts).toBe(95);
  });

  it("time: 10 min before any attempt, then the median of 14, 11 and 9 = 11", () => {
    expect(expectedMinutes(s, [], slownessFactor([s], []))).toBe(10);
    const three = [d1a, d1b, d2a];
    expect(expectedMinutes(s, three, slownessFactor([s], three))).toBe(11);
  });

  it("mastering it on day 4 raises a weight-20 course by 6.7 points", () => {
    const others = Array.from({ length: 9 }, (_, i) => skill({ id: `o${i}`, weight: 2 }));
    const before = replay([s, ...others], all.filter((a) => a.day <= D(3)), reviews);
    const after = replay([s, ...others], all.filter((a) => a.day <= D(4)), reviews);
    const delta = courseMastery([s, ...others], after.states, AT, D(4)).value - courseMastery([s, ...others], before.states, AT, D(3)).value;
    expect(delta * 100).toBeCloseTo(6.67, 1);
  });
});

describe("streak rules", () => {
  const s = skill({ difficulty: "normal" });

  it("a slip waiting for the student's answer changes nothing; disputed resets the streak", () => {
    const a1 = att(1);
    const a2 = att(2, { verdict: "slip" });
    expect(replay([s], [a1, a2], [slipReview(a2, null)]).states.get("chain")!.streak).toBe(1);
    expect(replay([s], [a1, a2], [slipReview(a2, "confirmed")]).states.get("chain")!.streak).toBe(1);
    expect(replay([s], [a1, a2], [slipReview(a2, "disputed")]).states.get("chain")!.streak).toBe(0);
  });

  it("solving after a worked example doesn't count", () => {
    const r = replay([s], [att(1, { sawWorkedExample: true })], []);
    expect(r.states.get("chain")!.streak).toBe(0);
    expect(r.points).toEqual([]);
  });

  it("a normal skill climbs 3, 7, 16, 35 days and is then retained", () => {
    const days = [1, 2, 3, 6, 13, 29, 64];
    const r = replay([s], days.map((d) => att(d)), []);
    const st = r.states.get("chain")!;
    expect(st.stage).toBe("retained");
    expect(st.dueAt).toBeNull();
    const dues = days.map((_, i) => replay([s], days.slice(0, i + 1).map((d) => att(d)), []).states.get("chain")!.dueAt);
    expect(dues.slice(2)).toEqual([D(6), D(13), D(29), D(64), null]);
  });

  it("an early review doesn't move the ladder", () => {
    const r = replay([s], [att(1), att(2), att(3), att(4)], []);
    const st = r.states.get("chain")!;
    expect(st.ladderStep).toBe(1);
    expect(st.dueAt).toBe(D(6));
  });

  it("an overdue review lowers credit to 0.75", () => {
    const r = replay([s], [att(1), att(2), att(3)], []);
    expect(courseMastery([s], r.states, AT, D(6)).value).toBe(1);
    expect(courseMastery([s], r.states, AT, D(7)).value).toBe(0.75);
  });

  it("a fundamental solved in the first check earns 10 points", () => {
    const f = skill({ id: "pq", isFundamental: true, difficulty: "normal" });
    const r = replay([f], [att(1, { skillId: "pq", part: "check" })], []);
    expect(r.points.map((p) => [p.kind, p.points])).toEqual([["fundamental_cleared", 10]]);
  });

  it("real exam results are evidence only", () => {
    const evidence = assessmentAttempts(
      { assessmentId: "ex1", courseId: "ana", component: "exam", points: 45, maxPoints: 50, date: D(5), skillIds: ["chain"] },
      0,
    );
    const r = replay([s], [...evidence, ...evidence.map((e) => ({ ...e, id: e.id + "b" }))], []);
    expect(r.states.get("chain")!.stage).toBe("new");
  });
});

describe("due skills", () => {
  const s = skill({ difficulty: "normal" });
  it("a retained skill comes back once in the week before its exam", () => {
    const days = [1, 2, 3, 6, 13, 29, 64];
    const attempts = days.map((d) => att(d));
    const { states } = replay([s], attempts, []);
    const exam = { courseId: "ana", date: D(80), skillIds: ["chain"] };
    expect(dueSkills([s], states, attempts, [exam], D(70))).toEqual([]);
    expect(dueSkills([s], states, attempts, [exam], D(75))).toEqual(["chain"]);
    expect(dueSkills([s], states, [...attempts, att(75)], [exam], D(76))).toEqual([]);
  });
});

describe("target grade", () => {
  it("only skills the target grade needs count", () => {
    const easy = skill({ id: "e", tier: 4, weight: 1 });
    const hard = skill({ id: "h", tier: 1, weight: 1 });
    const r = replay([easy, hard], [], []);
    expect(courseMastery([easy, hard], r.states, AT, D(1)).requiredCount).toBe(1);
    expect(courseMastery([easy, hard], r.states, { ...AT, targetGrade: 1 }, D(1)).requiredCount).toBe(2);
    const pct: CourseTarget = { courseId: "ana", targetGrade: 90, gradeScale: { name: "percent", best: 100, worst: 0 } };
    const p1 = skill({ id: "p1", tier: 60 });
    const p2 = skill({ id: "p2", tier: 95 });
    expect(courseMastery([p1, p2], r.states, pct, D(1)).requiredCount).toBe(1);
  });

  it("warns when an exam in the next 3 weeks is less than half ready", () => {
    const s = skill();
    const r = replay([s], [], []);
    const out = examReadiness([s], r.states, [AT], [{ courseId: "ana", date: D(15), skillIds: ["chain"] }], D(1));
    expect(out).toHaveLength(1);
    expect(out[0].warn).toBe(true);
    expect(examReadiness([s], r.states, [AT], [{ courseId: "ana", date: D(30), skillIds: ["chain"] }], D(1))).toEqual([]);
  });
});

describe("quest budget", () => {
  const s = skill({ difficulty: "normal" });
  it("a new student gets half their free time", () => {
    expect(questBudget(480, 240, [], D(1)).budgetMinutes).toBe(120);
  });
  it("after that, the smaller of 80% of free time and 1.2 × recent pace", () => {
    const attempts = [att(1, { activeSeconds: 3000 }), att(2, { activeSeconds: 3000 }), att(3, { activeSeconds: 3000 })];
    expect(questBudget(480, 240, attempts, D(4))).toEqual({ freeMinutes: 240, paceMinutes: 50, budgetMinutes: 60 });
    expect(questBudget(480, 420, attempts, D(4)).budgetMinutes).toBe(48);
  });
  it("slowness stays between 1 and 4", () => {
    expect(slownessFactor([s], [att(1, { activeSeconds: 60 * 60 })])).toBe(4);
    expect(slownessFactor([s], [att(1, { activeSeconds: 60 })])).toBe(1);
  });
});

describe("real grades", () => {
  const rules: GradeRules = {
    courseId: "ana",
    scale: { name: "Austrian", best: 1, worst: 5 },
    components: [
      { id: "exam", weight: 60 },
      { id: "homework", weight: 40 },
    ],
    thresholds: [
      { grade: 1, minPercent: 87.5 },
      { grade: 2, minPercent: 75 },
      { grade: 3, minPercent: 62.5 },
      { grade: 4, minPercent: 50 },
    ],
  };
  it("maps percent to the best grade reached", () => {
    expect(gradeFor(rules, 80)).toBe(2);
    expect(gradeFor(rules, 30)).toBe(5);
  });
  it("shows what's still needed for the target grade", () => {
    const st = gradeStanding(
      rules,
      [{ assessmentId: "hw", courseId: "ana", component: "homework", points: 30, maxPoints: 40, date: D(1), skillIds: [] }],
      2,
    );
    expect(st.percentSoFar).toBe(75);
    expect(st.weightDone).toBe(0.4);
    expect(st.neededPercent).toBe(75);
  });
});

describe("slip answers", () => {
  it("a disputed slip becomes a real error", () => {
    const item = slipReview(att(1, { verdict: "slip" }), null);
    expect(answerSlip(item, false, 1)).toMatchObject({ slipAnswer: "disputed", kind: "real_error", status: "answered" });
    expect(answerSlip(item, true, 1)).toMatchObject({ slipAnswer: "confirmed", kind: "slip" });
  });
});
