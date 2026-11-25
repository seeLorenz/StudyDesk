import { describe, expect, it } from "vitest";
import { mergeProgress } from "../src/quests/merge";
import { withMerge } from "../src/platform/questStore";
import { emptyProgress, emptyWork } from "../src/quests/handin";
import type { QuestProgress, QuestRecord } from "../src/quests/types";

const base: QuestProgress = { ...emptyProgress("q1"), work: { p1: emptyWork(), p2: emptyWork() }, updatedAt: 1 };
const edit = (p: QuestProgress, id: string, patch: object, at: number): QuestProgress => ({ ...p, work: { ...p.work, [id]: { ...p.work[id], ...patch } }, updatedAt: at });

describe("two devices on one quest", () => {
  // The laptop typed an answer and saved; the phone, still on the old copy, ticked its timer on the same problem.
  const laptop = edit(base, "p1", { answerText: "x = 4" }, 2);
  const phone = edit(base, "p1", { activeSeconds: 5 }, 3);

  it("a stale copy writes only its own changes", () => {
    const out = mergeProgress(base, phone, laptop);
    expect(out.work.p1).toMatchObject({ answerText: "x = 4", activeSeconds: 5 });
  });

  it("a copy with no changes of its own takes the stored one as it is", () => {
    expect(mergeProgress(base, base, laptop)).toBe(laptop);
  });

  it("hand-ins, reopened parts and notes merge by member", () => {
    const stored = { ...base, handedIn: ["a", "b"], notes: [{ id: "n1" }] } as unknown as QuestProgress;
    const mine = { ...stored, handedIn: ["a"], updatedAt: 5 }; // reopened b
    const theirs = { ...stored, handedIn: ["a", "b", "c"], notes: [{ id: "n1" }, { id: "n2" }], updatedAt: 6 } as unknown as QuestProgress;
    const out = mergeProgress(stored, mine, theirs);
    expect(out.handedIn.sort()).toEqual(["a", "c"]);
    expect(out.notes?.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("the store merges only when someone else saved since the caller's base", () => {
    const rec = (p: QuestProgress) => ({ quest: { id: "q1" }, progress: p }) as unknown as QuestRecord;
    expect(withMerge(rec(phone), base, rec(laptop)).progress.work.p1.answerText).toBe("x = 4");
    // Stored is the caller's own base: the caller's copy is written as it is.
    const cleared = edit(laptop, "p1", { answerText: "" }, 4);
    expect(withMerge(rec(cleared), laptop, rec(laptop)).progress.work.p1.answerText).toBe("");
  });
});
