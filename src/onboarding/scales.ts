// Grade scales by country, and the semester's default name and dates. The
// student can change the scale by hand when their school uses another one.

import type { GradeScale } from "../mastery/types";
import type { Level } from "./types";

export type ScaleOption = { key: string; label: string; scale: GradeScale };

export const SCALES: ScaleOption[] = [
  { key: "at", label: "Austria (1 best, 5 worst)", scale: { name: "Austrian 1–5", best: 1, worst: 5 } },
  { key: "de-uni", label: "Germany, university (1.0 best, 5.0 worst)", scale: { name: "German 1.0–5.0", best: 1, worst: 5 } },
  { key: "de-school", label: "Germany, school (1 best, 6 worst)", scale: { name: "German 1–6", best: 1, worst: 6 } },
  { key: "ch", label: "Switzerland (6 best, 1 worst)", scale: { name: "Swiss 6–1", best: 6, worst: 1 } },
  { key: "nl", label: "Netherlands (10 best, 1 worst)", scale: { name: "Dutch 10–1", best: 10, worst: 1 } },
  { key: "pct", label: "Percent (100 best, 0 worst)", scale: { name: "Percent", best: 100, worst: 0 } },
  { key: "us", label: "US letter grades as GPA (4 best, 0 worst)", scale: { name: "GPA 4–0", best: 4, worst: 0 } },
];

const BY_COUNTRY: Record<string, string> = {
  austria: "at",
  österreich: "at",
  germany: "de-uni",
  deutschland: "de-uni",
  switzerland: "ch",
  schweiz: "ch",
  netherlands: "nl",
  "united states": "us",
  usa: "us",
  us: "us",
};

/** A sensible default scale for a country, or percent when unknown. */
export function scaleFor(country: string, level: Level): GradeScale {
  const key = BY_COUNTRY[country.trim().toLowerCase()] ?? "pct";
  const k = key === "de-uni" && level === "school" ? "de-school" : key;
  return SCALES.find((s) => s.key === k)!.scale;
}

/** The grades a student can pick as a target: whole steps between best and worst, or null for wide scales. */
export function gradeSteps(scale: GradeScale): number[] | null {
  const lo = Math.min(scale.best, scale.worst);
  const hi = Math.max(scale.best, scale.worst);
  if (hi - lo > 10) return null;
  const out: number[] = [];
  for (let g = lo; g <= hi; g++) out.push(g);
  return scale.best < scale.worst ? out : out.reverse();
}

/** "WS 2026/27" style name and dates for a semester starting around `today`. */
export function defaultSemester(today: string, level: Level): { name: string; startDate: string; endDate: string } {
  const [y, m] = today.split("-").map(Number);
  if (level === "school") {
    const start = m >= 8 ? y : y - 1;
    return { name: `School year ${start}/${String(start + 1).slice(2)}`, startDate: `${start}-09-01`, endDate: `${start + 1}-06-30` };
  }
  if (m >= 8 || m <= 1) {
    const start = m >= 8 ? y : y - 1;
    return { name: `WS ${start}/${String(start + 1).slice(2)}`, startDate: `${start}-10-01`, endDate: `${start + 1}-02-28` };
  }
  return { name: `SS ${y}`, startDate: `${y}-03-01`, endDate: `${y}-07-31` };
}
