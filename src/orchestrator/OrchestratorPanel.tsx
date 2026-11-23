import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SentFiles } from "../chat/SentFiles";
import { useSentToTop } from "../chat/useSentToTop";
import { ImportProgress } from "../chat/ImportProgress";
import { Logo } from "../shell/Logo";
import { createPortal } from "react-dom";
import type { Note } from "../chat/types";
import { uid } from "../chat/types";
import { InputBox } from "../chat/InputBox";
import { SelectionReply } from "../chat/SelectionReply";
import { passageNoteTurns } from "../chat/prompts";
import type { PendingAttachment } from "../lib/files";
import { describedVideos, describeVideo, keepDrop, READ_FILE_TOOL, readKeptFile, recallImages, RECALL_IMAGES, type KeepProgress, type KeptDrop } from "../lib/keep";
import { IntakeCard } from "../chat/IntakeCard";
import { toDay } from "../mastery/days";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
import { useSideNotes } from "../notes/useSideNotes";
import { calendarForClaude, readCalendar, type CalendarError } from "../platform/calendar";
import { askClaude, canUseTools, claudeAvailable, errorCopy, maxImages, type AskError } from "../platform/claude";
import { publish, subscribe } from "../platform/deskBus";
import { checkHandoff, type HandoffSetup } from "../platform/handoff";
import { openRoutineStore } from "../platform/routineStore";
import { createSchedule, runScheduleNow, scheduleFits, studentTimeZone } from "../platform/schedule";
import { nightlySettings, type RoutineDoc } from "../routine/nightly";
import { applyShallow, applySweep, outboxOrder } from "../routine/apply";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { openOnboardingStore, StaleDraft, type OnboardingStore } from "../platform/onboardingStore";
import { openOrchestratorStore, type OrchestratorStore } from "../platform/orchestratorStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { compressImage } from "../quests/images";
import type { QuestRecord, Semester } from "../quests/types";
import type { Profile, SemesterDraft, Upload } from "../onboarding/types";
import { NIGHTLY_TOOL, UPDATE_TOOL, ASK_TOOL, CALENDAR_TOOL, CHANGE_TOOL, checkinTurns, deskSnapshot, JOB_TOOL, jobTitle, localCheckin, LOOKUP_TOOL, needsSummary, orchTurns, questStarted, PLACEMENT_TOOL, REBUILD_TOOL, summaryTurns, todaysBlocks } from "./agent";
import { PASS_ON_EVENT, type PassOn } from "./passOn";
import { applyOps, canUndo, findCourse, syncSemester, undoChange, type Desk } from "./changes";
import { advanceJobs, startJob, type JobFile } from "./jobs";
import { checkinTriggers } from "./signals";
import { GoBackCard, UpdateNotice } from "../updates/UpdateCards";
import { loadRelease, loadUpdates, markAnnounced, updateEnv } from "../platform/updateStore";
import { goBackTarget, offer } from "../updates/plan";
import { APP_VERSION } from "../updates/version";
import { plainNote, whatsNewTurns } from "../updates/whatsNew";
import { emptyState, type Change, type ChatCard, type Job, type Notification, type OrchMessage, type OrchState, type PendingConfirm } from "./types";

// The StudyDesk chat: the Orchestrator, reachable from every screen as a side
// panel. design/orchestrator.md. It answers questions about the desk, makes
// small changes through code-checked operations (each with an Undo card),
// starts organization agent jobs (the setup run of their courses), keeps a
// running memory, and speaks first when code finds a reason (check-ins).

const MAX_FILE_CHARS = 240_000;
const PREVIEW_CHARS = 3_000;
const CHECKIN_EVERY_MS = 10 * 60_000;
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Env = {
  os: OnboardingStore;
  qs: QuestStore;
  ms: MasteryStore;
  orch: OrchestratorStore;
  live: boolean;
};

export type OrchStatus = { needs: number; notes: number; nightly: "on" | "off" | "failed"; nightlyTime: string | null };

type Props = {
  open: boolean;
  expanded: boolean;
  onClose: () => void;
  onToggleExpand: () => void;
  /** What the student is looking at, e.g. "Now (today's plan)". */
  screen: string;
  /** Text the student selected when they opened the chat. */
  quote: string | null;
  onClearQuote: () => void;
  /** What the sidebar shows on Tell StudyDesk: things that need the student, unread notes, the nightly run. */
  onStatus: (s: OrchStatus) => void;
  /** On the Organize page the chat sits in this element as a full page instead of a side panel. */
  dock?: HTMLElement | null;
  onOpenAsk: (question: string) => void;
  onOpenSetup: () => void;
};

const NOTE_RULES = `You are StudyDesk, a study assistant for high school and university students.
The student highlighted a passage in their StudyDesk chat to ask about it.
Your answer appears in a small side note right under that passage. So:
- Answer only the question about the highlighted passage, using the context.
- Be brief: usually 2 to 6 sentences, or a short list.
- Don't restate the passage and don't greet.
- Use Markdown; write math with $...$ inline.`;

function message(e: unknown): string {
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return errorCopy(e as AskError);
  return e instanceof Error ? e.message : "Something went wrong.";
}

const dayOf = (ts: number) => toDay(new Date(ts));

export function OrchestratorPanel(props: Props) {
  const { expanded, onClose, onToggleExpand, screen, quote, onClearQuote, onStatus, onOpenAsk, onOpenSetup, dock } = props;
  const open = props.open || !!dock;
  const [env, setEnv] = useState<Env | null>(null);
  const [draft, setDraft] = useState<SemesterDraft | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<OrchState>(emptyState);
  const [messages, setMessages] = useState<OrchMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"on" | "off" | "unknown">("unknown");
  const [nightly, setNightly] = useState<"on" | "off" | "failed">("off");
  const handoffRef = useRef<HandoffSetup | null>(null);
  const routineRef = useRef<RoutineDoc | null>(null);
  /**
   * The nightly run's scheduled task, matching the student's time: made once,
   * and made again when the student changes the time (the old task then finds
   * a different key and does nothing).
   */
  const ensureNightly = useCallback(async (os: OnboardingStore) => {
    const p = profileRef.current;
    const setup = handoffRef.current;
    if (!p) return;
    const tz = studentTimeZone();
    const time = nightlySettings(p.nightly).time;
    if (scheduleFits(p.schedule, tz, time)) return setNightly("on");
    if (!setup) return setNightly(p.schedule ? "failed" : "off");
    try {
      const schedule = await createSchedule({ ...setup, ...(p.handoff?.environmentId === setup.environmentId ? p.handoff : {}) }, tz, time);
      const np = { ...(profileRef.current ?? p), schedule };
      await os.saveProfile(np);
      profileRef.current = np;
      setProfile(np);
      publish("profile", np, "orch");
      setNightly("on");
    } catch {
      setNightly("failed");
    }
  }, []);
  const today = toDay();

  // Everything the tools read lives in refs, so a reply sees the newest version.
  const draftRef = useRef<SemesterDraft | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const semesterRef = useRef<Semester | null>(null);
  const masteryRef = useRef<MasteryData>({ skills: [], targets: [], attempts: [], reviews: [] });
  const recordsRef = useRef<QuestRecord[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const ctl = useRef<AbortController | null>(null);
  const checking = useRef(false);
  const summarizing = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // ---------- loading ----------
  const loadData = useCallback(async (e: Env) => {
    const [mastery, records, semester, routine] = await Promise.all([e.ms.load(), e.qs.loadRecords(), e.qs.loadSemester(), openRoutineStore().then((r) => r.loadRoutine()).catch(() => null)]);
    routineRef.current = routine;
    masteryRef.current = mastery;
    recordsRef.current = records;
    if (semester) semesterRef.current = semester;
  }, []);

  useEffect(() => {
    (async () => {
      const [os, qs, ms, orch, live] = await Promise.all([openOnboardingStore(), openQuestStore(), openMasteryStore(), openOrchestratorStore(), claudeAvailable()]);
      const e: Env = { os, qs, ms, orch, live };
      const [p, d, s] = await Promise.all([os.loadProfile(), os.loadDraft(), orch.loadState()]);
      await loadData(e);
      let dd = d;
      // A workload the student accepted on the quest page is saved on the semester: keep it.
      const sem = semesterRef.current;
      if (dd && sem && sem.id === dd.id && sem.studyGoal.join() !== dd.studyGoal.join() && sem.studyGoalDecidedAt) dd = { ...dd, studyGoal: [...sem.studyGoal] };
      draftRef.current = dd;
      profileRef.current = p;
      setDraft(dd);
      setProfile(p);
      setState(s);
      if (dd) {
        publish("draft", dd, "orch");
        setMessages(await orch.loadMessages(dd.id));
      }
      if (p) publish("profile", p, "orch");
      setEnv(e);
      if (live) {
        const h = await checkHandoff(p?.handoff, false).catch(() => null);
        setCloud(h?.kind === "ready" ? "on" : h && h.kind !== "unavailable" ? "off" : "unknown");
        if (h?.kind === "ready") handoffRef.current = h.setup;
        if (dd?.status === "active") await ensureNightly(os);
      }
    })().catch((err) => setError(`StudyDesk's chat couldn't be loaded: ${message(err)}`));
  }, [loadData]);

  // ---------- saving ----------
  const saveState = useCallback(
    (fn: (s: OrchState) => OrchState) => {
      const next = { ...fn(stateRef.current), updatedAt: Date.now() };
      stateRef.current = next;
      setState(next);
      env?.orch.saveState(next).catch((err) => setError(`StudyDesk's memory couldn't be saved: ${message(err)}`));
      return next;
    },
    [env],
  );

  const saveMessages = useCallback(
    (fn: (m: OrchMessage[]) => OrchMessage[], persist = true) => {
      const before = messagesRef.current;
      const next = fn(before);
      messagesRef.current = next;
      setMessages(next);
      const d = draftRef.current;
      if (!persist || !env || !d) return;
      const changedDays = new Set(next.filter((m) => !before.includes(m)).map((m) => dayOf(m.createdAt)));
      for (const day of changedDays) env.orch.saveDay(d.id, day, next.filter((m) => dayOf(m.createdAt) === day)).catch((err) => setError(`The chat couldn't be saved: ${message(err)}`));
    },
    [env],
  );

  /** Saves a changed desk everywhere: the draft, the profile, and the semester the quests read. */
  const commitDesk = useCallback(
    async (changed: Desk) => {
      if (!env) return;
      const desk = { ...changed, draft: { ...changed.draft, updatedAt: Date.now() } };
      const profileChanged = desk.profile !== profileRef.current;
      draftRef.current = desk.draft;
      profileRef.current = desk.profile;
      setDraft(desk.draft);
      setProfile(desk.profile);
      publish("draft", desk.draft, "orch");
      if (profileChanged) publish("profile", desk.profile, "orch");
      try {
        await env.os.saveDraft(desk.draft);
      } catch (e) {
        // Another tab or device saved a newer setup: take it over, and don't build the semester from the stale one.
        if (e instanceof StaleDraft && e.latest) {
          draftRef.current = e.latest;
          setDraft(e.latest);
          publish("draft", e.latest, "orch");
        }
        throw e;
      }
      if (profileChanged) {
        await env.os.saveProfile(desk.profile);
        // A new time for the nightly run needs a new scheduled task.
        void ensureNightly(env.os);
      }
      const current = semesterRef.current ?? (await env.qs.loadSemester());
      if (desk.draft.status === "active" && (!current || current.id === desk.draft.id)) {
        const semester = syncSemester(desk.draft, desk.profile, current);
        semesterRef.current = semester;
        await env.qs.saveSemester(semester);
        publish("semester", semester, "orch");
      }
    },
    [env, ensureNightly],
  );

  // Back in view: pick up what another tab or device saved meanwhile (every screen here gets it).
  useEffect(() => {
    if (!env) return;
    const onShow = () => {
      if (document.visibilityState !== "visible") return;
      void env.os
        .loadDraft()
        .then((d) => {
          if (!d || d.updatedAt === draftRef.current?.updatedAt) return;
          draftRef.current = d;
          setDraft(d);
          publish("draft", d, "orch");
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [env]);

  // Other screens' changes (setup run, quest page) replace what's held here.
  useEffect(() => {
    const a = subscribe("draft", "orch", (d) => {
      draftRef.current = d;
      setDraft(d);
    });
    const b = subscribe("profile", "orch", (p) => {
      profileRef.current = p;
      setProfile(p);
    });
    const c = subscribe("semester", "orch", (s) => {
      semesterRef.current = s;
    });
    return () => {
      a();
      b();
      c();
    };
  }, []);

  // Jobs follow their courses: finished when read, queued ones start when free.
  useEffect(() => {
    if (!env || !draft) return;
    const r = advanceJobs(draft, stateRef.current.jobs);
    if (!r.changed) return;
    saveState((s) => ({ ...s, jobs: r.jobs }));
    if (r.draft !== draft) void commitDesk({ draft: r.draft, profile: profileRef.current! });
  }, [env, draft, saveState, commitDesk]);

  const desk = (): Desk | null => (draftRef.current && profileRef.current ? { draft: draftRef.current, profile: profileRef.current } : null);
  const ready = !!env && !!draft && !!profile && draft.status === "active";

  const nightlySnapshot = (): Record<string, unknown> | undefined => {
    const p = profileRef.current;
    if (!p?.schedule && nightly !== "failed") return undefined;
    const st = nightlySettings(p?.nightly);
    const r = routineRef.current;
    const names = new Map((draftRef.current?.courses ?? []).map((c) => [c.id, c.name]));
    const last = r?.nights[r.nights.length - 1];
    return {
      status: nightly === "failed" ? "couldn't be set up (cloud sessions needed)" : st.paused ? "paused" : `every day at ${st.time} (${p?.schedule?.timeZone})`,
      parts: { grading: st.grading, coursesCheck: st.check, tomorrowsQuest: st.quest },
      deepSweeps: Object.fromEntries([...names].map(([id, n]) => [n, draftRef.current?.sweepDates?.[id] ? `${draftRef.current.sweepDates[id]} (the student's date)` : r?.org[id]?.nextDeepSweep ?? "picked at the next nightly check"])),
      lastNight: last ? { day: last.day, log: last.lines } : null,
    };
  };

  const snapshot = useCallback(
    () =>
      deskSnapshot({
        draft: draftRef.current!,
        profile: profileRef.current!,
        semester: semesterRef.current,
        attempts: masteryRef.current.attempts,
        reviews: masteryRef.current.reviews,
        records: recordsRef.current,
        state: stateRef.current,
        today,
        screen,
        cloudSessions: cloud,
        nightly: nightlySnapshot(),
      }),
    [today, screen, cloud, nightly],
  );

  // ---------- applying changes (from Claude's tools and from cards) ----------
  const applyChange = useCallback(
    async (ops: Array<Record<string, unknown>>, studentWords: string, confirmed: boolean) => {
      const d = desk();
      if (!d || !env) throw new Error("StudyDesk isn't loaded yet.");
      const r = applyOps(d, ops.map((o) => ({ ...o, op: String(o.op ?? "") })), { studentWords, confirmed });
      if (r.change) {
        await commitDesk(r.desk);
        if (r.attempts.length) {
          await env.ms.appendAttempts(r.attempts);
          masteryRef.current = { ...masteryRef.current, attempts: [...masteryRef.current.attempts, ...r.attempts] };
        }
        for (const t of r.targets) await env.ms.putTarget(t);
        saveState((s) => ({ ...s, changes: [...s.changes, r.change!] }));
      }
      return r;
    },
    [env, commitDesk, saveState],
  );

  const launchJob = useCallback(
    async (input: { kind: Job["kind"]; courses: unknown[]; files?: JobFile[]; studentWords: string }) => {
      const d = desk();
      if (!d) throw new Error("StudyDesk isn't loaded yet.");
      const r = startJob(d, input, stateRef.current.jobs);
      if (!r.ok) return r;
      await commitDesk(r.desk);
      saveState((s) => ({ ...s, jobs: [...s.jobs, r.job] }));
      return r;
    },
    [commitDesk, saveState],
  );

  /** Sets today's unstarted blocks aside; Now plans and writes them again from the current desk. */
  const rebuildQuest = useCallback(async (): Promise<string> => {
    if (!env) throw new Error("StudyDesk isn't loaded yet.");
    recordsRef.current = await env.qs.loadRecords();
    const blocks = todaysBlocks(recordsRef.current, today, semesterRef.current?.placementQuestId);
    if (!blocks.length) return "There are no blocks for today yet: they're planned from the current desk when the student opens Now.";
    const open = blocks.filter((b) => !questStarted(b));
    if (!open.length) throw new Error("Every block of today is started already, so none is rewritten. Changes apply from tomorrow's plan.");
    for (const q of open) {
      const replaced = { ...q, progress: { ...q.progress, replacedAt: Date.now(), updatedAt: Date.now() } };
      await env.qs.saveRecord(replaced);
      recordsRef.current = recordsRef.current.map((r) => (r === q ? replaced : r));
    }
    window.dispatchEvent(new CustomEvent("studydesk:quest-replaced"));
    return `Today's blocks are being planned again from the current desk${open.length < blocks.length ? " (the started ones stay)" : ""}; they show on Now in a minute.`;
  }, [env, today]);

  /**
   * A new placement check: the old one is set aside (today's quest too, if it
   * is the placement), optionally with the past stats deleted, and Today
   * offers to start the new one, written from the current desk.
   */
  const redoPlacement = useCallback(
    async (resetStats: boolean) => {
      if (!env) throw new Error("StudyDesk isn't loaded yet.");
      const semester = semesterRef.current ?? (await env.qs.loadSemester());
      if (!semester || semester.source !== "onboarding") throw new Error("There's no set-up semester to write a placement check for.");
      if (resetStats) await env.ms.clearStats();
      recordsRef.current = await env.qs.loadRecords();
      for (const r of recordsRef.current) {
        // The old placement check goes, and today's quest while it isn't started: the new placement comes first.
        if (r.progress.replacedAt || (r.quest.id !== semester.placementQuestId && !(r.quest.date === today && !questStarted(r)))) continue;
        await env.qs.saveRecord({ ...r, progress: { ...r.progress, replacedAt: Date.now(), updatedAt: Date.now() } });
      }
      const next = { ...semester, placementQuestId: undefined };
      semesterRef.current = next;
      await env.qs.saveSemester(next);
      publish("semester", next, "orch");
      await loadData(env);
      window.dispatchEvent(new CustomEvent("studydesk:quest-replaced"));
    },
    [env, today, loadData],
  );

  const addCard = (messageId: string, card: ChatCard) =>
    saveMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, cards: [...(m.cards ?? []), card] } : m)));

  // ---------- keeping dropped files ----------
  const [progress, setProgress] = useState<KeepProgress | null>(null);
  const keepFiles = (files: PendingAttachment[]) =>
    keepDrop(files, env!.os, setBusy, {
      onProgress: setProgress,
      // Each zip is saved as soon as it's kept, so closing the window loses at most the one in progress.
      onZipKept: async (uploads, zip) => {
        if (!draftRef.current || !profileRef.current) return;
        await commitDesk({ draft: { ...draftRef.current, uploads: [...draftRef.current.uploads, ...uploads], zips: [...(draftRef.current.zips ?? []), zip] }, profile: profileRef.current });
      },
    }).finally(() => setProgress(null));

  // ---------- memory ----------
  const summarize = useCallback(async () => {
    if (!env?.live || summarizing.current) return;
    const mem = stateRef.current.memory;
    const seed = mem.updatedAt === 0 ? (draftRef.current?.chat ?? []).map((m) => `${m.role === "user" ? "Student" : "StudyDesk"}: ${m.text}`).join("\n\n").slice(-30_000) : "";
    const fresh = messagesRef.current.filter((m) => m.createdAt > mem.coversUpTo && !m.error);
    if (!seed && !needsSummary(messagesRef.current, mem, today)) return;
    summarizing.current = true;
    try {
      const text = await askClaude(summaryTurns(mem, fresh, seed), { tier: "default", background: true });
      const last = fresh[fresh.length - 1]?.createdAt ?? mem.coversUpTo;
      saveState((s) => ({ ...s, memory: { text: text.trim(), updatedAt: Date.now(), coversUpTo: last, day: today } }));
    } catch {
      // Tried again after the next message.
    } finally {
      summarizing.current = false;
    }
  }, [env, saveState, today]);

  // ---------- one answer ----------
  const send = async (text: string, files: PendingAttachment[], opts: { fromTutor?: boolean } = {}) => {
    if (!env || !ready || busy) return;
    setError(null);
    const userMsg: OrchMessage = { id: uid(), role: "user", text, createdAt: Date.now(), files: files.map((f) => f.name), screen, quote: quote ?? undefined, fromTutor: opts.fromTutor };
    saveMessages((ms) => [...ms, userMsg]);
    onClearQuote();
    const kept: KeptDrop = files.length ? await keepFiles(files) : { uploads: [], zips: [], previews: [], images: [], failed: [], report: null };
    if (kept.uploads.length || kept.zips.length) await commitDesk({ draft: { ...draftRef.current!, uploads: [...draftRef.current!.uploads, ...kept.uploads], zips: [...(draftRef.current!.zips ?? []), ...kept.zips] }, profile: profileRef.current! });
    if (kept.report || kept.uploads.length) saveMessages((ms) => ms.map((m) => (m.id === userMsg.id ? { ...m, intake: kept.report ?? m.intake, uploadIds: kept.uploads.length ? kept.uploads.map((u) => u.id) : m.uploadIds } : m)));
    await ask(text, kept);
  };

  // What each reply was asked with (the files just kept), so "Try again" can ask the same. Not saved.
  const askedWith = useRef(new Map<string, KeptDrop>());

  /** "Try again" on a reply that didn't come through: it's replaced by a new answer to the same message. */
  const resend = (failed: OrchMessage) => {
    if (busy) return;
    const all = messagesRef.current;
    const at = all.findIndex((m) => m.id === failed.id);
    const asked = [...all.slice(0, at)].reverse().find((m) => m.role === "user");
    const kept = askedWith.current.get(failed.id) ?? { uploads: [], zips: [], previews: [], images: [], failed: [], report: null };
    saveMessages((ms) => ms.filter((m) => m.id !== failed.id));
    void ask(asked?.text ?? "", kept);
  };

  const ask = async (text: string, kept: KeptDrop) => {
    if (!env) return;
    const reply: OrchMessage = { id: uid(), role: "assistant", text: "", createdAt: Date.now() + 1 };
    askedWith.current.set(reply.id, kept);
    saveMessages((ms) => [...ms, reply], false);
    setBusy("Thinking…");
    const patch = (p: Partial<OrchMessage>, persist = false) => saveMessages((ms) => ms.map((m) => (m.id === reply.id ? { ...m, ...p } : m)), persist);
    try {
      if (!env.live) {
        patch({ text: await localAnswer(text, applyChange, launchJob, (c) => addCard(reply.id, c)) });
      } else {
        if (!(await canUseTools())) throw new Error("This view can't let StudyDesk make changes. Open StudyDesk on claude.ai in a browser or the desktop app.");
        // As many images as this view allows per question: this turn's first, then earlier ones again.
        const imageRoom = await maxImages();
        const imagesOk = imageRoom > 0;
        const nowIds = new Set(kept.uploads.map((u) => u.id));
        const earlier = imagesOk ? await recallImages(messagesRef.current, draftRef.current!.uploads, kept.images.length, nowIds, (id) => env.os.loadUploadContent(id), Math.min(RECALL_IMAGES, imageRoom)) : { images: [], note: "" };
        const extra = [
          kept.previews.length ? `The student just dropped these files (saved as unsortedFiles). New files start a job: assign each to its course in start_job; a zip as a whole by its zip id, unless its folders clearly hold several courses.\n${kept.previews.join("\n\n")}` : "",
          kept.images.length && !imagesOk ? "Images can't be sent in this view; ask the student what the images show." : "",
          earlier.note,
          kept.failed.length ? `These files couldn't be kept: ${kept.failed.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const c = new AbortController();
        ctl.current = c;
        const turns = orchTurns(stateRef.current.memory, messagesRef.current.filter((m) => m.id !== reply.id), snapshot(), extra);
        const answer = await askClaude(turns, {
          signal: c.signal,
          images: imagesOk ? kept.images : [],
          earlierImages: earlier.images,
          onText: (t) => patch({ text: t }),
          tools: [
            {
              ...CHANGE_TOOL,
              inputSchema: CHANGE_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: async (input) => {
                const ops = Array.isArray(input.changes) ? (input.changes as Array<Record<string, unknown>>) : [];
                const words = String(input.studentWords ?? text);
                const r = await applyChange(ops, words, false);
                if (r.change) addCard(reply.id, { kind: "change", changeId: r.change.id });
                const out: string[] = [];
                if (r.change) out.push(`Applied (the student sees a card with Undo): ${r.change.lines.join("; ")}.`);
                if (r.newCourses.length) out.push(`New course ids: ${r.newCourses.map((x) => `${x.name} = ${x.id}`).join("; ")}. Start a new_course job for them.`);
                if (r.needsConfirm.length) {
                  const pc: PendingConfirm = {
                    id: `cf_${uid()}`,
                    at: Date.now(),
                    question: r.needsConfirm.map((o) => `Drop ${findCourse(draftRef.current!, o.course)?.name ?? String(o.course)}? Its quests stop; its data is kept.`).join(" "),
                    studentWords: words,
                    ops: r.needsConfirm,
                    status: "waiting",
                  };
                  saveState((s) => ({ ...s, confirms: [...s.confirms, pc] }));
                  addCard(reply.id, { kind: "confirm", confirmId: pc.id });
                  out.push("Shown to the student as a yes/no card; it's applied only on their yes. Don't ask again in text.");
                }
                if (r.errors.length) out.push(`Not applied: ${r.errors.join(" ")}`);
                return out.join(" ") || "Nothing changed (already like that).";
              },
            },
            {
              ...JOB_TOOL,
              inputSchema: JOB_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: async (input) => {
                const req = {
                  kind: (["new_material", "new_course", "remap"].includes(String(input.kind)) ? input.kind : "new_material") as Job["kind"],
                  courses: Array.isArray(input.courses) ? (input.courses as unknown[]) : [],
                  files: Array.isArray(input.files) ? (input.files as JobFile[]) : [],
                  studentWords: String(input.studentWords ?? text),
                };
                if (input.rereadAll) {
                  const names = req.courses.map((x) => findCourse(draftRef.current!, x)?.name ?? String(x));
                  const pc: PendingConfirm = { id: `cf_${uid()}`, at: Date.now(), question: `Read everything ${names.join(" and ")} already has again? This takes a few minutes per course.`, studentWords: req.studentWords, ops: [], job: { kind: req.kind, courseIds: names, studentWords: req.studentWords, uploadIds: [] }, status: "waiting" };
                  saveState((s) => ({ ...s, confirms: [...s.confirms, pc] }));
                  addCard(reply.id, { kind: "confirm", confirmId: pc.id });
                  return "Shown to the student as a yes/no card; the job starts only on their yes.";
                }
                const r = await launchJob(req);
                if (!r.ok) throw new Error(r.reason);
                addCard(reply.id, { kind: "job", jobId: r.job.id });
                return `${r.note} Job ${r.job.id}. The student sees its progress on a card; say in one line what you're doing.`;
              },
            },
            { ...READ_FILE_TOOL, inputSchema: READ_FILE_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema, execute: (input) => readKeptFile(input, draftRef.current!.uploads, (id) => env.os.loadUploadContent(id)) },
            {
              ...LOOKUP_TOOL,
              inputSchema: LOOKUP_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: (input) => lookUp(String(input.what), input.course, draftRef.current!, recordsRef.current, masteryRef.current, stateRef.current),
            },
            {
              ...ASK_TOOL,
              inputSchema: ASK_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: (input) => {
                onOpenAsk(String(input.question ?? text));
                return "Opened in Ask, already sent.";
              },
            },
            {
              ...NIGHTLY_TOOL,
              inputSchema: NIGHTLY_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: async () => {
                const s = profileRef.current?.schedule;
                if (!s) return "The nightly run isn't set up (it needs cloud sessions).";
                await runScheduleNow(s);
                return "Started. Results arrive within about 15 minutes, with a \"Last night's run\" message here.";
              },
            },
            {
              ...UPDATE_TOOL,
              inputSchema: UPDATE_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: async (input) => {
                const e = await updateEnv();
                if (!e) return "Updates only work inside StudyDesk on claude.ai.";
                const [doc, release] = await Promise.all([loadUpdates(e), loadRelease(e)]);
                const next = offer(APP_VERSION, release, doc);
                if (input.action === "update") {
                  if (!next) return `No newer release than ${APP_VERSION} is known${release ? ` (newest: ${release.latest})` : ""}. The nightly run checks for new releases every night.`;
                  addCard(reply.id, { kind: "update" });
                  return `Shown: a card with ${next.latest}'s notes and the Update button. Nothing starts until the student presses it. Say so in one line; don't repeat the notes.`;
                }
                if (input.action === "go_back") {
                  const to = goBackTarget(doc);
                  if (!to || doc.lastUpdate?.kind !== "update" || doc.lastUpdate.to !== APP_VERSION) return "There's no earlier version to go back to from here.";
                  addCard(reply.id, { kind: "goback" });
                  return `Shown: a card to go back to ${to}, with the warning that everything done since the update is lost. It happens only if the student confirms on the card. Don't ask again in text.`;
                }
                return {
                  installed: APP_VERSION,
                  newestKnown: release?.latest ?? "not checked yet (the nightly run checks every night)",
                  updateAvailable: next ? next.latest : false,
                  notes: next?.notes ?? null,
                  lastUpdate: doc.lastUpdate ? { kind: doc.lastUpdate.kind, from: doc.lastUpdate.from, to: doc.lastUpdate.to, on: new Date(doc.lastUpdate.at).toISOString().slice(0, 10) } : null,
                  updateRunning: doc.pending ? `${doc.pending.kind} to ${doc.pending.to}` : null,
                };
              },
            },
            {
              ...REBUILD_TOOL,
              inputSchema: REBUILD_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: () => rebuildQuest(),
            },
            {
              ...PLACEMENT_TOOL,
              inputSchema: PLACEMENT_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: (input) => {
                const resetStats = input.resetStats === true;
                const pc: PendingConfirm = {
                  id: `cf_${uid()}`,
                  at: Date.now(),
                  question: resetStats
                    ? "Write a new placement check and delete your past stats (mastery progress, past attempts and the mistake review)? The stats can't be brought back."
                    : "Write a new placement check? Your past stats are kept.",
                  studentWords: text,
                  ops: [],
                  placement: { resetStats },
                  status: "waiting",
                };
                saveState((s) => ({ ...s, confirms: [...s.confirms, pc] }));
                addCard(reply.id, { kind: "confirm", confirmId: pc.id });
                return "Shown to the student as a yes/no card; it happens only on their yes. Don't ask again in text.";
              },
            },
            {
              ...CALENDAR_TOOL,
              inputSchema: CALENDAR_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: async (_input, cx) => {
                setBusy("Reading your calendar…");
                try {
                  const events = await readCalendar(today, 120, cx.signal);
                  await commitDesk({ draft: { ...draftRef.current!, calendarImportedAt: Date.now() }, profile: profileRef.current! });
                  return calendarForClaude(events, today);
                } catch (e) {
                  throw new Error((e as CalendarError).message ?? "The calendar couldn't be read.");
                } finally {
                  setBusy("Thinking…");
                }
              },
            },
          ],
        });
        patch({ text: answer });
      }
    } catch (e) {
      const err = e as AskError;
      patch({ error: err?.code === "cancelled" ? "Stopped." : message(e), text: err?.text ?? messagesRef.current.find((m) => m.id === reply.id)?.text ?? "" });
    } finally {
      ctl.current = null;
      setBusy(null);
      patch({}, true);
      if (!messagesRef.current.find((m) => m.id === reply.id)?.error) askedWith.current.delete(reply.id);
      void summarize();
    }
  };

  // ---------- cards ----------
  const undo = async (change: Change) => {
    const d = desk();
    if (!d) return;
    const r = undoChange(d, change);
    if (!r.ok) return setError(r.reason);
    await commitDesk(r.desk);
    saveState((s) => ({ ...s, changes: s.changes.map((c) => (c.id === change.id ? { ...c, status: "undone" } : c)) }));
  };

  const answerConfirm = async (pc: PendingConfirm, yes: boolean) => {
    saveState((s) => ({ ...s, confirms: s.confirms.map((c) => (c.id === pc.id ? { ...c, status: yes ? "yes" : "no" } : c)) }));
    if (!yes) return;
    const msg: OrchMessage = { id: uid(), role: "assistant", text: "", createdAt: Date.now() };
    try {
      if (pc.placement) {
        await redoPlacement(pc.placement.resetStats);
        saveMessages((ms) => [...ms, { ...msg, text: pc.placement!.resetStats ? "Done: your past stats are deleted. Your new placement check is ready to start on Today." : "Done: your new placement check is ready to start on Today." }]);
      } else if (pc.job) {
        const r = await launchJob({ kind: pc.job.kind, courses: pc.job.courseIds, studentWords: pc.studentWords });
        if (!r.ok) throw new Error(r.reason);
        saveMessages((ms) => [...ms, { ...msg, text: "Started: I'm reading everything again.", cards: [{ kind: "job", jobId: r.job.id }] }]);
      } else {
        const r = await applyChange(pc.ops, pc.studentWords, true);
        saveMessages((ms) => [...ms, { ...msg, text: r.change ? "Done." : `That didn't work: ${r.errors.join(" ")}`, cards: r.change ? [{ kind: "change", changeId: r.change.id }] : [] }]);
      }
    } catch (e) {
      setError(message(e));
    }
  };

  // ---------- the nightly run's results: the organization agent's findings, and a word about the night ----------
  const applyNight = useCallback(async () => {
    if (!env || !draftRef.current || !profileRef.current) return;
    const rs = await openRoutineStore();
    const boxes = outboxOrder((await rs.loadOutbox()).filter((b) => b.kind !== "grading"));
    const changes: Change[] = [];
    if (boxes.length) {
      const now = Date.now();
      let desk: Desk = { draft: draftRef.current, profile: profileRef.current };
      for (const b of boxes) {
        if (b.kind === "org-sweep") desk = applySweep(desk, b, now);
        else if (b.kind === "org-shallow") {
          const r = applyShallow(desk, b, now);
          desk = r.desk;
          if (r.change) changes.push(r.change);
        }
      }
      if (desk.draft !== draftRef.current) await commitDesk(desk);
      if (changes.length) saveState((s) => ({ ...s, changes: [...s.changes, ...changes] }));
      for (const b of boxes) await rs.deleteOutbox(b.id).catch(() => undefined);
    }
    const night = [...((await rs.loadRoutine())?.nights ?? [])].reverse().find((n) => n.status === "done");
    const key = night ? `night:${night.day}:${night.startedAt}` : "";
    if (!night || stateRef.current.notifications.some((n) => n.key === key)) return;
    const text = `**StudyDesk's nightly run (${night.day})**\n\n${night.lines.map((l) => `- ${l}`).join("\n")}`;
    const msg: OrchMessage = { id: uid(), role: "assistant", text, createdAt: Date.now(), checkin: true, cards: changes.map((c) => ({ kind: "change" as const, changeId: c.id })) };
    saveMessages((ms) => [...ms, msg]);
    saveState((s) => ({ ...s, notifications: [...s.notifications, { key, kind: "night", day: today, at: Date.now(), courseId: null, facts: night.lines.join(" "), messageId: msg.id, seenAt: open ? Date.now() : null }] }));
  }, [env, commitDesk, saveState, saveMessages, today, open]);

  // ---------- check-ins: code finds a reason, Claude writes one message ----------
  const runCheckins = useCallback(async () => {
    if (!env || !ready || checking.current || busy) return;
    checking.current = true;
    try {
      await applyNight().catch(() => undefined);
      await loadData(env);
      const semester = semesterRef.current;
      if (!semester || semester.id !== draftRef.current!.id) return;
      const triggers = checkinTriggers({
        semester,
        draft: draftRef.current!,
        attempts: masteryRef.current.attempts,
        reviews: masteryRef.current.reviews,
        records: recordsRef.current,
        jobs: stateRef.current.jobs,
        sent: stateRef.current.notifications,
        today,
      });
      if (!triggers.length) return;
      const facts = triggers.map((t) => t.facts);
      const text = env.live ? await askClaude(checkinTurns(stateRef.current.memory, facts, snapshot()), { background: true }) : localCheckin(facts);
      const msg: OrchMessage = { id: uid(), role: "assistant", text: text.trim(), createdAt: Date.now(), checkin: true };
      saveMessages((ms) => [...ms, msg]);
      const sent: Notification[] = triggers.map((t) => ({ ...t, day: today, at: Date.now(), messageId: msg.id, seenAt: open ? Date.now() : null }));
      saveState((s) => ({ ...s, notifications: [...s.notifications, ...sent] }));
    } catch {
      // Quietly tried again at the next check.
    } finally {
      checking.current = false;
    }
  }, [env, ready, busy, loadData, today, snapshot, saveMessages, saveState, open, applyNight]);

  useEffect(() => {
    if (!ready) return;
    const first = setTimeout(() => void runCheckins(), 4_000);
    const every = setInterval(() => void runCheckins(), CHECKIN_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
    // runCheckins changes with busy/open; the timers only need the latest at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  // After an update (or going back), a short note on what's new, once.
  const announcing = useRef(false);
  useEffect(() => {
    if (!ready || !env || announcing.current) return;
    announcing.current = true;
    (async () => {
      const e = await updateEnv();
      const last = e ? (await loadUpdates(e)).lastUpdate : null;
      if (!last || last.announced || last.to !== APP_VERSION) return;
      let text = plainNote(last);
      if (env.live && last.kind === "update" && last.notes?.trim()) {
        const note = await askClaude(whatsNewTurns(last, stateRef.current.memory.text), { background: true }).catch(() => "");
        if (note.trim()) text = `**StudyDesk is updated to ${last.to}.** All your data came along.\n\n${note.trim()}`;
      }
      await markAnnounced();
      saveMessages((ms) => [...ms, { id: uid(), role: "assistant", text, createdAt: Date.now(), checkin: true }]);
    })().catch(() => {
      announcing.current = false;
    });
  }, [ready, env, saveMessages]);

  // A finished job is worth a word right away.
  const doneJobs = state.jobs.filter((j) => j.status === "done" || j.status === "failed").length;
  useEffect(() => {
    if (ready && doneJobs) void runCheckins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneJobs]);

  // Unseen check-ins show on Tell StudyDesk: a number when StudyDesk needs an answer, a dot for notes. Opening the chat marks them seen.
  const unseen = state.notifications.filter((n) => n.seenAt === null).length;
  const needs = state.notifications.filter((n) => n.seenAt === null && n.kind === "needs_answer").length + state.confirms.filter((c) => c.status === "waiting").length;
  const nightlyTime = profile?.schedule || nightly === "failed" ? nightlySettings(profile?.nightly).time : null;
  useEffect(() => onStatus({ needs, notes: unseen, nightly, nightlyTime }), [needs, unseen, nightly, nightlyTime, onStatus]);
  useEffect(() => {
    if (open && unseen) saveState((s) => ({ ...s, notifications: s.notifications.map((n) => (n.seenAt === null ? { ...n, seenAt: Date.now() } : n)) }));
  }, [open, unseen, saveState]);

  // A remark passed on from elsewhere (the tutor, or "Ask StudyDesk" on a selection) arrives as an event.
  const sendRef = useRef(send);
  sendRef.current = send;
  const passQueue = useRef<PassOn[]>([]);
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    const onPass = (e: Event) => {
      const d = (e as CustomEvent<PassOn>).detail;
      if (!d?.text) return;
      passQueue.current.push(d);
      setQueued((n) => n + 1);
    };
    window.addEventListener(PASS_ON_EVENT, onPass);
    return () => window.removeEventListener(PASS_ON_EVENT, onPass);
  }, []);
  // Remarks are handled one at a time, once the chat is free; each shows on the badge.
  useEffect(() => {
    if (!ready || busy || !passQueue.current.length) return;
    const p = passQueue.current.shift()!;
    setQueued((n) => n - 1);
    if (p.by === "student") {
      // The student's own words from another screen: a plain message of theirs.
      void sendRef.current(`${p.text}\n\n(sent from ${p.where})`, []);
      return;
    }
    saveState((s) => ({ ...s, notifications: [...s.notifications, { key: `pass:${uid()}`, kind: "passed_on", day: today, at: Date.now(), courseId: null, facts: p.text, messageId: null, seenAt: open ? Date.now() : null }] }));
    void sendRef.current(`${p.text}\n\n(said in ${p.where})`, [], { fromTutor: true });
  }, [ready, busy, queued, saveState, today, open]);

  // Opening the panel shows the end of the chat; a sent message moves to the top of the view, with the answer below it.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open]);
  const { tail, tailRef } = useSentToTop(scroller, [...messages].reverse().find((m) => m.role === "user")?.id, !!env);

  // ---------- select-to-reply on the chat ----------
  const blocks = useMemo(() => new Map(messages.filter((m) => m.role === "assistant").map((m) => [m.id, m.text])), [messages]);
  const turnsFor = useCallback((note: Note) => passageNoteTurns(NOTE_RULES, `<context>\nThe passage is in a message of the StudyDesk chat:\n"""\n${blocks.get(note.messageId) ?? ""}\n"""\n</context>`, note), [blocks]);
  const setNotes = useCallback((fn: (n: Note[]) => Note[]) => saveState((s) => ({ ...s, notes: fn(s.notes ?? []) })), [saveState]);
  const notes = useSideNotes({ notes: state.notes ?? [], setNotes, turnsFor });
  const md = (id: string, text: string) => <AnnotatedMarkdown blockId={id} text={text} notes={notes.byBlock.get(id) ?? []} {...notes.handlers} />;

  const names = useMemo(() => new Map((draft?.courses ?? []).map((c) => [c.id, c.name])), [draft]);
  // A change card offers to plan today again while some block isn't started and is older than the change.
  const [rebuilt, setRebuilt] = useState<Record<string, string>>({});
  const todayOpen = todaysBlocks(recordsRef.current, today, semesterRef.current?.placementQuestId).filter((b) => !questStarted(b));
  const rebuildOffer = (c: ChatCard) => {
    if (c.kind !== "change") return undefined;
    const ch = state.changes.find((x) => x.id === c.changeId);
    if (rebuilt[c.changeId]) return { label: rebuilt[c.changeId], run: null };
    if (!ch || ch.status !== "applied" || !todayOpen.some((b) => b.quest.createdAt < ch.at)) return undefined;
    return {
      label: "Plan today again",
      run: () =>
        void rebuildQuest()
          .then((t) => setRebuilt((r) => ({ ...r, [c.changeId]: t.startsWith("Today's blocks are being") ? "Planning today again" : t })))
          .catch((e) => setError(message(e))),
    };
  };
  const deskNow = draft && profile ? { draft, profile } : null;

  const panel = (
    <aside className={"orch" + (dock ? " is-docked" : (open ? " is-open" : "") + (expanded ? " is-expanded" : ""))} aria-label="Tell StudyDesk" aria-hidden={!open}>
      <header className="orch-head">
        <span className="orch-title">
          <Logo />
          Tell StudyDesk
        </span>
        {!dock && (
          <>
        <button type="button" className="icon-btn" onClick={onToggleExpand} aria-label={expanded ? "Back to side panel" : "Expand to full window"} title={expanded ? "Side panel" : "Full window"}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {expanded ? (
              <path d="M6 2.5v3.5H2.5M10 2.5v3.5h3.5M6 13.5V10H2.5M10 13.5V10h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the StudyDesk chat">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
          </>
        )}
      </header>

      <div className="orch-body" ref={scroller} data-select-scope="">
        {error && (
          <p className="quest-error" role="status">
            {error}{" "}
            <button type="button" className="link-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </p>
        )}
        {env && !env.live && <p className="quest-banner">Preview mode: no Claude here. Try "day off {today}" to see a change card.</p>}
        {!env && !error && <p className="quest-muted late-in">Loading…</p>}
        {env && <UpdateNotice md={md} />}
        {env && !ready && (
          <div className="orch-empty">
            <p>Set up your semester first: then you can ask me anything about your courses, dates and progress here, and I'll keep everything up to date.</p>
            <button type="button" className="mini-btn primary" onClick={onOpenSetup}>
              Set up your semester
            </button>
          </div>
        )}
        {ready && messages.length === 0 && (
          <div className="orch-empty">
            <p>Ask me anything about your desk, or tell me what changed: a moved exam, new homework, a day off, a new sheet to read. You can drop files here too.</p>
          </div>
        )}
        {ready &&
          messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="row-user" data-msg={m.id}>
                <div className="bubble">
                  {(m.quote || m.fromTutor) && <div className="orch-quote">{m.fromTutor ? "Passed on by the tutor" : `About: “${m.quote}”`}</div>}
                  {m.text && <div className="bubble-text">{m.text}</div>}
                  {m.files && m.files.length > 0 && <SentFiles names={m.files} />}
                  {m.intake && (
                    <IntakeCard
                      report={m.intake}
                      described={describedVideos(draft?.uploads ?? [])}
                      onChoose={(choice) => saveMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, intake: { ...m.intake!, videoChoice: choice } } : x)))}
                      onDescribe={async (uploadId, note) => {
                        if (!draftRef.current || !profileRef.current) return;
                        await commitDesk({ draft: describeVideo(draftRef.current, uploadId, note), profile: profileRef.current });
                      }}
                    />
                  )}
                </div>
              </div>
            ) : m.error && !m.text && !(m.cards ?? []).length && answeredLater(messages, m.id) ? null : (
              <div key={m.id} className={"row-assistant" + (m.checkin ? " is-checkin" : "")}>
                {m.text ? md(m.id, m.text) : !m.error && <p className="thinking">{busy ?? "…"}</p>}
                {m.error && !answeredLater(messages, m.id) && (
                  <div className="error-line send-failed">
                    <span>{m.error === "Stopped." ? "Stopped." : `${m.error.replace(/\s*Try again\.?$/, "")} Your message and files are saved.`}</span>
                    {!busy && m.id === messages[messages.length - 1]?.id && (
                      <button type="button" className="mini-btn" onClick={() => resend(m)}>
                        Try again
                      </button>
                    )}
                  </div>
                )}
                {deskNow &&
                  (m.cards ?? []).map((c, i) => (
                    <Card key={i} card={c} state={state} desk={deskNow} names={names} md={md} onUndo={undo} onConfirm={answerConfirm} onOpenSetup={onOpenSetup} rebuild={rebuildOffer(c)} />
                  ))}
              </div>
            ),
          )}
        <div ref={tailRef} style={{ height: tail }} aria-hidden="true" />
        <div ref={endRef} />
      </div>

      {ready && (
        <div className="orch-composer">
          {quote && (
            <div className="orch-quote is-pending">
              About: “{quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}”
              <button type="button" className="link-btn" onClick={onClearQuote} aria-label="Remove the quote">
                ×
              </button>
            </div>
          )}
          {progress ? <ImportProgress progress={progress} /> : busy && <p className="quest-muted">{busy}</p>}
          {busy && /^(Keeping|Opening)/.test(busy) && (
            <p className="quest-muted keep-note">This takes a few minutes with a lot of files. Keep this window open until it's done; each finished zip is saved, so closing early only loses the one in progress.</p>
          )}
          <InputBox id="orch-chat" keepAll placeholder="Ask, or tell me what changed. Drop or paste files or course zips." busy={!!busy} autoFocus={open} compact onSend={(t, f) => void send(t, f)} onStop={() => ctl.current?.abort()} />
        </div>
      )}
      <SelectionReply scope={scroller} disabled={false} onAsk={notes.ask} />
    </aside>
  );
  return dock ? createPortal(panel, dock) : panel;
}

// ---------- cards ----------

function Card({
  card,
  state,
  desk,
  names,
  md,
  onUndo,
  onConfirm,
  onOpenSetup,
  rebuild,
}: {
  rebuild?: { label: string; run: (() => void) | null };
  card: ChatCard;
  state: OrchState;
  desk: Desk;
  names: Map<string, string>;
  md: (id: string, text: string) => JSX.Element;
  onUndo: (c: Change) => void;
  onConfirm: (c: PendingConfirm, yes: boolean) => void;
  onOpenSetup: () => void;
}) {
  if (card.kind === "update") return <UpdateNotice md={md} always />;
  if (card.kind === "goback") return <GoBackCard />;
  if (card.kind === "change") {
    const c = state.changes.find((x) => x.id === card.changeId);
    if (!c) return null;
    const undoable = canUndo(desk, c);
    return (
      <div className={"orch-card" + (c.status === "undone" ? " is-undone" : "")}>
        {md(`card-${c.id}`, c.lines.map((l) => `- ${l}`).join("\n"))}
        <div className="orch-card-foot">
          {rebuild &&
            (rebuild.run ? (
              <button type="button" className="mini-btn" onClick={rebuild.run}>
                {rebuild.label}
              </button>
            ) : (
              <span className="quest-muted">{rebuild.label}</span>
            ))}
          {c.status === "undone" ? (
            <span className="quest-muted">Undone</span>
          ) : undoable ? (
            <button type="button" className="mini-btn" onClick={() => onUndo(c)}>
              Undo
            </button>
          ) : (
            <span className="quest-muted">{c.undoable ? "Changed again since" : "Saved"}</span>
          )}
        </div>
      </div>
    );
  }
  if (card.kind === "confirm") {
    const pc = state.confirms.find((x) => x.id === card.confirmId);
    if (!pc) return null;
    return (
      <div className="orch-card is-confirm">
        <p>{pc.question}</p>
        <div className="orch-card-foot">
          {pc.status === "waiting" ? (
            <>
              <button type="button" className="mini-btn primary" onClick={() => onConfirm(pc, true)}>
                Yes
              </button>
              <button type="button" className="mini-btn" onClick={() => onConfirm(pc, false)}>
                No
              </button>
            </>
          ) : (
            <span className="quest-muted">{pc.status === "yes" ? "You said yes" : "You said no"}</span>
          )}
        </div>
      </div>
    );
  }
  const j = state.jobs.find((x) => x.id === card.jobId);
  if (!j) return null;
  const status = (id: string) => desk.draft.courses.find((c) => c.id === id)?.setupStatus;
  return (
    <div className="orch-card is-job">
      <p className="orch-card-title">{jobTitle(j, names)}</p>
      {j.status === "queued" && <p className="quest-muted">Waiting: another reading of this course is still running.</p>}
      {j.status === "running" && (
        <>
          <ul className="orch-job-list">
            {j.courseIds.map((id) => (
              <li key={id}>
                {names.get(id) ?? id}: {status(id) === "reading" ? "reading now…" : status(id) === "waiting" ? "up next" : "done"}
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" onClick={onOpenSetup}>
            Watch it live
          </button>
        </>
      )}
      {(j.status === "done" || j.status === "failed") && md(`job-${j.id}`, j.result.map((l) => `- ${l}`).join("\n"))}
    </div>
  );
}

// ---------- look-ups ----------

function lookUp(what: string, courseRef: unknown, draft: SemesterDraft, records: QuestRecord[], mastery: MasteryData, state: OrchState): unknown {
  const c = courseRef ? findCourse(draft, courseRef) : undefined;
  if (courseRef && !c) return `No course "${String(courseRef)}".`;
  const ids = c ? [c.id] : draft.courses.map((x) => x.id);
  const res = (id: string) => draft.results[id];
  switch (what) {
    case "skills":
      return ids.flatMap((id) => (res(id)?.skills ?? []).filter((s) => s.courseId === id).map((s) => `${s.id}: ${s.name} (${s.isFundamental ? "fundamental, " : ""}${s.difficulty}, tier ${s.tier})`));
    case "homework":
      return ids.flatMap((id) => (res(id)?.assignments ?? []).map((a) => ({ id: a.id, course: id, title: a.title, due: a.dueAt, tasks: a.tasks.map((t) => `${t.label}: ${t.prompt.slice(0, 160)}`) })));
    case "dates":
      return ids.flatMap((id) => (res(id)?.keyDates ?? []).map((k) => `${id} ${k.date} ${k.kind}: ${k.title}`));
    case "facts":
      return draft.facts.filter((f) => !c || f.courseId === c.id).map((f) => `${f.courseId ?? "general"}: ${f.text}`);
    case "files":
      return draft.uploads.filter((u) => !c || u.courseId === c.id).map((u) => `${u.id} ${u.fileName}${u.studentNote ? ` (${u.studentNote})` : ""} → ${u.courseId ?? "unsorted"}`);
    case "timetable":
      return draft.timetable.map((t) => `${DAY_SHORT[t.weekday]} ${t.start}-${t.end} ${t.kind}: ${t.title}`);
    case "quests":
      return [...records]
        .sort((a, b) => (a.quest.date < b.quest.date ? 1 : -1))
        .slice(0, 10)
        .map((r) => {
          const work = Object.values(r.progress.work);
          return `${r.quest.date} ${r.quest.courseId}: planned ${r.quest.plannedMinutes} min, ${work.filter((w) => w.verdict === "solved").length} solved, ${work.filter((w) => w.verdict === "not_understood").length} not yet, ${Math.round(work.reduce((s, w) => s + w.activeSeconds, 0) / 60)} min worked`;
        });
    case "results":
      return (draft.assessments ?? []).filter((r) => !c || r.courseId === c.id).map((r) => `${r.courseId} ${r.date} ${r.component}: ${r.points}/${r.maxPoints}`);
    case "changes":
      return state.changes.slice(-30).map((x) => `${new Date(x.at).toISOString().slice(0, 16)} ${x.status}: ${x.lines.join("; ")}`);
    case "memory":
      return state.memory.text || "(empty)";
    default:
      return `Unknown look-up "${what}".`;
  }
}


/** Local preview stand-in: understands "day off YYYY-MM-DD" so the change card can be tried. */
async function localAnswer(
  text: string,
  apply: (ops: Array<Record<string, unknown>>, words: string, confirmed: boolean) => Promise<{ change: Change | null; errors: string[] }>,
  job: (input: { kind: Job["kind"]; courses: unknown[]; studentWords: string }) => Promise<{ ok: true; job: Job; note: string } | { ok: false; reason: string }>,
  card: (c: ChatCard) => void,
): Promise<string> {
  const rr = /^re-?read (.+)$/i.exec(text.trim());
  if (rr) {
    const r = await job({ kind: "remap", courses: [rr[1]], studentWords: text });
    if (!r.ok) return r.reason;
    card({ kind: "job", jobId: r.job.id });
    return "Reading it again now.";
  }
  const m = /day off (\d{4}-\d{2}-\d{2})/i.exec(text);
  if (m) {
    const r = await apply([{ op: "set_day_off", date: m[1], reason: "" }], text, false);
    if (r.change) card({ kind: "change", changeId: r.change.id });
    return r.change ? "Done, no quest that day." : `That didn't work: ${r.errors.join(" ")}`;
  }
  return "*Local preview: inside claude.ai, StudyDesk answers here and changes your desk from anything you write or drop.* Try \"day off 2026-12-24\" or \"reread <course>\".";
}

/** Whether an assistant reply after this one came through, so its error no longer matters. Pure. */
function answeredLater(messages: OrchMessage[], id: string): boolean {
  const at = messages.findIndex((m) => m.id === id);
  return messages.slice(at + 1).some((m) => m.role === "assistant" && !m.error && !!m.text);
}
