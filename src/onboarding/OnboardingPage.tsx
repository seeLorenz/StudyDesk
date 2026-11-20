import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "../chat/types";
import { uid } from "../chat/types";
import { InputBox } from "../chat/InputBox";
import { SelectionReply } from "../chat/SelectionReply";
import { passageNoteTurns } from "../chat/prompts";
import { readFullText, type PendingAttachment } from "../lib/files";
import { toDay } from "../mastery/days";
import { replay } from "../mastery/replay";
import type { Skill } from "../mastery/types";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
import { useSideNotes } from "../notes/useSideNotes";
import { askClaude, canSendImages, claudeAvailable, errorCopy, type AskError } from "../platform/claude";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { offerDownload, openOnboardingStore, type OnboardingStore } from "../platform/onboardingStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { emptyProgress } from "../quests/handin";
import { compressImage, dataUrlToBlob } from "../quests/images";
import { busyMinutes, formatDue } from "../quests/plan";
import { sampleWriter } from "../quests/seed";
import type { Semester, TimetableEntry } from "../quests/types";
import { writeQuest, type WriteStatus } from "../quests/write";
import { extract } from "./extract";
import { placementWriter, planPlacement } from "./placement";
import { SCALES, defaultSemester, gradeSteps, scaleFor } from "./scales";
import { buildSemester, localSetup, runCourseSetup, type FileForSetup } from "./setup";
import type { DraftCourse, Profile, SemesterDraft, SetupStep, Upload } from "./types";

// Start New Semester: a guided setup with a semester sheet beside it.
// design/onboarding.md. Every step saves as it goes and has "skip, add later",
// so the student can close the page and come back. Until the Orchestrator
// exists, each step asks its own question; the Orchestrator will take over the
// conversation and fill the same sheet.

/** Keep at most this much readable text per file (one database document holds 256 KiB). */
const MAX_FILE_CHARS = 240_000;
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STEPS: Array<{ key: SetupStep; label: string }> = [
  { key: "about", label: "About you" },
  { key: "courses", label: "Courses" },
  { key: "course", label: "Each course" },
  { key: "time", label: "Your time" },
  { key: "check", label: "Check and start" },
  { key: "done", label: "Placement check" },
];
const stepIndex = (s: SetupStep) => (s === "running" ? 4 : s === "welcome" ? -1 : STEPS.findIndex((x) => x.key === s));

const hours = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

function message(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) return errorCopy(e as AskError);
  return e instanceof Error ? e.message : "Something went wrong.";
}

function newDraft(profile: Profile | null, today: string): SemesterDraft {
  const d = defaultSemester(today, profile?.level ?? "university");
  return {
    id: `sem_${uid()}`,
    ...d,
    status: "setting_up",
    setupStep: "welcome",
    courseIndex: 0,
    courses: [],
    timetable: [],
    // A first suggestion (3 h on weekdays, 4 h on Saturday, Sunday off); step 7 recommends a real one.
    studyGoal: [0, 180, 180, 180, 180, 180, 240],
    uploads: [],
    facts: [],
    results: {},
    notes: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const emptyProfile = (): Profile => ({ level: "university", school: "", country: "", gradeScale: scaleFor("", "university"), program: "", year: "", updatedAt: 0 });

type Loaded = {
  os: OnboardingStore;
  qs: QuestStore;
  ms: MasteryStore;
  mastery: MasteryData;
  live: boolean;
  current: Semester | null;
};

const NOTE_RULES = `You are StudyDesk, a study assistant for high school and university students.
The student is setting up their semester and highlighted a passage of the setup report to ask about.
Your answer appears in a small side note right under that passage. So:
- Answer only the question about the highlighted passage, using the report as context.
- Be brief: usually 2 to 6 sentences, or a short list.
- Don't restate the passage and don't greet.
- Use Markdown; write math with $...$ inline.`;

export function OnboardingPage({ onDone }: { onDone: () => void }) {
  const [env, setEnv] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [draft, setDraft] = useState<SemesterDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const today = toDay();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const [os, qs, ms, live] = await Promise.all([openOnboardingStore(), openQuestStore(), openMasteryStore(), claudeAvailable()]);
      const [p, d, current, mastery] = await Promise.all([os.loadProfile(), os.loadDraft(), qs.loadSemester(), ms.load()]);
      // A finished draft belongs to the current semester; starting again makes a new one.
      const usable = d && (d.status === "setting_up" || (current && current.id === d.id)) ? d : null;
      if (p) setProfile(p);
      setDraft(usable ?? newDraft(p, today));
      setEnv({ os, qs, ms, mastery, live, current });
    })().catch((e) => setLoadError(message(e)));
  }, [today]);

  // ---- autosave: every change, written within a second and when the tab is hidden ----
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyProfile = useRef(false);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!env || !draftRef.current) return Promise.resolve();
    const jobs = [env.os.saveDraft({ ...draftRef.current, updatedAt: Date.now() })];
    if (dirtyProfile.current) {
      dirtyProfile.current = false;
      jobs.push(env.os.saveProfile({ ...profileRef.current, updatedAt: Date.now() }));
    }
    return Promise.all(jobs)
      .then(() => setSaveError(null))
      .catch((e) => setSaveError(`Your setup couldn't be saved: ${message(e)}`));
  }, [env]);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  }, [flush]);
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void flush();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void flush();
    };
  }, [flush]);

  const update = useCallback(
    (fn: (d: SemesterDraft) => SemesterDraft) => {
      setDraft((d) => {
        if (!d) return d;
        const next = fn(d);
        draftRef.current = next;
        return next;
      });
      schedule();
    },
    [schedule],
  );
  const updateProfile = (patch: Partial<Profile>) => {
    setProfile((p) => ({ ...p, ...patch }));
    dirtyProfile.current = true;
    schedule();
  };
  const go = (setupStep: SetupStep, courseIndex?: number) => {
    update((d) => ({ ...d, setupStep, courseIndex: courseIndex ?? d.courseIndex }));
    scroller.current?.scrollTo({ top: 0 });
  };

  // ---- select-to-reply on the setup report ----
  const blocks = useMemo(() => {
    const m = new Map<string, { text: string; label: string }>();
    if (!draft) return m;
    for (const c of draft.courses) {
      const r = draft.results[c.id];
      if (r?.summary) m.set(`sum-${c.id}`, { text: r.summary, label: `the setup report for ${c.name}` });
    }
    return m;
  }, [draft]);
  const turnsFor = useCallback(
    (note: Note) => {
      const b = blocks.get(note.messageId);
      return passageNoteTurns(NOTE_RULES, `<report>\nThe passage is in ${b?.label ?? "the setup report"}:\n"""\n${b?.text ?? ""}\n"""\n</report>`, note);
    },
    [blocks],
  );
  const setNotes = useCallback((fn: (n: Note[]) => Note[]) => update((d) => ({ ...d, notes: fn(d.notes ?? []) })), [update]);
  const notes = useSideNotes({ notes: draft?.notes ?? [], setNotes, turnsFor, onSettled: () => void flush() });
  const md = (blockId: string, text: string) => (
    <AnnotatedMarkdown blockId={blockId} text={text} notes={notes.byBlock.get(blockId) ?? []} {...notes.handlers} />
  );

  if (loadError) return <div className="quest-page"><p className="quest-error">Setup couldn't be loaded: {loadError}</p></div>;
  if (!env || !draft) return <div className="quest-page"><p className="quest-muted">Loading…</p></div>;

  const at = stepIndex(draft.setupStep);
  const returning = env.current?.source === "onboarding" && env.current.id !== draft.id;
  const props = { env, draft, profile, update, updateProfile, go, today, flush, md, onDone, setEnv };

  return (
    <div className="quest-page setup-page" ref={scroller} data-select-scope="">
      {!env.live && <p className="quest-banner">Preview mode: no Claude here, so setup reads typed lines only and builds a made-up skill map.</p>}
      {saveError && <p className="quest-error">{saveError}</p>}
      <header className="quest-head">
        <p className="quest-kicker">Start New Semester{draft.name ? ` · ${draft.name}` : ""}</p>
        {at >= 0 && (
          <ol className="setup-steps" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i < at ? "is-done" : i === at ? "is-current" : ""}>
                {i < at && i < 4 && draft.status === "setting_up" ? (
                  <button type="button" className="link-btn" onClick={() => go(s.key, s.key === "course" ? 0 : undefined)}>
                    {s.label}
                  </button>
                ) : (
                  <span>{s.label}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </header>
      <div className="setup-grid">
        <section className="setup-step">
          {draft.setupStep === "welcome" && <Welcome {...props} returning={returning} />}
          {draft.setupStep === "about" && <About {...props} />}
          {draft.setupStep === "courses" && <Courses {...props} />}
          {draft.setupStep === "course" && <CourseStep {...props} />}
          {draft.setupStep === "time" && <Time {...props} />}
          {draft.setupStep === "check" && <Check {...props} />}
          {draft.setupStep === "running" && <Running {...props} />}
          {draft.setupStep === "done" && <Done {...props} />}
        </section>
        {draft.setupStep !== "welcome" && <Sheet draft={draft} profile={profile} go={go} editable={draft.status === "setting_up"} />}
      </div>
      <SelectionReply scope={scroller} disabled={false} onAsk={notes.ask} />
    </div>
  );
}

type StepProps = {
  env: Loaded;
  draft: SemesterDraft;
  profile: Profile;
  update: (fn: (d: SemesterDraft) => SemesterDraft) => void;
  updateProfile: (p: Partial<Profile>) => void;
  go: (s: SetupStep, courseIndex?: number) => void;
  today: string;
  flush: () => Promise<void>;
  md: (blockId: string, text: string) => JSX.Element;
  onDone: () => void;
  setEnv: (e: Loaded) => void;
};

function Actions({ children, skip }: { children?: React.ReactNode; skip?: () => void }) {
  return (
    <div className="setup-actions">
      {skip && (
        <button type="button" className="link-btn" onClick={skip}>
          Skip, add later
        </button>
      )}
      {children}
    </div>
  );
}

// ---------- 1. welcome ----------

function Welcome({ env, draft, go, returning, today }: StepProps & { returning: boolean }) {
  const [exported, setExported] = useState<string | null>(null);
  const exportLast = async () => {
    const data = JSON.stringify({ semester: env.current, mastery: env.mastery, exportedAt: new Date().toISOString() }, null, 2);
    const r = await offerDownload(`studydesk-${(env.current?.name ?? "semester").replace(/[^\w-]+/g, "-")}.json`, data);
    setExported(r === "saved" ? "Saved." : "Not saved.");
  };
  return (
    <div className="setup-card">
      {returning ? (
        <>
          <h1>Start a new semester</h1>
          <p>
            StudyDesk will set up your new courses. <strong>{env.current?.name}</strong> is archived when the new semester starts, and every skill you mastered is kept,
            so you won't be asked about it again.
          </p>
          <p className="quest-muted">You can save a copy of last semester's data first.</p>
          <Actions>
            <button type="button" className="mini-btn" onClick={exportLast}>
              Export last semester
            </button>
            {exported && <span className="quest-muted">{exported}</span>}
            <button type="button" className="mini-btn primary big" onClick={() => go(draft.courses.length ? "courses" : "about")}>
              Start
            </button>
          </Actions>
        </>
      ) : (
        <>
          <h1>Let's set up your semester</h1>
          <p>StudyDesk needs a short setup before it can build your daily quests. It takes about ten minutes, and it's saved as you go, so you can stop and come back.</p>
          <p>You'll tell it three things:</p>
          <ul className="setup-list">
            <li>who you are (asked once),</li>
            <li>your courses, with the grade you're aiming for in each,</li>
            <li>how much time you want to study.</li>
          </ul>
          <p className="quest-muted">Course materials (syllabus, homework sheets, past exams, slides) make everything better, but they're optional. Anything can be added later.</p>
          <Actions>
            <button type="button" className="mini-btn primary big" onClick={() => go("about")}>
              Start setup
            </button>
          </Actions>
          <p className="quest-muted setup-today">Today is {new Date(`${today}T12:00`).toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long" })}.</p>
        </>
      )}
    </div>
  );
}

// ---------- 2. about you ----------

function About({ profile, updateProfile, draft, update, go, today, flush }: StepProps) {
  const scaleKey = SCALES.find((s) => s.scale.name === profile.gradeScale.name)?.key ?? "";
  const setLevelOrCountry = (patch: Partial<Profile>) => {
    const next = { ...profile, ...patch };
    updateProfile({ ...patch, gradeScale: scaleFor(next.country, next.level) });
    if (patch.level && !draft.courses.length) update((d) => ({ ...d, ...defaultSemester(today, next.level) }));
  };
  return (
    <div className="setup-card">
      <h1>About you</h1>
      <p className="quest-muted">Asked once and kept for every semester. Your program and year tell StudyDesk which basics matter.</p>
      <div className="setup-form">
        <fieldset className="setup-seg">
          <legend>I'm at</legend>
          {(["school", "university"] as const).map((l) => (
            <label key={l} className={profile.level === l ? "is-on" : ""}>
              <input type="radio" name="level" checked={profile.level === l} onChange={() => setLevelOrCountry({ level: l })} />
              {l === "school" ? "School" : "University"}
            </label>
          ))}
        </fieldset>
        <label>
          {profile.level === "school" ? "School" : "University"}
          <input value={profile.school} onChange={(e) => updateProfile({ school: e.target.value })} placeholder={profile.level === "school" ? "e.g. BRG Linz" : "e.g. TU Wien"} />
        </label>
        <label>
          Country
          <input value={profile.country} onChange={(e) => setLevelOrCountry({ country: e.target.value })} placeholder="e.g. Austria" list="countries" />
          <datalist id="countries">
            {["Austria", "Germany", "Switzerland", "Netherlands", "United States"].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label>
          Grade scale
          <select
            value={scaleKey}
            onChange={(e) => {
              const s = SCALES.find((x) => x.key === e.target.value);
              if (s) updateProfile({ gradeScale: s.scale });
            }}
          >
            {!scaleKey && <option value="">{profile.gradeScale.name}</option>}
            {SCALES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {profile.level === "school" ? "School type" : "Program"}
          <input value={profile.program} onChange={(e) => updateProfile({ program: e.target.value })} placeholder={profile.level === "school" ? "e.g. Gymnasium, science branch" : "e.g. BSc Physics"} />
        </label>
        <label>
          Year
          <input value={profile.year} onChange={(e) => updateProfile({ year: e.target.value })} placeholder={profile.level === "school" ? "e.g. 7th grade" : "e.g. 1st year"} />
        </label>
      </div>
      <h2 className="setup-h2">This semester</h2>
      <div className="setup-form">
        <label>
          Name
          <input value={draft.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} />
        </label>
        <label>
          Starts
          <input type="date" value={draft.startDate} onChange={(e) => update((d) => ({ ...d, startDate: e.target.value }))} />
        </label>
        <label>
          Ends
          <input type="date" value={draft.endDate} onChange={(e) => update((d) => ({ ...d, endDate: e.target.value }))} />
        </label>
      </div>
      <Actions skip={() => go("courses")}>
        <button
          type="button"
          className="mini-btn primary big"
          onClick={() => {
            void flush();
            go("courses");
          }}
        >
          Continue
        </button>
      </Actions>
    </div>
  );
}

// ---------- 3. courses ----------

function Courses({ env, draft, update, go }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);

  const onSend = async (text: string, files: PendingAttachment[]) => {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const images = (await canSendImages()) ? files.filter((f) => f.kind === "image" && f.blob).map((f) => f.blob!) : [];
      const texts = files.filter((f) => f.text).map((f) => `${f.name}:\n${f.text}`);
      const res = await extract("courses", text, texts, images, env.live ? askClaude : null);
      let added = 0;
      let slots = 0;
      update((d) => {
        const courses = [...d.courses];
        for (const c of res.courses) {
          if (courses.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) continue;
          courses.push({ id: `c${uid().slice(0, 6)}`, name: c.name, short: c.short, credits: c.credits, teachingLanguage: "", targetGrade: null, setupStatus: "waiting" });
          added++;
        }
        const timetable = [...d.timetable];
        for (const t of res.timetable) {
          const name = (t.courseName ?? "").toLowerCase();
          const course = courses.find((c) => c.name.toLowerCase() === name) ?? courses.find((c) => name && (name.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(name)));
          const entry: TimetableEntry = { weekday: t.weekday, start: t.start, end: t.end, kind: t.kind, title: course ? `${course.name} ${t.kind}` : t.title, courseId: course?.id ?? null };
          if (timetable.some((x) => x.weekday === entry.weekday && x.start === entry.start && x.end === entry.end)) continue;
          timetable.push(entry);
          slots++;
        }
        return { ...d, courses, timetable };
      });
      setFound(added || slots ? `Added ${added} ${added === 1 ? "course" : "courses"} and ${slots} weekly ${slots === 1 ? "slot" : "slots"}. Check them below.` : "No new courses found in that. Try typing them, one per line.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = (id: string, p: Partial<DraftCourse>) => update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  return (
    <div className="setup-card">
      <h1>Your courses</h1>
      <p>Drop your timetable, a screenshot of your course list, or just type them.</p>
      <InputBox id="setup-courses" placeholder="e.g. a screenshot of your timetable, or “Analysis 1, Linear Algebra, Physics lab”" busy={busy} onSend={onSend} sendLabel="Add" />
      {busy && <p className="quest-muted">Reading…</p>}
      {found && <p className="setup-ok">{found}</p>}
      {error && <p className="quest-error">{error}</p>}

      {draft.courses.length > 0 && (
        <>
          <h2 className="setup-h2">Courses StudyDesk will track</h2>
          <p className="quest-muted">Fix names, remove what you don't want tracked, and add what's missing.</p>
          <div className="setup-rows">
            {draft.courses.map((c) => (
              <div key={c.id} className="setup-row">
                <input aria-label="Course name" value={c.name} onChange={(e) => patch(c.id, { name: e.target.value })} />
                <input aria-label="Short name" className="is-short" value={c.short} onChange={(e) => patch(c.id, { short: e.target.value.slice(0, 8) })} />
                <input
                  aria-label="Credits"
                  className="is-num"
                  inputMode="decimal"
                  placeholder="credits"
                  value={c.credits ?? ""}
                  onChange={(e) => patch(c.id, { credits: e.target.value ? Number(e.target.value.replace(",", ".")) || null : null })}
                />
                <button
                  type="button"
                  className="chat-del"
                  aria-label={`Remove ${c.name}`}
                  onClick={() => update((d) => ({ ...d, courses: d.courses.filter((x) => x.id !== c.id), timetable: d.timetable.filter((t) => t.courseId !== c.id) }))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        className="link-btn"
        onClick={() => update((d) => ({ ...d, courses: [...d.courses, { id: `c${uid().slice(0, 6)}`, name: "", short: "", credits: null, teachingLanguage: "", targetGrade: null, setupStatus: "waiting" }] }))}
      >
        + Add a course by hand
      </button>

      <Slots draft={draft} update={update} kinds={["lecture", "exercise"]} title="Lectures and exercise classes" />

      <Actions>
        <button type="button" className="mini-btn" onClick={() => go("about")}>
          Back
        </button>
        <button type="button" className="mini-btn primary big" disabled={!draft.courses.some((c) => c.name.trim())} onClick={() => {
          update((d) => ({ ...d, courses: d.courses.filter((c) => c.name.trim()).map((c) => ({ ...c, short: c.short || c.name.slice(0, 8) })) }));
          go("course", 0);
        }}>
          Continue
        </button>
      </Actions>
    </div>
  );
}

function Slots({ draft, update, kinds, title }: { draft: SemesterDraft; update: StepProps["update"]; kinds: TimetableEntry["kind"][]; title: string }) {
  const list = draft.timetable.map((t, i) => ({ t, i })).filter(({ t }) => kinds.includes(t.kind)).sort((a, b) => WEEK.indexOf(a.t.weekday) - WEEK.indexOf(b.t.weekday) || (a.t.start < b.t.start ? -1 : 1));
  if (!list.length) return null;
  return (
    <>
      <h2 className="setup-h2">{title}</h2>
      <ul className="setup-slots">
        {list.map(({ t, i }) => (
          <li key={i}>
            <span className="setup-slot-time">
              {DAY_SHORT[t.weekday]} {t.start}–{t.end}
            </span>
            <span>{t.title}</span>
            <button type="button" className="chat-del" aria-label="Remove" onClick={() => update((d) => ({ ...d, timetable: d.timetable.filter((_, k) => k !== i) }))}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------- 4. each course ----------

function CourseStep({ env, draft, profile, update, go }: StepProps) {
  const i = Math.min(draft.courseIndex, draft.courses.length - 1);
  const course = draft.courses[i];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!course) {
    return (
      <div className="setup-card">
        <p>No courses yet.</p>
        <button type="button" className="mini-btn" onClick={() => go("courses")}>
          Add courses
        </button>
      </div>
    );
  }
  const steps = gradeSteps(profile.gradeScale);
  const facts = draft.facts.filter((f) => f.courseId === course.id);
  const uploads = draft.uploads.filter((u) => u.courseId === course.id);
  const next = () => (i + 1 < draft.courses.length ? go("course", i + 1) : go("time"));

  const onSend = async (text: string, files: PendingAttachment[]) => {
    setError(null);
    const now = Date.now();
    if (text) update((d) => ({ ...d, facts: [...d.facts, { id: uid(), courseId: course.id, text, addedAt: now }] }));
    const added: Upload[] = [];
    const failed: string[] = [];
    for (const [k, f] of files.entries()) {
      setBusy(`Keeping ${f.name} (${k + 1} of ${files.length})…`);
      try {
        const id = `up_${uid()}`;
        let pages: number | null = null;
        if (f.kind === "image" && f.blob) {
          const image = await compressImage(f.blob);
          if (!image) throw new Error("couldn't be read");
          await env.os.saveUploadContent(id, { image });
        } else if (f.file) {
          const full = await readFullText(f.file, MAX_FILE_CHARS);
          pages = full.pages;
          await env.os.saveUploadContent(id, { text: full.text });
        } else {
          await env.os.saveUploadContent(id, { text: f.text ?? "" });
        }
        const assetId = f.file ? await env.os.storeOriginal(f.file) : null;
        added.push({ id, courseId: course.id, fileName: f.name, type: f.kind, studentNote: text, addedAt: now, cataloguedAt: null, assetId, pages });
      } catch (e) {
        failed.push(`${f.name}: ${message(e)}`);
      }
    }
    setBusy(null);
    if (added.length) update((d) => ({ ...d, uploads: [...d.uploads, ...added], courses: d.courses.map((c) => (c.id === course.id ? { ...c, setupStatus: "waiting" } : c)) }));
    if (failed.length) setError(`Not kept: ${failed.join("; ")}`);
  };

  return (
    <div className="setup-card" key={course.id}>
      <p className="quest-kicker">
        Course {i + 1} of {draft.courses.length}
      </p>
      <h1>{course.name}</h1>

      <h2 className="setup-h2">What grade are you aiming for?</h2>
      {steps ? (
        <div className="setup-grades" role="radiogroup" aria-label="Target grade">
          {steps.map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={course.targetGrade === g}
              className={course.targetGrade === g ? "is-on" : ""}
              onClick={() => update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === course.id ? { ...c, targetGrade: g } : c)) }))}
            >
              {g}
            </button>
          ))}
        </div>
      ) : (
        <input
          className="setup-num"
          inputMode="decimal"
          value={course.targetGrade ?? ""}
          onChange={(e) => update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === course.id ? { ...c, targetGrade: e.target.value ? Number(e.target.value) : null } : c)) }))}
        />
      )}
      <p className="quest-muted">
        {profile.gradeScale.name}: {profile.gradeScale.best} is best. This is the one thing every course needs.
      </p>

      <h2 className="setup-h2">Anything you know about it (optional)</h2>
      <p>How is it graded? Known exam and hand-in dates? Drop materials too, as many as you like. Most useful first:</p>
      <ol className="setup-list">
        <li>the syllabus or course overview,</li>
        <li>homework sheets,</li>
        <li>past exams,</li>
        <li>slides or the lecture script.</li>
      </ol>
      <InputBox
        id={`setup-course-${course.id}`}
        placeholder="e.g. “Exam on 28 Jan, homework counts 40%”, or drop files and say what they are"
        busy={!!busy}
        onSend={onSend}
        sendLabel="Add"
      />
      {busy && <p className="quest-muted">{busy}</p>}
      {error && <p className="quest-error">{error}</p>}

      {(facts.length > 0 || uploads.length > 0) && (
        <ul className="setup-items">
          {facts.map((f) => (
            <li key={f.id}>
              <span className="setup-item-kind">You said</span>
              <span>“{f.text}”</span>
              <button type="button" className="chat-del" aria-label="Remove" onClick={() => update((d) => ({ ...d, facts: d.facts.filter((x) => x.id !== f.id) }))}>
                ×
              </button>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.id}>
              <span className="setup-item-kind">{u.type === "pdf" ? "PDF" : u.type === "image" ? "Image" : "File"}</span>
              <span>
                {u.fileName}
                {u.pages ? ` · ${u.pages} pages` : ""}
                {u.studentNote ? <span className="quest-muted"> · “{u.studentNote}”</span> : null}
              </span>
              <button type="button" className="chat-del" aria-label={`Remove ${u.fileName}`} onClick={() => update((d) => ({ ...d, uploads: d.uploads.filter((x) => x.id !== u.id) }))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <Actions skip={next}>
        <button type="button" className="mini-btn" onClick={() => (i > 0 ? go("course", i - 1) : go("courses"))}>
          Back
        </button>
        <button type="button" className="mini-btn primary big" disabled={!!busy} onClick={next}>
          {i + 1 < draft.courses.length ? "Next course" : "Continue"}
        </button>
      </Actions>
    </div>
  );
}

// ---------- 5. your time ----------

function Time({ env, draft, update, go }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSend = async (text: string, files: PendingAttachment[]) => {
    setBusy(true);
    setError(null);
    try {
      const images = (await canSendImages()) ? files.filter((f) => f.kind === "image" && f.blob).map((f) => f.blob!) : [];
      const res = await extract("commitments", text, files.filter((f) => f.text).map((f) => f.text!), images, env.live ? askClaude : null);
      update((d) => ({ ...d, timetable: [...d.timetable, ...res.timetable.map((t): TimetableEntry => ({ weekday: t.weekday, start: t.start, end: t.end, kind: "fixed", title: t.title, courseId: null }))] }));
      if (!res.timetable.length) setError("No weekly times found in that. Try “Tue 18:00-20:00 football”.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-card">
      <h1>Your time</h1>
      <p>How much do you want to study each day, lectures included? This is a starting point: after your placement check, StudyDesk recommends a real amount for your target grades.</p>
      <table className="setup-week">
        <thead>
          <tr>
            <th>Day</th>
            <th>Study goal</th>
            <th>Lectures and fixed</th>
            <th>Left for quests</th>
          </tr>
        </thead>
        <tbody>
          {WEEK.map((wd) => {
            const busyMin = busyMinutes(draft.timetable, wd);
            const goal = draft.studyGoal[wd] ?? 0;
            return (
              <tr key={wd}>
                <th scope="row">{DAY_NAME[wd]}</th>
                <td>
                  <input
                    className="setup-num"
                    type="number"
                    min={0}
                    max={16}
                    step={0.5}
                    aria-label={`Study goal on ${DAY_NAME[wd]}, hours`}
                    value={goal / 60}
                    onChange={(e) => update((d) => ({ ...d, studyGoal: d.studyGoal.map((m, k) => (k === wd ? Math.max(0, Math.round(Number(e.target.value) * 60)) : m)) }))}
                  />{" "}
                  h
                </td>
                <td className="quest-muted">{busyMin ? hours(busyMin) : "–"}</td>
                <td>{goal ? hours(Math.max(0, goal - busyMin)) : "day off"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2 className="setup-h2">Other fixed commitments (optional)</h2>
      <p className="quest-muted">A job, sport, a long commute: drop a screenshot or type them, and they're taken off your free time.</p>
      <InputBox id="setup-commitments" placeholder="e.g. “Tue and Thu 18:00-20:00 football”" busy={busy} onSend={onSend} sendLabel="Add" />
      {busy && <p className="quest-muted">Reading…</p>}
      {error && <p className="quest-error">{error}</p>}
      <Slots draft={draft} update={update} kinds={["fixed"]} title="Fixed commitments" />
      <Actions skip={() => go("check")}>
        <button type="button" className="mini-btn" onClick={() => go("course", Math.max(0, draft.courses.length - 1))}>
          Back
        </button>
        <button type="button" className="mini-btn primary big" onClick={() => go("check")}>
          Continue
        </button>
      </Actions>
    </div>
  );
}

// ---------- 6. check and start ----------

function Check({ draft, profile, go, update }: StepProps) {
  const withTarget = draft.courses.filter((c) => c.targetGrade !== null);
  const hasGoal = draft.studyGoal.some((m) => m > 0);
  const ready = withTarget.length > 0 && hasGoal;
  return (
    <div className="setup-card">
      <h1>Check and start</h1>
      <p>Here's everything in one view. When you start, StudyDesk reads your files carefully, once, and maps which pages cover which topics, so later it only opens the pages it needs.</p>
      <ul className="setup-check">
        {draft.courses.map((c, i) => {
          const files = draft.uploads.filter((u) => u.courseId === c.id).length;
          const facts = draft.facts.filter((f) => f.courseId === c.id).length;
          return (
            <li key={c.id}>
              <button type="button" className="link-btn setup-check-name" onClick={() => go("course", i)}>
                {c.name}
              </button>
              <span className={c.targetGrade === null ? "setup-warn" : ""}>{c.targetGrade === null ? "needs a target grade" : `target ${c.targetGrade}`}</span>
              <span className="quest-muted">
                {files ? `${files} ${files === 1 ? "file" : "files"}` : "no files"}
                {facts ? ` · ${facts} ${facts === 1 ? "note" : "notes"}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {draft.courses.some((c) => c.targetGrade === null) && withTarget.length > 0 && (
        <p className="quest-muted">Courses without a target grade are set up too, aiming for the best grade, until you give them one.</p>
      )}
      {!hasGoal && (
        <p className="setup-warn">
          Set a study goal for at least one day.{" "}
          <button type="button" className="link-btn" onClick={() => go("time")}>
            Your time
          </button>
        </p>
      )}
      {!profile.school && !profile.program && <p className="quest-muted">You skipped "About you". That's fine, but StudyDesk will guess the basics your courses need.</p>}
      <Actions>
        <button type="button" className="mini-btn" onClick={() => go("time")}>
          Back
        </button>
        <button
          type="button"
          className="mini-btn primary big"
          disabled={!ready}
          onClick={() => {
            update((d) => ({ ...d, courses: d.courses.map((c) => (c.setupStatus === "ready" || c.setupStatus === "needs_check" ? c : { ...c, setupStatus: "waiting" })) }));
            go("running");
          }}
        >
          Start setup
        </button>
      </Actions>
      {!ready && <p className="quest-muted">Setup can start once one course has a target grade and you have a study goal.</p>}
    </div>
  );
}

// ---------- 6b. the setup run ----------

function Running({ env, draft, profile, update, go, today, flush }: StepProps) {
  const running = useRef(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const setCourse = useCallback(
    (id: string, p: Partial<DraftCourse>) => update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === id ? { ...c, ...p } : c)) })),
    [update],
  );

  const prior = useMemo(() => {
    const { states } = replay(env.mastery.skills, env.mastery.attempts, env.mastery.reviews);
    return env.mastery.skills.filter((s): s is Skill => s.isFundamental && ["mastered", "retained"].includes(states.get(s.id)?.stage ?? ""));
  }, [env.mastery]);

  const runAll = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const images = await canSendImages();
    try {
      for (;;) {
        const d = draftRef.current;
        const c = d.courses.find((x) => x.setupStatus === "waiting" || x.setupStatus === "reading");
        if (!c) break;
        setCourse(c.id, { setupStatus: "reading", setupError: undefined });
        await flush();
        try {
          const files: FileForSetup[] = [];
          for (const u of d.uploads.filter((x) => x.courseId === c.id)) {
            const content = await env.os.loadUploadContent(u.id);
            if (!content) continue;
            if (content.image && !images) continue;
            files.push({ upload: u, text: content.text ?? null, image: content.image ? dataUrlToBlob(content.image) : null });
          }
          const input = { profile, draft: d, course: c, facts: d.facts.filter((f) => f.courseId === c.id), files, today, priorFundamentals: prior };
          const res = env.live ? await runCourseSetup(input, askClaude) : { ...localSetup(input), clipped: [] as string[] };
          const { clipped, ...result } = res;
          if (clipped.length) result.questions.push(`Only the first part of ${clipped.join(", ")} fit into one reading. Tell StudyDesk which chapters matter most.`);
          const check = result.conflicts.length > 0 || result.questions.length > 0 || result.truncated || result.basis === "general";
          const now = Date.now();
          update((x) => ({
            ...x,
            results: { ...x.results, [c.id]: result },
            uploads: x.uploads.map((u) => (u.courseId === c.id && files.some((f) => f.upload.id === u.id) ? { ...u, cataloguedAt: now } : u)),
            courses: x.courses.map((k) => (k.id === c.id ? { ...k, setupStatus: check ? "needs_check" : "ready", teachingLanguage: result.teachingLanguage } : k)),
          }));
        } catch (e) {
          setCourse(c.id, { setupStatus: "failed", setupError: message(e) });
          if ((e as AskError)?.code === "rate_limited" || (e as AskError)?.code === "not_granted") break;
        }
        await flush();
      }
    } finally {
      running.current = false;
    }
  }, [env, profile, today, prior, update, setCourse, flush]);

  useEffect(() => {
    void runAll();
  }, [runAll]);

  const pending = draft.courses.some((c) => c.setupStatus === "waiting" || c.setupStatus === "reading");
  const failed = draft.courses.filter((c) => c.setupStatus === "failed");
  const doneCount = draft.courses.filter((c) => draft.results[c.id] && c.setupStatus !== "failed").length;

  const finish = useCallback(async () => {
    setFinishError(null);
    try {
      const d = draftRef.current;
      const semester = buildSemester(d, profile);
      if (env.current && env.current.source === "onboarding" && env.current.id !== semester.id) await env.os.archiveSemester(env.current);
      await env.qs.saveSemester(semester);
      const known = new Set(env.mastery.skills.map((s) => s.id));
      await env.ms.putSkills(semester.skills.filter((s) => !known.has(s.id)));
      for (const t of semester.targets) await env.ms.putTarget(t);
      update((x) => ({ ...x, status: "active", setupStep: "done" }));
      await flush();
    } catch (e) {
      setFinishError(`The semester couldn't be saved: ${message(e)}`);
    }
  }, [env, profile, update, flush]);

  const finishing = useRef(false);
  useEffect(() => {
    if (!pending && !failed.length && doneCount > 0 && !finishing.current) {
      finishing.current = true;
      void finish().finally(() => (finishing.current = false));
    }
  }, [pending, failed.length, doneCount, finish]);

  return (
    <div className="setup-card">
      <h1>Setting up your semester</h1>
      <p>StudyDesk is reading your materials, one course at a time. Keep this page open; if you close it, it carries on with the next course when you come back.</p>
      <ul className="setup-progress">
        {draft.courses.map((c) => {
          const r = draft.results[c.id];
          const files = draft.uploads.filter((u) => u.courseId === c.id).length;
          return (
            <li key={c.id} className={`is-${c.setupStatus}`}>
              <span className="setup-progress-mark" aria-hidden="true" />
              <span className="setup-progress-name">{c.name}</span>
              <span className="setup-progress-status">
                {c.setupStatus === "waiting" && "waiting"}
                {c.setupStatus === "reading" && (files ? `reading ${files} ${files === 1 ? "file" : "files"}…` : "working out what the course covers…")}
                {(c.setupStatus === "ready" || c.setupStatus === "needs_check") && r && `${r.basis === "materials" ? "read your files, " : ""}found ${r.topics.length} topics and ${r.skills.length} skills`}
                {c.setupStatus === "failed" && (
                  <>
                    <span className="quest-error">{c.setupError}</span>{" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setCourse(c.id, { setupStatus: "waiting", setupError: undefined });
                        setTimeout(() => void runAll(), 0);
                      }}
                    >
                      Try again
                    </button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {!pending && failed.length > 0 && (
        <Actions>
          <button type="button" className="mini-btn" onClick={() => go("check")}>
            Back
          </button>
          {doneCount > 0 && (
            <button type="button" className="mini-btn primary" onClick={() => void finish()}>
              Continue without {failed.map((c) => c.name).join(", ")}
            </button>
          )}
        </Actions>
      )}
      {finishError && <p className="quest-error">{finishError}</p>}
    </div>
  );
}

// ---------- 7. done: dates to check, then the placement check ----------

function Done({ env, draft, md, onDone, setEnv, today }: StepProps) {
  const [semester, setSemester] = useState<Semester | null>(null);
  const [building, setBuilding] = useState<Record<string, WriteStatus> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    env.qs.loadSemester().then(setSemester).catch((e) => setError(message(e)));
  }, [env]);

  const start = async () => {
    if (!semester) return;
    if (semester.placementQuestId) return onDone();
    setError(null);
    try {
      const mastery = await env.ms.load();
      const { quest, partCourse } = planPlacement(semester, mastery.attempts, mastery.reviews, today);
      if (!quest.parts.length) {
        const s = { ...semester, placementQuestId: "none" };
        await env.qs.saveSemester(s);
        return onDone();
      }
      setBuilding({});
      const writer = placementWriter(semester, quest, partCourse, askClaude, env.live ? null : sampleWriter(semester.skills));
      const written = await writeQuest(quest, writer, (s) => setBuilding((b) => ({ ...(b ?? {}), [s.partId]: s })));
      await env.qs.saveRecord({ quest: written, progress: emptyProgress(written.id) });
      const s = { ...semester, placementQuestId: written.id };
      await env.qs.saveSemester(s);
      setEnv({ ...env, current: s });
      onDone();
    } catch (e) {
      setBuilding(null);
      setError(`The placement check couldn't be written: ${message(e)}`);
    }
  };

  const dates = useMemo(() => {
    if (!semester) return [];
    const name = (id: string) => semester.courses.find((c) => c.id === id)?.short || "";
    return [
      ...semester.keyDates.map((k) => ({ when: new Date(`${k.date}T12:00`).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" }), label: `${name(k.courseId)}: ${k.title}`, sort: k.date })),
      ...semester.assignments.map((a) => ({ when: formatDue(a.dueAt, today), label: `${name(a.courseId)}: ${a.title} due`, sort: a.dueAt })),
    ].sort((a, b) => (a.sort < b.sort ? -1 : 1));
  }, [semester, today]);

  const conflicts = draft.courses.flatMap((c) => (draft.results[c.id]?.conflicts ?? []).map((t) => ({ c, t })));
  const questions = draft.courses.flatMap((c) => (draft.results[c.id]?.questions ?? []).map((t) => ({ c, t })));

  return (
    <div className="setup-card">
      <h1>Your semester is set up</h1>
      {semester && (
        <p>
          {semester.courses.length} {semester.courses.length === 1 ? "course" : "courses"}, {semester.skills.length} skills to learn and track.
        </p>
      )}

      {dates.length > 0 && (
        <>
          <h2 className="setup-h2">Important dates: please double-check them</h2>
          <ul className="setup-dates">
            {dates.map((d, i) => (
              <li key={i}>
                <span className="setup-slot-time">{d.when}</span>
                <span>{d.label}</span>
              </li>
            ))}
          </ul>
          <p className="quest-muted">If anything turns out different later, just tell me and I'll fix it.</p>
        </>
      )}

      {conflicts.length > 0 && (
        <>
          <h2 className="setup-h2">Where your files disagree with what you said</h2>
          <p className="quest-muted">Your word was used.</p>
          <ul className="setup-list">
            {conflicts.map(({ c, t }, i) => (
              <li key={i}>
                <strong>{c.short || c.name}:</strong> {t}
              </li>
            ))}
          </ul>
        </>
      )}

      {questions.length > 0 && (
        <>
          <h2 className="setup-h2">Still open</h2>
          <ul className="setup-list">
            {questions.map(({ c, t }, i) => (
              <li key={i}>
                <strong>{c.short || c.name}:</strong> {t}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="setup-h2">What StudyDesk found</h2>
      {draft.courses
        .filter((c) => draft.results[c.id])
        .map((c) => {
          const r = draft.results[c.id];
          return (
            <div key={c.id} className="setup-report">
              <h3>
                {c.name} <span className="quest-muted">· {r.topics.length} topics, {r.skills.length} skills, taught in {r.teachingLanguage}</span>
              </h3>
              {r.summary && md(`sum-${c.id}`, r.summary)}
              <p className="quest-muted">{r.basis === "materials" ? `Mapped to your files: ${r.catalog.length} references to pages or lines.` : "No files yet, so this is what such a course usually covers."}</p>
            </div>
          );
        })}

      <h2 className="setup-h2">Next: a placement check</h2>
      <p>One short problem on each basic your courses build on and on each topic already taught, so StudyDesk knows how far you actually are. From the results it recommends how much to do each day for your target grades.</p>
      {building && (
        <p className="quest-muted">
          Writing your placement check… {Object.values(building).filter((s) => s.state === "done").length} of {Math.max(1, Object.keys(building).length)} courses ready
        </p>
      )}
      {error && <p className="quest-error">{error}</p>}
      <Actions>
        <button type="button" className="mini-btn primary big" disabled={!semester || !!building} onClick={() => void start()}>
          {semester?.placementQuestId ? "Open your quests" : "Start my placement check"}
        </button>
      </Actions>
    </div>
  );
}

// ---------- the semester sheet ----------

function Sheet({ draft, profile, go, editable }: { draft: SemesterDraft; profile: Profile; go: StepProps["go"]; editable: boolean }) {
  const lectures = draft.timetable.filter((t) => t.kind !== "fixed").length;
  const fixed = draft.timetable.length - lectures;
  const edit = (s: SetupStep, i?: number) =>
    editable ? (
      <button type="button" className="link-btn" onClick={() => go(s, i)}>
        edit
      </button>
    ) : null;
  return (
    <aside className="setup-sheet" aria-label="Semester sheet">
      <h2>Semester sheet</h2>
      <dl>
        <dt>Semester {edit("about")}</dt>
        <dd>
          {draft.name || "–"}
          <span className="quest-muted"> · {draft.startDate} to {draft.endDate}</span>
        </dd>
        <dt>You {edit("about")}</dt>
        <dd>{[profile.level === "school" ? "School" : "University", profile.school, profile.program, profile.year].filter(Boolean).join(", ")}</dd>
        <dd className="quest-muted">Grades: {profile.gradeScale.name}</dd>
        <dt>Courses {edit("courses")}</dt>
        {draft.courses.length === 0 && <dd className="quest-muted">none yet</dd>}
        {draft.courses.map((c, i) => {
          const files = draft.uploads.filter((u) => u.courseId === c.id).length;
          return (
            <dd key={c.id} className="setup-sheet-course">
              {editable ? (
                <button type="button" className="link-btn" onClick={() => go("course", i)}>
                  {c.name || "(no name)"}
                </button>
              ) : (
                c.name
              )}
              <span className={c.targetGrade === null ? "setup-warn" : "quest-muted"}>{c.targetGrade === null ? " · no target yet" : ` · target ${c.targetGrade}`}</span>
              {files > 0 && <span className="quest-muted"> · {files} {files === 1 ? "file" : "files"}</span>}
              {c.setupStatus !== "waiting" && <span className={`setup-tag is-${c.setupStatus}`}>{c.setupStatus === "needs_check" ? "check" : c.setupStatus}</span>}
            </dd>
          );
        })}
        <dt>Week {edit("time")}</dt>
        <dd>
          {draft.studyGoal.some((m) => m > 0)
            ? WEEK.filter((wd) => draft.studyGoal[wd] > 0)
                .map((wd) => `${DAY_SHORT[wd]} ${hours(draft.studyGoal[wd])}`)
                .join(", ")
            : "no study goal yet"}
        </dd>
        <dd className="quest-muted">
          {lectures} lecture {lectures === 1 ? "slot" : "slots"}
          {fixed ? `, ${fixed} fixed ${fixed === 1 ? "commitment" : "commitments"}` : ""}
        </dd>
      </dl>
    </aside>
  );
}
