import { useEffect, useMemo, useRef, useState } from "react";
import { toDay } from "../mastery/days";
import { courseMastery, isRequired } from "../mastery/mastery";
import { replay } from "../mastery/replay";
import type { Skill, SkillState } from "../mastery/types";
import { latestOf, publish, subscribe } from "../platform/deskBus";
import { openMasteryStore, type MasteryData } from "../platform/masteryStore";
import { openQuestStore } from "../platform/questStore";
import { openOnboardingStore, type StorageUsage, type UploadContent } from "../platform/onboardingStore";
import { describeCounts, fmtMB } from "../lib/keep";
import { LeftoversNotice } from "../shell/LeftoversNotice";
import { askAboutItem } from "../shell/ComingUp";
import { countdown, upcoming, type UpcomingItem } from "../shell/upcoming";
import { SelectionReply, askStudyDesk } from "../chat/SelectionReply";
import type { PendingAttachment } from "../lib/files";
import type { SemesterDraft, Upload } from "../onboarding/types";
import type { Semester } from "../quests/types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KIND = { homework: "Hand-in", exam: "Exam", quiz: "Quiz" } as const;
const fmtDay = (day: string) => new Date(`${day}T12:00`).toLocaleDateString([], { day: "numeric", month: "short" });
const hours = (min: number) => `${Number.isInteger(min / 60) ? min / 60 : (min / 60).toFixed(1)} h`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Props = {
  /** The open course page, or null for the list. */
  courseId: string | null;
  onOpen: (courseId: string | null) => void;
  onOpenSetup: () => void;
  onToday: () => void;
  /** A question about a selected passage, for the StudyDesk chat. */
  onAsk: (text: string, files: PendingAttachment[], quote: string) => void;
};

/**
 * The Courses tab: everything StudyDesk knows about the semester and each
 * course, to look at and check. Nothing is edited here; every "Wrong?" goes
 * to the StudyDesk chat (design/courses.md).
 */
export function CoursesPage({ courseId, onOpen, onOpenSetup, onToday, onAsk }: Props) {
  // undefined while loading; null when there's no semester yet.
  const [semester, setSemester] = useState<Semester | null>();
  const [mastery, setMastery] = useState<MasteryData | null>(null);
  const [draft, setDraft] = useState<SemesterDraft | null>(latestOf("draft") ?? null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const today = toDay();

  useEffect(() => {
    let live = true;
    Promise.all([openQuestStore().then((qs) => qs.loadSemester()), openMasteryStore().then((ms) => ms.load())])
      .then(([s, m]) => live && (setSemester(s), setMastery(m)))
      .catch((e) => live && setFailed(e instanceof Error ? e.message : "Your courses couldn't be loaded."));
    openOnboardingStore()
      .then(async (os) => {
        const [d, u] = await Promise.all([latestOf("draft") ? null : os.loadDraft(), os.storageUsage()]);
        if (!live) return;
        if (d) setDraft(d);
        setUsage(u);
      })
      .catch(() => undefined);
    const stops = [subscribe("semester", "courses", setSemester), subscribe("draft", "courses", setDraft)];
    return () => {
      live = false;
      stops.forEach((s) => s());
    };
  }, []);

  const states = useMemo(() => (semester && mastery ? replay(semester.skills, mastery.attempts, mastery.reviews).states : null), [semester, mastery]);
  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [courseId]);

  const course = semester?.courses.find((c) => c.id === courseId);
  return (
    <div className="courses" ref={scroller} data-select-scope="">
      {failed ? (
        <p className="quest-error">{failed}</p>
      ) : semester === null ? (
        <p className="quest-muted">
          No semester yet.{" "}
          <button type="button" className="link-btn" onClick={onOpenSetup}>
            Set up your semester
          </button>
        </p>
      ) : !semester || !mastery || !states ? (
        <p className="quest-muted late-in">Loading your courses…</p>
      ) : (
        <div className="desk" data-selectable="true" data-msg-body={course ? `course-${course.id}` : "courses"}>
          {course ? (
            <CourseView semester={semester} mastery={mastery} states={states} draft={draft} courseId={course.id} today={today} onBack={() => onOpen(null)} onToday={onToday} />
          ) : (
            <CourseList semester={semester} mastery={mastery} states={states} usage={usage} today={today} onOpen={onOpen} onOpenSetup={onOpenSetup} onUsage={setUsage} />
          )}
        </div>
      )}
      <SelectionReply scope={scroller} disabled={false} onAsk={(_, anchor, question, files) => onAsk(question, files, anchor.quote)} />
    </div>
  );
}

type Shared = { semester: Semester; mastery: MasteryData; states: Map<string, SkillState>; today: string };

function CourseList({
  semester,
  mastery,
  states,
  usage,
  today,
  onOpen,
  onOpenSetup,
  onUsage,
}: Shared & { usage: StorageUsage | null; onOpen: (id: string) => void; onOpenSetup: () => void; onUsage: (u: StorageUsage | null) => void }) {
  const dates = upcoming(semester, today, 400);
  const weekly = semester.studyGoal.reduce((a, b) => a + b, 0);
  const unsorted = (semester.uploads ?? []).filter((u) => !u.courseId);
  const range = semester.startDate && semester.endDate ? `${fmtDay(semester.startDate)} to ${fmtDay(semester.endDate)}` : null;
  return (
    <>
      <header className="desk-head">
        <div>
          <p className="quest-kicker">Your semester</p>
          <h2 className="desk-title">{semester.name}</h2>
          <p className="desk-meta">{[range, plural(semester.courses.length, "course"), weekly ? `${hours(weekly)} a week` : null].filter(Boolean).join(" · ")}</p>
        </div>
        {semester.source === "sample" && (
          <button type="button" className="mini-btn" onClick={onOpenSetup}>
            Set up your semester
          </button>
        )}
      </header>
      {semester.source === "sample" && <p className="quest-banner">This is sample data (Calculus 1). Setting up your semester replaces it with your real courses.</p>}

      <section className="desk-section" aria-label="Courses">
        <h3 className="section-label">Courses</h3>
        <div className="course-grid">
          {semester.courses.map((c) => {
            const target = semester.targets.find((t) => t.courseId === c.id);
            const m = target ? courseMastery(semester.skills, states, target, today) : null;
            const open = openMistakes(semester, mastery, c.id);
            const next = dates.find((d) => d.courseId === c.id && d.kind !== "homework") ?? dates.find((d) => d.courseId === c.id);
            const unsure = (semester.uploads ?? []).filter((u) => u.courseId === c.id && u.courseUnsure).length;
            return (
              <button type="button" key={c.id} className="course-card is-link" onClick={() => onOpen(c.id)}>
                <span className="course-top">
                  <span className="course-name">{c.name}</span>
                  {m && <span className="course-pct">{Math.round(m.value * 100)}%</span>}
                </span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${Math.round((m?.value ?? 0) * 100)}%` }} />
                </span>
                <span className="course-line">
                  {m ? `${m.masteredCount} of ${m.requiredCount} skills mastered` : "No target grade yet"}
                  {target ? ` · aiming for ${target.targetGrade}` : ""}
                </span>
                {(open > 0 || next || unsure > 0) && (
                  <span className="course-tags">
                    {open > 0 && <span className="tag is-warn">{plural(open, "open mistake")}</span>}
                    {unsure > 0 && <span className="tag is-warn">{plural(unsure, "file")} to check</span>}
                    {next && (
                      <span className="tag">
                        {KIND[next.kind]} {countdown(next.inDays)}
                      </span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="desk-section" aria-label="Dates">
        <h3 className="section-label">All dates</h3>
        <DateList dates={dates} empty="No hand-ins or exams yet." withCourse />
      </section>

      <section className="desk-section" aria-label="Study time">
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

      {(unsorted.length > 0 || usage) && (
        <section className="desk-section" aria-label="Files">
          <h3 className="section-label">Files</h3>
          {unsorted.length > 0 && <p className="desk-meta">Not sorted to a course: {unsorted.length === 1 ? unsorted[0].fileName : `${unsorted.length} files (${describeCounts(unsorted)})`}</p>}
          <p className="quest-muted">Each course's files are on its page.</p>
          <LeftoversNotice
            onRemoved={() =>
              void openOnboardingStore()
                .then((os) => os.storageUsage())
                .then(onUsage)
            }
          />
          {usage && (
            <div className="storage-meter" title="Your StudyDesk's file store, where original files are kept">
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.round((usage.bytes / usage.maxBytes) * 100))}%` }} />
              </div>
              <p className="quest-muted">
                File store: {fmtMB(usage.bytes)} of {fmtMB(usage.maxBytes)} used · {usage.files} of {usage.maxFiles} files
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function openMistakes(semester: Semester, mastery: MasteryData, courseId: string): number {
  const skills = new Set(semester.skills.filter((s) => s.courseId === courseId).map((s) => s.id));
  const attempts = new Set(mastery.attempts.filter((a) => skills.has(a.skillId)).map((a) => a.id));
  return mastery.reviews.filter((r) => r.status !== "resolved" && attempts.has(r.attemptId)).length;
}

function DateList({ dates, empty, withCourse }: { dates: UpcomingItem[]; empty: string; withCourse?: boolean }) {
  if (!dates.length) return <p className="quest-muted">{empty}</p>;
  return (
    <ul className="date-list">
      {dates.map((d) => (
        <li key={d.id}>
          <span className="date-when">{fmtDay(d.date)}</span>
          <span className="date-what">
            {withCourse && `${d.courseName}: `}
            {d.title}
            <span className="quest-muted">
              {" "}
              · {d.kind === "homework" ? `hand-in${d.time ? ` ${d.time}` : ""}` : d.kind}
              {d.inDays >= 0 && ` ${countdown(d.inDays)}`}
            </span>
          </span>
          <button type="button" className="coming-wrong" onClick={() => askAboutItem(d)}>
            Wrong?
          </button>
        </li>
      ))}
    </ul>
  );
}

function skillState(s: Skill, st: SkillState | undefined, today: string): string {
  if (!st || st.stage === "new") return "Not started";
  if (st.stage === "lapsed") return "Slipped";
  if (st.stage === "learning") return `Learning · ${st.streak} of ${s.streakTarget ?? 3} clean solves`;
  return st.dueAt && st.dueAt <= today ? "Due for review" : "Mastered";
}

function CourseView({ semester, mastery, states, draft, courseId, today, onBack, onToday }: Shared & { draft: SemesterDraft | null; courseId: string; onBack: () => void; onToday: () => void }) {
  const [viewing, setViewing] = useState<Upload | null>(null);
  const course = semester.courses.find((c) => c.id === courseId)!;
  const target = semester.targets.find((t) => t.courseId === courseId);
  const m = target ? courseMastery(semester.skills, states, target, today) : null;
  const credits = draft?.courses.find((c) => c.id === courseId)?.credits;
  const open = openMistakes(semester, mastery, courseId);
  const results = (draft?.assessments ?? []).filter((r) => r.courseId === courseId);
  const dates = upcoming(semester, today, 400, "0000-01-01").filter((d) => d.courseId === courseId);
  const skills = semester.skills.filter((s) => s.courseId === courseId);
  const uploads = (semester.uploads ?? []).filter((u) => u.courseId === courseId);
  // The catalog both ways, in one pass: where each skill is covered, and how many skills each file covers.
  const fileName = new Map(uploads.map((u) => [u.id, u.fileName]));
  const where = new Map<string, string[]>();
  const skillsOf = new Map<string, Set<string>>();
  for (const e of semester.catalog ?? []) {
    const name = fileName.get(e.uploadId);
    if (!name) continue;
    where.set(e.skillId, [...(where.get(e.skillId) ?? []), `${name}, ${e.where}`]);
    skillsOf.set(e.uploadId, (skillsOf.get(e.uploadId) ?? new Set()).add(e.skillId));
  }
  const slots = semester.timetable.filter((t) => t.courseId === courseId);
  const facts = (draft?.facts ?? []).filter((f) => f.courseId === courseId);
  const unsure = uploads.filter((u) => u.courseUnsure);
  const folders = groupBy(
    uploads.filter((u) => !u.courseUnsure),
    (u) => (u.path?.includes("/") ? u.path.slice(0, u.path.lastIndexOf("/")) : ""),
  );
  const wrongCourse = (u: Upload) => askStudyDesk(`File "${u.fileName}" is in ${course.name}: wrong course?`);
  const fileLine = (u: Upload) => {
    const n = skillsOf.get(u.id)?.size ?? 0;
    const status = u.state === "listed" ? "listed only" : n ? `read, used for ${plural(n, "skill")}` : u.cataloguedAt ? "read" : "not read yet";
    return [u.pages ? plural(u.pages, "page") : null, u.state === "agent" ? `scan, ${status}` : status].filter(Boolean).join(" · ");
  };
  const nameButton = (u: Upload) => (
    <button type="button" className="link-btn file-open" onClick={() => setViewing(u)}>
      {u.fileName}
    </button>
  );

  return (
    <>
      <button type="button" className="link-btn" onClick={onBack}>
        ← Courses
      </button>
      <header className="desk-head">
        <div>
          <p className="quest-kicker">Course</p>
          <h2 className="desk-title">{course.name}</h2>
          <p className="desk-meta">
            {[credits ? `${credits} credits` : null, target ? `aiming for ${target.targetGrade}` : "no target grade yet", course.teachingLanguage, m ? `${Math.round(m.value * 100)}% mastered` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </header>

      <section className="desk-section" aria-label="Progress">
        <h3 className="section-label">Progress</h3>
        <div className="bar" aria-hidden="true">
          <span style={{ width: `${Math.round((m?.value ?? 0) * 100)}%` }} />
        </div>
        <p className="desk-meta">
          {m ? `${m.masteredCount} of ${m.requiredCount} skills your target needs are mastered.` : "Set a target grade to see how far along you are."}
          {open > 0 && (
            <>
              {" "}
              {plural(open, "open mistake")}:{" "}
              <button type="button" className="link-btn" onClick={onToday}>
                review on Today
              </button>
            </>
          )}
        </p>
        {results.length > 0 && (
          <ul className="file-list">
            {results.map((r) => (
              <li key={r.assessmentId}>
                {r.component}
                <span className="quest-muted">
                  {" "}
                  · {r.points} of {r.maxPoints} · {fmtDay(r.date)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="desk-section" aria-label="Dates">
        <h3 className="section-label">Dates</h3>
        <DateList dates={dates.filter((d) => d.inDays >= 0)} empty="Nothing coming up." />
        {dates.some((d) => d.inDays < 0) && (
          <details className="fold">
            <summary>Earlier</summary>
            <DateList dates={dates.filter((d) => d.inDays < 0).reverse()} empty="" />
          </details>
        )}
      </section>

      <section className="desk-section" aria-label="Topics and skills">
        <h3 className="section-label">Topics and skills</h3>
        {course.topics.length === 0 && <p className="quest-muted">StudyDesk hasn't read this course yet.</p>}
        {course.topics.map((t) => {
          const ts = skills.filter((s) => s.topicId === t.id);
          const needed = target ? ts.filter((s) => isRequired(s, target)) : ts;
          const done = needed.filter((s) => skillState(s, states.get(s.id), today) === "Mastered").length;
          return (
            <details key={t.id} className="fold topic">
              <summary>
                <span className="topic-name">
                  {t.name}
                  {t.taught && <span className="tag">taught</span>}
                </span>
                <span className="quest-muted">
                  {done} of {needed.length}
                </span>
                <span className="bar topic-bar" aria-hidden="true">
                  <span style={{ width: `${needed.length ? Math.round((done / needed.length) * 100) : 0}%` }} />
                </span>
              </summary>
              <ul className="skill-list">
                {ts.map((s) => {
                  const need = !target || isRequired(s, target);
                  const covered = where.get(s.id) ?? [];
                  return (
                    <li key={s.id} className={need ? "" : "is-unneeded"}>
                      <span>{s.name}</span>
                      <span className="quest-muted">{need ? skillState(s, states.get(s.id), today) : `not needed for a ${target!.targetGrade}`}</span>
                      {covered.length > 0 && <span className="skill-where">{covered.slice(0, 2).join(" · ")}</span>}
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })}
      </section>

      {slots.length > 0 && (
        <section className="desk-section" aria-label="Timetable">
          <h3 className="section-label">Timetable</h3>
          <ul className="date-list">
            {slots.map((s) => (
              <li key={`${s.weekday}-${s.start}`}>
                <span className="date-when">{DAYS[s.weekday]}</span>
                <span className="date-what">
                  {s.start} to {s.end} · {s.title}
                  <span className="quest-muted"> · {s.kind}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="desk-section" aria-label="Files">
        <h3 className="section-label">Files</h3>
        {unsure.length > 0 && (
          <div className="unsure">
            <p className="unsure-head">Not sure these belong here</p>
            <ul className="file-list">
              {unsure.map((u) => (
                <li key={u.id}>
                  <span className="date-what">
                    {nameButton(u)}
                    <span className="quest-muted"> · {u.courseUnsure}</span>
                  </span>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => publish("op", { ops: [{ op: "set_file_course", file: u.id, course: courseId }], words: `"${u.fileName}" belongs to ${course.name} (Courses page)` }, "courses")}
                  >
                    Belongs here
                  </button>
                  <button type="button" className="coming-wrong" onClick={() => wrongCourse(u)}>
                    Wrong course?
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {uploads.length === 0 && <p className="quest-muted">No files for this course yet. Drop them into the box below.</p>}
        {[...folders].map(([folder, us]) => (
          <details key={folder} className="fold" open={us.length <= 6}>
            <summary>
              {folder || "Files"} <span className="quest-muted">· {us.length}</span>
            </summary>
            <ul className="file-list">
              {us.map((u) => (
                <li key={u.id}>
                  <span className="date-what">
                    {nameButton(u)}
                    <span className="quest-muted"> · {fileLine(u)}</span>
                    {u.studentNote && <span className="skill-where">You said: {u.studentNote}</span>}
                  </span>
                  <button type="button" className="coming-wrong" onClick={() => wrongCourse(u)}>
                    Wrong course?
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>

      {facts.length > 0 && (
        <section className="desk-section" aria-label="What you told StudyDesk">
          <h3 className="section-label">What you told StudyDesk</h3>
          <ul className="file-list">
            {facts.map((f) => (
              <li key={f.id}>{f.text}</li>
            ))}
          </ul>
        </section>
      )}
      {viewing && <FileViewer upload={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/** The original in a pop-out when it's kept and the browser can show it, otherwise the kept text. */
function FileViewer({ upload, onClose }: { upload: Upload; onClose: () => void }) {
  const original = upload.assetId && (upload.type === "pdf" || upload.type === "image") ? `/_blob/${upload.assetId}` : null;
  const [content, setContent] = useState<UploadContent | null | "loading">(original ? null : "loading");
  useEffect(() => {
    if (original) return;
    void openOnboardingStore()
      .then((os) => os.loadUploadContent(upload.id))
      .then(setContent)
      .catch(() => setContent(null));
  }, [upload.id, original]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const text = content && content !== "loading" ? content.text || content.description || content.outline : null;
  return (
    <div className="file-viewer" role="dialog" aria-label={upload.fileName} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="file-viewer-box">
        <header>
          <strong>{upload.fileName}</strong>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {original ? (
          upload.type === "image" ? (
            <img src={original} alt={upload.fileName} />
          ) : (
            <iframe src={original} title={upload.fileName} />
          )
        ) : content === "loading" ? (
          <p className="quest-muted">Loading…</p>
        ) : content?.image ? (
          <img src={content.image} alt={upload.fileName} />
        ) : text ? (
          <pre>{text.slice(0, 40_000)}</pre>
        ) : (
          <p className="quest-muted">StudyDesk only knows this file by its name{upload.type === "video" ? ": it can't watch videos" : ""}.</p>
        )}
      </div>
    </div>
  );
}
