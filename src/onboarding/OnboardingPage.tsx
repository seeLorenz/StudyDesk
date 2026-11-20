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
import { readCalendar, weeklyPattern, type CalendarError } from "../platform/calendar";
import { askClaude, canSendImages, canUseTools, claudeAvailable, errorCopy, type AskError } from "../platform/claude";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { offerDownload, openOnboardingStore, type OnboardingStore } from "../platform/onboardingStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { emptyProgress } from "../quests/handin";
import { compressImage, dataUrlToBlob } from "../quests/images";
import { busyMinutes, formatDue } from "../quests/plan";
import { sampleWriter } from "../quests/seed";
import type { Semester } from "../quests/types";
import { writeQuest, type WriteStatus } from "../quests/write";
import { SHEET_TOOL_DESCRIPTION, SHEET_TOOL_SCHEMA, applySheetUpdate, chatTurns, greeting, localReply, setupReady, sheetSnapshot } from "./agent";
import { placementWriter, planPlacement } from "./placement";
import { gradeSteps } from "./scales";
import { buildSemester, localSetup, runCourseSetup, type FileForSetup } from "./setup";
import type { DraftCourse, Profile, SemesterDraft, SetupMessage, SetupStep, Upload } from "./types";

// Start New Semester: one chat with the Orchestrator, with the semester sheet
// beside it. design/onboarding.md. The student talks, pastes and drops files;
// Claude asks, reads, and fills the sheet through page tools; the student can
// also edit the sheet by hand. Everything saves as it goes. When the student
// confirms, the setup run reads the course files, and the first quest is a
// placement check.

/** Keep at most this much readable text per file (one database document holds 256 KiB). */
const MAX_FILE_CHARS = 240_000;
/** How much of a dropped file Claude sees in the chat, to tell what it is. */
const PREVIEW_CHARS = 3_000;
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const hours = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

function message(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) return errorCopy(e as AskError);
  return e instanceof Error ? e.message : "Something went wrong.";
}

function newDraft(): SemesterDraft {
  return {
    id: `sem_${uid()}`,
    name: "",
    startDate: "",
    endDate: "",
    status: "setting_up",
    setupStep: "chat",
    courseIndex: 0,
    courses: [],
    timetable: [],
    studyGoal: [0, 0, 0, 0, 0, 0, 0],
    uploads: [],
    facts: [],
    results: {},
    chat: [],
    notes: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const emptyProfile = (): Profile => ({ level: "university", school: "", country: "", gradeScale: { name: "", best: 1, worst: 5 }, program: "", year: "", updatedAt: 0 });

type Loaded = {
  os: OnboardingStore;
  qs: QuestStore;
  ms: MasteryStore;
  mastery: MasteryData;
  live: boolean;
  current: Semester | null;
};

const NOTE_RULES = `You are StudyDesk, a study assistant for high school and university students.
The student is setting up their semester and highlighted a passage to ask about.
Your answer appears in a small side note right under that passage. So:
- Answer only the question about the highlighted passage, using the context.
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
      let usable = d && (d.status === "setting_up" || (current && current.id === d.id)) ? d : null;
      // Drafts from the first (form) version continue as a chat.
      if (usable && !["chat", "running", "done"].includes(usable.setupStep)) usable = { ...usable, setupStep: "chat" };
      if (p) setProfile(p);
      const draft = usable ?? newDraft();
      const returning = current?.source === "onboarding" && current.id !== draft.id;
      if (!draft.chat?.length) draft.chat = [{ id: uid(), role: "assistant", text: greeting(returning || !!p, null), createdAt: Date.now() }];
      setDraft(draft);
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
      const cur = draftRef.current;
      if (!cur) return;
      const next = fn(cur);
      draftRef.current = next;
      setDraft(next);
      schedule();
    },
    [schedule],
  );
  const updateProfile = useCallback(
    (fn: (p: Profile) => Profile) => {
      const next = fn(profileRef.current);
      profileRef.current = next;
      setProfile(next);
      dirtyProfile.current = true;
      schedule();
    },
    [schedule],
  );
  const go = (setupStep: SetupStep) => update((d) => ({ ...d, setupStep }));

  // ---- select-to-reply on the chat and the setup report ----
  const blocks = useMemo(() => {
    const m = new Map<string, { text: string; label: string }>();
    if (!draft) return m;
    for (const msg of draft.chat ?? []) if (msg.role === "assistant") m.set(msg.id, { text: msg.text, label: "a message of the setup chat" });
    for (const c of draft.courses) {
      const r = draft.results[c.id];
      if (r?.summary) m.set(`sum-${c.id}`, { text: r.summary, label: `the setup report for ${c.name}` });
    }
    return m;
  }, [draft]);
  const turnsFor = useCallback(
    (note: Note) => {
      const b = blocks.get(note.messageId);
      return passageNoteTurns(NOTE_RULES, `<context>\nThe passage is in ${b?.label ?? "the setup"}:\n"""\n${b?.text ?? ""}\n"""\n</context>`, note);
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

  const returning = env.current?.source === "onboarding" && env.current.id !== draft.id;
  const props: StepProps = { env, draft, profile, update, updateProfile, go, today, flush, md, onDone, setEnv, returning, draftRef, profileRef };

  return (
    <div className="quest-page setup-page" ref={scroller} data-select-scope="">
      {!env.live && <p className="quest-banner">Preview mode: no Claude here, so the chat is a simple stand-in and setup builds a made-up skill map.</p>}
      {saveError && <p className="quest-error">{saveError}</p>}
      <header className="quest-head">
        <p className="quest-kicker">Start New Semester{draft.name ? ` · ${draft.name}` : ""}</p>
      </header>
      <div className="setup-grid">
        <section className="setup-main">
          <SetupChat {...props} />
          {draft.setupStep === "running" && <Running {...props} />}
          {draft.setupStep === "done" && <Done {...props} />}
        </section>
        <Sheet {...props} editable={draft.setupStep === "chat"} />
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
  updateProfile: (fn: (p: Profile) => Profile) => void;
  go: (s: SetupStep) => void;
  today: string;
  flush: () => Promise<void>;
  md: (blockId: string, text: string) => JSX.Element;
  onDone: () => void;
  setEnv: (e: Loaded) => void;
  returning: boolean;
  draftRef: React.MutableRefObject<SemesterDraft | null>;
  profileRef: React.MutableRefObject<Profile>;
};

function Actions({ children }: { children?: React.ReactNode }) {
  return <div className="setup-actions">{children}</div>;
}

// ---------- the setup chat ----------

function SetupChat({ env, draft, update, updateProfile, today, flush, md, returning, draftRef, profileRef }: StepProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const chat = draft.chat ?? [];
  const open = draft.setupStep === "chat";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.length]);

  const patchMsg = (id: string, p: Partial<SetupMessage>) => update((d) => ({ ...d, chat: (d.chat ?? []).map((m) => (m.id === id ? { ...m, ...p } : m)) }));

  /** Keeps each dropped file: readable content in the student's data, the original in the file store. */
  const keepFiles = async (files: PendingAttachment[]): Promise<{ uploads: Upload[]; previews: string[]; images: Blob[]; failed: string[] }> => {
    const uploads: Upload[] = [];
    const previews: string[] = [];
    const images: Blob[] = [];
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
          images.push(f.blob);
          previews.push(`File ${id} "${f.name}": image ${images.length} of the attached images.`);
        } else {
          const full = f.file ? await readFullText(f.file, MAX_FILE_CHARS) : { text: f.text ?? "", pages: null, cut: false };
          pages = full.pages;
          await env.os.saveUploadContent(id, { text: full.text });
          previews.push(`File ${id} "${f.name}"${pages ? `, ${pages} pages` : ""}. Beginning:\n"""\n${full.text.slice(0, PREVIEW_CHARS)}\n"""`);
        }
        const assetId = f.file ? await env.os.storeOriginal(f.file) : null;
        uploads.push({ id, courseId: null, fileName: f.name, type: f.kind, studentNote: "", addedAt: Date.now(), cataloguedAt: null, assetId, pages });
      } catch (e) {
        failed.push(`${f.name}: ${message(e)}`);
      }
    }
    return { uploads, previews, images, failed };
  };

  const send = async (text: string, files: PendingAttachment[]) => {
    if (!open) return;
    const userMsg: SetupMessage = { id: uid(), role: "user", text, files: files.map((f) => f.name), createdAt: Date.now() };
    update((d) => ({ ...d, chat: [...(d.chat ?? []), userMsg] }));
    const kept = files.length ? await keepFiles(files) : { uploads: [], previews: [], images: [], failed: [] };
    if (kept.uploads.length) update((d) => ({ ...d, uploads: [...d.uploads, ...kept.uploads] }));
    const reply: SetupMessage = { id: uid(), role: "assistant", text: "", createdAt: Date.now() };
    update((d) => ({ ...d, chat: [...(d.chat ?? []), reply] }));
    setBusy("Thinking…");
    let startNow = false;

    try {
      if (!env.live) {
        const r = localReply(text, draftRef.current!, profileRef.current);
        if (r.input) applyUpdate(r.input);
        startNow = r.start;
        patchMsg(reply.id, { text: r.reply });
      } else {
        if (!(await canUseTools())) throw new Error("This view can't let Claude fill in the sheet. Open StudyDesk on claude.ai in a browser or the desktop app.");
        const sendImages = (await canSendImages()) ? kept.images : [];
        const extra = [
          kept.previews.length ? `The student just dropped these files (saved as unsortedFiles; assign each to a course):\n${kept.previews.join("\n\n")}` : "",
          kept.images.length && !sendImages.length ? "Images can't be sent in this view; ask the student what the images show." : "",
          kept.failed.length ? `These files couldn't be kept: ${kept.failed.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const c = new AbortController();
        ctl.current = c;
        const turns = chatTurns(draftRef.current!.chat!.filter((m) => m.id !== reply.id), sheetSnapshot(draftRef.current!, profileRef.current, today), returning, extra);
        const answer = await askClaude(turns, {
          signal: c.signal,
          images: sendImages,
          tier: "default",
          onText: (t) => patchMsg(reply.id, { text: t }),
          tools: [
            { name: "update_sheet", description: SHEET_TOOL_DESCRIPTION, inputSchema: SHEET_TOOL_SCHEMA as unknown as Claude.sample.SampleToolInputSchema, execute: (input) => applyUpdate(input) },
            {
              name: "read_calendar",
              description:
                "Reads the student's Google Calendar (through their own connector): repeating weekly events of the next two weeks, and one-off events of the next four months (exams, trips). Returns plain lists. Use it when the student agrees or asks to import their calendar.",
              execute: async (_input, ctx) => {
                setBusy("Reading your calendar…");
                try {
                  const events = await readCalendar(today, 120, ctx.signal);
                  const twoWeeks = events.filter((e) => e.date < addDaysLocal(today, 14));
                  const { weekly } = weeklyPattern(twoWeeks);
                  const recurringTitles = new Set(weekly.map((w) => `${w.title}|${w.weekday}|${w.start}`));
                  const once = events.filter((e) => !e.recurring && !recurringTitles.has(`${e.title}|${e.weekday}|${e.start}`)).slice(0, 80);
                  update((d) => ({ ...d, calendarImportedAt: Date.now() }));
                  return {
                    weekly: weekly.map((w) => `${DAY_SHORT[w.weekday]} ${w.start}-${w.end}: ${w.title}${w.location ? ` @ ${w.location}` : ""}`),
                    upcomingOnce: once.map((e) => `${e.date}${e.start ? ` ${e.start}-${e.end}` : " (all day)"}: ${e.title}`),
                  };
                } catch (e) {
                  throw new Error((e as CalendarError).message ?? "The calendar couldn't be read.");
                } finally {
                  setBusy("Thinking…");
                }
              },
            },
            {
              name: "start_setup",
              description: "Starts the setup run (reading the files and mapping each course). Call only after the student confirmed the summary. Returns an error if something required is missing.",
              execute: () => {
                const r = setupReady(draftRef.current!);
                if (!r.ok) throw new Error(`Can't start yet: missing ${r.missing.join(", ")}.`);
                startNow = true;
                return "Started. Tell the student in one line that you're reading their materials now, course by course, and that they can follow the progress below.";
              },
            },
          ],
        });
        patchMsg(reply.id, { text: answer });
      }
    } catch (e) {
      const err = e as AskError;
      patchMsg(reply.id, { error: err?.code === "cancelled" ? "Stopped." : message(e), text: err?.text ?? draftRef.current?.chat?.find((m) => m.id === reply.id)?.text ?? "" });
    } finally {
      ctl.current = null;
      setBusy(null);
      if (startNow && setupReady(draftRef.current!).ok) {
        update((d) => ({ ...d, setupStep: "running", courses: d.courses.map((c) => (c.setupStatus === "ready" || c.setupStatus === "needs_check" ? c : { ...c, setupStatus: "waiting" })) }));
      }
      void flush();
    }
  };

  function applyUpdate(input: Record<string, unknown>): string {
    const r = applySheetUpdate(draftRef.current!, profileRef.current, input);
    update(() => r.draft);
    if (r.profile !== profileRef.current) updateProfile(() => r.profile);
    return r.result;
  }

  return (
    <div className="setup-chat">
      <div className="setup-thread">
        {chat.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="row-user">
              <div className="bubble">
                {m.text && <div className="bubble-text">{m.text}</div>}
                {m.files && m.files.length > 0 && <div className="setup-files">{m.files.map((f) => `📎 ${f}`).join("  ")}</div>}
              </div>
            </div>
          ) : (
            <div key={m.id} className="row-assistant">
              {m.text ? md(m.id, m.text) : !m.error && <p className="thinking">{busy ?? "…"}</p>}
              {m.error && <p className="error-line">{m.error}</p>}
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      {open && (
        <div className="setup-composer">
          {busy && <p className="quest-muted">{busy}</p>}
          <InputBox
            id="setup-chat"
            placeholder="Type, paste or drop anything: your timetable, a course list, syllabus, homework sheets…"
            busy={!!busy}
            onSend={(t, f) => void send(t, f)}
            onStop={() => ctl.current?.abort()}
          />
        </div>
      )}
    </div>
  );
}

function addDaysLocal(day: string, n: number): string {
  const d = new Date(`${day}T12:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    <div className="setup-card setup-run">
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
          <button type="button" className="mini-btn" onClick={() => go("chat")}>
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


// ---------- the semester sheet: filled by the chat, editable by hand ----------

function Sheet({ env, draft, profile, update, updateProfile, returning, editable }: StepProps & { editable: boolean }) {
  const [exported, setExported] = useState<string | null>(null);
  const steps = gradeSteps(profile.gradeScale);
  const patchCourse = (id: string, p: Partial<DraftCourse>) => update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  const exportLast = async () => {
    const data = JSON.stringify({ semester: env.current, mastery: env.mastery, exportedAt: new Date().toISOString() }, null, 2);
    const r = await offerDownload(`studydesk-${(env.current?.name ?? "semester").replace(/[^\w-]+/g, "-")}.json`, data);
    setExported(r === "saved" ? "Saved." : "Not saved.");
  };
  const field = (label: string, value: string, set: (v: string) => void, type = "text") => (
    <label className="sheet-field">
      <span>{label}</span>
      <input type={type} value={value} disabled={!editable} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const ready = setupReady(draft);
  return (
    <aside className="setup-sheet" aria-label="Semester sheet">
      <h2>Semester sheet</h2>
      {returning && (
        <p className="sheet-export">
          <button type="button" className="link-btn" onClick={() => void exportLast()}>
            Export last semester ({env.current?.name})
          </button>
          {exported && <span className="quest-muted"> {exported}</span>}
        </p>
      )}

      <h3>You</h3>
      <div className="sheet-grid">
        <label className="sheet-field">
          <span>Level</span>
          <select value={profile.level} disabled={!editable} onChange={(e) => updateProfile((p) => ({ ...p, level: e.target.value as Profile["level"] }))}>
            <option value="school">School</option>
            <option value="university">University</option>
          </select>
        </label>
        {field(profile.level === "school" ? "School" : "University", profile.school, (v) => updateProfile((p) => ({ ...p, school: v })))}
        {field("Country", profile.country, (v) => updateProfile((p) => ({ ...p, country: v })))}
        {field(profile.level === "school" ? "School type" : "Program", profile.program, (v) => updateProfile((p) => ({ ...p, program: v })))}
        {field("Year", profile.year, (v) => updateProfile((p) => ({ ...p, year: v })))}
        {field("Grade scale", profile.gradeScale.name, (v) => updateProfile((p) => ({ ...p, gradeScale: { ...p.gradeScale, name: v } })))}
        {field("Best grade", String(profile.gradeScale.best), (v) => Number.isFinite(Number(v)) && updateProfile((p) => ({ ...p, gradeScale: { ...p.gradeScale, best: Number(v) } })), "number")}
        {field("Worst grade", String(profile.gradeScale.worst), (v) => Number.isFinite(Number(v)) && updateProfile((p) => ({ ...p, gradeScale: { ...p.gradeScale, worst: Number(v) } })), "number")}
      </div>

      <h3>Semester</h3>
      <div className="sheet-grid">
        {field("Name", draft.name, (v) => update((d) => ({ ...d, name: v })))}
        {field("Starts", draft.startDate, (v) => update((d) => ({ ...d, startDate: v })), "date")}
        {field("Ends", draft.endDate, (v) => update((d) => ({ ...d, endDate: v })), "date")}
      </div>

      <h3>Courses</h3>
      {draft.courses.length === 0 && <p className="quest-muted">None yet.</p>}
      {draft.courses.map((c) => {
        const files = draft.uploads.filter((u) => u.courseId === c.id).length;
        const facts = draft.facts.filter((f) => f.courseId === c.id).length;
        return (
          <div key={c.id} className="sheet-course">
            <div className="sheet-course-row">
              <input aria-label="Course name" value={c.name} disabled={!editable} onChange={(e) => patchCourse(c.id, { name: e.target.value })} />
              <select
                aria-label={`Target grade for ${c.name}`}
                className={c.targetGrade === null ? "is-missing" : ""}
                value={c.targetGrade ?? ""}
                disabled={!editable}
                onChange={(e) => patchCourse(c.id, { targetGrade: e.target.value === "" ? null : Number(e.target.value) })}
              >
                <option value="">target?</option>
                {(steps ?? [profile.gradeScale.best]).map((g) => (
                  <option key={g} value={g}>
                    target {g}
                  </option>
                ))}
                {c.targetGrade !== null && !(steps ?? []).includes(c.targetGrade) && <option value={c.targetGrade}>target {c.targetGrade}</option>}
              </select>
              {editable && (
                <button
                  type="button"
                  className="chat-del"
                  aria-label={`Remove ${c.name}`}
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      courses: d.courses.filter((x) => x.id !== c.id),
                      timetable: d.timetable.filter((t) => t.courseId !== c.id),
                      facts: d.facts.filter((f) => f.courseId !== c.id),
                      uploads: d.uploads.map((u) => (u.courseId === c.id ? { ...u, courseId: null } : u)),
                    }))
                  }
                >
                  ×
                </button>
              )}
            </div>
            <p className="quest-muted sheet-course-meta">
              {[c.credits ? `${c.credits} credits` : "", files ? `${files} ${files === 1 ? "file" : "files"}` : "", facts ? `${facts} ${facts === 1 ? "note" : "notes"}` : ""].filter(Boolean).join(" · ") || "no materials yet"}
              {c.setupStatus !== "waiting" && <span className={`setup-tag is-${c.setupStatus}`}>{c.setupStatus === "needs_check" ? "check" : c.setupStatus}</span>}
            </p>
          </div>
        );
      })}
      {draft.uploads.some((u) => !u.courseId) && <p className="quest-muted">{draft.uploads.filter((u) => !u.courseId).length} files not sorted to a course yet.</p>}

      <h3>Week {draft.calendarImportedAt ? <span className="setup-tag">from your calendar</span> : null}</h3>
      <table className="sheet-week">
        <tbody>
          {WEEK.map((wd) => {
            const busy = busyMinutes(draft.timetable, wd);
            return (
              <tr key={wd}>
                <th scope="row">{DAY_SHORT[wd]}</th>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={16}
                    step={0.5}
                    aria-label={`Study goal on ${DAY_SHORT[wd]}, hours`}
                    disabled={!editable}
                    value={(draft.studyGoal[wd] ?? 0) / 60}
                    onChange={(e) => update((d) => ({ ...d, studyGoal: d.studyGoal.map((m, k) => (k === wd ? Math.max(0, Math.round(Number(e.target.value) * 60)) : m)) }))}
                  />{" "}
                  h
                </td>
                <td className="quest-muted">{busy ? `${hours(busy)} fixed` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {draft.timetable.length > 0 && (
        <ul className="sheet-slots">
          {draft.timetable
            .map((t, i) => ({ t, i }))
            .sort((a, b) => WEEK.indexOf(a.t.weekday) - WEEK.indexOf(b.t.weekday) || (a.t.start < b.t.start ? -1 : 1))
            .map(({ t, i }) => (
              <li key={i}>
                <span className="setup-slot-time">
                  {DAY_SHORT[t.weekday]} {t.start}–{t.end}
                </span>
                <span>{t.title}</span>
                {editable && (
                  <button type="button" className="chat-del" aria-label="Remove" onClick={() => update((d) => ({ ...d, timetable: d.timetable.filter((_, k) => k !== i) }))}>
                    ×
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}
      {editable && <p className={"sheet-ready " + (ready.ok ? "is-ok" : "")}>{ready.ok ? "Ready to start. Tell StudyDesk to go when you're happy." : `Still needed: ${ready.missing.join(", ")}.`}</p>}
    </aside>
  );
}
