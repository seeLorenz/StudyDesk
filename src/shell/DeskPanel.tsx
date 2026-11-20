import { useEffect, useMemo, useState } from "react";
import { toDay } from "../mastery/days";
import { courseMastery } from "../mastery/mastery";
import { replay } from "../mastery/replay";
import { subscribe } from "../platform/deskBus";
import { openMasteryStore, type MasteryData } from "../platform/masteryStore";
import { openQuestStore } from "../platform/questStore";
import type { Semester } from "../quests/types";
import { askAboutItem } from "./ComingUp";
import { countdown, upcoming } from "./upcoming";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FILES_SHOWN = 8;

function fmtDay(day: string) {
  return new Date(`${day}T12:00`).toLocaleDateString([], { day: "numeric", month: "short" });
}

function hours(min: number) {
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/**
 * The Organize page's right side: everything StudyDesk knows about the
 * semester, to look at and check. Changes go through the chat beside it.
 */
export function DeskPanel({ onOpenSetup }: { onOpenSetup: () => void }) {
  const [semester, setSemester] = useState<Semester | null>(null);
  const [mastery, setMastery] = useState<MasteryData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const today = toDay();

  useEffect(() => {
    let live = true;
    Promise.all([openQuestStore().then((qs) => qs.loadSemester()), openMasteryStore().then((ms) => ms.load())])
      .then(([s, m]) => {
        if (!live) return;
        setSemester(s);
        setMastery(m);
      })
      .catch((e) => live && setFailed(e instanceof Error ? e.message : "Your desk couldn't be loaded."));
    const stop = subscribe("semester", "desk-panel", (s) => setSemester(s));
    return () => {
      live = false;
      stop();
    };
  }, []);

  const courses = useMemo(() => {
    if (!semester || !mastery) return [];
    const { states } = replay(semester.skills, mastery.attempts, mastery.reviews);
    const skillCourse = new Map(semester.skills.map((s) => [s.id, s.courseId]));
    const attemptCourse = new Map(mastery.attempts.map((a) => [a.id, skillCourse.get(a.skillId)]));
    const dates = upcoming(semester, today, 400);
    return semester.courses.map((c) => {
      const target = semester.targets.find((t) => t.courseId === c.id);
      const m = target ? courseMastery(semester.skills, states, target, today) : null;
      const open = mastery.reviews.filter((r) => r.status !== "resolved" && attemptCourse.get(r.attemptId) === c.id).length;
      const next = dates.find((d) => d.courseId === c.id && d.kind !== "homework") ?? dates.find((d) => d.courseId === c.id);
      return { course: c, target, mastery: m, open, next };
    });
  }, [semester, mastery, today]);

  if (failed) return <p className="quest-error">{failed}</p>;
  if (!semester || !mastery) return <p className="quest-muted">Loading your desk…</p>;

  const dates = upcoming(semester, today, 400);
  const weekly = semester.studyGoal.reduce((a, b) => a + b, 0);
  const uploads = semester.uploads ?? [];
  const range = semester.startDate && semester.endDate ? `${fmtDay(semester.startDate)} to ${fmtDay(semester.endDate)}` : null;

  return (
    <div className="desk" data-select-scope="">
      <header className="desk-head">
        <div>
          <p className="quest-kicker">Your semester</p>
          <h2 className="desk-title">{semester.name}</h2>
          <p className="desk-meta">
            {[range, `${semester.courses.length} ${semester.courses.length === 1 ? "course" : "courses"}`, weekly ? `${hours(weekly)} a week` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button type="button" className="mini-btn" onClick={onOpenSetup}>
          {semester.source === "sample" ? "Set up your semester" : "Setup sheet"}
        </button>
      </header>
      {semester.source === "sample" && <p className="quest-banner">This is sample data (Calculus 1). Setting up your semester replaces it with your real courses.</p>}

      <section className="desk-section" aria-label="Courses">
        <h3 className="section-label">Courses</h3>
        <div className="course-grid">
          {courses.map(({ course, target, mastery: m, open, next }) => (
            <article key={course.id} className="course-card">
              <div className="course-top">
                <span className="course-name">{course.name}</span>
                {m && <span className="course-pct">{Math.round(m.value * 100)}%</span>}
              </div>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${Math.round((m?.value ?? 0) * 100)}%` }} />
              </div>
              <p className="course-line">
                {m ? `${m.masteredCount} of ${m.requiredCount} skills mastered` : "No target grade yet"}
                {target ? ` · aiming for ${target.targetGrade}` : ""}
              </p>
              {(open > 0 || next) && (
                <div className="course-tags">
                  {open > 0 && (
                    <span className="tag is-warn">
                      {open} open {open === 1 ? "mistake" : "mistakes"}
                    </span>
                  )}
                  {next && (
                    <span className="tag">
                      {next.kind === "homework" ? "Hand-in" : next.kind === "exam" ? "Exam" : "Quiz"} {countdown(next.inDays)}
                    </span>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="desk-section" aria-label="Dates">
        <h3 className="section-label">All dates</h3>
        {dates.length === 0 ? (
          <p className="quest-muted">No hand-ins or exams yet.</p>
        ) : (
          <ul className="date-list">
            {dates.map((d) => (
              <li key={d.id}>
                <span className="date-when">{fmtDay(d.date)}</span>
                <span className="date-what">
                  {d.courseName}: {d.title}
                  <span className="quest-muted"> · {d.kind === "homework" ? `hand-in${d.time ? ` ${d.time}` : ""}` : d.kind}</span>
                </span>
                <button type="button" className="coming-wrong" onClick={() => askAboutItem(d)}>
                  Wrong?
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="desk-section" aria-label="Your week">
        <h3 className="section-label">Study time</h3>
        <div className="week-row">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <div key={d} className={"week-day" + (semester.studyGoal[d] ? "" : " is-off")}>
              <span>{DAYS[d]}</span>
              <strong>{semester.studyGoal[d] ? hours(semester.studyGoal[d]) : "off"}</strong>
            </div>
          ))}
        </div>
      </section>

      {uploads.length > 0 && (
        <section className="desk-section" aria-label="Files">
          <h3 className="section-label">Files</h3>
          <ul className="file-list">
            {uploads.slice(0, FILES_SHOWN).map((u) => (
              <li key={u.id}>
                {u.fileName}
                <span className="quest-muted"> · {semester.courses.find((c) => c.id === u.courseId)?.name ?? "not sorted"}</span>
              </li>
            ))}
          </ul>
          {uploads.length > FILES_SHOWN && <p className="quest-muted">and {uploads.length - FILES_SHOWN} more</p>}
        </section>
      )}
    </div>
  );
}
