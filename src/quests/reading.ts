// How long a lesson takes to read: code measures the written text and learns
// the student's reading rate from timed reads. design/quest-creation.md,
// "Realistic part times".

import { median } from "../mastery/days";
import type { Day } from "../mastery/types";
import { QUEST_CONFIG } from "./config";
import type { QuestRecord } from "./types";

const DISPLAY = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g;
const INLINE = /\$[^$\n]+\$|\\\([\s\S]+?\\\)/g;

/** Size of a text in word-equivalents: words, plus extra for each formula (formulas read slowly). */
export function textSize(md: string): number {
  const { displayFormula, inlineFormula } = QUEST_CONFIG.reading;
  let size = 0;
  const words = md
    .replace(DISPLAY, () => ((size += displayFormula), " "))
    .replace(INLINE, () => ((size += inlineFormula), " "))
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
  return size + words;
}

export type Reading = { rate: number; minutesByDay: Map<Day, number> };

/**
 * From the quest records: the student's reading rate (median word-equivalents
 * per minute over their last timed reads, kept in bounds) and their reading
 * minutes per day, which count toward the daily pace.
 */
export function readingOf(records: QuestRecord[]): Reading {
  const { startRate, minRate, maxRate, window, minSeconds } = QUEST_CONFIG.reading;
  const rates: number[] = [];
  const minutesByDay = new Map<Day, number>();
  for (const r of [...records].sort((a, b) => a.quest.createdAt - b.quest.createdAt)) {
    for (const p of r.quest.parts) {
      const s = r.progress.read?.[p.id] ?? 0;
      if (!s) continue;
      minutesByDay.set(r.quest.date, (minutesByDay.get(r.quest.date) ?? 0) + s / 60);
      if (s >= minSeconds && p.kind === "lesson" && p.body) rates.push(textSize(p.body) / (s / 60));
    }
  }
  const m = median(rates.slice(-window));
  return { rate: m === null ? startRate : Math.min(maxRate, Math.max(minRate, m)), minutesByDay };
}

/** Minutes to read this text at this rate, at least 1. */
export const readMinutes = (md: string, rate: number) => Math.max(1, Math.round(textSize(md) / rate));
