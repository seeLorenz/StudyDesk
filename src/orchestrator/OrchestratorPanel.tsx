import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "../chat/types";
import { uid } from "../chat/types";
import { InputBox } from "../chat/InputBox";
import { SelectionReply } from "../chat/SelectionReply";
import { passageNoteTurns } from "../chat/prompts";
import { readFullText, type PendingAttachment } from "../lib/files";
import { toDay } from "../mastery/days";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
import { useSideNotes } from "../notes/useSideNotes";
import { readCalendar, weeklyPattern, type CalendarError } from "../platform/calendar";
import { askClaude, canSendImages, canUseTools, claudeAvailable, errorCopy, type AskError } from "../platform/claude";
import { publish, subscribe } from "../platform/deskBus";
import { checkHandoff } from "../platform/handoff";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { openOnboardingStore, type OnboardingStore } from "../platform/onboardingStore";
import { openOrchestratorStore, type OrchestratorStore } from "../platform/orchestratorStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { compressImage } from "../quests/images";
import type { QuestRecord, Semester } from "../quests/types";
import type { Profile, SemesterDraft, Upload } from "../onboarding/types";
import { ASK_TOOL, CALENDAR_TOOL, CHANGE_TOOL, checkinTurns, deskSnapshot, JOB_TOOL, jobTitle, localCheckin, LOOKUP_TOOL, needsSummary, orchTurns, summaryTurns } from "./agent";
import { applyOps, canUndo, findCourse, syncSemester, undoChange, type Desk } from "./changes";
import { advanceJobs, startJob, type JobFile } from "./jobs";
import { checkinTriggers } from "./signals";
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

type Props = {
  open: boolean;
  expanded: boolean;
  onClose: () => void;
  onToggleExpand: () => void;
  /** What the student is looking at, e.g. "Today's quest". */
  screen: string;
  /** Text the student selected when they opened the chat. */
  quote: string | null;
  onClearQuote: () => void;
  onUnseen: (n: number) => void;
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
  const { open, expanded, onClose, onToggleExpand, screen, quote, onClearQuote, onUnseen, onOpenAsk, onOpenSetup } = props;
  const [env, setEnv] = useState<Env | null>(null);
  const [draft, setDraft] = useState<SemesterDraft | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<OrchState>(emptyState);
  const [messages, setMessages] = useState<OrchMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"on" | "off" | "unknown">("unknown");
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
    const [mastery, records, semester] = await Promise.all([e.ms.load(), e.qs.loadRecords(), e.qs.loadSemester()]);
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
      await env.os.saveDraft(desk.draft);
      if (profileChanged) await env.os.saveProfile(desk.profile);
      const current = semesterRef.current ?? (await env.qs.loadSemester());
      if (desk.draft.status === "active" && (!current || current.id === desk.draft.id)) {
        const semester = syncSemester(desk.draft, desk.profile, current);
        semesterRef.current = semester;
        await env.qs.saveSemester(semester);
        publish("semester", semester, "orch");
      }
    },
    [env],
  );

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
      }),
    [today, screen, cloud],
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

  const addCard = (messageId: string, card: ChatCard) =>
    saveMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, cards: [...(m.cards ?? []), card] } : m)));

  // ---------- keeping dropped files ----------
  const keepFiles = async (files: PendingAttachment[]) => {
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
          await env!.os.saveUploadContent(id, { image });
          images.push(f.blob);
          previews.push(`File ${id} "${f.name}": image ${images.length} of the attached images.`);
        } else {
          const full = f.file ? await readFullText(f.file, MAX_FILE_CHARS) : { text: f.text ?? "", pages: null, cut: false };
          pages = full.pages;
          await env!.os.saveUploadContent(id, { text: full.text });
          previews.push(`File ${id} "${f.name}"${pages ? `, ${pages} pages` : ""}. Beginning:\n"""\n${full.text.slice(0, PREVIEW_CHARS)}\n"""`);
        }
        const assetId = f.file ? await env!.os.storeOriginal(f.file) : null;
        uploads.push({ id, courseId: null, fileName: f.name, type: f.kind, studentNote: "", addedAt: Date.now(), cataloguedAt: null, assetId, pages });
      } catch (e) {
        failed.push(`${f.name}: ${message(e)}`);
      }
    }
    return { uploads, previews, images, failed };
  };

  // ---------- memory ----------
  const summarize = useCallback(async () => {
    if (!env?.live || summarizing.current) return;
    const mem = stateRef.current.memory;
    const seed = mem.updatedAt === 0 ? (draftRef.current?.chat ?? []).map((m) => `${m.role === "user" ? "Student" : "StudyDesk"}: ${m.text}`).join("\n\n").slice(-30_000) : "";
    const fresh = messagesRef.current.filter((m) => m.createdAt > mem.coversUpTo && !m.error);
    if (!seed && !needsSummary(messagesRef.current, mem, today)) return;
    summarizing.current = true;
    try {
      const text = await askClaude(summaryTurns(mem, fresh, seed), { tier: "default" });
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
    const kept = files.length ? await keepFiles(files) : { uploads: [], previews: [], images: [], failed: [] };
    if (kept.uploads.length) await commitDesk({ draft: { ...draftRef.current!, uploads: [...draftRef.current!.uploads, ...kept.uploads] }, profile: profileRef.current! });
    const reply: OrchMessage = { id: uid(), role: "assistant", text: "", createdAt: Date.now() + 1 };
    saveMessages((ms) => [...ms, reply], false);
    setBusy("Thinking…");
    const patch = (p: Partial<OrchMessage>, persist = false) => saveMessages((ms) => ms.map((m) => (m.id === reply.id ? { ...m, ...p } : m)), persist);
    try {
      if (!env.live) {
        patch({ text: await localAnswer(text, applyChange, launchJob, (c) => addCard(reply.id, c)) });
      } else {
        if (!(await canUseTools())) throw new Error("This view can't let StudyDesk make changes. Open StudyDesk on claude.ai in a browser or the desktop app.");
        const sendImages = (await canSendImages()) ? kept.images : [];
        const extra = [
          kept.previews.length ? `The student just dropped these files (saved as unsortedFiles). New files start a job: assign each to its course in start_job.\n${kept.previews.join("\n\n")}` : "",
          kept.images.length && !sendImages.length ? "Images can't be sent in this view; ask the student what the images show." : "",
          kept.failed.length ? `These files couldn't be kept: ${kept.failed.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const c = new AbortController();
        ctl.current = c;
        const turns = orchTurns(stateRef.current.memory, messagesRef.current.filter((m) => m.id !== reply.id), snapshot(), extra);
        const answer = await askClaude(turns, {
          signal: c.signal,
          images: sendImages,
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
              ...CALENDAR_TOOL,
              inputSchema: CALENDAR_TOOL.inputSchema as unknown as Claude.sample.SampleToolInputSchema,
              execute: async (_input, cx) => {
                setBusy("Reading your calendar…");
                try {
                  const events = await readCalendar(today, 120, cx.signal);
                  const two = events.filter((e) => e.date < addDaysLocal(today, 14));
                  const { weekly } = weeklyPattern(two);
                  const rec = new Set(weekly.map((w) => `${w.title}|${w.weekday}|${w.start}`));
                  const once = events.filter((e) => !e.recurring && !rec.has(`${e.title}|${e.weekday}|${e.start}`)).slice(0, 80);
                  await commitDesk({ draft: { ...draftRef.current!, calendarImportedAt: Date.now() }, profile: profileRef.current! });
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
      if (pc.job) {
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

  // ---------- check-ins: code finds a reason, Claude writes one message ----------
  const runCheckins = useCallback(async () => {
    if (!env || !ready || checking.current || busy) return;
    checking.current = true;
    try {
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
      const text = env.live ? await askClaude(checkinTurns(stateRef.current.memory, facts, snapshot()), {}) : localCheckin(facts);
      const msg: OrchMessage = { id: uid(), role: "assistant", text: text.trim(), createdAt: Date.now(), checkin: true };
      saveMessages((ms) => [...ms, msg]);
      const sent: Notification[] = triggers.map((t) => ({ ...t, day: today, at: Date.now(), messageId: msg.id, seenAt: open ? Date.now() : null }));
      saveState((s) => ({ ...s, notifications: [...s.notifications, ...sent] }));
    } catch {
      // Quietly tried again at the next check.
    } finally {
      checking.current = false;
    }
  }, [env, ready, busy, loadData, today, snapshot, saveMessages, saveState, open]);

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
  // A finished job is worth a word right away.
  const doneJobs = state.jobs.filter((j) => j.status === "done" || j.status === "failed").length;
  useEffect(() => {
    if (ready && doneJobs) void runCheckins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneJobs]);

  // Unseen check-ins show as a badge; opening the chat marks them seen.
  const unseen = state.notifications.filter((n) => n.seenAt === null).length;
  useEffect(() => onUnseen(unseen), [unseen, onUnseen]);
  useEffect(() => {
    if (open && unseen) saveState((s) => ({ ...s, notifications: s.notifications.map((n) => (n.seenAt === null ? { ...n, seenAt: Date.now() } : n)) }));
  }, [open, unseen, saveState]);

  // A remark passed on from elsewhere (the tutor, or "Ask StudyDesk" on a selection) arrives as an event.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onPass = (e: Event) => {
      const d = (e as CustomEvent<{ text: string }>).detail;
      if (d?.text) void sendRef.current(d.text, [], { fromTutor: true });
    };
    window.addEventListener("studydesk:pass-on", onPass);
    return () => window.removeEventListener("studydesk:pass-on", onPass);
  }, []);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open, messages.length]);

  // ---------- select-to-reply on the chat ----------
  const blocks = useMemo(() => new Map(messages.filter((m) => m.role === "assistant").map((m) => [m.id, m.text])), [messages]);
  const turnsFor = useCallback((note: Note) => passageNoteTurns(NOTE_RULES, `<context>\nThe passage is in a message of the StudyDesk chat:\n"""\n${blocks.get(note.messageId) ?? ""}\n"""\n</context>`, note), [blocks]);
  const setNotes = useCallback((fn: (n: Note[]) => Note[]) => saveState((s) => ({ ...s, notes: fn(s.notes ?? []) })), [saveState]);
  const notes = useSideNotes({ notes: state.notes ?? [], setNotes, turnsFor });
  const md = (id: string, text: string) => <AnnotatedMarkdown blockId={id} text={text} notes={notes.byBlock.get(id) ?? []} {...notes.handlers} />;

  const names = useMemo(() => new Map((draft?.courses ?? []).map((c) => [c.id, c.name])), [draft]);
  const deskNow = draft && profile ? { draft, profile } : null;

  return (
    <aside className={"orch" + (open ? " is-open" : "") + (expanded ? " is-expanded" : "")} aria-label="StudyDesk chat" aria-hidden={!open}>
      <header className="orch-head">
        <span className="orch-title">
          <span className="brand-mark" aria-hidden="true" />
          StudyDesk
        </span>
        <button type="button" className="icon-btn" onClick={onToggleExpand} aria-label={expanded ? "Back to side panel" : "Expand to full window"} title={expanded ? "Side panel" : "Full window"}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {expanded ? (
              <path d="M6 2.5v3.5H2.5M10 2.5v3.5h3.5M6 13.5V10H2.5M10 13.5V10h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close StudyDesk chat">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
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
        {!env && !error && <p className="quest-muted">Loading…</p>}
        {env && !ready && (
          <div className="orch-empty">
            <p>Set up your semester first: then you can ask me anything about your courses, dates and progress here, and I'll keep everything up to date.</p>
            <button type="button" className="mini-btn primary" onClick={onOpenSetup}>
              Start New Semester
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
              <div key={m.id} className="row-user">
                <div className="bubble">
                  {(m.quote || m.fromTutor) && <div className="orch-quote">{m.fromTutor ? "Passed on by the tutor" : `About: “${m.quote}”`}</div>}
                  {m.text && <div className="bubble-text">{m.text}</div>}
                  {m.files && m.files.length > 0 && <div className="setup-files">{m.files.map((f) => `📎 ${f}`).join("  ")}</div>}
                </div>
              </div>
            ) : (
              <div key={m.id} className={"row-assistant" + (m.checkin ? " is-checkin" : "")}>
                {m.text ? md(m.id, m.text) : !m.error && <p className="thinking">{busy ?? "…"}</p>}
                {m.error && <p className="error-line">{m.error}</p>}
                {deskNow &&
                  (m.cards ?? []).map((c, i) => (
                    <Card key={i} card={c} state={state} desk={deskNow} names={names} md={md} onUndo={undo} onConfirm={answerConfirm} onOpenSetup={onOpenSetup} />
                  ))}
              </div>
            ),
          )}
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
          {busy && <p className="quest-muted">{busy}</p>}
          <InputBox id="orch-chat" placeholder="Ask, or tell me what changed. Drop or paste files." busy={!!busy} autoFocus={open} compact onSend={(t, f) => void send(t, f)} onStop={() => ctl.current?.abort()} />
        </div>
      )}
      <SelectionReply scope={scroller} disabled={false} onAsk={notes.ask} />
    </aside>
  );
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
}: {
  card: ChatCard;
  state: OrchState;
  desk: Desk;
  names: Map<string, string>;
  md: (id: string, text: string) => JSX.Element;
  onUndo: (c: Change) => void;
  onConfirm: (c: PendingConfirm, yes: boolean) => void;
  onOpenSetup: () => void;
}) {
  if (card.kind === "change") {
    const c = state.changes.find((x) => x.id === card.changeId);
    if (!c) return null;
    const undoable = canUndo(desk, c);
    return (
      <div className={"orch-card" + (c.status === "undone" ? " is-undone" : "")}>
        {md(`card-${c.id}`, c.lines.map((l) => `- ${l}`).join("\n"))}
        <div className="orch-card-foot">
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

function addDaysLocal(day: string, n: number): string {
  const d = new Date(`${day}T12:00`);
  d.setDate(d.getDate() + n);
  return toDay(d);
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
