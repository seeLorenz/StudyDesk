// Today on the clock: school and appointments, then each block at its time,
// which one is "now", and what moved because an earlier slot passed. Pure, so
// it's tested. design/day-plan.md, "Now".

import { busySpans, CLOCK, freeMinutes, freeWindows, placeBlocks, roundUp5, type BusySpan, type CalendarSpan, type Minute } from "./clock";
import type { PlannedBlock } from "./day";
import type { TimetableEntry } from "../quests/types";

export type BlockState = {
  /** Every part handed in (or read). */
  done: boolean;
  /** The student did something on it already. */
  started: boolean;
  /** Pushed to the end of today ("Later today"), when. */
  laterAt?: number;
};

export type TimelineBlock = {
  type: "block";
  block: PlannedBlock;
  start: Minute | null;
  end: Minute | null;
  status: "done" | "now" | "next" | "later" | "no_slot";
  /** Where it was planned before an earlier slot passed. */
  movedFrom: Minute | null;
};

export type TimelineItem =
  | { type: "busy"; start: Minute; end: Minute; title: string; kind: "school" | "busy"; past: boolean }
  | { type: "free"; start: Minute; end: Minute }
  | TimelineBlock
  | { type: "break"; start: Minute; end: Minute }
  | { type: "end"; at: Minute }
  | { type: "nightly"; at: Minute };

export type Today = {
  items: TimelineItem[];
  blocks: TimelineBlock[];
  /** The block to do now, or the next one. */
  now: TimelineBlock | null;
  /** Minutes still free from now (or from the end of school) until the hand-in time. */
  freeLeft: number;
  plannedLeft: number;
  /** When the last remaining block ends. */
  doneBy: Minute | null;
  schoolEnd: Minute | null;
  spans: BusySpan[];
};

export type TodayInput = {
  blocks: PlannedBlock[];
  state: (b: PlannedBlock) => BlockState;
  timetable: TimetableEntry[];
  weekday: number;
  calendar?: CalendarSpan[];
  /** Minutes since midnight now. */
  now: Minute;
  /** The nightly run's time, when it's set up. */
  nightlyAt?: Minute | null;
  /** Minutes of a block left to do (parts not handed in); the whole block when absent. */
  remaining?: (b: PlannedBlock) => number;
  /** When today's plan was made, if it was made today: nothing was planned before it. */
  anchor?: Minute | null;
};

/** A block counts as "now" from this many minutes before its slot. */
const NOW_LEAD = 10;

export function today(input: TodayInput): Today {
  const spans = busySpans(input.timetable, input.weekday, input.calendar ?? []);
  const school = spans.filter((s) => s.kind === "school");
  const schoolEnd = school.length ? Math.max(...school.map((s) => s.end)) : null;
  const order = [...input.blocks].sort((a, b) => {
    const la = input.state(a).laterAt ?? 0;
    const lb = input.state(b).laterAt ?? 0;
    return la - lb || a.rank - b.rank;
  });

  // Where each block was meant to go, from the start of the day…
  const planned = new Map(placeBlocks(freeWindows(spans, input.anchor ?? null), order.map((b) => ({ key: b.key, minutes: b.minutes }))).map((p) => [p.key, p]));
  // …and where the ones still to do go now.
  const open = order.filter((b) => !input.state(b).done);
  const from = roundUp5(input.now);
  const inProgress = open.find((b) => input.state(b).started);
  const live = new Map<string, { start: Minute | null; end: Minute | null }>();
  let liveFrom = from;
  if (inProgress) {
    // The block being worked on is "now", whatever its slot was.
    const left = Math.max(5, Math.round(input.remaining?.(inProgress) ?? inProgress.minutes));
    live.set(inProgress.key, { start: from, end: from + left });
    liveFrom = from + left + CLOCK.breakBetween;
  }
  const rest = open.filter((b) => b !== inProgress);
  for (const p of placeBlocks(freeWindows(spans, liveFrom), rest.map((b) => ({ key: b.key, minutes: input.remaining?.(b) ?? b.minutes })))) live.set(p.key, p);

  const blocks: TimelineBlock[] = order.map((b) => {
    const st = input.state(b);
    const plan = planned.get(b.key);
    if (st.done) return { type: "block", block: b, start: plan?.start ?? null, end: plan?.end ?? null, status: "done", movedFrom: null };
    const at = live.get(b.key);
    const start = at?.start ?? null;
    const moved = start !== null && plan?.start != null && start > plan.start + 5 ? plan.start : null;
    return { type: "block", block: b, start, end: at?.end ?? null, status: start === null ? "no_slot" : "later", movedFrom: moved };
  });
  const remainingBlocks = blocks.filter((b) => b.status !== "done");
  const first = (inProgress && blocks.find((b) => b.block.key === inProgress.key)) || remainingBlocks.find((b) => b.status !== "no_slot") || remainingBlocks[0] || null;
  if (first) {
    const isNow = first.start !== null && (first.block.key === inProgress?.key || first.start <= input.now + NOW_LEAD);
    if (first.status !== "no_slot") first.status = isNow ? "now" : "next";
  }

  // ---- the items, in time order ----
  const items: TimelineItem[] = spans.map((s) => ({ type: "busy", start: s.start, end: s.end, title: s.title, kind: s.kind, past: s.end <= input.now }));
  const timed = blocks.filter((b) => b.start !== null).sort((a, b) => a.start! - b.start!);
  const firstOpen = timed.find((b) => b.status !== "done");
  // The free hour after school, while it's still ahead (or now).
  if (schoolEnd !== null && firstOpen && firstOpen.start! - schoolEnd >= 30 && input.now < schoolEnd + CLOCK.afterSchool) items.push({ type: "free", start: schoolEnd, end: firstOpen.start! });
  items.push(...timed);
  const openTimed = timed.filter((b) => b.status !== "done");
  for (let i = 1; i < openTimed.length; i++) {
    const gap = openTimed[i].start! - openTimed[i - 1].end!;
    if (gap > 0 && gap <= 30) items.push({ type: "break", start: openTimed[i - 1].end!, end: openTimed[i].start! });
  }
  const lastEnd = timed.length ? Math.max(...timed.map((b) => b.end!)) : null;
  if (lastEnd !== null) items.push({ type: "end", at: lastEnd });
  if (input.nightlyAt != null) items.push({ type: "nightly", at: input.nightlyAt });
  const rank = (x: TimelineItem) => (x.type === "busy" ? 0 : x.type === "free" ? 1 : x.type === "block" ? 2 : x.type === "break" ? 3 : x.type === "end" ? 4 : 5);
  const at = (x: TimelineItem) => (x.type === "end" || x.type === "nightly" ? x.at : x.start ?? 0);
  items.sort((a, b) => at(a) - at(b) || rank(a) - rank(b));
  // Blocks with no free slot left go last, so they can still be done or moved.
  items.push(...blocks.filter((b) => b.start === null));

  const windows = freeWindows(spans, from);
  const plannedLeft = remainingBlocks.reduce((s, b) => s + (input.remaining?.(b.block) ?? b.block.minutes), 0);
  const ends = remainingBlocks.filter((b) => b.end !== null).map((b) => b.end!);
  return {
    items,
    blocks,
    now: first,
    freeLeft: freeMinutes(windows),
    plannedLeft,
    doneBy: ends.length ? Math.max(...ends) : null,
    schoolEnd,
    spans,
  };
}
