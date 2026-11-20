import { useEffect, useRef, useState } from "react";
import type { Day } from "../mastery/types";
import type { Semester } from "../quests/types";
import { countdown, upcoming, type UpcomingItem } from "./upcoming";

const KIND = { homework: "Hand-in", exam: "Exam", quiz: "Quiz" } as const;

function dateLabel(i: UpcomingItem): string {
  const d = new Date(`${i.date}T12:00`);
  const day = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return i.time ? `${day} · ${i.time}` : day;
}

/** Opens Organize with the item quoted, so the student can correct it. */
export function askAboutItem(i: UpcomingItem) {
  const quote = `${KIND[i.kind]}: ${i.courseName}, ${i.title}, ${dateLabel(i)}`;
  window.dispatchEvent(new CustomEvent("studydesk:ask", { detail: { quote } }));
}

/**
 * Every hand-in, exam and quiz in the next six weeks, as one scrolling row.
 * Each card can be checked and corrected ("Wrong?" opens Organize with it).
 */
export function ComingUp({ semester, today }: { semester: Pick<Semester, "courses" | "assignments" | "keyDates">; today: Day }) {
  const items = upcoming(semester, today);
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  // Folded to one line by default; the full list lives on Organize.
  const [open, setOpen] = useState(false);

  const measure = () => {
    const el = row.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [items.length, open]);

  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.8, behavior: "smooth" });

  if (!open)
    return (
      <section className="coming is-folded" aria-label="Coming up">
        <button type="button" className="coming-line" onClick={() => setOpen(true)} aria-expanded={false} disabled={items.length === 0}>
          <span className="section-label">Coming up</span>
          <span className="coming-line-text">
            {items.length === 0
              ? "nothing in the next six weeks"
              : items
                  .slice(0, 2)
                  .map((i) => `${i.courseShort} ${KIND[i.kind].toLowerCase()} ${countdown(i.inDays)}`)
                  .join(" · ")}
            {items.length > 2 && <span className="quest-muted"> · +{items.length - 2} more</span>}
          </span>
          {items.length > 0 && (
            <svg className="coming-chev" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </section>
    );

  return (
    <section className="coming" aria-label="Coming up">
      <div className="coming-head">
        <button type="button" className="coming-fold" onClick={() => setOpen(false)} aria-expanded={true}>
          <span className="section-label">Coming up</span>
          <span className="coming-sub">Next six weeks</span>
          <svg className="coming-chev is-up" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {items.length > 0 && (
          <span className="coming-nav">
            <button type="button" className="icon-btn" aria-label="Earlier" disabled={edges.start} onClick={() => page(-1)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button type="button" className="icon-btn" aria-label="Later" disabled={edges.end} onClick={() => page(1)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="quest-muted">Nothing due in the next six weeks. If that's wrong, tell Organize what's missing.</p>
      ) : (
        <div className={"coming-row" + (edges.end ? "" : " has-more")} ref={row} onScroll={measure}>
          {items.map((i) => (
            <article key={i.id} className={"coming-card" + (i.inDays <= 1 ? " is-close" : i.inDays <= 3 ? " is-soon" : "")}>
              <span className="coming-date">{dateLabel(i)}</span>
              <span className="coming-title">
                {i.courseName}: {i.title}
              </span>
              <span className="coming-kind">{KIND[i.kind]}</span>
              <span className="coming-count">{countdown(i.inDays)}</span>
              <button type="button" className="coming-wrong" onClick={() => askAboutItem(i)} title="Tell Organize what's wrong with this">
                Wrong?
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
