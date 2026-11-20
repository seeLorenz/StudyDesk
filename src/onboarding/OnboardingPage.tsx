import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Note } from "../chat/types";
import { uid } from "../chat/types";
import { InputBox } from "../chat/InputBox";
import { SelectionReply } from "../chat/SelectionReply";
import { passageNoteTurns } from "../chat/prompts";
import type { PendingAttachment } from "../lib/files";
import { describedVideos, describeVideo, keepDrop } from "../lib/keep";
import { IntakeCard } from "../chat/IntakeCard";
import { LeftoversNotice } from "../shell/LeftoversNotice";
import { toDay } from "../mastery/days";
import { replay } from "../mastery/replay";
import type { Skill } from "../mastery/types";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
import { useSideNotes } from "../notes/useSideNotes";
import { readCalendar, weeklyPattern, type CalendarError } from "../platform/calendar";
import { askClaude, canSendImages, canUseTools, claudeAvailable, errorCopy, lastModel, type AskError } from "../platform/claude";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { offerDownload, openOnboardingStore, type OnboardingStore } from "../platform/onboardingStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { emptyProgress } from "../quests/handin";
import { compressImage, dataUrlToBlob } from "../quests/images";
import { busyMinutes, formatDue } from "../quests/plan";
import { sampleWriter } from "../quests/seed";
import type { Quest, Semester } from "../quests/types";
import { QuestIncomplete, writeQuest, type WriteStatus } from "../quests/write";
import { SHEET_TOOL_DESCRIPTION, SHEET_TOOL_SCHEMA, applySheetUpdate, chatTurns, greeting, localReply, setupReady, sheetSnapshot } from "./agent";
import { placementWriter, planPlacement } from "./placement";
import { gradeSteps } from "./scales";
import { setupTodo, staleCourses, type TodoItem } from "./todo";
import { buildSemester, SCAN_WRITE_BACK, localSetup, parseSetup, runCourseSetup, setupTurns, type FileForSetup, type SetupInput, liveProgress, type LiveProgress } from "./setup";
import { buildBackup, freshStart, saveBackup } from "../platform/backup";
import { RestoreBackup } from "../updates/RestoreBackup";
import { latestOf, publish, subscribe } from "../platform/deskBus";
import { byteLength, checkHandoff, jobProgress, MAX_JOB_BYTES, readJobDoc, removeJob, sessionUrl, startJob, type HandoffSetup, type HandoffState } from "../platform/handoff";
import type { CloudJob, CourseSetup, DraftCourse, Profile, SemesterDraft, SetupMessage, SetupStep, Upload } from "./types";

// Start New Semester: one chat with the Orchestrator, with the semester sheet
// beside it. design/onboarding.md. The student talks, pastes and drops files;
// Claude asks, reads, and fills the sheet through page tools; the student can
// also edit the sheet by hand. Everything saves as it goes. When the student
// confirms, the setup run reads the course files, and the first quest is a
// placement check.

/** Keep at most this much readable text per file (one database document holds 256 KiB). */
/** How much of a dropped file Claude sees in the chat, to tell what it is. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const hours = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

function message(e: unknown): string {
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return errorCopy(e as AskError);
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
      // Another screen (the StudyDesk chat) may hold a newer version that's still being saved.
      const held = latestOf("draft");
      if (usable && held && held.id === usable.id && held.updatedAt >= usable.updatedAt) usable = held;
      // Drafts from the first (form) version continue as a chat.
      if (usable && !["chat", "running", "done"].includes(usable.setupStep)) usable = { ...usable, setupStep: "chat" };
      if (p) setProfile(p);
      const draft = usable ?? newDraft();
      const returning = current?.source === "onboarding" && current.id !== draft.id;
      if (!draft.chat?.length) draft.chat = [{ id: uid(), role: "assistant", text: greeting(returning || !!p, null), createdAt: Date.now() }];
      setDraft(draft);
      publish("draft", draft, "setup");
      if (p) publish("profile", p, "setup");
      setEnv({ os, qs, ms, mastery, live, current });
    })().catch((e) => setLoadError(message(e)));
  }, [today]);

  // ---- autosave: every change, written within a second and when the tab is hidden ----
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  // Changes made elsewhere (the Orchestrator panel) replace what's held here.
  useEffect(() => {
    const a = subscribe("draft", "setup", (d) => {
      if (draftRef.current && d.id === draftRef.current.id) {
        draftRef.current = d;
        setDraft(d);
      }
    });
    const b = subscribe("profile", "setup", (p) => {
      profileRef.current = p;
      setProfile(p);
    });
    return () => {
      a();
      b();
    };
  }, []);
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
      publish("draft", next, "setup");
      schedule();
    },
    [schedule],
  );
  const updateProfile = useCallback(
    (fn: (p: Profile) => Profile) => {
      const next = fn(profileRef.current);
      profileRef.current = next;
      setProfile(next);
      publish("profile", next, "setup");
      dirtyProfile.current = true;
      schedule();
    },
    [schedule],
  );
  const go = (setupStep: SetupStep) => update((d) => ({ ...d, setupStep }));

  // ---- starting the next semester while one is active ----
  // Opening Start New Semester while a semester is active asks first, then
  // saves a backup zip, then offers a fresh start (src/platform/backup.ts).
  type FreshStep = "ask" | "exporting" | "exported" | "declined" | "wiping" | null;
  const [fresh, setFresh] = useState<FreshStep>("ask");
  const [freshLine, setFreshLine] = useState("");
  const [freshInfo, setFreshInfo] = useState<{ files: number; missing: string[] } | null>(null);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wipeChats, setWipeChats] = useState(false);
  const [freshError, setFreshError] = useState<string | null>(null);

  const exportAll = useCallback(async () => {
    if (!env) return;
    setFreshError(null);
    setFresh("exporting");
    try {
      await flush();
      const { zip, files, missing } = await buildBackup(setFreshLine);
      const name = (draftRef.current?.name || "semester").replace(/[^\w-]+/g, "-");
      const ok = await saveBackup(zip, `studydesk-backup-${name}-${toDay()}.zip`);
      setFreshInfo({ files, missing });
      setFresh(ok ? "exported" : "declined");
    } catch (e) {
      setFreshError(`The backup couldn't be made: ${message(e)}`);
      setFresh("ask");
    }
  }, [env, flush]);

  /** Opens a new setup. With `wipe`, the old semester data is deleted first. */
  const startFresh = useCallback(
    async (wipe: boolean) => {
      if (!env) return;
      setFreshError(null);
      let current = (await env.qs.loadSemester().catch(() => null)) ?? env.current;
      if (wipe) {
        setFresh("wiping");
        try {
          await freshStart(!wipeChats, setFreshLine);
          current = null;
        } catch (e) {
          setFreshError(`Not everything could be deleted: ${message(e)} Your backup is safe; try again.`);
          setFresh("exported");
          return;
        }
      } else {
        await flush();
      }
      const next = newDraft();
      next.chat = [{ id: uid(), role: "assistant", text: greeting(true, null), createdAt: Date.now() }];
      draftRef.current = next;
      setDraft(next);
      publish("draft", next, "setup");
      setEnv({ ...env, current });
      setFresh(null);
      setWipeArmed(false);
      schedule();
    },
    [env, flush, schedule, wipeChats],
  );

  // ---- hand-off: can long work go to cloud sessions? ----
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  const recheckHandoff = useCallback(
    async (connect: boolean) => {
      if (!env?.live) return setHandoff({ kind: "unavailable", detail: "local preview" });
      const st = await checkHandoff(profileRef.current.handoff, connect);
      setHandoff(st);
      const saved = profileRef.current.handoff;
      if (st.kind === "ready" && (saved?.environmentId !== st.setup.environmentId || saved?.triggerId !== st.setup.triggerId)) {
        updateProfile((p) => ({ ...p, handoff: st.setup }));
      }
    },
    [env, updateProfile],
  );
  useEffect(() => {
    if (env) void recheckHandoff(false);
  }, [env, recheckHandoff]);

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
  // Blocks that only exist on screen (live log, to-do list) register here as they render.
  const extraBlocks = useRef(new Map<string, { text: string; label: string }>());
  const turnsFor = useCallback(
    (note: Note) => {
      const b = blocks.get(note.messageId) ?? extraBlocks.current.get(note.messageId);
      return passageNoteTurns(NOTE_RULES, `<context>\nThe passage is in ${b?.label ?? "the setup"}:\n"""\n${b?.text ?? ""}\n"""\n</context>`, note);
    },
    [blocks],
  );
  const setNotes = useCallback((fn: (n: Note[]) => Note[]) => update((d) => ({ ...d, notes: fn(d.notes ?? []) })), [update]);
  const notes = useSideNotes({ notes: draft?.notes ?? [], setNotes, turnsFor, onSettled: () => void flush() });
  const md = (blockId: string, text: string, label?: string) => {
    if (label) extraBlocks.current.set(blockId, { text, label });
    return <AnnotatedMarkdown blockId={blockId} text={text} notes={notes.byBlock.get(blockId) ?? []} {...notes.handlers} />;
  };

  if (loadError) return <div className="quest-page"><p className="quest-error">Setup couldn't be loaded: {loadError}</p></div>;
  // "Loading…" only fades in if loading is slow: a line that flashes and is replaced at once reads as lag.
  if (!env || !draft) return <div className="quest-page" aria-busy="true"><p className="quest-muted late-in">Loading…</p></div>;

  const returning = env.current?.source === "onboarding" && env.current.id !== draft.id;
  const props: StepProps = { env, draft, profile, update, updateProfile, go, today, flush, md, onDone, setEnv, returning, draftRef, profileRef, handoff, recheckHandoff };

  return (
    <div className="quest-page setup-page" ref={scroller} data-select-scope="">
      {!env.live && <p className="quest-banner">Preview mode: no Claude here, so the chat is a simple stand-in and setup builds a made-up skill map.</p>}
      {saveError && <p className="quest-error">{saveError}</p>}
      <header className="quest-head">
        <p className="quest-kicker">Semester setup{draft.name ? ` · ${draft.name}` : ""}</p>
      </header>
      {draft.status === "active" && (
        <div className="setup-current">
          {fresh === null && (
            <>
              <span>This is your current semester{draft.name ? `, ${draft.name}` : ""}.</span>
              <button type="button" className="mini-btn primary" onClick={() => setFresh("ask")}>
                Start a new semester
              </button>
            </>
          )}
          {fresh === "ask" && (
            <>
              <span>
                <strong>Are you sure?</strong>{" "}
                {draft.endDate && draft.endDate > today
                  ? `${draft.name || "Your current semester"} runs until ${new Date(`${draft.endDate}T12:00`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}. `
                  : ""}
                First StudyDesk saves a backup: one zip with every file you imported and all your data, including mastery and stats. Then you choose whether to
                keep the old data or start completely fresh.
              </span>
              <button type="button" className="mini-btn primary" onClick={() => void exportAll()}>
                Export everything
              </button>
              <button type="button" className="mini-btn" onClick={() => setFresh(null)}>
                Cancel
              </button>
            </>
          )}
          {(fresh === "exporting" || fresh === "wiping") && <span className="quest-muted">{freshLine || "Working…"}</span>}
          {fresh === "declined" && (
            <>
              <span>The backup wasn't saved, so nothing is deleted. You can try again, or start the new semester and keep all old data.</span>
              <button type="button" className="mini-btn primary" onClick={() => void exportAll()}>
                Try the export again
              </button>
              <button type="button" className="mini-btn" onClick={() => void startFresh(false)}>
                Start new, keep old data
              </button>
            </>
          )}
          {fresh === "exported" && (
            <div className="setup-fresh">
              <p>
                <strong>Backup saved</strong>
                {freshInfo?.files ? ` with ${freshInfo.files} imported ${freshInfo.files === 1 ? "file" : "files"}` : ""}.
                {freshInfo?.missing.length ? ` These couldn't be included: ${freshInfo.missing.join(", ")}.` : ""}
              </p>
              <p>Do you want a completely fresh StudyDesk?</p>
              <ul>
                <li>
                  <strong>Deleted:</strong> your courses and semester, the setup chat and to-do list, quests with your answers, imported files, archived semesters.
                </li>
                <li>
                  <strong>Kept:</strong> everything you've mastered, your stats (like how long work takes you), and your profile.
                </li>
              </ul>
              <label className="setup-fresh-check">
                <input type="checkbox" checked={wipeChats} onChange={(e) => setWipeChats(e.target.checked)} /> Also delete my Ask chats
              </label>
              <div className="handoff-actions">
                <button type="button" className="mini-btn primary" onClick={() => void startFresh(false)}>
                  Keep old data
                </button>
                <button
                  type="button"
                  className={`mini-btn danger${wipeArmed ? " is-armed" : ""}`}
                  onClick={() => (wipeArmed ? void startFresh(true) : setWipeArmed(true))}
                >
                  {wipeArmed ? "Click again to delete for good" : "Delete old data and start fresh"}
                </button>
              </div>
            </div>
          )}
          {freshError && <p className="quest-error">{freshError}</p>}
        </div>
      )}
      <div className="setup-grid">
        <section className="setup-main">
          {draft.setupStep !== "running" && <HandoffCard {...props} />}
          <SetupChat
            {...props}
            below={draft.status === "setting_up" && !returning && env.current?.source !== "onboarding" && draft.courses.length === 0 ? <RestoreBackup /> : null}
          />
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
  /** Markdown with select-to-reply. `label` tells Claude where the passage is when it isn't a chat message or report. */
  md: (blockId: string, text: string, label?: string) => JSX.Element;
  onDone: () => void;
  setEnv: (e: Loaded) => void;
  returning: boolean;
  draftRef: React.MutableRefObject<SemesterDraft | null>;
  profileRef: React.MutableRefObject<Profile>;
  /** Whether long work can go to cloud sessions (null while checking). */
  handoff: HandoffState | null;
  recheckHandoff: (connect: boolean) => Promise<void>;
};

function Actions({ children }: { children?: React.ReactNode }) {
  return <div className="setup-actions">{children}</div>;
}

// ---------- hand-off: Claude Code on the web ----------

const HANDOFF_WHY =
  "Setting up a semester means reading many files and looking courses up online. StudyDesk hands that to Claude sessions in the cloud (Claude Code on the web). They can search the web, keep working when this page is closed, and stay out of your regular Claude chat list. Each one reports its results straight back into your StudyDesk. Without them, StudyDesk reads your files here in the page and can only guess courses you have no files for.";

function HandoffCard({ handoff, recheckHandoff, draft, update }: StepProps) {
  const [checking, setChecking] = useState(false);
  if (!handoff || handoff.kind === "unavailable" || handoff.kind === "ready" || draft.handoffSkipped) return null;
  const check = async (connect: boolean) => {
    setChecking(true);
    try {
      await recheckHandoff(connect);
    } finally {
      setChecking(false);
    }
  };
  const steps: Record<string, { title: string; body: string; action?: "connect" | "open" }> = {
    ask: { title: "Let StudyDesk start cloud sessions", body: "One click: allow the “Claude Code Remote” connector when claude.ai asks.", action: "connect" },
    no_connector: {
      title: "Turn on Claude Code on the web",
      body: "1. Open claude.ai/code and finish its short first-time setup.\n2. Come back here and press “Check again”, then allow access when claude.ai asks.",
      action: "open",
    },
    no_environment: { title: "Finish setting up Claude Code on the web", body: "Open claude.ai/code once and finish its setup: StudyDesk needs one cloud environment there. Then press “Check again”.", action: "open" },
    no_tools: { title: "Cloud sessions aren't allowed here", body: "Your plan or organization doesn't let apps start Claude Code sessions. StudyDesk still works: it reads your files here in the page." },
    declined: { title: "Cloud sessions are turned off", body: "You said no when claude.ai asked. To allow them, open this page's Permissions in the artifact menu, then press “Check again”." },
  };
  const key = handoff.kind === "off" ? handoff.reason : handoff.kind;
  const st = steps[key];
  if (!st) return null;
  return (
    <div className="handoff-card" role="note">
      <h3>{st.title}</h3>
      <p className="handoff-why">{HANDOFF_WHY}</p>
      <p className="handoff-steps">{st.body}</p>
      {handoff.kind === "off" && handoff.detail && <p className="handoff-detail">{handoff.detail}</p>}
      <div className="handoff-actions">
        {st.action === "connect" && (
          <button type="button" className="mini-btn primary" disabled={checking} onClick={() => void check(true)}>
            {checking ? "Connecting…" : "Allow cloud sessions"}
          </button>
        )}
        {st.action === "open" && (
          <a className="mini-btn primary" href="https://claude.ai/code" target="_blank" rel="noreferrer">
            Open claude.ai/code
          </a>
        )}
        {key !== "ask" && (
          <button type="button" className="mini-btn" disabled={checking} onClick={() => void check(true)}>
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => update((d) => ({ ...d, handoffSkipped: true }))}>
          Not now
        </button>
      </div>
    </div>
  );
}

// ---------- the setup chat ----------

// `below`: a quiet line under the input box ("Had StudyDesk before?"). It sits
// there, not above the chat, so it never pushes the conversation around when
// it appears or goes away.
function SetupChat({ env, draft, update, updateProfile, today, flush, md, returning, draftRef, profileRef, handoff, below }: StepProps & { below?: ReactNode }) {
  const [busy, setBusy] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const chat = draft.chat ?? [];
  // The chat stays open after setup, to work through the to-do list.
  const open = draft.setupStep !== "running";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.length]);

  const patchMsg = (id: string, p: Partial<SetupMessage>) => update((d) => ({ ...d, chat: (d.chat ?? []).map((m) => (m.id === id ? { ...m, ...p } : m)) }));

  /** Keeps each dropped file (zips opened): readable content and outline in the student's data, the original in the file store. */
  const keepFiles = (files: PendingAttachment[]) =>
    keepDrop(files, env.os, setBusy, {
      onZipKept: async (uploads, zip) => {
        update((d) => ({ ...d, uploads: [...d.uploads, ...uploads], zips: [...(d.zips ?? []), zip] }));
        await flush();
      },
    });

  const send = async (text: string, files: PendingAttachment[]) => {
    if (!open) return;
    const userMsg: SetupMessage = { id: uid(), role: "user", text, files: files.map((f) => f.name), createdAt: Date.now() };
    update((d) => ({ ...d, chat: [...(d.chat ?? []), userMsg] }));
    const kept = files.length ? await keepFiles(files) : { uploads: [], zips: [], previews: [], images: [], failed: [], report: null };
    if (kept.uploads.length || kept.zips.length) update((d) => ({ ...d, uploads: [...d.uploads, ...kept.uploads], zips: [...(d.zips ?? []), ...kept.zips] }));
    if (kept.report) patchMsg(userMsg.id, { intake: kept.report });
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
          kept.previews.length ? `The student just dropped these files (saved as unsortedFiles; assign each to a course, and a zip as a whole by its zip id unless its folders clearly hold several courses):\n${kept.previews.join("\n\n")}` : "",
          kept.images.length && !sendImages.length ? "Images can't be sent in this view; ask the student what the images show." : "",
          kept.failed.length ? `These files couldn't be kept: ${kept.failed.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const c = new AbortController();
        ctl.current = c;
        const turns = chatTurns(draftRef.current!.chat!.filter((m) => m.id !== reply.id), sheetSnapshot(draftRef.current!, profileRef.current, today, handoff?.kind === "ready" ? "on" : handoff && handoff.kind !== "unavailable" ? "off" : "unknown"), returning, extra);
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
        update((d) => ({ ...d, setupStep: "running", courses: d.courses.map((c) => ((c.setupStatus === "ready" || c.setupStatus === "needs_check") && !staleCourses(d).some((s) => s.id === c.id) ? c : { ...c, setupStatus: "waiting", cloudFailed: undefined })) }));
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
                {m.intake && (
                  <IntakeCard
                    report={m.intake}
                    described={describedVideos(draft.uploads)}
                    onChoose={(choice) => patchMsg(m.id, { intake: { ...m.intake!, videoChoice: choice } })}
                    onDescribe={async (uploadId, note) => update((d) => describeVideo(d, uploadId, note))}
                  />
                )}
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
          {!busy && <LeftoversNotice />}
          {busy && <p className="quest-muted">{busy}</p>}
          {busy && /^(Keeping|Opening)/.test(busy) && (
            <p className="quest-muted keep-note">This takes a few minutes with a lot of files. Keep this window open until it's done; each finished zip is saved, so closing early only loses the one in progress.</p>
          )}
          <InputBox
            id="setup-chat"
            keepAll
            placeholder="Type, paste or drop anything: your timetable, a course list, syllabus, homework sheets…"
            busy={!!busy}
            onSend={(t, f) => void send(t, f)}
            onStop={() => ctl.current?.abort()}
          />
          {below}
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

type FeedEntry = { prep: string[]; live: LiveProgress | null; model?: string; log?: string[] };

function Running({ env, draft, profile, update, updateProfile, go, today, flush, md, draftRef: pageDraftRef, profileRef, handoff }: StepProps) {
  const running = useRef(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  // The live feed: what the org agent is doing right now, per course. Not saved.
  const [feed, setFeed] = useState<Record<string, FeedEntry>>({});
  const setPrep = (id: string, prep: string[]) => setFeed((f) => ({ ...f, [id]: { prep, live: null } }));
  // The page's own draft ref: updated the moment update() runs, not on the next render.
  const draftRef = pageDraftRef as React.MutableRefObject<SemesterDraft>;
  const setCourse = useCallback(
    (id: string, p: Partial<DraftCourse>) => update((d) => ({ ...d, courses: d.courses.map((c) => (c.id === id ? { ...c, ...p } : c)) })),
    [update],
  );

  const prior = useMemo(() => {
    const { states } = replay(env.mastery.skills, env.mastery.attempts, env.mastery.reviews);
    return env.mastery.skills.filter((s): s is Skill => s.isFundamental && ["mastered", "retained"].includes(states.get(s.id)?.stage ?? ""));
  }, [env.mastery]);

  const cloud = env.live && handoff?.kind === "ready" ? handoff.setup : null;
  const pageBusy = useRef(false);

  /** Loads a course's kept files and builds the run's input. */
  const prepare = useCallback(
    async (c: DraftCourse, d: SemesterDraft, images: boolean) => {
      const files: FileForSetup[] = [];
      const all = d.uploads.filter((x) => x.courseId === c.id);
      for (const u of all) {
        // Videos and unknown formats have nothing kept, but the agent still sees them by name.
        const content = u.state === "listed" ? {} : await env.os.loadUploadContent(u.id);
        if (!content) continue;
        if (content.image && !images) continue;
        files.push({ upload: u, text: content.text ?? null, image: content.image ? dataUrlToBlob(content.image) : null, outline: content.outline });
      }
      const facts = d.facts.filter((f) => f.courseId === c.id);
      const input: SetupInput = { profile, draft: d, course: c, facts, files, today, priorFundamentals: prior };
      const prep: string[] = [];
      if (files.length) prep.push(`${files.length} ${files.length === 1 ? "file" : "files"} in this course: the agent starts from the list and opens what it needs`);
      if (all.length > files.length) prep.push(`${all.length - files.length} ${all.length - files.length === 1 ? "file" : "files"} couldn't be opened in this view and are skipped`);
      if (facts.length) prep.push(`Using ${facts.length} ${facts.length === 1 ? "thing" : "things"} you told me about this course`);
      return { input, files, prep };
    },
    [env, profile, today, prior],
  );

  const saveResult = useCallback(
    (c: DraftCourse, res: CourseSetup & { clipped: string[] }, readIds: string[]) => {
      const { clipped, ...result } = res;
      if (clipped.length) result.questions.push(`Only the first part of ${clipped.join(", ")} fit into one reading. Tell StudyDesk which chapters matter most.`);
      const check = result.conflicts.length > 0 || result.questions.length > 0 || result.truncated || result.basis === "general";
      const now = Date.now();
      update((x) => ({
        ...x,
        results: { ...x.results, [c.id]: result },
        uploads: x.uploads.map((u) => (readIds.includes(u.id) ? { ...u, cataloguedAt: now } : u)),
        courses: x.courses.map((k) => (k.id === c.id ? { ...k, setupStatus: check ? "needs_check" : "ready", teachingLanguage: result.teachingLanguage, job: undefined } : k)),
      }));
    },
    [update],
  );

  /** One course, read here in the page (no cloud session, or it doesn't fit one). */
  const runInPage = useCallback(
    async (c: DraftCourse) => {
      pageBusy.current = true;
      try {
        setCourse(c.id, { setupStatus: "reading", setupError: undefined });
        await flush();
        const { input, files, prep } = await prepare(c, draftRef.current, await canSendImages());
        if (!files.length) prep.unshift("No files for this course, so this is an estimate from the course name and your program, not your syllabus.");
        setPrep(c.id, prep);
        let lastKey = "";
        const onText = (t: string) => {
          const live = liveProgress(t);
          const key = `${live.log.length}|${live.stage}|${live.topics}|${live.skills}`;
          if (key === lastKey) return;
          lastKey = key;
          setFeed((f) => ({ ...f, [c.id]: { ...f[c.id], prep, live } }));
        };
        const onLog = (line: string) => {
          prep.push(line);
          setFeed((f) => ({ ...f, [c.id]: { ...f[c.id], prep: [...prep] } }));
        };
        const res = env.live ? await runCourseSetup(input, askClaude, undefined, onText, onLog) : await previewRun(input, onText);
        const used = lastModel();
        if (env.live && used) setFeed((f) => ({ ...f, [c.id]: { ...f[c.id], model: used.opus ? "Opus" : `most capable model available (${used.tier} tier) answered instead` } }));
        saveResult(c, res, files.map((f) => f.upload.id));
      } catch (e) {
        setCourse(c.id, { setupStatus: "failed", setupError: message(e) });
      } finally {
        pageBusy.current = false;
        await flush();
      }
    },
    [env, prepare, saveResult, setCourse, flush],
  );

  /** Hands one course to a cloud session. False when it has to be read in the page instead. */
  const startCloud = useCallback(
    async (c: DraftCourse, cloudSetup: HandoffSetup): Promise<boolean> => {
      const { input, files, prep } = await prepare(c, draftRef.current, true);
      // The session opens the files itself, so only the inventory goes into the job.
      const built = setupTurns(input, { web: true, navigate: "cloud" });
      if (byteLength(built.turns[0].content) > MAX_JOB_BYTES) return false; // a huge inventory: the page reads it instead
      setCourse(c.id, { setupStatus: "reading", setupError: undefined });
      // The saved setup may know more than the check did (a new task, the page's own address).
      const saved = profileRef.current.handoff;
      const setup = saved && saved.environmentId === cloudSetup.environmentId ? { ...cloudSetup, ...saved } : cloudSetup;
      const started = await startJob(setup, `Set up the course "${c.name}"`, built.turns[0].content, SCAN_WRITE_BACK);
      if (started.setup.triggerId !== setup.triggerId) updateProfile((p) => ({ ...p, handoff: started.setup }));
      const now = Date.now();
      const job: CloudJob = { jobId: started.jobId, sessionId: started.sessionId, startedAt: now, changedAt: now, seen: "", fileKeys: Object.fromEntries(built.fileKeys), readIds: files.map((f) => f.upload.id) };
      setCourse(c.id, { job });
      setFeed((f) => ({ ...f, [c.id]: { prep: [...prep, "Handed to a cloud session: it opens your files as it needs them and looks the course up online"], live: null, log: [] } }));
      await flush();
      return true;
    },
    [prepare, setCourse, flush, profileRef, updateProfile],
  );

  /** Follows one cloud session through its report; saves its result when it has finished. */
  const pollCloud = useCallback(
    async (c: DraftCourse) => {
      const job = c.job!;
      if (!job.jobId) {
        // Started by an older StudyDesk that can't follow it: start it again.
        setCourse(c.id, { job: undefined, setupStatus: "waiting" });
        return;
      }
      const doc = await readJobDoc(job.jobId);
      const now = Date.now();
      const sig = `${doc?.status}|${doc?.log?.length ?? 0}|${doc?.log?.[doc.log.length - 1] ?? ""}`;
      const changed = sig !== job.seen;
      const p = jobProgress(doc, { startedAt: job.startedAt, changedAt: changed ? now : job.changedAt }, now);
      setFeed((f) => ({ ...f, [c.id]: { prep: f[c.id]?.prep ?? ["Handed to a cloud session"], live: null, log: p.status === "waiting" ? ["Waiting for the cloud session to start…"] : p.log } }));
      if (p.artifactUrl && profileRef.current.handoff && profileRef.current.handoff.artifactUrl !== p.artifactUrl) {
        const url = p.artifactUrl;
        updateProfile((x) => (x.handoff ? { ...x, handoff: { ...x.handoff, artifactUrl: url } } : x));
      }
      if (p.status === "waiting" || p.status === "working") {
        if (changed) setCourse(c.id, { job: { ...job, seen: sig, changedAt: now } });
        return;
      }
      try {
        if (p.status !== "done" || !p.answer) throw new Error(p.error ?? "The cloud session stopped without an answer.");
        const d = draftRef.current;
        const input: SetupInput = { profile, draft: d, course: c, facts: d.facts.filter((f) => f.courseId === c.id), files: [], today, priorFundamentals: prior };
        const result = parseSetup(p.answer, input, new Map(Object.entries(job.fileKeys)));
        saveResult(c, { ...result, clipped: [] }, job.readIds);
      } catch (e) {
        // The page reads it instead.
        setCourse(c.id, { job: undefined, cloudFailed: `${message(e)} Reading it here instead.`, setupStatus: "waiting" });
      }
      void removeJob(job.jobId);
      await flush();
    },
    [profile, today, prior, saveResult, setCourse, flush, profileRef, updateProfile],
  );

  const runAll = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const d = draftRef.current;
        const open = d.courses.filter((x) => x.setupStatus === "waiting" || x.setupStatus === "reading");
        if (!open.length && !pageBusy.current) break;
        // Start a cloud session for every course that can have one.
        if (cloud) {
          for (const c of open.filter((x) => x.setupStatus === "waiting" && !x.job && !x.cloudFailed)) {
            try {
              if (!(await startCloud(c, cloud))) setCourse(c.id, { cloudFailed: "Too many files to list for one cloud session." });
            } catch (e) {
              setCourse(c.id, { setupStatus: "waiting", cloudFailed: message(e) });
            }
          }
        }
        // Follow the running sessions.
        for (const c of draftRef.current.courses.filter((x) => x.setupStatus === "reading" && x.job)) {
          try {
            await pollCloud(c);
          } catch {
            // A failed check is retried on the next round.
          }
        }
        // The page reads one course at a time itself.
        if (!pageBusy.current) {
          const next = draftRef.current.courses.find((x) => (x.setupStatus === "waiting" || x.setupStatus === "reading") && !x.job && (!cloud || x.cloudFailed));
          if (next) void runInPage(next);
        }
        const anyCloud = draftRef.current.courses.some((x) => x.setupStatus === "reading" && x.job);
        await new Promise((r) => setTimeout(r, anyCloud ? 10_000 : 400));
      }
    } finally {
      running.current = false;
    }
  }, [cloud, startCloud, pollCloud, runInPage, setCourse]);

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
      const current = (await env.qs.loadSemester().catch(() => null)) ?? env.current;
      const built = buildSemester(d, profile);
      // Re-reading courses after answers keeps the same semester and its placement check.
      const semester = current && current.id === built.id && current.placementQuestId ? { ...built, placementQuestId: current.placementQuestId, studyGoalSource: current.studyGoalSource, studyGoalDecidedAt: current.studyGoalDecidedAt } : built;
      if (current && current.source === "onboarding" && current.id !== semester.id) await env.os.archiveSemester(current);
      await env.qs.saveSemester(semester);
      publish("semester", semester, "setup");
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

  const reading = draft.courses.filter((c) => c.setupStatus === "reading");
  const next = draft.courses.filter((c) => c.setupStatus === "waiting");
  const finished = draft.courses.filter((c) => draft.results[c.id] && (c.setupStatus === "ready" || c.setupStatus === "needs_check"));
  /** The newest steps of a long log, with how many came before. */
  const recent = (lines: string[], n = 14) => (lines.length > n ? [`(${lines.length - n} earlier steps)`, ...lines.slice(-n)] : lines);
  const nowText = (c: DraftCourse) => {
    const fb = feed[c.id];
    if (c.job) {
      const lines = [...(fb?.prep ?? ["Working in a cloud session"]), ...(fb?.log ?? [])];
      const mins = Math.max(1, Math.round((Date.now() - c.job.startedAt) / 60_000));
      return [...recent(lines).map((l) => `- ${l}`), "", `*Working in a cloud session · ${mins} min so far*`].join("\n");
    }
    if (!fb) return "*Opening the files…*";
    return [
      ...recent([...(c.cloudFailed && cloud ? [`Not in a cloud session: ${c.cloudFailed}`] : []), ...fb.prep, ...(fb.live?.log ?? [])]).map((l) => `- ${l}`),
      "",
      `*${!fb.live?.stage || fb.live.stage === "reading" ? "Reading…" : `Now ${fb.live.stage}`}${fb.live && fb.live.skills > 0 ? ` · ${fb.live.topics} topics, ${fb.live.skills} skills so far` : ""}*`,
    ].join("\n");
  };
  const doneText = finished
    .map((c) => {
      const r = draft.results[c.id];
      return r.basis === "materials"
        ? `- **${c.name}**: read your files, ${r.topics.length} topics and ${r.skills.length} skills`
        : `- **${c.name}**: no files, so its ${r.topics.length} topics and ${r.skills.length} skills are an estimate`;
    })
    .join("\n");
  const fallback = Object.values(feed).find((f) => f.model && f.model !== "Opus")?.model;

  return (
    <div className="setup-card setup-run">
      <h1>Setting up your semester</h1>
      <p>
        {cloud
          ? "Setup usually takes a few minutes, longer with a lot of files. The organization agent (Claude Opus) now works on every course at once, each in its own cloud session: it starts from your file list, opens the syllabus first and follows it to what matters, looks the course up online, and turns it into topics, skills, dates, homework and grading rules. The sessions keep working if you close this page, and they don't show up in your regular Claude chats."
          : "Setup usually takes a few minutes per course, longer with a lot of files, and this window has to stay open until it's done (if you close it, it carries on where it stopped next time). The organization agent (Claude Opus) works through your courses one at a time, right here in the page. It starts from each course's file list, opens the syllabus first and follows it to what matters, and turns that into topics, skills, dates, homework and grading rules. Without cloud sessions, courses without files are only an estimate and nothing is looked up online."}
      </p>
      <p className="setup-count">
        <strong>
          {finished.length} of {draft.courses.length}
        </strong>{" "}
        courses done{pending ? (cloud && !draft.courses.some((c) => c.cloudFailed && (c.setupStatus === "waiting" || c.setupStatus === "reading")) ? ". You can close this page; it picks up the results when you come back." : ". Keep this page open; if you close it, it carries on when you come back.") : "."}
      </p>
      {fallback && <p className="quest-muted">Opus wasn't available on your plan here, so the {fallback}.</p>}

      {reading.map((c) => (
        <div key={c.id} className="setup-now">
          <h3>
            <span className="setup-spin" aria-hidden="true" /> {c.name}
            {c.job?.sessionId && (
              <a className="setup-session-link" href={sessionUrl(c.job.sessionId)} target="_blank" rel="noreferrer">
                Open the session
              </a>
            )}
          </h3>
          {md(`run-now-${c.id}`, nowText(c), `the live log of the setup run for ${c.name}`)}
        </div>
      ))}

      {failed.map((c) => (
        <p key={c.id} className="setup-failed">
          <strong>{c.name}</strong>: <span className="quest-error">{c.setupError}</span>{" "}
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
        </p>
      ))}

      {next.length > 0 && <p className="quest-muted">Up next: {next.map((c) => c.short || c.name).join(", ")}</p>}

      {finished.length > 0 && (
        <details className="setup-fold">
          <summary>
            {finished.length} {finished.length === 1 ? "course" : "courses"} done
          </summary>
          {md("run-done", doneText, "the list of courses the setup run finished")}
        </details>
      )}

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

/** Local preview: plays a short made-up log so the live feed can be seen without Claude. */
async function previewRun(input: Parameters<typeof localSetup>[0], onText: (t: string) => void) {
  const name = input.files[0]?.upload.fileName;
  const steps = [
    "=== LOG ===\n",
    `- ${name ? `Reading F1 (${name}), p. 1-12: course outline and first chapter` : "Estimating from the course name (local preview)"}\n`,
    "- Looking for exam dates and grading rules\n",
    "=== SUMMARY ===\nPreview.\n=== TOPICS ===\nt1 | A | taught\n=== SKILLS ===\ns1 | t1 | One\n",
  ];
  let text = "";
  for (const st of steps) {
    text += st;
    onText(text);
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ...localSetup(input), clipped: [] as string[] };
}

// ---------- 7. done: dates to check, then the placement check ----------

function Done({ env, draft, md, onDone, setEnv, today, update }: StepProps) {
  const [semester, setSemester] = useState<Semester | null>(null);
  const partial = useRef<{ quest: Quest; writtenIds: string[] } | null>(null);
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
      publish("semester", s, "setup");
        return onDone();
      }
      // Every part is listed from the start, so the count never grows while it writes.
      setBuilding(Object.fromEntries(quest.parts.map((p) => [p.id, { partId: p.id, state: "waiting" } as WriteStatus])));
      const writer = placementWriter(semester, quest, partCourse, askClaude, env.live ? null : sampleWriter(semester.skills));
      // A retry carries on from the parts already written.
      const prev = partial.current;
      const resume = prev && prev.quest.parts.length === quest.parts.length && prev.quest.parts.every((p, i) => p.id === quest.parts[i].id);
      let written: Quest;
      try {
        written = await writeQuest(resume ? prev.quest : quest, writer, (s) => setBuilding((b) => ({ ...(b ?? {}), [s.partId]: s })), {
          skip: resume ? new Set(prev.writtenIds) : undefined,
        });
      } catch (e) {
        if (e instanceof QuestIncomplete) partial.current = { quest: e.quest, writtenIds: e.writtenIds };
        throw e;
      }
      partial.current = null;
      await env.qs.saveRecord({ quest: written, progress: emptyProgress(written.id) });
      const s = { ...semester, placementQuestId: written.id };
      await env.qs.saveSemester(s);
      publish("semester", s, "setup");
      setEnv({ ...env, current: s });
      onDone();
    } catch (e) {
      setBuilding(null);
      const kept = partial.current?.writtenIds.length ?? 0;
      setError(`The placement check couldn't be finished: ${message(e)}${kept ? ` The ${kept} ${kept === 1 ? "part" : "parts"} already written ${kept === 1 ? "is" : "are"} kept, so trying again carries on from there.` : ""}`);
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

  const conflicts = draft.courses.flatMap((c) => (draft.results[c.id]?.conflicts ?? []).map((t) => `- **${c.short || c.name}:** ${t}`));
  const todo = setupTodo(draft);
  const left = todo.filter((t) => !t.done);
  const stale = staleCourses(draft);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const shownKey = openKey ?? left[0]?.key ?? null;

  const tick = (key: string, on: boolean) =>
    update((d) => ({ ...d, todoDone: on ? [...new Set([...(d.todoDone ?? []), key])] : (d.todoDone ?? []).filter((k) => k !== key) }));
  const startInChat = (item: TodoItem) => {
    const msg: SetupMessage = { id: uid(), role: "assistant", text: item.chatPrompt, createdAt: Date.now() };
    update((d) => ({ ...d, chat: [...(d.chat ?? []), msg] }));
    setOpenKey(item.key);
    setTimeout(() => document.querySelector(".setup-composer textarea")?.scrollIntoView({ block: "center" }), 50);
  };
  const reread = () =>
    update((d) => {
      const ids = new Set(staleCourses(d).map((c) => c.id));
      return { ...d, setupStep: "running", courses: d.courses.map((c) => (ids.has(c.id) ? { ...c, setupStatus: "waiting", cloudFailed: undefined, job: undefined } : c)) };
    });

  return (
    <div className="setup-card">
      <h1>Your semester is set up</h1>
      {semester && (
        <p>
          {semester.courses.length} {semester.courses.length === 1 ? "course" : "courses"}, {semester.skills.length} skills to learn and track.
          {todo.length > 0 && " A few things are still open. Work through them below, one at a time, whenever you like."}
        </p>
      )}

      {todo.length > 0 && (
        <>
          <h2 className="setup-h2">
            To do <span className="quest-muted">· {left.length ? `${left.length} left` : "all done"}</span>
          </h2>
          <ol className="setup-todo">
            {todo.map((t) => (
              <li key={t.key} className={t.done ? "is-done" : ""}>
                <div className="setup-todo-head">
                  <input type="checkbox" checked={t.done} aria-label={`Mark "${t.title}" done`} onChange={(e) => tick(t.key, e.target.checked)} />
                  <button type="button" className="setup-todo-title" aria-expanded={shownKey === t.key} onClick={() => setOpenKey(shownKey === t.key ? "" : t.key)}>
                    {t.title}
                  </button>
                </div>
                {shownKey === t.key && (
                  <div className="setup-todo-body">
                    {md(`todo-${t.key}`, t.body, `the to-do list after setup ("${t.title}")`)}
                    <button type="button" className="mini-btn" onClick={() => startInChat(t)}>
                      {t.key === "upload" ? "Add files in the chat" : "Answer in the chat"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}

      {stale.length > 0 && (
        <p className="setup-stale">
          You added answers or files for {stale.map((c) => c.short || c.name).join(", ")}.{" "}
          <button type="button" className="mini-btn primary" onClick={reread}>
            Update {stale.length === 1 ? "this course" : `these ${stale.length} courses`}
          </button>
        </p>
      )}

      <h2 className="setup-h2">Next: a placement check</h2>
      <p>One short problem on each basic your courses build on and on each topic already taught, so StudyDesk knows how far you actually are. From the results it recommends how much to do each day for your target grades.</p>
      {building && (
        <p className="quest-muted">
          Writing your placement check… {Object.values(building).filter((s) => s.state === "done").length} of {Object.keys(building).length} parts ready (two at a time)
        </p>
      )}
      {error && <p className="quest-error">{error}</p>}
      <Actions>
        <button type="button" className="mini-btn primary big" disabled={!semester || !!building} onClick={() => void start()}>
          {semester?.placementQuestId ? "Open your quests" : "Start my placement check"}
        </button>
      </Actions>

      <h2 className="setup-h2">Details</h2>
      {dates.length > 0 && (
        <details className="setup-fold">
          <summary>Important dates ({dates.length}): please double-check them</summary>
          <ul className="setup-dates">
            {dates.map((d, i) => (
              <li key={i}>
                <span className="setup-slot-time">{d.when}</span>
                <span>{d.label}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {conflicts.length > 0 && (
        <details className="setup-fold">
          <summary>Where your files disagree with what you said ({conflicts.length}). Your word was used.</summary>
          {md("conflicts", conflicts.join("\n"), "the list of places where the student's files disagree with what they said")}
        </details>
      )}
      {draft.courses
        .filter((c) => draft.results[c.id])
        .map((c) => {
          const r = draft.results[c.id];
          return (
            <details key={c.id} className="setup-fold">
              <summary>
                {c.name} <span className="quest-muted">· {r.topics.length} topics, {r.skills.length} skills{r.basis === "general" ? ", estimated" : ""}</span>
              </summary>
              {r.summary && md(`sum-${c.id}`, r.summary)}
              <p className="quest-muted">{r.basis === "materials" ? `Mapped to your files: ${r.catalog.length} references to pages or lines.` : "No files yet, so this is what such a course usually covers."}</p>
            </details>
          );
        })}
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
