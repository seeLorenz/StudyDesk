// The pieces of the Now page: what to do now, the day on the clock, the exams
// ahead, quick answers and last night. Display only; QuestPage owns the data.
// design/day-plan.md, "Now".

import { useState, type ReactNode } from "react";
import { duration, hhmm, type Minute } from "../plan/clock";
import { KIND_LABEL, shortDate, type ExamRun, type PlannedBlock } from "../plan/day";
import type { TimelineBlock, TimelineItem } from "../plan/today";

export type BlockView = {
  block: PlannedBlock;
  /** Course name and short name. */
  course: string;
  short: string;
  title: string;
  why: string;
  /** Up to four steps, for the now card. */
  steps: Array<{ label: string; title: string; minutes: number; done: boolean }>;
  /** One or two sentences: why this block, now. */
  reason: string;
  minutesLeft: number;
  /** Still being written. */
  preparing: boolean;
};

export type LaterChoice = "later" | "tomorrow" | "skip";

const toneClass = (b: PlannedBlock) => (b.tone === "due" ? "is-due" : b.tone === "exam" ? "is-exam" : "");

export function CourseChip({ short, now = false }: { short: string; now?: boolean }) {
  return (
    <span className={"course-chip" + (now ? " is-now" : "")} aria-hidden="true">
      {short.slice(0, 4)}
    </span>
  );
}

// ---------- what to do now ----------

export function NowCard({
  view,
  item,
  onStart,
  onLater,
  laterOptions,
  nightly,
}: {
  view: BlockView;
  item: TimelineBlock;
  onStart: () => void;
  onLater: (c: LaterChoice) => void;
  laterOptions: Array<{ choice: LaterChoice; label: string; note: string; disabled?: boolean }>;
  nightly: string | null;
}) {
  const [menu, setMenu] = useState(false);
  const slot = item.start !== null ? `${hhmm(item.start)} – ${hhmm(item.end!)}` : "No free time left today";
  return (
    <section className="now-card" aria-label="What to do now">
      <div className="now-card-top">
        <span className={"now-pill" + (item.status === "now" ? " is-now" : "")}>{item.status === "now" ? "NOW" : "NEXT"}</span>
        <span className="now-slot">
          {slot} · {duration(view.minutesLeft)}
        </span>
        {view.why && <span className={"why-chip " + toneClass(view.block)}>{view.why}</span>}
      </div>
      {item.movedFrom !== null && <p className="now-moved">Planned for {hhmm(item.movedFrom)} and not started yet, so it moved to the next free time.</p>}
      <div className="now-card-title">
        <p className="now-kicker">
          {view.course} · {KIND_LABEL[view.block.kind]}
        </p>
        <h2>{view.title}</h2>
      </div>
      {view.reason && (
        <p className="now-why">
          <strong>Why now:</strong> {view.reason}
        </p>
      )}
      {view.steps.length > 0 && (
        <ol className="now-steps" aria-label="Steps in this block">
          {view.steps.map((s, i) => (
            <li key={i} className={s.done ? "is-done" : ""}>
              <span className="now-step-label">
                {i + 1} · {s.label}
              </span>
              <span className="now-step-title">{s.title}</span>
              <span className="now-step-min">{s.done ? "Done" : duration(s.minutes)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="now-actions">
        <button type="button" className="mini-btn primary big" onClick={onStart} disabled={view.preparing}>
          {view.preparing ? "Preparing…" : view.steps.some((s) => s.done) ? `Continue · ${duration(view.minutesLeft)}` : `Start · ${duration(view.minutesLeft)}`}
        </button>
        <div className="later-wrap">
          <button type="button" className="mini-btn big" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            Later…
          </button>
          {menu && (
            <div className="later-menu" role="menu">
              {laterOptions.map((o) => (
                <button
                  key={o.choice}
                  type="button"
                  role="menuitem"
                  disabled={o.disabled}
                  onClick={() => {
                    setMenu(false);
                    onLater(o.choice);
                  }}
                >
                  <span className="later-label">{o.label}</span>
                  {o.note && <span className="later-note">{o.note}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="now-foot">{nightly ? `Hand in by 21:45, graded tonight at ${nightly}` : "Grading runs when you press Grade me early"}</span>
      </div>
    </section>
  );
}

// ---------- the day on the clock ----------

export function Timeline({
  items,
  views,
  now,
  onOpen,
  freeNote,
}: {
  items: TimelineItem[];
  views: Map<string, BlockView>;
  now: Minute;
  onOpen: (key: string) => void;
  freeNote: string;
}) {
  return (
    <ol className="tl">
      {items.map((it, i) => {
        if (it.type === "busy")
          return (
            <li key={`b${i}`} className={"tl-row is-busy" + (it.past ? " is-past" : "")}>
              <span className="tl-time">{hhmm(it.start)}</span>
              <span className="tl-rail" aria-hidden="true">
                <span className="tl-dot is-grey" />
              </span>
              <div className="tl-card is-busy">
                <span className="tl-title">{it.title}</span>
                <span className="tl-sub">until {hhmm(it.end)}</span>
                {it.end <= now && <span className="tl-done">Done</span>}
              </div>
            </li>
          );
        if (it.type === "free")
          return (
            <li key={`f${i}`} className="tl-row is-free">
              <span className="tl-time">{hhmm(it.start)}</span>
              <span className="tl-rail" aria-hidden="true">
                <span className="tl-dot is-ring" />
              </span>
              <div className="tl-card is-free">
                <span className="tl-title">Free</span>
                <span className="tl-sub">{freeNote}</span>
              </div>
            </li>
          );
        if (it.type === "break")
          return (
            <li key={`k${i}`} className="tl-row is-break">
              <span className="tl-time">{hhmm(it.start)}</span>
              <span className="tl-rail" aria-hidden="true">
                <span className="tl-dot is-small" />
              </span>
              <p className="tl-note">Break · {duration(it.end - it.start)}</p>
            </li>
          );
        if (it.type === "end")
          return (
            <li key={`e${i}`} className="tl-row is-end">
              <span className="tl-time">{hhmm(it.at)}</span>
              <span className="tl-rail" aria-hidden="true">
                <span className="tl-dot is-ok" />
              </span>
              <p className="tl-note">
                <strong>Done for today.</strong> The evening is yours.
              </p>
            </li>
          );
        if (it.type === "nightly")
          return (
            <li key={`n${i}`} className="tl-row is-night">
              <span className="tl-time">{hhmm(it.at)}</span>
              <span className="tl-rail" aria-hidden="true">
                <span className="tl-dot is-night" />
              </span>
              <p className="tl-note">
                <strong>Nightly run.</strong> Grades what you handed in, then plans tomorrow.
              </p>
            </li>
          );
        const v = views.get(it.block.key);
        if (!v) return null;
        const cls = it.status === "done" ? " is-done" : it.status === "now" ? " is-now" : "";
        return (
          <li key={it.block.key} className={"tl-row is-block" + cls}>
            <span className="tl-time">{it.start !== null ? hhmm(it.start) : "—"}</span>
            <span className="tl-rail" aria-hidden="true">
              <span className={"tl-dot" + (it.status === "done" ? " is-ok" : it.status === "now" ? " is-now" : " is-open")} />
            </span>
            <button type="button" className={"tl-card is-block" + cls} onClick={() => onOpen(it.block.key)}>
              <CourseChip short={v.short} now={it.status === "now"} />
              <span className="tl-main">
                <span className="tl-title">
                  {v.course} · {v.title}
                </span>
                <span className="tl-sub">
                  {it.status === "done" ? "Done" : v.preparing ? "Preparing…" : it.start === null ? "No free time left today" : duration(v.minutesLeft)}
                  {it.movedFrom !== null && it.status !== "done" ? ` · moved from ${hhmm(it.movedFrom)}` : ""}
                </span>
              </span>
              {v.why && it.status !== "done" && <span className={"why-chip " + toneClass(it.block)}>{v.why}</span>}
              {it.status === "done" && (
                <svg className="tl-check" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- the exams ahead ----------

const STATUS = { on_track: "On track", tight: "Tight", behind: "Behind", needs_you: "Needs you" } as const;

export function ExamRail({ exams, courseName, onWeek, onNeedsYou, today }: { exams: ExamRun[]; courseName: (id: string) => string; onWeek: () => void; onNeedsYou: (e: ExamRun) => void; today: string }) {
  if (!exams.length) return null;
  const shown = exams.slice(0, 4);
  const more = exams.slice(4);
  return (
    <section className="rail-card" aria-label="Exams ahead">
      <div className="rail-head">
        <h3 className="section-label">{exams.some((e) => e.label === "Klausur") ? "Klausuren ahead" : "Exams ahead"}</h3>
        <button type="button" className="link-btn" onClick={onWeek}>
          See the plan →
        </button>
      </div>
      <ul className="exam-list">
        {shown.map((e) => {
          const [, , d] = e.date.split("-");
          const wd = shortDate(e.date).split(" ")[0].toUpperCase();
          return (
            <li key={e.key} className="exam-row">
              <span className="exam-date" aria-hidden="true">
                {wd}
                <span>{Number(d)}</span>
              </span>
              <span className="exam-main">
                <span className="exam-top">
                  <span className="exam-name">{courseName(e.courseId)}</span>
                  <span className={"exam-status is-" + e.status}>{STATUS[e.status]}</span>
                </span>
                {e.status === "needs_you" ? (
                  <span className="exam-sub">
                    No material yet.{" "}
                    <button type="button" className="link-btn" onClick={() => onNeedsYou(e)}>
                      Tell StudyDesk what's on it
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="exam-bar" aria-hidden="true">
                      {Array.from({ length: e.wanted }, (_, i) => (
                        <span key={i} className={i < e.planned ? "is-planned" : ""} />
                      ))}
                    </span>
                    <span className="exam-sub">
                      {Math.round(e.readiness * 100)}% ready · {e.planned >= e.wanted ? `all ${e.wanted} prep blocks planned` : `${e.planned} of ${e.wanted} prep blocks planned`}
                      <span className="sr-only"> before {shortDate(e.date)}</span>
                    </span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {more.length > 0 && (
        <p className="rail-foot">
          +{more.length} more: {more.map((e) => `${courseName(e.courseId)} ${shortDate(e.date).split(" ").slice(1).join(" ")}`).join(", ")}.
        </p>
      )}
      {exams[0] && exams[0].date === today && <p className="rail-foot">Good luck today.</p>}
    </section>
  );
}

// ---------- quick answers ----------

export type QuickQuestion = { key: string; course: string; text: string; impact: string };

export function QuickAnswers({ questions, waiting, onAnswer, onSeeAll }: { questions: QuickQuestion[]; waiting: number; onAnswer: (q: QuickQuestion, answer: string) => void; onSeeAll: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string[]>([]);
  const open = questions.filter((q) => !sent.includes(q.key));
  if (!open.length && !sent.length) return null;
  return (
    <section className="rail-card" aria-label="Quick answers">
      <div className="rail-head">
        <h3 className="section-label">Quick answers{open.length ? ` · ${open.length}` : ""}</h3>
        {open.length > 0 && <span className="rail-meta">about {open.length} min</span>}
      </div>
      {!open.length && <p className="rail-foot">Thanks. StudyDesk is putting your answers into the plan.</p>}
      {open.map((q) => (
        <form
          key={q.key}
          className="qa"
          onSubmit={(e) => {
            e.preventDefault();
            const a = (drafts[q.key] ?? "").trim();
            if (!a) return;
            onAnswer(q, a);
            setSent((s) => [...s, q.key]);
          }}
        >
          <label htmlFor={`qa-${q.key}`} className="qa-q">
            <span className="qa-course">{q.course}:</span> {q.text}
          </label>
          <div className="qa-row">
            <input
              id={`qa-${q.key}`}
              type="text"
              value={drafts[q.key] ?? ""}
              placeholder="Your answer, or “don't know”"
              onChange={(e) => setDrafts((d) => ({ ...d, [q.key]: e.target.value }))}
            />
            <button type="submit" className="mini-btn dark">
              Send
            </button>
          </div>
          {q.impact && <p className="qa-impact">{q.impact}</p>}
        </form>
      ))}
      {waiting > 0 && (
        <p className="rail-foot">
          {waiting} more can wait: none of them changes this week's plan.{" "}
          <button type="button" className="link-btn" onClick={onSeeAll}>
            See all
          </button>
        </p>
      )}
    </section>
  );
}

// ---------- small cards ----------

export function RailNote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="rail-card" aria-label={label}>
      <h3 className="section-label">{label}</h3>
      {children}
    </section>
  );
}
