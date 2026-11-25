import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Note } from "../chat/types";
import { ChatView } from "../chat/ChatView";
import { SelectionReply } from "../chat/SelectionReply";
import { passageNoteTurns } from "../chat/prompts";
import { AnnotatedMarkdown } from "../notes/AnnotatedMarkdown";
import { useSideNotes } from "../notes/useSideNotes";
import { CONFIG } from "../mastery/config";
import { toDay } from "../mastery/days";
import { answerSlip, GradingFailed } from "../mastery/grading";
import { questBonus, replay } from "../mastery/replay";
import { askClaude, claudeAvailable, errorCopy, type AskError } from "../platform/claude";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { QUEST_CONFIG, partMinutes } from "./config";
import { allHandedIn, answerUnlocked, emptyProgress, emptyWork, handIn, isFinished, ungraded } from "./handin";
import { carriedOver, doneTasks, formatDue, planQuest, recentBlockers, recentFeel, type PlanResult } from "./plan";
import { ProblemCard, clock } from "./ProblemCard";
import { sampleGradingAsk, sampleSemester, sampleWriter } from "./seed";
import type { AnswerFile, ProblemPart, ProblemWork, Quest, QuestPart, QuestProgress, QuestRecord, Rating, Semester } from "./types";
import { claudeWriter, QuestIncomplete, writeQuest, type WriteStatus } from "./write";
import { compressImage, dataUrlToBlob } from "./images";
import { addAnki, deckSizes, ankiDeck } from "./anki";
import { applyChecks, checkResults, isResolved, newReviewChat, questMistakes, reviewRules } from "./review";
import { WorkloadCard } from "../onboarding/WorkloadCard";
import { placementWriter, planPlacement } from "../onboarding/placement";
import { busyMinutesFromEvents, readCalendar } from "../platform/calendar";
import { publish, subscribe } from "../platform/deskBus";
import { offerDownload, openOnboardingStore } from "../platform/onboardingStore";
import { openRoutineStore } from "../platform/routineStore";
import { mergeGrading, type GradingOutbox } from "../routine/apply";
import { mergeProgress } from "./merge";
import { ComingUp } from "../shell/ComingUp";
import { QUEST_CHANGED } from "./times";

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
  /** The nightly run is set up (grading at 22:00, tomorrow's quest overnight). */
  nightly: boolean;
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
        await qs.saveRecord(merged, rec.progress);
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

function message(e: unknown): string {
  if (e instanceof GradingFailed) return "The grading agent's answer couldn't be used, even after a retry. Try handing in again.";
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return errorCopy(e as AskError);
  return e instanceof Error ? e.message : "Something went wrong.";
}

const WEEKDAY = (day: string) => new Date(`${day}T12:00`).toLocaleDateString("en", { weekday: "long" });

/** A testing tool picked in the sidebar's menu; `id` changes each time it's picked. */
export type QuestCommand = { id: number; kind: "build" | "restart" };

export function QuestPage({ onStartSetup, command }: { onStartSetup: () => void; command?: QuestCommand | null }) {
  const [data, setData] = useState<Data | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [building, setBuilding] = useState<{ plan: Quest; status: Record<string, WriteStatus> } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [planNotice, setPlanNotice] = useState<Exclude<PlanResult, { kind: "quest" }> | null>(null);
  const autoBuilt = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const today = toDay();

  const load = useCallback((useSample = false) => {
    (async () => {
      const [qs, ms, live] = await Promise.all([openQuestStore(), openMasteryStore(), claudeAvailable()]);
      let semester = await qs.loadSemester();
      if (!semester && !useSample) {
        // A new student: StudyDesk needs Start New Semester before it can build quests.
        setNeedsSetup(true);
        return;
      }
      if (!semester) {
        semester = sampleSemester(toDay());
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
      const [loaded, reviewChats, profile] = await Promise.all([qs.loadRecords(), qs.loadReviewChats(), openOnboardingStore().then((o) => o.loadProfile()).catch(() => null)]);
      // Grades from the nightly run come in before anything is shown.
      const { records } = await applyNightlyGrades(qs, loaded, null).catch(() => ({ records: loaded }));
      setData({ qs, ms, semester, records, reviewChats, mastery, live, nightly: !!profile?.schedule });
    })().catch((e) => setLoadError(message(e)));
  }, []);
  useEffect(() => load(), [load]);
  // While the page is open (say at 22:00), the night's grades arrive within a few minutes.
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const tick = async () => {
      const d = dataRef.current;
      if (!d || document.visibilityState === "hidden") return;
      const open = d.records.filter((r) => r.quest.date === toDay() && !r.progress.replacedAt).sort((a, b) => b.quest.createdAt - a.quest.createdAt)[0];
      const res = await applyNightlyGrades(d.qs, d.records, open?.quest.id ?? null).catch(() => null);
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
    const todo = data.records.filter((r) => !r.progress.replacedAt && r.quest.date < today && ungraded(r.quest, r.progress).length);
    if (!todo.length) return;
    void (async () => {
      setLeftovers(`Grading work from ${todo.map((r) => WEEKDAY(r.quest.date)).join(", ")} that wasn't graded overnight…`);
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
          await data.qs.saveRecord(rec, r.progress);
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
  // "Rebuild today's quest" from the StudyDesk chat: reload, and the newest plan is written.
  useEffect(() => {
    const onReplaced = () => {
      autoBuilt.current = false;
      setPlanNotice(null);
      load();
    };
    window.addEventListener("studydesk:quest-replaced", onReplaced);
    return () => window.removeEventListener("studydesk:quest-replaced", onReplaced);
  }, [load]);
  // A change through the Orchestrator (a new date, a day off) shows up here at once.
  useEffect(() => subscribe("semester", "quests", (semester) => setData((d) => (d && d.semester.id === semester.id ? { ...d, semester } : d))), []);

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

  const current = useMemo(
    () => data?.records.filter((r) => r.quest.date === today && !r.progress.replacedAt).sort((a, b) => b.quest.createdAt - a.quest.createdAt)[0] ?? null,
    [data, today],
  );
  const currentDone = !!current && isFinished(current.quest, current.progress);
  /** Graded quests and earlier days' quests, newest first. */
  const archive = useMemo(
    () =>
      (data?.records ?? [])
        .filter((r) => !r.progress.replacedAt)
        .filter((r) => r !== current || currentDone)
        .filter((r) => isFinished(r.quest, r.progress) || r.quest.date < today)
        .sort((a, b) => b.quest.createdAt - a.quest.createdAt),
    [data, current, currentDone, today],
  );
  /** The newest graded quest with mistakes gets the review chat at the top. */
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
  const [openArchived, setOpenArchived] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const build = useCallback(
    async (budgetOverride?: number) => {
      if (!data) return;
      setBuildError(null);
      setPlanNotice(null);
      const { semester, records, mastery } = data;
      // A semester set up from the calendar sizes today's quest from today's real calendar.
      let calendarBusyMinutes: number | undefined;
      if (semester.calendarSync && data.live) {
        try {
          calendarBusyMinutes = busyMinutesFromEvents(await readCalendar(today, 1), today);
        } catch {
          calendarBusyMinutes = undefined; // not reachable now: the weekly timetable is used
        }
      }
      const res = planQuest({
        calendarBusyMinutes,
        semester,
        today,
        nowLocal: nowLocal(),
        attempts: mastery.attempts,
        reviews: mastery.reviews,
        doneTaskIds: doneTasks(records),
        deckSizes: deckSizes(records, semester),
        blockerSkillIds: recentBlockers(records, today),
        budgetOverride,
        questId: `qst_${today}_${Date.now().toString(36)}`,
      });
      if (res.kind !== "quest") {
        setPlanNotice(res);
        return;
      }
      setBuilding({ plan: res.quest, status: {} });
      try {
        const { states } = replay(mastery.skills, mastery.attempts, mastery.reviews);
        const knownIds = [...states.values()].filter((s) => s.stage === "mastered" || s.stage === "retained").map((s) => s.skillId);
        const feel = recentFeel(records, (id) => semester.skills.find((s) => s.id === id)?.name, today);
        const writer = data.live ? claudeWriter(semester, res.quest, knownIds, askClaude, undefined, feel) : sampleWriter(semester.skills);
        addAnki(res.quest, records, semester);
        const carried = carriedOver(records, res.quest);
        if (carried.length) {
          res.quest.notes.unshift(`Carried over from ${WEEKDAY(carried[0].from)}, when the quest wasn't finished: ${carried.map((c) => c.label).join(", ")}.`);
        }
        const quest = await writeQuest(res.quest, writer, (s) =>
          setBuilding((b) => (b ? { ...b, status: { ...b.status, [s.partId]: s } } : b)),
        );
        const record = { quest, progress: emptyProgress(quest.id) };
        await data.qs.saveRecord(record);
        window.dispatchEvent(new Event(QUEST_CHANGED));
        setData((d) => (d ? { ...d, records: [...d.records, record] } : d));
        setBuilding(null);
      } catch (e) {
        setBuildError(message(e));
      }
    },
    [data, today],
  );

  // The placement check is written here, on the student's go. A retry carries on from the parts already written.
  const placed = useRef<{ quest: Quest; writtenIds: string[] } | null>(null);
  const writePlacement = async () => {
    if (!data) return;
    const { semester, mastery, qs } = data;
    const { quest, partCourse } = planPlacement(semester, mastery.attempts, mastery.reviews, today);
    const prev = placed.current;
    const resume = prev && prev.quest.parts.length === quest.parts.length && prev.quest.parts.every((p, i) => p.id === quest.parts[i].id);
    setBuildError(null);
    setBuilding({ plan: quest, status: {} });
    try {
      let placementQuestId = "none";
      if (quest.parts.length) {
        const writer = placementWriter(semester, quest, partCourse, askClaude, data.live ? null : sampleWriter(semester.skills));
        const written = await writeQuest(resume ? prev.quest : quest, writer, (st) => setBuilding((b) => (b ? { ...b, status: { ...b.status, [st.partId]: st } } : b)), {
          skip: resume ? new Set(prev.writtenIds) : undefined,
        });
        placed.current = null;
        const record = { quest: written, progress: emptyProgress(written.id) };
        await qs.saveRecord(record);
        setData((d) => (d ? { ...d, records: [...d.records, record] } : d));
        placementQuestId = written.id;
      }
      const s = { ...semester, placementQuestId };
      await qs.saveSemester(s);
      publish("semester", s, "quests");
      setData((d) => (d ? { ...d, semester: s } : d));
      setBuilding(null);
    } catch (e) {
      if (e instanceof QuestIncomplete) placed.current = { quest: e.quest, writtenIds: e.writtenIds };
      setBuildError(message(e));
    }
  };

  useEffect(() => {
    if (data && !current && !building && !autoBuilt.current && !planNotice && !needsPlacement) {
      autoBuilt.current = true;
      void build();
    }
  }, [data, current, building, build, needsPlacement]);

  const restartSample = async () => {
    if (!data) return;
    const semester = sampleSemester(toDay());
    await data.qs.saveSemester(semester);
    setData({ ...data, semester });
    autoBuilt.current = true;
    void build();
  };

  // Testing tools live in the sidebar's menu and arrive here as commands.
  const doneCommand = useRef<number | null>(null);
  useEffect(() => {
    if (!command || !data || doneCommand.current === command.id) return;
    doneCommand.current = command.id;
    if (command.kind === "build" && !(building && !buildError)) void build();
    if (command.kind === "restart" && data.semester.source === "sample") void restartSample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, data]);

  if (loadError) return <div className="quest-page"><p className="quest-error">Your quests couldn't be loaded: {loadError}</p></div>;
  if (needsSetup)
    return (
      <div className="quest-page">
        <section className="setup-card setup-welcome">
          <p className="quest-kicker">Welcome to StudyDesk</p>
          <h1>Set up your semester first</h1>
          <p>StudyDesk builds a quest for you every day, around your real courses, homework and exams. For that it needs a short setup: your courses, the grade you're aiming for in each, and how much time you have. About ten minutes, saved as you go.</p>
          <div className="setup-actions">
            <button type="button" className="link-btn" onClick={() => load(true)}>
              Look around with sample data first
            </button>
            <button type="button" className="mini-btn primary big" onClick={onStartSetup}>
              Set up your semester
            </button>
          </div>
        </section>
      </div>
    );
  if (!data) return <div className="quest-page"><p className="quest-muted">Loading today's quest…</p></div>;

  return (
    <div className="quest-page" ref={scroller} data-select-scope="">
      {!data.live && (
        <p className="quest-banner">Preview mode: no Claude here, so quests use sample text and a stand-in grader (an empty answer is "not yet", an answer with the word "typo" is a slip).</p>
      )}

      {leftovers && <p className="quest-banner">{leftovers}</p>}

      {needsPlacement && !building && (
        <section className="setup-card setup-welcome">
          <p className="quest-kicker">{data.semester.name}</p>
          <h1>Your semester is set up</h1>
          <p>Your first quest is a placement check: one short problem on each basic your courses build on and on each topic already taught. It finds out where you stand, so StudyDesk can plan the right amount each day.</p>
          <p className="quest-muted">Anything StudyDesk still wants to know about your courses is under To do on Organize, whenever you like.</p>
          <div className="setup-actions">
            <button type="button" className="mini-btn primary big" onClick={() => void writePlacement()}>
              Start the placement check
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

      {review && (
        <section className="review-card">
          <button type="button" className="ov-row review-row" aria-expanded={reviewOpen} onClick={() => setReviewOpen((o) => !o)}>
            <span className="ov-mark review-mark" aria-hidden="true">
              !
            </span>
            <span className="ov-main">
              <span className="ov-kind">Mistake review · {WEEKDAY(review.record.quest.date)}</span>
              <span className="ov-title">
                {review.mistakes.length} {review.mistakes.length === 1 ? "mistake" : "mistakes"} to understand
              </span>
            </span>
            <span className="ov-status">
              {review.mistakes.filter((m) => isResolved(m, data.mastery.reviews)).length} of {review.mistakes.length} understood
            </span>
            <svg className="ov-chev" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {reviewOpen && (
            <div className="review-chat">
              <ChatView
                key={review.record.quest.id}
                initial={data.reviewChats[review.record.quest.id] ?? newReviewChat(review.record.quest, review.mistakes)}
                rules={reviewRules(
                  review.mistakes,
                  data.semester.courses.find((c) => c.id === review.record.quest.courseId)?.name ?? "",
                  data.semester.courses.find((c) => c.id === review.record.quest.courseId)?.teachingLanguage ?? "English",
                )}
                placeholder="Answer here, or paste a photo of your working"
                save={async (chat) => {
                  setData((d) => (d ? { ...d, reviewChats: { ...d.reviewChats, [review.record.quest.id]: chat } } : d));
                  await data.qs.saveReviewChat(review.record.quest.id, chat);
                  // A passed check question resolves the mistake and counts for the skill.
                  const res = applyChecks(review.mistakes, checkResults(chat), data.mastery.reviews, review.record.quest.id, toDay(), Date.now());
                  if (!res.attempts.length && !res.reviews.length) return;
                  await data.ms.appendAttempts(res.attempts);
                  for (const r of res.reviews) await data.ms.putReview(r);
                  setData((d) =>
                    d
                      ? {
                          ...d,
                          mastery: {
                            ...d.mastery,
                            attempts: [...d.mastery.attempts, ...res.attempts.filter((a) => !d.mastery.attempts.some((x) => x.id === a.id))],
                            reviews: d.mastery.reviews.map((r) => res.reviews.find((u) => u.attemptId === r.attemptId) ?? r),
                          },
                        }
                      : d,
                  );
                }}
                onSaveError={() => {}}
              />
            </div>
          )}
        </section>
      )}

      {current && !currentDone && !building ? (
        <QuestView
          key={current.quest.id}
          record={current}
          data={data}
          scroller={scroller}
          extra={<ComingUp semester={data.semester} today={today} />}
          onRecord={(r) => setData((d) => (d ? { ...d, records: d.records.map((x) => (x.quest.id === r.quest.id ? r : x)) } : d))}
          onMastery={(m) => setData((d) => (d ? { ...d, mastery: m } : d))}
        />
      ) : current && currentDone && !building ? (
        <section className="quest-empty">
          <h2>Today's quest is done</h2>
          <p className="quest-muted">It's in the archive below{review?.record === current ? ", and the mistake review above goes through what went wrong" : ""}. Tomorrow's quest builds on today's results.</p>
          <ComingUp semester={data.semester} today={today} />
        </section>
      ) : building ? (
        <section className="quest-building" aria-live="polite">
          <h2>{needsPlacement ? "Writing your placement check" : "Writing today's quest"}</h2>
          <p className="quest-muted">{building.plan.reason}</p>
          <ol>
            {building.plan.parts.map((p, i) => {
              const st = building.status[p.id]?.state ?? "waiting";
              return (
                <li key={p.id} className={`b-${st}`}>
                  Part {i + 1} · {kindLabel(p)}: {p.title}
                  <span>{st === "done" ? "ready" : st === "failed" ? "failed" : st === "waiting" ? "waiting" : "writing…"}</span>
                </li>
              );
            })}
          </ol>
          {buildError && (
            <div className="quest-error">
              <p>{buildError}</p>
              <button type="button" className="mini-btn primary" onClick={() => void (needsPlacement ? writePlacement() : build(building.plan.budgetMinutes))}>
                Try again
              </button>
            </div>
          )}
        </section>
      ) : planNotice ? (
        <section className="quest-empty">
          {planNotice.kind === "no_time" ? (
            <>
              <h2>No quest today</h2>
              <p>Your study goal for {WEEKDAY(today)} is {planNotice.goalMinutes} min{planNotice.goalMinutes ? " and your lectures fill it" : ""}, so there's no quest. Enjoy the day off.</p>
            </>
          ) : (
            <>
              <h2>Nothing is due</h2>
              <p>No homework, reviews or new skills are waiting in this course right now.</p>
            </>
          )}
          <button type="button" className="mini-btn primary" onClick={() => void build(QUEST_CONFIG.restDayMinutes)}>
            Give me a {QUEST_CONFIG.restDayMinutes}-minute quest anyway
          </button>
        </section>
      ) : (
        <p className="quest-muted">Getting today's quest ready…</p>
      )}

      {archive.length > 0 && (
        <section className="archive" aria-label="Done quests">
          <h2 className="archive-h">Done quests</h2>
          <div className="overview">
            {archive.map((r) => {
              const isOpen = openArchived === r.quest.id;
              const course = data.semester.courses.find((c) => c.id === r.quest.courseId);
              const probs = r.quest.parts.flatMap((p) => (p.kind === "learn" ? [] : p.problems));
              const pts = probs.reduce((s, p) => s + (r.progress.work[p.id]?.points ?? 0), 0);
              const max = probs.reduce((s, p) => s + p.maxPoints, 0);
              const graded = isFinished(r.quest, r.progress);
              return (
                <div key={r.quest.id} className={"ov-part" + (isOpen ? " is-open" : "")}>
                  <button type="button" className="ov-row is-done" aria-expanded={isOpen} onClick={() => setOpenArchived(isOpen ? null : r.quest.id)}>
                    <span className={"ov-mark " + (graded ? "graded" : "done")} aria-hidden="true">
                      {graded ? "✓" : ""}
                    </span>
                    <span className="ov-main">
                      <span className="ov-kind">
                        {WEEKDAY(r.quest.date)} {r.quest.date.slice(5).replace("-", "/")} · {r.quest.parts.some((p) => p.kind !== "learn" && p.check) ? "Placement check" : course?.name}
                      </span>
                      <span className="ov-title">{r.quest.reason}</span>
                    </span>
                    <span className="ov-status">{graded ? `${pts}/${max}` : "Not finished"}</span>
                    <svg className="ov-chev" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {isOpen && (
                    <div className="archive-body">
                      <QuestView
                        key={r.quest.id}
                        record={r}
                        data={data}
                        scroller={scroller}
                        onRecord={(x) => setData((d) => (d ? { ...d, records: d.records.map((y) => (y.quest.id === x.quest.id ? x : y)) } : d))}
                        onMastery={(m) => setData((d) => (d ? { ...d, mastery: m } : d))}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
  /** Shown under the quest's header (Coming up). */
  extra?: React.ReactNode;
};

const KIND = { learn: "Learn", lesson: "Learn & try", practice: "Practice", assignment: "Homework" } as const;
const kindLabel = (p: QuestPart) => (p.kind !== "learn" && p.check ? "Placement check" : KIND[p.kind]);

const NOTE_RULES = `You are StudyDesk, a study assistant for high school and university students.
The student is working through today's study quest and highlighted a passage in it to ask about.
Your answer appears in a small side note right under that passage. So:
- Answer only the question about the highlighted passage, using the quest text as context.
- Be brief: usually 2 to 6 sentences, or a short list. A small example is fine when it helps.
- Don't restate the passage and don't greet.
- Use Markdown; write math with $...$ inline and $$...$$ for display formulas.`;

const HOMEWORK_RULE = `
- This passage belongs to real homework the student hasn't handed in yet. Guide with a question or the principle behind it; never give the answer or a finished step.`;


function QuestView({ record, data, scroller, onRecord, onMastery, extra }: ViewProps) {
  const { quest } = record;
  // The header shows only "Why today"; the extra notes open on request.
  const [notesOpen, setNotesOpen] = useState(false);
  const { semester, mastery, ms, qs, live } = data;
  // A copy of the work, and the saved version it's built on, is kept in this browser on every
  // change, so a crash or a closed tab loses nothing; its own changes are merged onto the saved record.
  const draftKey = `studydesk.questdraft.${quest.id}`;
  const base = useRef(record.progress); // the saved version this page's work is built on
  const [progress, setProgress] = useState<QuestProgress>(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || "null") as { base: QuestProgress; progress: QuestProgress } | null;
      if (d?.base && d.progress?.questId === quest.id) return mergeProgress(d.base, d.progress, record.progress);
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
  /** Changes on this page not yet saved. */
  const dirty = useRef(progress !== record.progress); // this browser's copy still has changes to save
  const saving = useRef<Promise<void>>(Promise.resolve()); // saves and reloads run one after another

  const skills = useMemo(() => new Map(semester.skills.map((s) => [s.id, s])), [semester]);
  const course = semester.courses.find((c) => c.id === quest.courseId);
  const deck = semester.questSettings?.anki ? ankiDeck(quest, data.records, semester) : null;
  const ask = live ? askClaude : sampleGradingAsk;

  const onRecordRef = useRef(onRecord);
  onRecordRef.current = onRecord;
  /** Takes over a newer saved copy, keeping this page's changes since `from`. */
  const adopt = useCallback(
    (from: QuestProgress, saved: QuestProgress) => {
      const next = mergeProgress(from, progressRef.current, saved);
      base.current = saved;
      progressRef.current = next;
      setProgress(next);
      onRecordRef.current({ quest, progress: next });
    },
    [quest],
  );
  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!dirty.current) return saving.current;
    dirty.current = false;
    return (saving.current = saving.current.then(async () => {
      const mine = progressRef.current;
      try {
        adopt(mine, (await qs.saveRecord({ quest, progress: mine }, base.current)).progress);
        setErrors((e) => (e.save ? { ...e, save: "" } : e));
      } catch {
        dirty.current = true;
        setErrors((e) => ({ ...e, save: "Your work couldn't be saved. Keep this page open and try again." }));
      }
    }));
  }, [qs, quest, adopt]);

  const saveSoon = useCallback(() => {
    dirty.current = true;
    if (!saveTimer.current) saveTimer.current = setTimeout(() => void flush(), 2000);
  }, [flush]);

  useEffect(() => () => void flush(), [flush]);

  // Local draft on every change; saved for real when the tab is hidden or closed.
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ base: base.current, progress }));
    } catch {
      /* storage full or blocked: the 2-second save still runs */
    }
  }, [progress, draftKey]);
  // Back on the page: take over work saved elsewhere (another tab or device), keeping this page's own changes.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== "visible") return;
      saving.current = saving.current
        .then(() => qs.loadRecords())
        .then((rs) => {
          const r = rs.find((x) => x.quest.id === quest.id);
          if (r && r.progress.updatedAt !== base.current.updatedAt) adopt(base.current, r.progress);
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [qs, quest, adopt]);
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
    commit((p) => ({ ...p, handedIn: [...p.handedIn.filter((x) => x !== part.id), part.id], updatedAt: Date.now() }));
    window.dispatchEvent(new Event(QUEST_CHANGED));
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
  const doneCount = quest.parts.filter((p) => progress.handedIn.includes(p.id)).length;
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
          {WEEKDAY(quest.date)} · {quest.parts.some((p) => p.kind !== "learn" && p.check) ? "Placement check" : course?.name} · about {quest.plannedMinutes} min
        </p>
        <h1>Today's quest</h1>
        <p className="quest-reason">
          <strong>Why today:</strong> {quest.reason}
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
              More about this quest
            </button>
          ))}
        {deck && (
          <button type="button" className="mini-btn" onClick={() => void offerDownload(`${course?.short || course?.name || "StudyDesk"} ${quest.date}.txt`, deck.text)}>
            Export deck ({deck.count} cards)
          </button>
        )}
      </header>

      {extra}

      {errors.save && <p className="quest-error">{errors.save}</p>}

      <section className="overview" aria-label="Today's parts">
        {quest.parts.map((part, i) => {
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
            {doneCount} of {quest.parts.length} done
            {spentSeconds > 0 && <> · {clock(spentSeconds)} worked</>}
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
        Active time {clock(spentSeconds)} against a plan of about {quest.plannedMinutes} min. These times train your estimates, so tomorrow's quest fits better.
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
