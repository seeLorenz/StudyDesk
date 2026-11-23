import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "../chat/types";
import { ChatView } from "../chat/ChatView";
import { SelectionReply } from "../chat/SelectionReply";
import { passageNoteTurns } from "../chat/prompts";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
import { useSideNotes } from "../notes/useSideNotes";
import { CONFIG } from "../mastery/config";
import { addDays, daysBetween, toDay } from "../mastery/days";
import { answerSlip, GradingFailed } from "../mastery/grading";
import { questBonus, replay } from "../mastery/replay";
import { askClaude, claudeAvailable, errorCopy, type AskError } from "../platform/claude";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { QUEST_CONFIG, partMinutes } from "./config";
import { allHandedIn, answerUnlocked, emptyProgress, emptyWork, handIn, isFinished, questStarted, ungraded } from "./handin";
import { carriedOver, formatDue, recentFeel } from "./plan";
import { ProblemCard, clock as clockText } from "./ProblemCard";
import { sampleGradingAsk, sampleSemester, sampleWriter } from "./seed";
import type { AnswerFile, ProblemPart, ProblemWork, Quest, QuestPart, QuestProgress, QuestRecord, Rating, Semester } from "./types";
import type { Chat } from "../chat/types";
import { claudeWriter, writeQuest, type WriteStatus } from "./write";
import { compressImage, dataUrlToBlob } from "./images";
import { applyChecks, checkResults, isResolved, newReviewChat, questMistakes, reviewRules } from "./review";
import { WorkloadCard } from "../onboarding/WorkloadCard";
import type { SemesterDraft } from "../onboarding/types";
import { busyFromAhead, spansFromAhead, type CalendarAhead } from "../platform/calendar";
import { publish, subscribe } from "../platform/deskBus";
import { openOnboardingStore } from "../platform/onboardingStore";
import { openRoutineStore } from "../platform/routineStore";
import { gradingFields, mergeGrading, type GradingOutbox } from "../routine/apply";
import { nightlySettings } from "../routine/nightly";
import { passOn } from "../orchestrator/passOn";
import { duration, hhmm, toMinute } from "../plan/clock";
import { DAY_PLAN, dueLine, needsQuest, planDays, recordOnDay, recordsOnDay, shortDate, whyLine, type PlannedBlock } from "../plan/day";
import { questsForDay, type BlockQuest } from "../plan/build";
import { quickQuestions } from "../plan/questions";
import { today as todayLine, type BlockState } from "../plan/today";
import { ExamRail, NowCard, QuickAnswers, RailNote, Timeline, type BlockView, type LaterChoice } from "../now/parts";

// The quest page: builds today's quest on the first open of the day (the
// in-page fallback from the design), then lets the student work through it
// part by part and hand each problem part in to the grading agent.
// Rough on purpose: the overall app layout comes later.

type Data = {
  qs: QuestStore;
  ms: MasteryStore;
  semester: Semester;
  records: QuestRecord[];
  reviewChats: Record<string, Chat>;
  mastery: MasteryData;
  live: boolean;
  /** The nightly run is set up (grading at 22:00, tomorrow's blocks overnight). */
  nightly: boolean;
  /** Its time, "22:00", when it's set up. */
  nightlyTime: string | null;
  /** The setup sheet, for the open questions (quick answers). */
  draft: SemesterDraft | null;
  /** The calendar's last read: busy time per day, for the clock. */
  calendar: CalendarAhead | null;
};

/** Tonight's grades for the quest that's open, handed to it so it merges them into its own copy. */
const GRADES_EVENT = "studydesk:nightly-grades";

/**
 * Merges grades the nightly run left in the outbox. The quest that's open on
 * screen takes them over itself (it holds the newest copy of the work); the
 * others are merged and saved here. Each outbox document is deleted once it's in.
 */
async function applyNightlyGrades(qs: QuestStore, records: QuestRecord[], openQuestId: string | null): Promise<{ records: QuestRecord[]; applied: number }> {
  const rs = await openRoutineStore();
  const boxes = (await rs.loadOutbox()).filter((b): b is GradingOutbox => b.kind === "grading");
  let out = records;
  for (const box of boxes) {
    const rec = out.find((r) => r.quest.id === box.questId);
    if (rec && rec.quest.id === openQuestId) window.dispatchEvent(new CustomEvent(GRADES_EVENT, { detail: box }));
    else if (rec) {
      const merged = mergeGrading(rec, box, Date.now());
      if (merged !== rec) {
        await qs.saveRecord(merged);
        out = out.map((r) => (r === rec ? merged : r));
      }
    }
    await rs.deleteOutbox(box.id).catch(() => undefined);
  }
  return { records: out, applied: boxes.length };
}

function nowLocal(d = new Date()): string {
  return `${toDay(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * This browser's copy of the work against the saved one: the newer wins, but a browser copy
 * holding hand-ins the saved copy lacks (its last save didn't get through, and the saved copy
 * was stamped newer since, say by the night's grades) keeps them, with the saved grades merged in.
 */
function pickDraft(d: QuestProgress, rec: QuestProgress): QuestProgress {
  if (d.updatedAt > rec.updatedAt) return d;
  if (rec.replacedAt || d.handedIn.every((id) => rec.handedIn.includes(id))) return rec;
  const work = { ...d.work };
  for (const [pid, w] of Object.entries(rec.work)) {
    if (w.verdict && !work[pid]?.verdict) work[pid] = { ...(work[pid] ?? w), ...gradingFields(w) };
  }
  const handedIn = [...new Set([...rec.handedIn, ...d.handedIn])];
  return { ...d, work, handedIn, finishedAt: rec.finishedAt ?? d.finishedAt, updatedAt: Date.now() };
}

function message(e: unknown): string {
  if (e instanceof GradingFailed) return "The grading agent's answer couldn't be used, even after a retry. Try handing in again.";
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return errorCopy(e as AskError);
  return e instanceof Error ? e.message : "Something went wrong.";
}

const WEEKDAY = (day: string) => new Date(`${day}T12:00`).toLocaleDateString("en", { weekday: "long" });

/** A testing tool picked in the sidebar's menu; `id` changes each time it's picked. */
export type QuestCommand = { id: number; kind: "build" | "restart" };

/** Blocks being written right now, in the order they're written. */
type Building = { items: Array<{ key: string; quest: Quest; status: Record<string, WriteStatus>; state: "waiting" | "writing" | "done" | "failed" }> };

/** Per-day choices only this browser needs: blocks pushed to later today, blocks hidden for today. */
type DayPrefs = { day: string; later: Record<string, number>; hidden: string[] };
const PREFS_KEY = "studydesk.dayprefs";
function loadPrefs(day: string): DayPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null") as DayPrefs | null;
    if (p && p.day === day) return p;
  } catch {
    /* none kept */
  }
  return { day, later: {}, hidden: [] };
}
function savePrefs(p: DayPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* only for this page load */
  }
}

const minuteOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const KIND = { learn: "Learn", lesson: "Learn & try", practice: "Practice", assignment: "Homework" } as const;
const kindLabel = (p: QuestPart) => (p.kind !== "learn" && p.check ? "Placement check" : KIND[p.kind]);

/** The title a block shows: its homework, else its first lesson, else its first part. */
function blockTitle(q: Quest, courseName: string): string {
  return q.parts.find((p) => p.kind === "assignment")?.title ?? q.parts.find((p) => p.kind === "lesson")?.title ?? q.parts[0]?.title ?? courseName;
}

const minutesLeft = (q: Quest, p: QuestProgress) => q.parts.filter((x) => !p.handedIn.includes(x.id)).reduce((s, x) => s + partMinutes(x), 0);

export function QuestPage({
  onStartSetup,
  onOpenWeek,
  onOpenTodo,
  command,
}: {
  onStartSetup: () => void;
  onOpenWeek: () => void;
  onOpenTodo: () => void;
  command?: QuestCommand | null;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const autoBuilt = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const today = toDay(clock);
  const [prefs, setPrefs] = useState<DayPrefs>(() => loadPrefs(toDay()));
  const updatePrefs = (fn: (p: DayPrefs) => DayPrefs) =>
    setPrefs((p) => {
      const next = fn(p.day === today ? p : { day: today, later: {}, hidden: [] });
      savePrefs(next);
      return next;
    });

  // The clock moves the plan along: what's "now", what moved.
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback((useSample = false) => {
    (async () => {
      const [qs, ms, live] = await Promise.all([openQuestStore(), openMasteryStore(), claudeAvailable()]);
      let semester = await qs.loadSemester();
      if (!semester && !useSample) {
        // A new student: StudyDesk needs Start New Semester before it can plan anything.
        setNeedsSetup(true);
        return;
      }
      if (!semester) {
        semester = sampleSemester(toDay(), Date.now(), { more: true });
        await qs.saveSemester(semester);
      }
      setNeedsSetup(false);
      const mastery = await ms.load();
      const newSkills = semester.skills.filter((s) => !mastery.skills.some((x) => x.id === s.id));
      if (newSkills.length) {
        await ms.putSkills(newSkills);
        mastery.skills.push(...newSkills);
      }
      for (const t of semester.targets) {
        if (!mastery.targets.some((x) => x.courseId === t.courseId)) {
          await ms.putTarget(t);
          mastery.targets.push(t);
        }
      }
      const onboarding = await openOnboardingStore().catch(() => null);
      const [loaded, reviewChats, profile, draft, calendar] = await Promise.all([
        qs.loadRecords(),
        qs.loadReviewChats(),
        onboarding ? onboarding.loadProfile().catch(() => null) : null,
        onboarding ? onboarding.loadDraft().catch(() => null) : null,
        qs.loadCalendar().catch(() => null),
      ]);
      // Grades from the nightly run come in before anything is shown.
      const { records } = await applyNightlyGrades(qs, loaded, null).catch(() => ({ records: loaded }));
      setData({
        qs,
        ms,
        semester,
        records,
        reviewChats,
        mastery,
        live,
        nightly: !!profile?.schedule,
        nightlyTime: profile?.schedule ? nightlySettings(profile.nightly).time : null,
        draft: draft && draft.id === semester.id ? draft : null,
        calendar,
      });
    })().catch((e) => setLoadError(message(e)));
  }, []);
  useEffect(() => load(), [load]);
  // While the page is open (say at 22:00), the night's grades arrive within a few minutes.
  const dataRef = useRef(data);
  dataRef.current = data;
  const openRecordId = useRef<string | null>(null);
  useEffect(() => {
    const tick = async () => {
      const d = dataRef.current;
      if (!d || document.visibilityState === "hidden") return;
      const res = await applyNightlyGrades(d.qs, d.records, openRecordId.current).catch(() => null);
      if (!res?.applied) return;
      const mastery = await d.ms.load();
      setData((x) => (x ? { ...x, records: x.records.map((r) => res.records.find((y) => y.quest.id === r.quest.id) ?? r), mastery } : x));
    };
    const every = setInterval(() => void tick(), 5 * 60_000);
    return () => clearInterval(every);
  }, []);
  // Work handed in on an earlier day that no nightly run graded (no cloud sessions, or the run failed): graded now, once.
  const leftoversTried = useRef(false);
  const [leftovers, setLeftovers] = useState<string | null>(null);
  useEffect(() => {
    if (!data || leftoversTried.current) return;
    leftoversTried.current = true;
    const todo = data.records.filter((r) => !r.progress.replacedAt && r.quest.date < today && r.quest.id !== data.semester.placementQuestId && ungraded(r.quest, r.progress).length);
    if (!todo.length) return;
    void (async () => {
      setLeftovers(`Grading work from ${[...new Set(todo.map((r) => WEEKDAY(r.quest.date)))].join(", ")} that wasn't graded overnight…`);
      try {
        for (const r of todo) {
          const problems = ungraded(r.quest, r.progress);
          const images: Record<string, Blob[]> = {};
          for (const { problem } of problems) {
            const stored = (r.progress.work[problem.id]?.files ?? []).filter((f) => f.kind === "image" && f.stored);
            const blobs: Blob[] = [];
            for (const f of stored) {
              const url = await data.qs.loadImage(f.id).catch(() => null);
              if (url) blobs.push(dataUrlToBlob(url));
            }
            if (blobs.length) images[problem.id] = blobs;
          }
          const res = await handIn({ quest: r.quest, problems, work: r.progress.work, images, semester: data.semester, today, nowLocal: nowLocal(), ask: data.live ? askClaude : sampleGradingAsk });
          await data.ms.appendAttempts(res.attempts);
          for (const rv of res.reviews) await data.ms.putReview(rv);
          const progress = { ...r.progress, work: { ...r.progress.work, ...res.work }, updatedAt: Date.now() };
          if (!progress.finishedAt && isFinished(r.quest, progress)) progress.finishedAt = Date.now();
          const rec = { ...r, progress };
          await data.qs.saveRecord(rec);
          setData((x) =>
            x ? { ...x, records: x.records.map((y) => (y.quest.id === rec.quest.id ? rec : y)), mastery: { ...x.mastery, attempts: [...x.mastery.attempts, ...res.attempts], reviews: [...x.mastery.reviews, ...res.reviews] } } : x,
          );
        }
        setLeftovers(null);
      } catch (e) {
        setLeftovers(`Earlier work couldn't be graded yet: ${message(e)} It's tried again next time.`);
      }
    })();
  }, [data, today]);
  // "Rebuild today's blocks" from the StudyDesk chat: reload, and the newest plan is written.
  useEffect(() => {
    const onReplaced = () => {
      autoBuilt.current = null;
      setOpenKey(null);
      load();
    };
    window.addEventListener("studydesk:quest-replaced", onReplaced);
    return () => window.removeEventListener("studydesk:quest-replaced", onReplaced);
  }, [load]);
  // A change through the StudyDesk chat (a new date, a day off, an answer) shows up here at once.
  useEffect(() => subscribe("semester", "quests", (semester) => setData((d) => (d && d.semester.id === semester.id ? { ...d, semester } : d))), []);
  useEffect(() => subscribe("draft", "quests", (draft) => setData((d) => (d && d.semester.id === draft.id ? { ...d, draft } : d))), []);

  /** Set up through onboarding, but the placement check hasn't been written yet. */
  const needsPlacement = !!data && data.semester.source === "onboarding" && !data.semester.placementQuestId;
  /** The placement check is graded and the workload recommendation is waiting for an answer. */
  const workloadDue = useMemo(() => {
    if (!data) return false;
    const s = data.semester;
    if (s.source !== "onboarding" || !s.placementQuestId || s.placementQuestId === "none" || s.studyGoalDecidedAt) return false;
    const r = data.records.find((x) => x.quest.id === s.placementQuestId);
    return !!r && isFinished(r.quest, r.progress);
  }, [data]);

  /** Graded quests and earlier days' blocks, newest first. */
  const archive = useMemo(
    () =>
      (data?.records ?? [])
        .filter((r) => !r.progress.replacedAt)
        .filter((r) => r.quest.id !== data?.semester.placementQuestId || isFinished(r.quest, r.progress))
        .filter((r) => isFinished(r.quest, r.progress) || (r.quest.date < today && r.progress.deferredTo !== today))
        .sort((a, b) => b.quest.createdAt - a.quest.createdAt),
    [data, today],
  );
  /** The newest graded quest with mistakes gets the mistake review, today's first block. */
  const review = useMemo(() => {
    if (!data) return null;
    for (const r of archive) {
      if (!isFinished(r.quest, r.progress)) continue;
      const skills = new Map(data.semester.skills.map((s) => [s.id, s]));
      const mistakes = questMistakes(r.quest, r.progress, skills, data.semester.assignments, nowLocal());
      return mistakes.length ? { record: r, mistakes } : null;
    }
    return null;
  }, [archive, data]);
  const openMistakes = review ? review.mistakes.filter((m) => !isResolved(m, data!.mastery.reviews)).length : 0;
  const [openArchived, setOpenArchived] = useState<string | null>(null);
  const [showAllArchive, setShowAllArchive] = useState(false);

  // ---- the plan: today on the clock, and four weeks of exams ----
  const nl = nowLocal(clock);
  const plan = useMemo(() => {
    if (!data) return null;
    const fixKey = `fix:${today}`;
    const fix = review && openMistakes && !prefs.hidden.includes(fixKey) ? { courseId: review.record.quest.courseId, count: openMistakes } : null;
    return planDays({ semester: data.semester, today, nowLocal: nl, attempts: data.mastery.attempts, reviews: data.mastery.reviews, records: data.records, days: 1, calendarBusy: (d) => busyFromAhead(data.calendar, d), fix }).days[0];
  }, [data, today, nl, review, openMistakes, prefs.hidden]);
  const weeks = useMemo(
    () =>
      data
        ? planDays({ semester: data.semester, today, nowLocal: `${today}T00:00`, attempts: data.mastery.attempts, reviews: data.mastery.reviews, records: data.records, days: DAY_PLAN.horizonDays, calendarBusy: (d) => busyFromAhead(data.calendar, d) })
        : null,
    [data, today],
  );

  const pending = new Map((building?.items ?? []).filter((i) => i.state !== "done").map((i) => [i.key, i]));
  const blocks = (plan?.blocks ?? []).filter((b) => !prefs.hidden.includes(b.key) && (!needsQuest(b) || pending.has(b.key)));
  const courseName = (id: string) => data?.semester.courses.find((c) => c.id === id)?.name ?? id;
  const courseShort = (id: string) => {
    const c = data?.semester.courses.find((x) => x.id === id);
    return c?.short || c?.name.slice(0, 2) || "?";
  };

  const recordOf = (b: PlannedBlock): QuestRecord | null => (b.recordId ? data?.records.find((r) => r.quest.id === b.recordId) ?? null : null);
  const blockState = (b: PlannedBlock): BlockState => {
    const later = prefs.later[b.key];
    if (b.kind === "fix") {
      const chat = review ? data?.reviewChats[review.record.quest.id] : undefined;
      return { done: openMistakes === 0, started: !!chat?.messages.some((m) => m.role === "user"), laterAt: later };
    }
    const r = recordOf(b);
    if (!r) return { done: false, started: false, laterAt: later };
    if (b.kind === "check") {
      const parts = r.quest.parts.filter((p) => b.partIds?.includes(p.id));
      const done = parts.every((p) => r.progress.handedIn.includes(p.id));
      const started = parts.some((p) => p.kind !== "learn" && p.problems.some((q) => (r.progress.work[q.id]?.activeSeconds ?? 0) > 0 || !!r.progress.work[q.id]?.answerText.trim()));
      return { done, started, laterAt: later };
    }
    return { done: allHandedIn(r.quest, r.progress), started: questStarted(r), laterAt: later };
  };
  const remaining = (b: PlannedBlock): number => {
    const r = recordOf(b);
    if (!r || b.kind === "fix") return b.minutes;
    if (b.kind === "check") return r.quest.parts.filter((p) => b.partIds?.includes(p.id) && !r.progress.handedIn.includes(p.id)).reduce((s, p) => s + partMinutes(p), 0) || b.minutes;
    return minutesLeft(r.quest, r.progress);
  };

  const views = useMemo(() => {
    const m = new Map<string, BlockView>();
    if (!data) return m;
    for (const b of blocks) {
      const course = courseName(b.courseId);
      const why = whyLine(b, today, data.semester);
      const base = { block: b, course, short: courseShort(b.courseId), why, minutesLeft: remaining(b), preparing: false };
      const r = recordOf(b);
      if (b.kind === "fix" && review) {
        const skills = new Map(data.semester.skills.map((s) => [s.id, s]));
        m.set(b.key, {
          ...base,
          title: `${openMistakes} ${openMistakes === 1 ? "mistake" : "mistakes"} from ${WEEKDAY(review.record.quest.date)}`,
          reason: "Understand each one, then solve a fresh problem on your own: that's what moves the streak again.",
          steps: review.mistakes.slice(0, 4).map((x) => ({ label: "Mistake", title: skills.get(x.problem.skillId)?.name ?? "A problem", minutes: DAY_PLAN.fixPerMistake, done: isResolved(x, data.mastery.reviews) })),
        });
      } else if (b.kind === "check" && r) {
        const parts = r.quest.parts.filter((p): p is ProblemPart => p.kind !== "learn" && !!b.partIds?.includes(p.id));
        const n = parts.reduce((s, p) => s + p.problems.length, 0);
        m.set(b.key, {
          ...base,
          title: "Where you stand",
          reason: `${n} short ${n === 1 ? "problem" : "problems"}, one per skill: the basics and what's been taught so far. Skip what you can't do; a gap only tells StudyDesk where to start.`,
          steps: parts.map((p) => ({ label: "Placement check", title: `${p.problems.length} short problems`, minutes: partMinutes(p), done: r.progress.handedIn.includes(p.id) })),
        });
      } else if (r) {
        m.set(b.key, {
          ...base,
          title: blockTitle(r.quest, course),
          reason: r.quest.reason,
          steps: r.quest.parts.slice(0, 4).map((p) => ({ label: kindLabel(p), title: p.title, minutes: partMinutes(p), done: r.progress.handedIn.includes(p.id) })),
        });
      } else {
        const p = pending.get(b.key);
        m.set(b.key, {
          ...base,
          title: p ? blockTitle(p.quest, course) : course,
          reason: p?.quest.reason ?? "",
          steps: (p?.quest.parts ?? []).slice(0, 4).map((x) => ({ label: kindLabel(x), title: x.title, minutes: partMinutes(x), done: false })),
          preparing: true,
        });
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks.map((b) => b.key).join("|"), data, today, review, openMistakes, building]);

  const todayRecords = data ? recordsOnDay(data.records, today, data.semester.placementQuestId) : [];
  const madeToday = todayRecords.map((r) => r.quest.createdAt).filter((t) => toDay(new Date(t)) === today);
  const line = data
    ? todayLine({
        blocks,
        state: blockState,
        timetable: data.semester.timetable,
        weekday: clock.getDay(),
        calendar: spansFromAhead(data.calendar, today),
        now: minuteOf(clock),
        nightlyAt: data.nightlyTime ? toMinute(data.nightlyTime) : null,
        remaining,
        anchor: madeToday.length && madeToday.length === todayRecords.length ? minuteOf(new Date(Math.min(...madeToday))) : null,
      })
    : null;

  // ---- writing today's blocks ----
  const knownSkillIds = (mastery: MasteryData) => {
    const { states } = replay(mastery.skills, mastery.attempts, mastery.reviews);
    return [...states.values()].filter((s) => s.stage === "mastered" || s.stage === "retained").map((s) => s.skillId);
  };
  const buildDay = useCallback(
    async (opts: { anyway?: number } = {}) => {
      if (!data) return;
      setBuildError(null);
      const { semester, records, mastery } = data;
      const ctx = { semester, nowLocal: nowLocal(), attempts: mastery.attempts, reviews: mastery.reviews, records, now: Date.now() };
      let list: BlockQuest[];
      if (opts.anyway) {
        // A block on a day the plan has no time for, because the student asked.
        const exam = weeks?.exams.find((e) => e.status !== "needs_you");
        const courseId = exam?.courseId ?? semester.courses[0]?.id;
        if (!courseId) return;
        const block: PlannedBlock = { key: `extra:${courseId}:${today}`, kind: exam ? "exam" : "new", courseId, minutes: opts.anyway, day: today, rank: 6, tone: exam ? "exam" : "plain", examKeys: exam ? [exam.key] : [] };
        list = questsForDay({ day: today, budget: opts.anyway, blocks: [block] }, ctx);
      } else {
        if (!plan) return;
        list = questsForDay(plan, ctx);
      }
      if (!list.length) return;
      const items: Building["items"] = list.map((x) => ({ key: x.block.key, quest: x.quest, status: {}, state: "waiting" }));
      setBuilding({ items });
      const known = knownSkillIds(mastery);
      const feel = recentFeel(records, (id) => semester.skills.find((s) => s.id === id)?.name, today);
      const mark = (key: string, patch: Partial<Building["items"][number]>) =>
        setBuilding((b) => (b ? { items: b.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) } : b));
      for (const { block, quest: planned } of list) {
        mark(block.key, { state: "writing" });
        try {
          const carried = carriedOver(records, planned);
          if (carried.length) planned.notes.unshift(`Carried over from ${WEEKDAY(carried[0].from)}, when it wasn't finished: ${carried.map((c) => c.label).join(", ")}.`);
          const writer = data.live ? claudeWriter(semester, planned, known, askClaude, undefined, feel) : sampleWriter(semester.skills);
          const quest = await writeQuest(planned, writer, (s) => setBuilding((b) => (b ? { items: b.items.map((i) => (i.key === block.key ? { ...i, status: { ...i.status, [s.partId]: s } } : i)) } : b)));
          const record = { quest, progress: emptyProgress(quest.id) };
          await data.qs.saveRecord(record);
          setData((d) => (d ? { ...d, records: [...d.records, record] } : d));
          mark(block.key, { state: "done" });
        } catch (e) {
          mark(block.key, { state: "failed" });
          setBuildError(`${courseName(block.courseId)} couldn't be prepared: ${message(e)}`);
        }
      }
      setBuilding((b) => (b && b.items.every((i) => i.state === "done") ? null : b));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, plan, weeks, today],
  );

  useEffect(() => {
    if (!data || !plan || building || needsPlacement || autoBuilt.current === today) return;
    if (!plan.blocks.some((b) => needsQuest(b) && !prefs.hidden.includes(b.key))) return;
    autoBuilt.current = today;
    void buildDay();
  }, [data, plan, building, buildDay, needsPlacement, today, prefs.hidden]);

  /** Sets today's unstarted blocks aside so the plan is written again (testing tool). */
  const rebuildToday = async () => {
    if (!data) return;
    const records = await Promise.all(
      data.records.map(async (r) => {
        if (!recordOnDay(r, today) || r.quest.id === data.semester.placementQuestId || questStarted(r)) return r;
        const next = { ...r, progress: { ...r.progress, replacedAt: Date.now(), updatedAt: Date.now() } };
        await data.qs.saveRecord(next);
        return next;
      }),
    );
    autoBuilt.current = null;
    setBuilding(null);
    setData({ ...data, records });
  };

  const restartSample = async () => {
    if (!data) return;
    const semester = sampleSemester(toDay(), Date.now(), { more: true });
    await data.qs.saveSemester(semester);
    autoBuilt.current = null;
    setData({ ...data, semester });
  };

  // Testing tools live in the sidebar's menu and arrive here as commands.
  const doneCommand = useRef<number | null>(null);
  useEffect(() => {
    if (!command || !data || doneCommand.current === command.id) return;
    doneCommand.current = command.id;
    if (command.kind === "build" && !building) void rebuildToday();
    if (command.kind === "restart" && data.semester.source === "sample") void restartSample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, data]);

  // ---- moving a block: later today, tomorrow, or skipped ----
  const tomorrow = addDays(today, 1);
  const saveRec = async (r: QuestRecord, patch: Partial<QuestProgress>) => {
    if (!data) return;
    const next = { ...r, progress: { ...r.progress, ...patch, updatedAt: Date.now() } };
    await data.qs.saveRecord(next);
    setData((d) => (d ? { ...d, records: d.records.map((x) => (x.quest.id === next.quest.id ? next : x)) } : d));
  };
  const moveBlock = async (b: PlannedBlock, choice: LaterChoice) => {
    if (choice === "later") return updatePrefs((p) => ({ ...p, later: { ...p.later, [b.key]: Date.now() } }));
    const r = recordOf(b);
    if (b.kind === "check" && r) {
      const notBefore = { ...(r.progress.partsNotBefore ?? {}) };
      for (const id of b.partIds ?? []) notBefore[id] = tomorrow;
      return saveRec(r, { partsNotBefore: notBefore });
    }
    if (r && b.kind !== "fix") return saveRec(r, choice === "tomorrow" ? { deferredTo: tomorrow } : { skippedOn: today });
    updatePrefs((p) => ({ ...p, hidden: [...p.hidden, b.key] }));
  };
  /** What moving a block does to its exam, from the plan with and without it. */
  const impact = (b: PlannedBlock, choice: LaterChoice): string => {
    if (!data || !weeks || !b.examKeys.length || !b.recordId) return choice === "skip" ? "Less today; the plan makes room for it later." : "";
    const r = recordOf(b);
    if (!r) return "";
    const changed = data.records.map((x) => (x === r ? { ...x, progress: { ...x.progress, ...(choice === "tomorrow" ? { deferredTo: tomorrow } : { skippedOn: today }) } } : x));
    const after = planDays({ semester: data.semester, today, nowLocal: `${today}T00:00`, attempts: data.mastery.attempts, reviews: data.mastery.reviews, records: changed, days: DAY_PLAN.horizonDays, calendarBusy: (d) => busyFromAhead(data.calendar, d) });
    const was = weeks.exams.find((e) => e.key === b.examKeys[0]);
    const now = after.exams.find((e) => e.key === b.examKeys[0]);
    if (!was || !now) return "";
    const say = { on_track: "on track", tight: "tight", behind: "behind", needs_you: "waiting for you" } as const;
    return was.status === now.status ? `${courseName(b.courseId)} stays ${say[now.status]}.` : `${courseName(b.courseId)} goes from ${say[was.status]} to ${say[now.status]}.`;
  };
  const laterOptions = (b: PlannedBlock) => {
    const dueTomorrowMorning = !!b.dueAt && daysBetween(today, b.dueAt.slice(0, 10)) <= 1 && b.dueAt.slice(11, 16) < DAY_PLAN.morningDue;
    const out: Array<{ choice: LaterChoice; label: string; note: string; disabled?: boolean }> = [{ choice: "later", label: "Later today", note: "After your other blocks" }];
    if (b.kind !== "fix") out.push({ choice: "tomorrow", label: "Tomorrow", note: dueTomorrowMorning ? `${dueLine(b.dueAt!, today)}: tomorrow is too late.` : impact(b, "tomorrow"), disabled: dueTomorrowMorning });
    out.push({ choice: "skip", label: "Skip today", note: b.kind === "fix" ? "The mistakes wait in the review." : impact(b, "skip") });
    return out;
  };

  if (loadError) return <div className="quest-page"><p className="quest-error">Your plan couldn't be loaded: {loadError}</p></div>;
  if (needsSetup)
    return (
      <div className="quest-page">
        <section className="setup-card setup-welcome">
          <p className="quest-kicker">Welcome to StudyDesk</p>
          <h1>Set up your semester first</h1>
          <p>StudyDesk plans each day around your courses, exams and free time. It needs your courses, a target grade for each, and how much you want to study. It takes about ten minutes, in a chat.</p>
          <div className="setup-actions">
            <button type="button" className="mini-btn primary big" onClick={onStartSetup}>
              Set up my semester
            </button>
            <button type="button" className="link-btn" onClick={() => load(true)}>
              Look around with a sample semester first
            </button>
          </div>
        </section>
      </div>
    );
  if (!data || !plan || !line || !weeks) return <div className="quest-page"><p className="quest-muted">Loading your day…</p></div>;

  const updateRecord = (r: QuestRecord) => setData((d) => (d ? { ...d, records: d.records.map((x) => (x.quest.id === r.quest.id ? r : x)) } : d));
  const updateMastery = (m: MasteryData) => setData((d) => (d ? { ...d, mastery: m } : d));

  // ---- one block, opened ----
  const opened = openKey ? line.blocks.find((x) => x.block.key === openKey) ?? null : null;
  if (openKey && opened) {
    const b = opened.block;
    const v = views.get(b.key);
    const r = recordOf(b);
    openRecordId.current = r?.quest.id ?? null;
    const after = line.blocks.filter((x) => x.status !== "done" && x.block.key !== b.key);
    const nextUp = after[0] ?? null;
    const next = nextUp ? { label: `Next: ${courseName(nextUp.block.courseId)}${nextUp.start !== null ? ` at ${hhmm(nextUp.start)}` : ""}`, open: () => setOpenKey(nextUp.block.key) } : null;
    return (
      <div className="quest-page" ref={scroller} data-select-scope="">
        <div className="back-now">
          <button type="button" className="link-btn" onClick={() => setOpenKey(null)}>
            ← Now
          </button>
        </div>
        {b.kind === "fix" && review ? (
          <section className="quest">
            <header className="quest-head">
              <p className="quest-kicker">
                {courseName(review.record.quest.courseId)} · Mistake review · {WEEKDAY(review.record.quest.date)}
              </p>
              <h1>{v?.title ?? "Mistake review"}</h1>
              <p className="quest-reason">
                <strong>How it works:</strong> explain your step first; when you're stuck you get the idea from the start, then one fresh problem of your own. A mistake counts as understood once you solve that problem alone.
              </p>
            </header>
            <div className="review-chat">
              <ChatView
                key={review.record.quest.id}
                initial={data.reviewChats[review.record.quest.id] ?? newReviewChat(review.record.quest, review.mistakes)}
                rules={reviewRules(review.mistakes, courseName(review.record.quest.courseId), data.semester.courses.find((c) => c.id === review.record.quest.courseId)?.teachingLanguage ?? "English")}
                placeholder="Answer here, or paste a photo of your working"
                save={async (chat) => {
                  setData((d) => (d ? { ...d, reviewChats: { ...d.reviewChats, [review.record.quest.id]: chat } } : d));
                  await data.qs.saveReviewChat(review.record.quest.id, chat);
                  // A passed check question resolves the mistake and counts for the skill.
                  const res = applyChecks(review.mistakes, checkResults(chat), data.mastery.reviews, review.record.quest.id, toDay(), Date.now());
                  if (!res.attempts.length && !res.reviews.length) return;
                  await data.ms.appendAttempts(res.attempts);
                  for (const rv of res.reviews) await data.ms.putReview(rv);
                  setData((d) =>
                    d
                      ? {
                          ...d,
                          mastery: {
                            ...d.mastery,
                            attempts: [...d.mastery.attempts, ...res.attempts.filter((a) => !d.mastery.attempts.some((x) => x.id === a.id))],
                            reviews: d.mastery.reviews.map((rv) => res.reviews.find((u) => u.attemptId === rv.attemptId) ?? rv),
                          },
                        }
                      : d,
                  );
                }}
                onSaveError={() => {}}
              />
            </div>
          </section>
        ) : r ? (
          <QuestView
            key={`${r.quest.id}:${b.partIds?.join(",") ?? ""}`}
            record={r}
            data={data}
            scroller={scroller}
            onlyParts={b.kind === "check" ? b.partIds : undefined}
            title={b.kind === "check" ? `${courseName(b.courseId)}: where you stand` : v?.title}
            why={whyLine(b, today, data.semester)}
            next={next}
            onBack={() => setOpenKey(null)}
            onRecord={updateRecord}
            onMastery={updateMastery}
          />
        ) : (
          <section className="quest-building" aria-live="polite">
            <h2>Preparing {courseName(b.courseId)}</h2>
            <p className="quest-muted">{v?.reason}</p>
            <ol>
              {(pending.get(b.key)?.quest.parts ?? []).map((p, i) => {
                const st = pending.get(b.key)?.status[p.id]?.state ?? "waiting";
                return (
                  <li key={p.id} className={`b-${st}`}>
                    Part {i + 1} · {kindLabel(p)}: {p.title}
                    <span>{st === "done" ? "ready" : st === "failed" ? "failed" : st === "waiting" ? "waiting" : "writing…"}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>
    );
  }
  openRecordId.current = null;

  // ---- the day ----
  const nowItem = line.now;
  const nowView = nowItem ? views.get(nowItem.block.key) ?? null : null;
  const doneCount = line.blocks.filter((b) => b.status === "done").length;
  const dayOff = !!data.semester.daysOff?.includes(today);
  const nowMin = minuteOf(clock);
  const dateLine = clock.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  let headline: string;
  let context: string;
  if (needsPlacement) {
    headline = "Your semester is set up";
    context = "First, a short placement check, a couple of courses a day, so StudyDesk knows where you stand.";
  } else if (dayOff) {
    headline = "Day off today. Enjoy it.";
    context = "Nothing is planned. Reviews move to your next study day.";
  } else if (!line.blocks.length) {
    headline = plan.budget > 0 ? "Nothing is due today" : "No study time planned today";
    context = plan.budget > 0 ? "No homework, reviews or exam prep are waiting." : `Your study goal for ${WEEKDAY(today)} leaves no time after school.`;
  } else if (!nowItem) {
    headline = "Done for today. The evening is yours.";
    context = `${doneCount} ${doneCount === 1 ? "block" : "blocks"} done.${data.nightly ? ` Graded tonight at ${data.nightlyTime}.` : ""}`;
  } else if (line.schoolEnd !== null && nowMin < line.schoolEnd && nowItem.start !== null) {
    headline = `School until ${hhmm(line.schoolEnd)}. Your first block is at ${hhmm(nowItem.start)}.`;
    context = `${line.blocks.length - doneCount} ${line.blocks.length - doneCount === 1 ? "block" : "blocks"} today, ${duration(line.plannedLeft)} in all.`;
  } else {
    const left = line.blocks.length - doneCount;
    headline = line.doneBy !== null ? `${left} ${left === 1 ? "block" : "blocks"} left today. You're done by ${hhmm(line.doneBy)}.` : `${left} ${left === 1 ? "block" : "blocks"} left today.`;
    context = `You have about ${duration(line.freeLeft)} free until 21:30. StudyDesk planned ${duration(line.plannedLeft)} of it and kept the rest for you.`;
  }

  const { top: questions, waiting } = quickQuestions(data.draft, data.semester.keyDates, today);
  const graded = data.mastery.attempts.filter((a) => a.part !== "assessment" && a.gradedAt > clock.getTime() - 20 * 3_600_000);
  const lastNight = graded.length
    ? {
        solved: graded.filter((a) => a.verdict === "solved").length,
        slips: graded.filter((a) => a.verdict === "slip").length,
        missed: graded.filter((a) => a.verdict === "not_understood").length,
      }
    : null;
  const examsAhead = weeks.exams.filter((e) => e.date >= today);
  const tooLittle = weeks.leftOut.length > 0 && weeks.neededPerDay > weeks.budgetPerDay * 1.15;
  const tell = (text: string) => passOn({ text, where: "Now", by: "student" });

  return (
    <div className="quest-page now-page" ref={scroller} data-select-scope="">
      {!data.live && <p className="quest-banner">Preview mode: no Claude here, so blocks use sample text and a stand-in grader (an empty answer is "not yet", an answer with the word "typo" is a slip).</p>}
      {leftovers && <p className="quest-banner">{leftovers}</p>}

      <header className="now-head">
        <p className="quest-kicker">
          {dateLine} · {hhmm(nowMin)}
        </p>
        <h1>{headline}</h1>
        <p className="now-context">{context}</p>
      </header>

      {needsPlacement && (
        <section className="setup-card setup-welcome">
          <p className="quest-kicker">{data.semester.name}</p>
          <h2>Start with a placement check</h2>
          <p>One short problem per skill, a couple of courses a day, nearest exam first. A gap only tells StudyDesk where to start.</p>
          <div className="setup-actions">
            <button type="button" className="mini-btn primary big" onClick={onStartSetup}>
              Prepare the placement check
            </button>
          </div>
        </section>
      )}

      {workloadDue && (
        <WorkloadCard
          semester={data.semester}
          attempts={data.mastery.attempts}
          reviews={data.mastery.reviews}
          today={today}
          onSave={async (semester) => {
            await data.qs.saveSemester(semester);
            publish("semester", semester, "quests");
            setData((d) => (d ? { ...d, semester } : d));
          }}
        />
      )}

      {tooLittle && (
        <section className="room-card" aria-label="Not enough time">
          <p>
            <strong>Your study time is too short for what's coming.</strong> Homework and prep for {examsAhead.length} {examsAhead.length === 1 ? "exam" : "exams"} in the next four weeks need about {duration(weeks.neededPerDay)} per study day; your study goal gives about {duration(weeks.budgetPerDay)}.
          </p>
          <button
            type="button"
            className="mini-btn dark"
            onClick={() => tell(`Please raise my study goal so StudyDesk can plan about ${weeks.neededPerDay} minutes of study blocks per study day until my exams are over.`)}
          >
            Plan about {duration(weeks.neededPerDay)} a day
          </button>
        </section>
      )}

      <div className="now-grid">
        <div className="now-main">
          {nowItem && nowView ? (
            <NowCard
              view={nowView}
              item={nowItem}
              nightly={data.nightlyTime}
              onStart={() => setOpenKey(nowItem.block.key)}
              onLater={(c) => void moveBlock(nowItem.block, c)}
              laterOptions={laterOptions(nowItem.block)}
            />
          ) : (
            !needsPlacement && (
              <section className="quest-empty">
                <h2>{line.blocks.length ? "That's today" : dayOff ? "Rest" : "Nothing planned"}</h2>
                <p className="quest-muted">
                  {line.blocks.length ? "Everything you handed in is graded tonight, and tomorrow's plan builds on it." : "Want to get ahead anyway? StudyDesk picks the course with the nearest exam."}
                </p>
                {!line.blocks.length && (
                  <button type="button" className="mini-btn primary" disabled={!!building} onClick={() => void buildDay({ anyway: QUEST_CONFIG.restDayMinutes })}>
                    Give me a {QUEST_CONFIG.restDayMinutes}-minute block anyway
                  </button>
                )}
              </section>
            )
          )}
          {buildError && (
            <div className="quest-error">
              <p>{buildError}</p>
              <button
                type="button"
                className="mini-btn primary"
                onClick={() => {
                  setBuilding(null);
                  void buildDay();
                }}
              >
                Try again
              </button>
            </div>
          )}

          {line.items.length > 0 && (
            <section className="now-today" aria-label="Today">
              <div className="now-today-head">
                <h3 className="section-label">Today</h3>
                <span className="quest-muted">
                  {duration(line.blocks.reduce((s, b) => s + b.block.minutes, 0))} planned{plan.budget ? ` · study goal leaves ${duration(plan.budget)}` : ""}
                </span>
              </div>
              <Timeline items={line.items} views={views} now={nowMin} onOpen={(k) => setOpenKey(k)} freeNote="The first hour after school stays free." />
            </section>
          )}
        </div>

        <aside className="now-rail" aria-label="Coming up and questions">
          <ExamRail
            exams={examsAhead}
            today={today}
            courseName={courseName}
            onWeek={onOpenWeek}
            onNeedsYou={(e) => window.dispatchEvent(new CustomEvent("studydesk:ask", { detail: { quote: `${courseName(e.courseId)}: ${e.label} on ${shortDate(e.date)}. StudyDesk has no material for it yet.` } }))}
          />
          <QuickAnswers
            questions={questions.map((q) => ({ key: q.key, course: q.course, text: q.text, impact: q.impact }))}
            waiting={waiting}
            onSeeAll={onOpenTodo}
            onAnswer={(q, a) => tell(`${q.course}, a question from the to-do list: “${q.text}” My answer: ${a}`)}
          />
          {lastNight && (
            <RailNote label="Last night">
              <p className="rail-text">
                Graded {lastNight.solved + lastNight.slips + lastNight.missed} {lastNight.solved + lastNight.slips + lastNight.missed === 1 ? "problem" : "problems"}: <strong>{lastNight.solved} solved</strong>
                {lastNight.slips ? `, ${lastNight.slips} ${lastNight.slips === 1 ? "slip" : "slips"}` : ""}
                {lastNight.missed ? `, ${lastNight.missed} not understood yet` : ""}.
              </p>
              {openMistakes > 0 && <p className="rail-foot">The mistakes are today's first block.</p>}
            </RailNote>
          )}
        </aside>
      </div>

      {archive.length > 0 && (
        <section className="archive" aria-label="Earlier blocks">
          <h2 className="archive-h">Earlier blocks</h2>
          <div className="overview">
            {(showAllArchive ? archive : archive.slice(0, 8)).map((r) => {
              const isOpen = openArchived === r.quest.id;
              const probs = r.quest.parts.flatMap((p) => (p.kind === "learn" ? [] : p.problems));
              const pts = probs.reduce((s, p) => s + (r.progress.work[p.id]?.points ?? 0), 0);
              const max = probs.reduce((s, p) => s + p.maxPoints, 0);
              const isGraded = isFinished(r.quest, r.progress);
              return (
                <div key={r.quest.id} className={"ov-part" + (isOpen ? " is-open" : "")}>
                  <button type="button" className="ov-row is-done" aria-expanded={isOpen} onClick={() => setOpenArchived(isOpen ? null : r.quest.id)}>
                    <span className={"ov-mark " + (isGraded ? "graded" : "done")} aria-hidden="true">
                      {isGraded ? "✓" : ""}
                    </span>
                    <span className="ov-main">
                      <span className="ov-kind">
                        {WEEKDAY(r.quest.date)} {r.quest.date.slice(5).replace("-", "/")} · {r.quest.id === data.semester.placementQuestId ? "Placement check" : courseName(r.quest.courseId)}
                      </span>
                      <span className="ov-title">{r.quest.reason}</span>
                    </span>
                    <span className="ov-status">{isGraded ? `${pts}/${max}` : r.progress.skippedOn ? "Skipped" : "Not finished"}</span>
                    <svg className="ov-chev" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {isOpen && (
                    <div className="archive-body">
                      <QuestView key={r.quest.id} record={r} data={data} scroller={scroller} onRecord={updateRecord} onMastery={updateMastery} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {archive.length > 8 && !showAllArchive && (
            <button type="button" className="link-btn" onClick={() => setShowAllArchive(true)}>
              Show all {archive.length}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type ViewProps = {
  record: QuestRecord;
  data: Data;
  scroller: React.RefObject<HTMLDivElement>;
  onRecord: (r: QuestRecord) => void;
  onMastery: (m: MasteryData) => void;
  /** Show only these parts (a placement check block: one course's part). */
  onlyParts?: string[];
  /** The block's title, when it isn't the course's name. */
  title?: string;
  /** Why this block is in the day: "Due tomorrow 08:00", "Klausur in 9 days". */
  why?: string;
  /** The next block of the day, offered once this one is handed in. */
  next?: { label: string; open: () => void } | null;
  onBack?: () => void;
};

const NOTE_RULES = `You are StudyDesk, a study assistant for high school and university students.
The student is working through today's study quest and highlighted a passage in it to ask about.
Your answer appears in a small side note right under that passage. So:
- Answer only the question about the highlighted passage, using the quest text as context.
- Be brief: usually 2 to 6 sentences, or a short list. A small example is fine when it helps.
- Don't restate the passage and don't greet.
- Use Markdown; write math with $...$ inline and $$...$$ for display formulas.`;

const HOMEWORK_RULE = `
- This passage belongs to real homework the student hasn't handed in yet. Guide with a question or the principle behind it; never give the answer or a finished step.`;


function QuestView({ record, data, scroller, onRecord, onMastery, onlyParts, title, why, next, onBack }: ViewProps) {
  const { quest } = record;
  // The header shows only "Why today"; the extra notes open on request.
  const [notesOpen, setNotesOpen] = useState(false);
  const { semester, mastery, ms, qs, live } = data;
  // A copy of the work is kept in this browser on every change, so a crash or a
  // closed tab loses nothing; it wins over the saved record when it's newer.
  const draftKey = `studydesk.questdraft.${quest.id}`;
  const [progress, setProgress] = useState<QuestProgress>(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || "null") as QuestProgress | null;
      if (d && d.questId === quest.id) return pickDraft(d, record.progress);
    } catch {
      /* no draft */
    }
    return record.progress;
  });
  const [openPart, setOpenPart] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const images = useRef<Record<string, Blob[]>>({});
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Changes on this page not yet saved. A page with none never writes, so an old tab can't overwrite newer work. */
  const dirty = useRef(progress !== record.progress); // a newer copy from this browser still needs saving

  const skills = useMemo(() => new Map(semester.skills.map((s) => [s.id, s])), [semester]);
  const course = semester.courses.find((c) => c.id === quest.courseId);
  const ask = live ? askClaude : sampleGradingAsk;

  const onRecordRef = useRef(onRecord);
  onRecordRef.current = onRecord;
  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!dirty.current) return Promise.resolve();
    dirty.current = false;
    const r = { quest, progress: { ...progressRef.current, updatedAt: Date.now() } };
    onRecordRef.current(r);
    return qs
      .saveRecord(r)
      .then(() => setErrors((e) => (e.save ? { ...e, save: "" } : e)))
      .catch(() => {
        dirty.current = true;
        setErrors((e) => ({ ...e, save: "Your work couldn't be saved. Keep this page open and try again." }));
      });
  }, [qs, quest]);

  const saveSoon = useCallback(() => {
    dirty.current = true;
    if (!saveTimer.current) saveTimer.current = setTimeout(() => void flush(), 2000);
  }, [flush]);

  useEffect(() => () => void flush(), [flush]);

  // Local draft on every change; saved for real when the tab is hidden or closed.
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ ...progress, updatedAt: Math.max(progress.updatedAt, Date.now()) }));
    } catch {
      /* storage full or blocked: the 2-second save still runs */
    }
  }, [progress, draftKey]);
  // Back on the page with nothing unsaved: take over newer work saved elsewhere (another tab or device).
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== "visible" || dirty.current) return;
      void qs
        .loadRecords()
        .then((rs) => {
          const r = rs.find((x) => x.quest.id === quest.id);
          if (!r || dirty.current || r.progress.updatedAt <= progressRef.current.updatedAt) return;
          progressRef.current = r.progress;
          setProgress(r.progress);
          onRecordRef.current({ quest, progress: r.progress });
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [qs, quest]);
  useEffect(() => {
    const save = () => void flush();
    const onHide = () => document.visibilityState === "hidden" && save();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flush]);

  const commit = (fn: (p: QuestProgress) => QuestProgress) => {
    const next = fn(progressRef.current);
    progressRef.current = next;
    setProgress(next);
    dirty.current = true;
    void flush();
  };

  // The nightly run's grades for this quest, while it's open: merged into this copy, then saved.
  useEffect(() => {
    const onGrades = (e: Event) => {
      const box = (e as CustomEvent<GradingOutbox>).detail;
      if (!box || box.questId !== quest.id) return;
      const merged = mergeGrading({ quest, progress: progressRef.current }, box, Date.now());
      if (merged.progress !== progressRef.current) commit(() => merged.progress);
    };
    window.addEventListener(GRADES_EVENT, onGrades);
    return () => window.removeEventListener(GRADES_EVENT, onGrades);
  });

  const setWork = (id: string, patch: Partial<ProblemWork>) => {
    setProgress((p) => ({ ...p, work: { ...p.work, [id]: { ...(p.work[id] ?? emptyWork()), ...patch } }, updatedAt: Date.now() }));
    saveSoon();
  };

  // ---- select-to-reply ----
  const setNotes = useCallback(
    (fn: (n: Note[]) => Note[]) => {
      setProgress((p) => ({ ...p, notes: fn(p.notes ?? []) }));
      saveSoon();
    },
    [saveSoon],
  );

  /** Every block of text a note can point at, with the part it belongs to. */
  const blocks = useMemo(() => {
    const m = new Map<string, { text: string; part: QuestPart; label: string }>();
    quest.parts.forEach((part, i) => {
      const where = `Part ${i + 1} (${kindLabel(part)}): ${part.title}`;
      if (part.kind === "learn") m.set(part.id, { text: part.body, part, label: where });
      else {
        if (part.body) m.set(part.id, { text: part.body, part, label: `${where}, the explanation and worked example` });
        if (part.keyRule) m.set(`${part.id}-keyrule`, { text: part.keyRule, part, label: `${where}, the key rule` });
        part.problems.forEach((p) => {
          const name = p.label ? `task ${p.label}` : "a problem";
          m.set(`${p.id}-prompt`, { text: p.prompt, part, label: `${where}, ${name}` });
          p.hints.forEach((h, k) => m.set(`${p.id}-hint${k + 1}`, { text: h, part, label: `${where}, hint ${k + 1} for ${name}` }));
          if (p.similarSolved) m.set(`${p.id}-similar`, { text: p.similarSolved, part, label: `${where}, a solved similar problem for ${name}` });
          m.set(`${p.id}-key`, { text: p.answerKey, part, label: `${where}, the worked answer to ${name}` });
          const fb = progress.work[p.id]?.feedback;
          if (fb) m.set(`${p.id}-feedback`, { text: fb, part, label: `${where}, the grader's feedback on ${name}` });
        });
      }
    });
    return m;
  }, [quest, progress.work]);

  const turnsFor = useCallback(
    (note: Note) => {
      const b = blocks.get(note.messageId);
      const homework =
        b?.part.kind === "assignment" && !answerUnlocked(semester.assignments.find((a) => a.id === (b.part as ProblemPart).assignmentId), nowLocal());
      const context = `<quest>
Course: ${course?.name ?? ""}. Why today's quest: ${quest.reason}
The passage is in ${b?.label ?? "the quest"}:
"""
${b?.text ?? ""}
"""
</quest>`;
      return passageNoteTurns(NOTE_RULES + (homework ? HOMEWORK_RULE : ""), context, note);
    },
    [blocks, course, quest, semester],
  );

  const notes = useSideNotes({ notes: progress.notes ?? [], setNotes, turnsFor, onSettled: () => void flush() });
  const md = (blockId: string, text: string) => (
    <AnnotatedMarkdown blockId={blockId} text={text} notes={notes.byBlock.get(blockId) ?? []} {...notes.handlers} />
  );

  // ---- the timer: one problem at a time, only while the page is in front ----
  useEffect(() => {
    if (!activeId) return;
    let last = Date.now();
    let hiddenSince: number | null = null;
    const t = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      if (document.hidden) {
        hiddenSince ??= now - dt * 1000;
        if (now - hiddenSince > CONFIG.timing.autoPauseAfterMs) {
          setActiveId(null);
          return;
        }
      } else hiddenSince = null;
      setProgress((p) => {
        const w = p.work[activeId] ?? emptyWork();
        return { ...p, work: { ...p.work, [activeId]: { ...w, activeSeconds: w.activeSeconds + dt } } };
      });
      saveSoon();
    }, 1000);
    return () => clearInterval(t);
  }, [activeId, saveSoon]);

  const activity = (id: string) => {
    const w = progressRef.current.work[id];
    if (w?.verdict) return;
    if (activeId !== id) setActiveId(id);
    if (!w?.startedAt) setWork(id, { startedAt: Date.now() });
  };

  const addFile = (id: string, file: AnswerFile, blob?: Blob) => {
    if (blob) images.current[id] = [...(images.current[id] ?? []), blob];
    const w = progressRef.current.work[id] ?? emptyWork();
    setWork(id, { files: [...w.files, file] });
    if (blob && file.kind === "image") {
      // Keep a compressed copy with the quest, so the photo can still be graded after a reload.
      void compressImage(blob).then(async (url) => {
        if (!url) return;
        await qs.saveImage(file.id, url);
        const cur = progressRef.current.work[id] ?? emptyWork();
        setWork(id, { files: cur.files.map((f) => (f.id === file.id ? { ...f, stored: true } : f)) });
      }).catch(() => {});
    }
  };

  /** Photos for grading: the ones in memory, or the stored copies after a reload. */
  const imagesFor = async (problemIds: string[]) => {
    const out: Record<string, Blob[]> = {};
    for (const pid of problemIds) {
      if (images.current[pid]?.length) {
        out[pid] = images.current[pid];
        continue;
      }
      const stored = (progressRef.current.work[pid]?.files ?? []).filter((f) => f.kind === "image" && f.stored);
      const blobs: Blob[] = [];
      for (const f of stored) {
        const url = await qs.loadImage(f.id).catch(() => null);
        if (url) blobs.push(dataUrlToBlob(url));
      }
      if (blobs.length) out[pid] = blobs;
    }
    return out;
  };

  // ---- hand in = save; grading runs once for everything ----
  const toggle = (id: string) => setOpenPart((o) => (o === id ? null : id));

  const handInPart = (part: QuestPart) => {
    if (part.kind !== "learn" && activeId && part.problems.some((p) => p.id === activeId)) setActiveId(null);
    commit((p) => ({ ...p, handedIn: [...p.handedIn.filter((x) => x !== part.id), part.id], handedInOn: { ...(p.handedInOn ?? {}), [part.id]: toDay() }, updatedAt: Date.now() }));
    setOpenPart(null);
    requestAnimationFrame(() => document.getElementById(`row-${part.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const reopen = (part: QuestPart) => commit((p) => ({ ...p, handedIn: p.handedIn.filter((x) => x !== part.id) }));

  const gradeNow = async () => {
    const todo = ungraded(quest, progressRef.current);
    if (!todo.length) return;
    setGrading(true);
    setErrors((e) => ({ ...e, grade: "" }));
    try {
      const imgs = await imagesFor(todo.map((t) => t.problem.id));
      const res = await handIn({ quest, problems: todo, work: progressRef.current.work, images: imgs, semester, today: toDay(), nowLocal: nowLocal(), ask });
      await ms.appendAttempts(res.attempts);
      for (const r of res.reviews) await ms.putReview(r);
      onMastery({ ...mastery, attempts: [...mastery.attempts, ...res.attempts], reviews: [...mastery.reviews, ...res.reviews] });
      commit((p) => {
        const next = { ...p, work: { ...p.work, ...res.work }, updatedAt: Date.now() };
        if (!next.finishedAt && isFinished(quest, next)) next.finishedAt = Date.now();
        return next;
      });
    } catch (e) {
      setErrors((x) => ({ ...x, grade: message(e) }));
    } finally {
      setGrading(false);
    }
  };

  const answerSlipQ = async (problemId: string, confirmed: boolean) => {
    const w = progressRef.current.work[problemId];
    const review = mastery.reviews.find((r) => r.attemptId === w?.attemptId);
    if (review) {
      const updated = answerSlip(review, confirmed, Date.now());
      await ms.putReview(updated).catch(() => {});
      onMastery({ ...mastery, reviews: mastery.reviews.map((r) => (r.attemptId === updated.attemptId ? updated : r)) });
    }
    setWork(problemId, { slipAnswer: confirmed ? "confirmed" : "disputed" });
    setTimeout(() => void flush(), 0);
  };

  // ---- rendering ----
  const nl = nowLocal();
  const spentSeconds = Object.values(progress.work).reduce((s, w) => s + (w.activeSeconds || 0), 0);
  const shownParts = onlyParts ? quest.parts.filter((p) => onlyParts.includes(p.id)) : quest.parts;
  const doneCount = shownParts.filter((p) => progress.handedIn.includes(p.id)).length;
  const blockDone = shownParts.length > 0 && doneCount === shownParts.length;
  const waiting = ungraded(quest, progress).length;
  const everythingIn = allHandedIn(quest, progress);

  /** Active minutes on a part's problems (reading isn't timed). */
  const tookMin = (part: QuestPart) =>
    part.kind === "learn" ? 0 : Math.round(part.problems.reduce((s, p) => s + (progress.work[p.id]?.activeSeconds ?? 0), 0) / 60);
  const timeText = (part: QuestPart) => {
    const took = tookMin(part);
    const planned = partMinutes(part);
    return took > 0 ? ` · ${took} of ${planned} min` : ` · ${planned} min planned`;
  };
  const status = (part: QuestPart): { mark: string; cls: string; text: string } => {
    if (!progress.handedIn.includes(part.id)) {
      const took = tookMin(part);
      return { mark: "", cls: "todo", text: took > 0 ? `${took} of ${partMinutes(part)} min` : `${partMinutes(part)} min` };
    }
    if (part.kind === "learn") return { mark: "✓", cls: "done", text: "Read" };
    const ws = part.problems.map((p) => progress.work[p.id]);
    if (ws.some((w) => !w?.verdict)) return { mark: "✓", cls: "done", text: `Handed in${timeText(part)}` };
    const pts = part.problems.reduce((s, p) => s + (progress.work[p.id]?.points ?? 0), 0);
    const max = part.problems.reduce((s, p) => s + p.maxPoints, 0);
    const solved = ws.filter((w) => w?.verdict === "solved").length;
    return { mark: "✓", cls: solved === ws.length ? "graded" : "graded mixed", text: `${pts}/${max}${timeText(part)}` };
  };

  const rate = (partId: string, r: Rating) => {
    commit((p) => {
      const ratings = { ...(p.ratings ?? {}) };
      if (ratings[partId] === r) delete ratings[partId];
      else ratings[partId] = r;
      return { ...p, ratings };
    });
  };
  const rater = (part: QuestPart) => (
    <div className="rater" role="group" aria-label="How did this part feel?">
      <span>How did this feel?</span>
      {(
        [
          ["easy", "Too easy"],
          ["right", "Just right"],
          ["hard", "Too hard"],
        ] as const
      ).map(([r, label]) => (
        <button key={r} type="button" className={"rate-btn" + (progress.ratings?.[part.id] === r ? " is-on" : "")} aria-pressed={progress.ratings?.[part.id] === r} onClick={() => rate(part.id, r)}>
          {label}
        </button>
      ))}
    </div>
  );

  let problemN = 0;
  const body = (part: QuestPart) => {
    const isIn = progress.handedIn.includes(part.id);
    if (part.kind === "learn") {
      return (
        <div className="part-body">
          <div className="learn-text">{md(part.id, part.body)}</div>
          {rater(part)}
          <div className="part-actions">
            {isIn ? (
              <span className="quest-muted">Marked as read.</span>
            ) : (
              <button type="button" className="mini-btn primary big" onClick={() => handInPart(part)}>
                Done reading
              </button>
            )}
          </div>
        </div>
      );
    }
    const a = part.kind === "assignment" ? semester.assignments.find((x) => x.id === part.assignmentId) : undefined;
    const graded = part.problems.every((p) => progress.work[p.id]?.verdict);
    const myLine = progress.keyLines?.[part.id] ?? "";
    const empty = part.problems.filter((p) => {
      const w = progress.work[p.id];
      return !w || (!w.answerText.trim() && !w.files.length);
    }).length;
    return (
      <div className="part-body">
        {part.kind === "lesson" && part.body && (
          <>
            <div className="learn-text">{md(part.id, part.body)}</div>
            <h3 className="your-turn">Your turn</h3>
          </>
        )}
        {part.kind === "assignment" && !isIn && (
          <p className="part-note">This is your real homework. Solve it the way you'd hand it in, then type your answer or add a photo. Hints guide you without giving the answer away.</p>
        )}
        {part.problems.map((problem) => {
          const w = progress.work[problem.id] ?? emptyWork();
          return (
            <ProblemCard
              key={problem.id}
              n={++problemN}
              render={md}
              problem={problem}
              skillName={skills.get(problem.skillId)?.name ?? ""}
              work={w}
              locked={isIn || grading}
              graded={!!w.verdict}
              timing={activeId === problem.id}
              answerLockedUntil={a && !answerUnlocked(a, nl) ? formatDue(a.dueAt, toDay()) : null}
              onChange={(patch) => setWork(problem.id, patch)}
              onAddFile={(f, b) => addFile(problem.id, f, b)}
              onActivity={() => activity(problem.id)}
              onPause={() => {
                setActiveId(null);
                void flush();
              }}
              onSlipAnswer={(c) => void answerSlipQ(problem.id, c)}
            />
          );
        })}
        {part.kind === "lesson" && part.keyRule && (
          <div className="keyrule">
            <label htmlFor={`${part.id}-key`}>In one line: what's the key rule here?</label>
            <input
              id={`${part.id}-key`}
              type="text"
              value={myLine}
              disabled={isIn}
              placeholder="Say it in your own words"
              onChange={(e) => {
                const v = e.target.value;
                setProgress((p) => ({ ...p, keyLines: { ...(p.keyLines ?? {}), [part.id]: v } }));
                saveSoon();
              }}
            />
            {(isIn || myLine.trim().length > 8) && (
              <details className="keyrule-compare">
                <summary>Compare with the key rule</summary>
                {md(`${part.id}-keyrule`, part.keyRule)}
              </details>
            )}
          </div>
        )}
        {rater(part)}
        <div className="part-actions">
          {isIn ? (
            !graded && (
              <>
                <span className="quest-muted">Handed in. It's graded with the rest of today's quest.</span>
                <button type="button" className="link-btn" disabled={grading} onClick={() => reopen(part)}>
                  Change my answers
                </button>
              </>
            )
          ) : (
            <>
              {empty > 0 && (
                <span className="quest-muted">
                  {empty} {empty === 1 ? "problem has" : "problems have"} no answer yet.
                </span>
              )}
              <button type="button" className="mini-btn primary big" onClick={() => handInPart(part)}>
                Hand in
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="quest">
      <header className="quest-head">
        <p className="quest-kicker">
          {WEEKDAY(quest.date)} · {quest.parts.some((p) => p.kind !== "learn" && p.check) ? "Placement check" : course?.name} · about {shownParts.reduce((s, p) => s + partMinutes(p), 0)} min
          {why ? ` · ${why}` : ""}
        </p>
        <h1>{title ?? (quest.block ? course?.name ?? "This block" : "Today's quest")}</h1>
        <p className="quest-reason">
          <strong>{quest.block ? "Why now:" : "Why today:"}</strong> {quest.reason}
        </p>
        {quest.notes.length > 0 &&
          (notesOpen ? (
            quest.notes.map((n, i) => (
              <p key={i} className="quest-note">
                {n}
              </p>
            ))
          ) : (
            <button type="button" className="link-btn quest-more" onClick={() => setNotesOpen(true)}>
              More about this {quest.block ? "block" : "quest"}
            </button>
          ))}
      </header>

      {errors.save && <p className="quest-error">{errors.save}</p>}

      <section className="overview" aria-label="This block's parts">
        {shownParts.map((part, i) => {
          const st = status(part);
          const isOpen = openPart === part.id;
          return (
            <div key={part.id} className={"ov-part" + (isOpen ? " is-open" : "")} id={`row-${part.id}`}>
              <button type="button" className={`ov-row is-${st.cls.split(" ")[0]}`} aria-expanded={isOpen} onClick={() => toggle(part.id)}>
                <span className={`ov-mark ${st.cls}`} aria-hidden="true">
                  {st.mark}
                </span>
                <span className="ov-main">
                  <span className="ov-kind">
                    Part {i + 1} · {kindLabel(part)}
                  </span>
                  <span className="ov-title">{part.title}</span>
                </span>
                <span className="ov-status">{st.text}</span>
                <svg className="ov-chev" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {isOpen && body(part)}
            </div>
          );
        })}

        <div className="ov-foot">
          <span className="ov-count">
            {doneCount} of {shownParts.length} done
            {spentSeconds > 0 && <> · {clockText(spentSeconds)} worked</>}
          </span>
          {waiting > 0 || grading ? (
            <button type="button" className="mini-btn primary big" disabled={grading} onClick={() => void gradeNow()}>
              {grading ? "Grading…" : everythingIn ? "Submit for grading" : "Grade me early"}
            </button>
          ) : null}
          <span className="ov-hint">
            {progress.finishedAt
              ? "Everything is graded. Open a part to see the feedback."
              : waiting > 0
                ? data.nightly
                  ? `${waiting} ${waiting === 1 ? "problem is" : "problems are"} waiting. Grading runs on its own tonight at 22:00, or press the button to grade now.`
                  : `${waiting} ${waiting === 1 ? "problem is" : "problems are"} waiting. Press the button when you're done; anything left is graded the next time you open StudyDesk.`
                : "Open a part, work through it, and hand it in. Grading happens once, for the whole quest."}
          </span>
          {errors.grade && <p className="quest-error">{errors.grade}</p>}
        </div>
      </section>

      {blockDone && !progress.finishedAt && (next || onBack) && (
        <section className="block-done" aria-live="polite">
          <p>
            <strong>This block is done.</strong> {data.nightly ? "It's graded tonight with the rest of today." : "Press the button above to grade it, or it's graded the next time you open StudyDesk."}
          </p>
          <div className="block-done-actions">
            {next && (
              <button type="button" className="mini-btn primary big" onClick={next.open}>
                {next.label}
              </button>
            )}
            {onBack && (
              <button type="button" className="mini-btn big" onClick={onBack}>
                Back to Now
              </button>
            )}
          </div>
        </section>
      )}

      {progress.finishedAt && <Summary quest={quest} progress={progress} mastery={mastery} spentSeconds={spentSeconds} semester={semester} />}

      <SelectionReply scope={scroller} disabled={false} onAsk={notes.ask} />
    </div>
  );
}

function Summary({ quest, progress, mastery, spentSeconds, semester }: { quest: Quest; progress: QuestProgress; mastery: MasteryData; spentSeconds: number; semester: Semester }) {
  const attemptIds = new Set(Object.values(progress.work).map((w) => w.attemptId).filter(Boolean) as string[]);
  const { states, points } = replay(mastery.skills, mastery.attempts, mastery.reviews);
  const earned = points.filter((p) => p.attemptId && attemptIds.has(p.attemptId)).reduce((s, p) => s + p.points, 0);
  const probs = quest.parts.flatMap((p) => (p.kind === "learn" ? [] : p.problems));
  const solved = probs.filter((p) => {
    const w = progress.work[p.id];
    return w?.verdict === "solved" || (w?.verdict === "slip" && w.slipAnswer === "confirmed");
  }).length;
  const bonus = questBonus(solved, probs.length);
  const total = earned + bonus;
  const skillIds = [...new Set(quest.parts.flatMap((p) => (p.kind === "learn" ? [] : p.problems.map((q) => q.skillId))))];
  const pendingSlips = Object.values(progress.work).filter((w) => w.verdict === "slip" && !w.slipAnswer).length;
  return (
    <section className="summary">
      <h2>Quest finished</h2>
      <p className="summary-points">
        {total > 0 ? `+${total} points` : "No points this time"}{" "}
        <span className="quest-muted">
          ({solved} of {probs.length} problems solved: {earned} from problems, {bonus} of {CONFIG.points.quest_finished} finishing bonus)
        </span>
      </p>
      {solved === 0 && <p>Nothing was solved yet, so there's nothing to reward. The mistake review at the top goes through it with you.</p>}
      <p>
        Active time {clockText(spentSeconds)} against a plan of about {quest.plannedMinutes} min. These times train your estimates, so tomorrow's quest fits better.
      </p>
      {pendingSlips > 0 && <p className="part-note is-warn">Open the parts marked with a slip and answer the question there, so your streaks count correctly.</p>}
      <table className="summary-table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Where it stands</th>
          </tr>
        </thead>
        <tbody>
          {skillIds.map((id) => {
            const s = semester.skills.find((x) => x.id === id);
            const st = states.get(id);
            const target = s?.streakTarget ?? CONFIG.defaultStreakTarget;
            const label =
              !st || st.stage === "new"
                ? "Not started"
                : st.stage === "learning" || st.stage === "lapsed"
                  ? `${st.stage === "lapsed" ? "Relearning" : "Learning"}: ${st.streak} of ${target} clean solves on different days`
                  : st.stage === "mastered"
                    ? `Mastered, next check ${st.dueAt}`
                    : "Retained";
            return (
              <tr key={id}>
                <td>{s?.name}</td>
                <td>{label}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
