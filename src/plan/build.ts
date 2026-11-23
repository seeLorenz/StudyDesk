// From a day plan to quests: each block that needs one becomes a normal quest
// for its course, planned by the quest builder (src/quests/plan.ts) and sized
// to the block. Shared by the page and the nightly run. design/day-plan.md.

import type { Attempt, Day, ReviewItem } from "../mastery/types";
import { doneTasks, planQuest, recentBlockers } from "../quests/plan";
import type { Quest, QuestRecord, Semester } from "../quests/types";
import { needsQuest, whyLine, type DayPlan, type PlannedBlock } from "./day";

export type BlockQuest = { block: PlannedBlock; quest: Quest };

/**
 * Plans a quest for every block of `plan` that needs one. A block whose course
 * has nothing to do is left out. Quests come back in the plan's order, not
 * yet written.
 */
export function questsForDay(
  plan: DayPlan,
  ctx: { semester: Semester; nowLocal: string; attempts: Attempt[]; reviews: ReviewItem[]; records: QuestRecord[]; now: number },
): BlockQuest[] {
  const { semester, attempts, reviews, records, now } = ctx;
  const day: Day = plan.day;
  const out: BlockQuest[] = [];
  const done = doneTasks(records);
  const blockers = recentBlockers(records, day);
  for (const [i, block] of plan.blocks.entries()) {
    if (!needsQuest(block)) continue;
    const res = planQuest({
      semester,
      today: day,
      nowLocal: ctx.nowLocal,
      attempts,
      reviews,
      doneTaskIds: done,
      blockerSkillIds: blockers,
      courseId: block.courseId,
      budgetOverride: Math.max(5, block.minutes),
      questId: `qst_${day}_${block.courseId}_${(now + i).toString(36)}`,
      block: { kind: block.kind, why: whyLine(block, day, semester) },
    });
    if (res.kind !== "quest") continue;
    res.quest.block = { kind: block.kind, tone: block.tone, rank: block.rank, examKeys: block.examKeys, ...(block.dueAt ? { dueAt: block.dueAt } : {}) };
    out.push({ block, quest: res.quest });
  }
  return out;
}
