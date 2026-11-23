// The Week page: four weeks of exams, and how the plan gets there. Every block
// here comes from the same day plan as Now (src/plan/day.ts), placed on the
// clock the same way. design/day-plan.md, "Week".

import { useEffect, useMemo, useState } from "react";
import { addDays, toDay } from "../mastery/days";
import { openMasteryStore, type MasteryData } from "../platform/masteryStore";
import { openQuestStore } from "../platform/questStore";
import { busyFromAhead, spansFromAhead, type CalendarAhead } from "../platform/calendar";
import { subscribe } from "../platform/deskBus";
import { busySpans, duration, freeWindows, hhmm, placeBlocks, roundUp5 } from "../plan/clock";
import { DAY_PLAN, KIND_LABEL, planDays, shortDate, whyLine, type PlannedBlock } from "../plan/day";
import { weekdayOf } from "../quests/plan";
import type { QuestRecord, Semester } from "../quests/types";

type Data = { semester: Semester; records: QuestRecord[]; mastery: MasteryData; calendar: CalendarAhead | null };

const LETTER = ["S", "M", "T", "W", "T", "F", "S"];
const STATUS = { on_track: "on track", tight: "tight", behind: "behind", needs_you: "needs your notes" } as const;

export function WeekPage({ onOpenNow }: { onOpenNow: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = toDay();

  useEffect(() => {
    (async () => {
      const [qs, ms] = await Promise.all([openQuestStore(), openMasteryStore()]);
      const semester = await qs.loadSemester();
      if (!semester) return setError("Set up your semester first: the week is planned from your courses and exams.");
      const [records, mastery, calendar] = await Promise.all([qs.loadRecords(), ms.load(), qs.loadCalendar().catch(() => null)]);
      setData({ semester, records, mastery, calendar });
    })().catch((e) => setError(e instanceof Error ? e.message : "Your plan couldn't be loaded."));
  }, []);
  useEffect(() => subscribe("semester", "week", (semester) => setData((d) => (d && d.semester.id === semester.id ? { ...d, semester } : d))), []);

  const plan = useMemo(
    () =>
      data
        ? planDays({
            semester: data.semester,
            today,
            nowLocal: `${today}T00:00`,
            attempts: data.mastery.attempts,
            reviews: data.mastery.reviews,
            records: data.records,
            days: DAY_PLAN.horizonDays,
            calendarBusy: (d) => busyFromAhead(data.calendar, d),
          })
        : null,
    [data, today],
  );

  if (error) return <div className="quest-page"><p className="quest-muted">{error}</p></div>;
  if (!data || !plan) return <div className="quest-page"><p className="quest-muted">Planning your weeks…</p></div>;

  const { semester } = data;
  const name = (id: string) => semester.courses.find((c) => c.id === id)?.name ?? id;
  const short = (id: string) => semester.courses.find((c) => c.id === id)?.short || name(id).slice(0, 3);
  const exams = plan.exams;
  const rows = [...new Set(exams.map((e) => e.courseId))];
  const last = exams.length ? exams[exams.length - 1].date : addDays(today, 20);
  const shownDays = plan.days.filter((d) => d.day <= (last > addDays(today, 20) ? last : addDays(today, 20)));

  // ---- this week, on the clock ----
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const week = plan.days.slice(0, 7).map((d) => {
    const wd = weekdayOf(d.day);
    const spans = busySpans(semester.timetable, wd, spansFromAhead(data.calendar, d.day));
    // Today goes from now, like on Now; the other days from the start.
    const windows = freeWindows(spans, d.day === today ? roundUp5(nowMin) : null);
    const placed = new Map(placeBlocks(windows, d.blocks.map((b) => ({ key: b.key, minutes: b.minutes }))).map((p) => [p.key, p]));
    return { ...d, wd, spans, placed };
  });
  const weekPlanned = week.reduce((s, d) => s + d.blocks.reduce((x, b) => x + b.minutes, 0), 0);
  const weekBudget = week.reduce((s, d) => s + d.budget, 0);
  const behind = exams.filter((e) => e.status === "behind" || e.status === "tight");
  const clash = exams.find((e, i) => exams.some((x, j) => j !== i && x.date === e.date));
  const tightest = clash ?? behind[0] ?? null;

  const cell = (b: PlannedBlock | undefined) => (b ? (b.kind === "homework" ? "is-hw" : b.kind === "check" ? "is-check" : b.examKeys.length ? "is-prep" : "is-other") : "");

  return (
    <div className="quest-page week-page">
      <header className="now-head">
        <p className="quest-kicker">
          PLAN · {shortDate(today).toUpperCase()} – {shortDate(shownDays[shownDays.length - 1].day).toUpperCase()}
        </p>
        <h1>{exams.length ? `Your run-up to ${exams.length} ${exams.some((e) => e.label === "Klausur") ? (exams.length === 1 ? "Klausur" : "Klausuren") : exams.length === 1 ? "exam" : "exams"}` : "Your next four weeks"}</h1>
        <p className="now-context">StudyDesk spreads the prep backwards from each exam into your free afternoons, so nothing piles up the night before. When you skip or move a block, everything after it is planned again.</p>
      </header>

      <div className="wk-stats">
        <div className="stat-card">
          <span className="section-label">This week</span>
          <span className="stat-big">{duration(weekPlanned)} planned</span>
          <span className="quest-muted">of about {duration(weekBudget)} your study goal leaves</span>
        </div>
        <div className="stat-card">
          <span className="section-label">{exams.length ? `All ${exams.length} exams` : "Exams"}</span>
          <span className={"stat-big" + (behind.length ? " is-warn" : " is-ok")}>{!exams.length ? "None in 4 weeks" : behind.length ? `${behind.length} ${behind.length === 1 ? "needs" : "need"} more time` : "Fit at this pace"}</span>
          <span className="quest-muted">{plan.neededPerDay > plan.budgetPerDay * 1.15 ? `needs about ${duration(plan.neededPerDay)} a study day; you have ${duration(plan.budgetPerDay)}` : `about ${duration(plan.budgetPerDay)} per study day`}</span>
        </div>
        {tightest && (
          <div className="stat-card is-warn">
            <span className="section-label">Tightest spot</span>
            <span className="stat-big">{shortDate(tightest.date)}</span>
            <span className="quest-muted">
              {clash ? `${exams.filter((x) => x.date === clash.date).map((x) => name(x.courseId)).join(" and ")} on one day, so both start early` : `${name(tightest.courseId)} is ${STATUS[tightest.status]}`}
            </span>
          </div>
        )}
      </div>

      {exams.length > 0 && (
        <section className="rail-card runup" aria-label="Run-up per course">
          <div className="rail-head">
            <h2 className="section-label">Run-up per course</h2>
            <span className="rail-meta">% ready = the share of what your target grade needs that you can do now</span>
          </div>
          <div className="runup-scroll">
            <table className="runup">
              <thead>
                <tr>
                  <th scope="col" className="runup-name">
                    <span className="sr-only">Course</span>
                  </th>
                  {shownDays.map((d) => {
                    const wd = weekdayOf(d.day);
                    return (
                      <th key={d.day} scope="col" className={(d.day === today ? "is-today" : "") + (wd === 0 || wd === 6 ? " is-weekend" : "")}>
                        <span className="runup-month">{d.day.endsWith("-01") ? shortDate(d.day).split(" ")[2] : ""}</span>
                        <span>{LETTER[wd]}</span>
                        <span className="runup-num">{Number(d.day.slice(8))}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((cid) => {
                  const mine = exams.filter((e) => e.courseId === cid);
                  const first = mine[0];
                  return (
                    <tr key={cid}>
                      <th scope="row" className="runup-name">
                        <span className="runup-course">{name(cid)}</span>
                        <span className={"runup-state is-" + first.status}>
                          {first.status === "needs_you" ? "needs your notes" : `${Math.round(first.readiness * 100)}% ready · ${STATUS[first.status]}`}
                        </span>
                      </th>
                      {shownDays.map((d) => {
                        const b = d.blocks.find((x) => x.courseId === cid);
                        const exam = mine.find((e) => e.date === d.day);
                        const wd = weekdayOf(d.day);
                        return (
                          <td key={d.day} className={(d.day === today ? "is-today" : "") + (wd === 0 || wd === 6 ? " is-weekend" : "")}>
                            {exam ? (
                              <span className="runup-exam" title={`${exam.title}, ${shortDate(exam.date)}`}>
                                {exam.label.charAt(0)}
                              </span>
                            ) : b ? (
                              <span className={"runup-block " + cell(b)} title={`${KIND_LABEL[b.kind]} · ${b.minutes} min · ${whyLine(b, d.day, semester)}`} />
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="runup-load">
                  <th scope="row" className="runup-name">
                    Minutes planned
                  </th>
                  {shownDays.map((d) => {
                    const m = d.blocks.reduce((s, b) => s + b.minutes, 0);
                    return (
                      <td key={d.day} className={d.day === today ? "is-today" : ""}>
                        {m || ""}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="runup-legend">
            <span>
              <span className="runup-block is-prep" aria-hidden="true" /> Exam prep
            </span>
            <span>
              <span className="runup-block is-hw" aria-hidden="true" /> Homework
            </span>
            <span>
              <span className="runup-block is-check" aria-hidden="true" /> Placement check
            </span>
            <span>
              <span className="runup-exam" aria-hidden="true">
                {exams[0].label.charAt(0)}
              </span>{" "}
              {exams[0].label} day
            </span>
          </div>
        </section>
      )}

      <section aria-label="This week" className="wk-days-wrap">
        <div className="rail-head">
          <h2 className="section-label">This week</h2>
          <span className="rail-meta">Grey is school and your calendar. Every block sits in free time, with a break between blocks.</span>
        </div>
        <div className="wk-days">
          {week.map((d) => (
            <div key={d.day} className={"wk-day" + (d.day === today ? " is-today" : "") + (d.budget <= 0 && !d.blocks.length ? " is-off" : "")}>
              <div className="wk-day-head">
                <span className="wk-day-name">{shortDate(d.day).split(" ").slice(0, 2).join(" ")}</span>
                <span className="quest-muted">{d.blocks.length ? duration(d.blocks.reduce((s, b) => s + b.minutes, 0)) : d.budget <= 0 ? "Off" : "—"}</span>
              </div>
              {d.spans.map((s, i) => (
                <span key={i} className="wk-busy">
                  {s.kind === "school" ? `School until ${hhmm(s.end)}` : `${s.title} ${hhmm(s.start)}–${hhmm(s.end)}`}
                </span>
              ))}
              {d.blocks.map((b) => {
                const at = d.placed.get(b.key);
                return (
                  <button key={b.key} type="button" className="wk-block" onClick={d.day === today ? onOpenNow : undefined} disabled={d.day !== today}>
                    <span className="wk-block-top">
                      <span className="wk-time">{at?.start != null ? hhmm(at.start) : "Any time"}</span>
                      <span className="course-chip is-small">{short(b.courseId)}</span>
                    </span>
                    <span className="wk-block-title">{name(b.courseId)}</span>
                    <span className={"wk-why" + (b.tone === "due" ? " is-due" : b.tone === "exam" ? " is-exam" : "")}>{whyLine(b, d.day, semester) || KIND_LABEL[b.kind]}</span>
                  </button>
                );
              })}
              {!d.blocks.length && <span className="quest-muted wk-note">{d.budget <= 0 ? "Your day off" : "Nothing planned"}</span>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
