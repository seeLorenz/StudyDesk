import { useMemo, useState } from "react";
import type { Attempt, ReviewItem } from "../mastery/types";
import type { Semester } from "../quests/types";
import { recommendWorkload } from "./placement";

// Step 7 of Start New Semester: once the placement check is graded, recommend
// a daily workload for the target grades. The student accepts it or changes it.

const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const h = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

export function WorkloadCard({
  semester,
  attempts,
  reviews,
  today,
  onSave,
}: {
  semester: Semester;
  attempts: Attempt[];
  reviews: ReviewItem[];
  today: string;
  onSave: (s: Semester) => Promise<void>;
}) {
  const rec = useMemo(() => recommendWorkload(semester, attempts, reviews, today), [semester, attempts, reviews, today]);
  const [goal, setGoal] = useState<number[]>(rec.studyGoal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => semester.courses.find((c) => c.id === id)?.name ?? id;
  const changed = goal.some((m, i) => m !== rec.studyGoal[i]);

  const save = async (studyGoal: number[], source: "student" | "recommended") => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...semester, studyGoal, studyGoalSource: source, studyGoalDecidedAt: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      setSaving(false);
    }
  };

  return (
    <section className="workload-card">
      <p className="quest-kicker">Placement check graded</p>
      <h2>About {h(rec.dailyQuestMinutes)} of quests per study day</h2>
      <p>That's what reaching your target grades takes at your measured speed, with room for reviews. Accept it, or change it to what fits your life.</p>
      <table className="setup-week">
        <thead>
          <tr>
            <th>Course</th>
            <th>Skills to go</th>
            <th>Until</th>
            <th>Per day</th>
          </tr>
        </thead>
        <tbody>
          {rec.perCourse.map((c) => (
            <tr key={c.courseId}>
              <th scope="row">{name(c.courseId)}</th>
              <td>{c.remainingSkills}</td>
              <td>{new Date(`${c.deadline}T12:00`).toLocaleDateString("en", { day: "numeric", month: "short" })}</td>
              <td>{c.dailyMinutes} min</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="setup-h2">Study goal per day, lectures included</h3>
      <div className="workload-days">
        {WEEK.map((wd) => (
          <label key={wd}>
            <span>{DAY_SHORT[wd]}</span>
            <input
              type="number"
              min={0}
              max={16}
              step={0.25}
              value={goal[wd] / 60}
              onChange={(e) => setGoal((g) => g.map((m, k) => (k === wd ? Math.max(0, Math.round(Number(e.target.value) * 60)) : m)))}
            />
            <span className="quest-muted">was {h(semester.studyGoal[wd] ?? 0)}</span>
          </label>
        ))}
      </div>
      {error && <p className="quest-error">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="link-btn" disabled={saving} onClick={() => void save(semester.studyGoal, "student")}>
          Keep my own goal
        </button>
        <button type="button" className="mini-btn primary big" disabled={saving} onClick={() => void save(goal, changed ? "student" : "recommended")}>
          {changed ? "Use these hours" : "Use the recommendation"}
        </button>
      </div>
    </section>
  );
}
