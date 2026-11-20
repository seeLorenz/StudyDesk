// Target grades a student can pick on their grade scale. The scale itself is
// worked out in the setup chat, never from a built-in list.

import type { GradeScale } from "../mastery/types";

/** The grades a student can pick as a target: whole steps between best and worst, or null for wide scales. */
export function gradeSteps(scale: GradeScale): number[] | null {
  const lo = Math.min(scale.best, scale.worst);
  const hi = Math.max(scale.best, scale.worst);
  if (hi - lo > 10) return null;
  const out: number[] = [];
  for (let g = lo; g <= hi; g++) out.push(g);
  return scale.best < scale.worst ? out : out.reverse();
}
