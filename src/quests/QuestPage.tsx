import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../chat/Markdown";
import { CONFIG } from "../mastery/config";
import { toDay } from "../mastery/days";
import { answerSlip, GradingFailed } from "../mastery/grading";
import { replay } from "../mastery/replay";
import { askClaude, claudeAvailable, errorCopy, type AskError } from "../platform/claude";
import { openMasteryStore, type MasteryData, type MasteryStore } from "../platform/masteryStore";
import { openQuestStore, type QuestStore } from "../platform/questStore";
import { QUEST_CONFIG } from "./config";
import { answerUnlocked, emptyProgress, emptyWork, gateFailed, handIn, isFinished, lockedParts } from "./handin";
import { doneTasks, formatDue, planQuest, recentBlockers, type PlanResult } from "./plan";
import { ProblemCard, clock } from "./ProblemCard";
import { sampleFixIt, sampleGradingAsk, sampleSemester, sampleWriter } from "./seed";
import type { AnswerFile, ProblemPart, ProblemWork, Quest, QuestProgress, QuestRecord, Semester } from "./types";
import { claudeWriter, writeFixIt, writeQuest, type WriteStatus } from "./write";

// The quest page: builds today's quest on the first open of the day (the
// in-page fallback from the design), then lets the student work through it
// part by part and hand each problem part in to the grading agent.
// Rough on purpose: the overall app layout comes later.

type Data = { qs: QuestStore; ms: MasteryStore; semester: Semester; records: QuestRecord[]; mastery: MasteryData; live: boolean };

function nowLocal(d = new Date()): string {
  return `${toDay(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function message(e: unknown): string {
  if (e instanceof GradingFailed) return "The grading agent's answer couldn't be used, even after a retry. Try handing in again.";
  if (e && typeof e === "object" && "code" in e) return errorCopy(e as AskError);
  return e instanceof Error ? e.message : "Something went wrong.";
}

const WEEKDAY = (day: string) => new Date(`${day}T12:00`).toLocaleDateString("en", { weekday: "long" });

export function QuestPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [building, setBuilding] = useState<{ plan: Quest; status: Record<string, WriteStatus> } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [planNotice, setPlanNotice] = useState<Exclude<PlanResult, { kind: "quest" }> | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const autoBuilt = useRef(false);
  const today = toDay();

  useEffect(() => {
    (async () => {
      const [qs, ms, live] = await Promise.all([openQuestStore(), openMasteryStore(), claudeAvailable()]);
      let semester = await qs.loadSemester();
      if (!semester) {
        semester = sampleSemester(toDay());
        await qs.saveSemester(semester);
      }
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
      const records = await qs.loadRecords();
      setData({ qs, ms, semester, records, mastery, live });
    })().catch((e) => setLoadError(message(e)));
  }, []);

  const current = useMemo(
    () => data?.records.filter((r) => r.quest.date === today).sort((a, b) => b.quest.createdAt - a.quest.createdAt)[0] ?? null,
    [data, today],
  );

  const build = useCallback(
    async (budgetOverride?: number) => {
      if (!data) return;
      setBuildError(null);
      setPlanNotice(null);
      const { semester, records, mastery } = data;
      const res = planQuest({
        semester,
        today,
        nowLocal: nowLocal(),
        attempts: mastery.attempts,
        reviews: mastery.reviews,
        doneTaskIds: doneTasks(records),
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
        const writer = data.live ? claudeWriter(semester, res.quest, knownIds, askClaude) : sampleWriter(semester.skills);
        const quest = await writeQuest(res.quest, writer, (s) =>
          setBuilding((b) => (b ? { ...b, status: { ...b.status, [s.partId]: s } } : b)),
        );
        const record = { quest, progress: emptyProgress(quest.id) };
        await data.qs.saveRecord(record);
        setData((d) => (d ? { ...d, records: [...d.records, record] } : d));
        setBuilding(null);
      } catch (e) {
        setBuildError(message(e));
      }
    },
    [data, today],
  );

  useEffect(() => {
    if (data && !current && !building && !autoBuilt.current) {
      autoBuilt.current = true;
      void build();
    }
  }, [data, current, building, build]);

  const restartSample = async () => {
    if (!data) return;
    const semester = sampleSemester(toDay());
    await data.qs.saveSemester(semester);
    setData({ ...data, semester });
    setConfirmRestart(false);
    autoBuilt.current = true;
    void build();
  };

  if (loadError) return <div className="quest-page"><p className="quest-error">Your quests couldn't be loaded: {loadError}</p></div>;
  if (!data) return <div className="quest-page"><p className="quest-muted">Loading today's quest…</p></div>;

  return (
    <div className="quest-page">
      {!data.live && (
        <p className="quest-banner">Preview mode: no Claude here, so quests use sample text and a stand-in grader (an empty answer is "not yet", an answer with the word "typo" is a slip).</p>
      )}

      {current && !building ? (
        <QuestView
          key={current.quest.id}
          record={current}
          data={data}
          onRecord={(r) => setData((d) => (d ? { ...d, records: d.records.map((x) => (x.quest.id === r.quest.id ? r : x)) } : d))}
          onMastery={(m) => setData((d) => (d ? { ...d, mastery: m } : d))}
        />
      ) : building ? (
        <section className="quest-building" aria-live="polite">
          <h2>Writing today's quest</h2>
          <p className="quest-muted">{building.plan.reason}</p>
          <ol>
            {building.plan.parts.map((p, i) => {
              const st = building.status[p.id]?.state ?? "writing";
              return (
                <li key={p.id} className={`b-${st}`}>
                  Part {i + 1} · {p.kind === "learn" ? "Learn" : p.kind === "practice" ? "Practice" : "Assignment"}: {p.title}
                  <span>{st === "done" ? "ready" : st === "failed" ? "failed" : "writing…"}</span>
                </li>
              );
            })}
          </ol>
          {buildError && (
            <div className="quest-error">
              <p>{buildError}</p>
              <button type="button" className="mini-btn primary" onClick={() => void build(building.plan.budgetMinutes)}>
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

      <footer className="quest-testing">
        <span>Testing tools</span>
        <button type="button" className="link-btn" disabled={!!building && !buildError} onClick={() => void build()}>
          Build a new quest for today
        </button>
        {confirmRestart ? (
          <span>
            Restart with fresh sample homework (Sheet 4 due tomorrow)? Your attempts are kept.{" "}
            <button type="button" className="link-btn" onClick={() => void restartSample()}>
              Restart
            </button>{" "}
            <button type="button" className="link-btn" onClick={() => setConfirmRestart(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="link-btn" onClick={() => setConfirmRestart(true)}>
            Restart the sample semester
          </button>
        )}
        <span className="quest-muted">
          {data.semester.source === "sample" ? "Using sample course data (Calculus 1) until Start New Semester is built." : ""}
        </span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

type ViewProps = {
  record: QuestRecord;
  data: Data;
  onRecord: (r: QuestRecord) => void;
  onMastery: (m: MasteryData) => void;
};

function QuestView({ record, data, onRecord, onMastery }: ViewProps) {
  const { quest } = record;
  const { semester, mastery, ms, qs, live } = data;
  const [progress, setProgress] = useState<QuestProgress>(record.progress);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const images = useRef<Record<string, Blob[]>>({});
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const skills = useMemo(() => new Map(semester.skills.map((s) => [s.id, s])), [semester]);
  const course = semester.courses.find((c) => c.id === quest.courseId);
  const ask = live ? askClaude : sampleGradingAsk;

  const onRecordRef = useRef(onRecord);
  onRecordRef.current = onRecord;
  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const r = { quest, progress: progressRef.current };
    onRecordRef.current(r);
    return qs
      .saveRecord(r)
      .then(() => setErrors((e) => (e.save ? { ...e, save: "" } : e)))
      .catch(() => setErrors((e) => ({ ...e, save: "Your work couldn't be saved. Keep this page open and try again." })));
  }, [qs, quest]);

  const saveSoon = useCallback(() => {
    if (!saveTimer.current) saveTimer.current = setTimeout(() => void flush(), 5000);
  }, [flush]);

  useEffect(() => () => void flush(), [flush]);

  const setWork = (id: string, patch: Partial<ProblemWork>) => {
    setProgress((p) => ({ ...p, work: { ...p.work, [id]: { ...(p.work[id] ?? emptyWork()), ...patch } }, updatedAt: Date.now() }));
    saveSoon();
  };

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
  };

  // ---- hand-in ----
  const submit = async (key: string, problems: Parameters<typeof handIn>[0]["problems"], after: (p: QuestProgress) => QuestProgress) => {
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    if (activeId && problems.some((x) => x.problem.id === activeId)) setActiveId(null);
    try {
      // Images whose bytes were lost on reload can't be sent; the grader is told about text only.
      const res = await handIn({ quest, problems, work: progressRef.current.work, images: images.current, semester, today: toDay(), nowLocal: nowLocal(), ask });
      await ms.appendAttempts(res.attempts);
      for (const r of res.reviews) await ms.putReview(r);
      onMastery({ ...mastery, attempts: [...mastery.attempts, ...res.attempts], reviews: [...mastery.reviews, ...res.reviews] });
      let next: QuestProgress = { ...progressRef.current, work: { ...progressRef.current.work, ...res.work }, updatedAt: Date.now() };
      next = after(next);
      if (!next.finishedAt && isFinished(quest, next)) next.finishedAt = Date.now();
      progressRef.current = next;
      setProgress(next);
      await flush();
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: message(e) }));
    } finally {
      setBusy(null);
    }
  };

  const handInPart = (part: ProblemPart) =>
    submit(
      part.id,
      part.problems.map((problem) => ({ problem, part })),
      (p) => ({ ...p, handedIn: [...p.handedIn, part.id] }),
    );

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

  // ---- fix-its after a failed gate ----
  const failedIn = (part: ProblemPart) =>
    part.problems.filter((p) => {
      const w = progress.work[p.id];
      return w?.verdict === "not_understood" || (w?.verdict === "slip" && w.slipAnswer === "disputed");
    });

  const startFixIts = async (part: ProblemPart) => {
    const key = `${part.id}-fix`;
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const fixes = await Promise.all(
        failedIn(part)
          .filter((p) => !progress.fixIts.some((f) => f.fromProblemId === p.id))
          .map((p) => {
            const w = progress.work[p.id];
            return live ? writeFixIt(semester, quest, p, w?.answerText ?? "", w?.feedback ?? "", askClaude) : sampleFixIt(p);
          }),
      );
      setProgress((p) => ({ ...p, fixIts: [...p.fixIts, ...fixes] }));
      setTimeout(() => void flush(), 0);
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: message(e) }));
    } finally {
      setBusy(null);
    }
  };

  const handInFixIts = (part: ProblemPart) => {
    const fixes = progress.fixIts.filter((f) => part.problems.some((p) => p.id === f.fromProblemId) && !progress.work[f.problem.id]?.verdict);
    return submit(
      `${part.id}-fix`,
      fixes.map((f) => ({ problem: f.problem, part: "fixit" as const })),
      (p) => ({ ...p, gatesCleared: [...p.gatesCleared, part.id] }),
    );
  };

  const clearGate = (part: ProblemPart) => {
    setProgress((p) => ({ ...p, gatesCleared: [...p.gatesCleared, part.id] }));
    setTimeout(() => void flush(), 0);
  };

  // ---- rendering ----
  const locked = lockedParts(quest, progress);
  const nl = nowLocal();
  let problemN = 0;
  const spentSeconds = Object.values(progress.work).reduce((s, w) => s + (w.activeSeconds || 0), 0);

  const card = (problem: ProblemPart["problems"][number], part: ProblemPart | "fixit", isLocked: boolean) => {
    const w = progress.work[problem.id] ?? emptyWork();
    const a = part !== "fixit" && part.kind === "assignment" ? semester.assignments.find((x) => x.id === part.assignmentId) : undefined;
    return (
      <ProblemCard
        key={problem.id}
        n={++problemN}
        problem={problem}
        skillName={skills.get(problem.skillId)?.name ?? ""}
        work={w}
        locked={isLocked || busy !== null}
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
  };

  return (
    <div className="quest">
      <header className="quest-head">
        <p className="quest-kicker">
          {WEEKDAY(quest.date)} · {course?.name} · about {quest.plannedMinutes} min
        </p>
        <h1>Today's quest</h1>
        <p className="quest-reason">
          <strong>Why today:</strong> {quest.reason}
        </p>
        {quest.notes.map((n, i) => (
          <p key={i} className="quest-note">
            {n}
          </p>
        ))}
        <ol className="quest-toc">
          {quest.parts.map((p, i) => (
            <li key={p.id} className={p.kind !== "learn" && progress.handedIn.includes(p.id) ? "is-done" : ""}>
              <a href={`#${p.id}`}>
                Part {i + 1} · {p.kind === "learn" ? "Learn" : p.kind === "practice" ? (p.gate ? "Practice (gate)" : "Practice") : "Assignment"}
              </a>
              <span>
                {p.kind === "learn" ? p.estMinutes : p.problems.reduce((s, q) => s + q.expMinutes, 0)} min
              </span>
            </li>
          ))}
        </ol>
      </header>

      {errors.save && <p className="quest-error">{errors.save}</p>}

      {quest.parts.map((part, i) => {
        if (part.kind === "learn") {
          return (
            <section key={part.id} id={part.id} className="part part-learn">
              <h2>
                <span className="part-n">Part {i + 1} · Learn</span>
                {part.title}
                <span className="part-min">about {part.estMinutes} min</span>
              </h2>
              <Markdown text={part.body} />
            </section>
          );
        }
        const isLocked = locked.has(part.id);
        const handedIn = progress.handedIn.includes(part.id);
        const failed = handedIn && part.gate && gateFailed(part, progress);
        const fixes = progress.fixIts.filter((f) => part.problems.some((p) => p.id === f.fromProblemId));
        const fixesOpen = fixes.some((f) => !progress.work[f.problem.id]?.verdict);
        const cleared = progress.gatesCleared.includes(part.id);
        const empty = part.problems.filter((p) => {
          const w = progress.work[p.id];
          return !w || (!w.answerText.trim() && !w.files.length);
        }).length;
        return (
          <section key={part.id} id={part.id} className={"part part-problems" + (isLocked ? " is-locked" : "")}>
            <h2>
              <span className="part-n">
                Part {i + 1} · {part.kind === "practice" ? "Practice" : "Assignment"}
              </span>
              {part.title}
            </h2>
            {part.gate && !handedIn && <p className="part-note">The rest of the quest builds on these. If one isn't understood yet, the quest pauses for a short fix-it.</p>}
            {part.kind === "assignment" && !handedIn && (
              <p className="part-note">This is your real homework. Solve it the way you'd hand it in, then upload a photo or type your answer. Hints guide you without giving the answer away.</p>
            )}
            {isLocked && <p className="part-note is-warn">This part opens after the fix-it above.</p>}

            {part.problems.map((p) => card(p, part, isLocked))}

            {!handedIn && (
              <div className="handin">
                {empty > 0 && !isLocked && (
                  <span className="quest-muted">
                    {empty} {empty === 1 ? "problem has" : "problems have"} no answer yet and would count as not understood.
                  </span>
                )}
                <button type="button" className="mini-btn primary" disabled={isLocked || busy !== null} onClick={() => void handInPart(part)}>
                  {busy === part.id ? "Grading…" : `Hand in Part ${i + 1}`}
                </button>
                {errors[part.id] && <p className="quest-error">{errors[part.id]}</p>}
              </div>
            )}

            {failed && !cleared && (
              <div className="fixit">
                <h3>Fix-it first</h3>
                <p>The next parts need {failedIn(part).map((p) => skills.get(p.skillId)?.name).join(" and ")}. A short explanation and one fresh problem will sort it out.</p>
                {fixes.length === 0 ? (
                  <button type="button" className="mini-btn primary" disabled={busy !== null} onClick={() => void startFixIts(part)}>
                    {busy === `${part.id}-fix` ? "Writing the fix-it…" : "Start the fix-it"}
                  </button>
                ) : (
                  fixes.map((f) => (
                    <div key={f.problem.id} className="fixit-item">
                      <Markdown text={f.explanation} />
                      {card(f.problem, "fixit", false)}
                    </div>
                  ))
                )}
                {fixes.length > 0 && fixesOpen && (
                  <button type="button" className="mini-btn primary" disabled={busy !== null} onClick={() => void handInFixIts(part)}>
                    {busy === `${part.id}-fix` ? "Grading…" : "Hand in the fix-it"}
                  </button>
                )}
                {errors[`${part.id}-fix`] && <p className="quest-error">{errors[`${part.id}-fix`]}</p>}
                <button type="button" className="link-btn" onClick={() => clearGate(part)}>
                  Continue without the fix-it
                </button>
              </div>
            )}
            {failed && cleared && fixes.length > 0 && (
              <div className="fixit is-done">
                {fixes.map((f) => (
                  <div key={f.problem.id} className="fixit-item">
                    <Markdown text={f.explanation} />
                    {card(f.problem, "fixit", true)}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {progress.finishedAt && <Summary quest={quest} progress={progress} mastery={mastery} spentSeconds={spentSeconds} semester={semester} />}
    </div>
  );
}

function Summary({ quest, progress, mastery, spentSeconds, semester }: { quest: Quest; progress: QuestProgress; mastery: MasteryData; spentSeconds: number; semester: Semester }) {
  const attemptIds = new Set(Object.values(progress.work).map((w) => w.attemptId).filter(Boolean) as string[]);
  const { states, points } = replay(mastery.skills, mastery.attempts, mastery.reviews);
  const earned = points.filter((p) => p.attemptId && attemptIds.has(p.attemptId)).reduce((s, p) => s + p.points, 0);
  const total = earned + CONFIG.points.quest_finished;
  const skillIds = [...new Set(quest.parts.flatMap((p) => (p.kind === "learn" ? [] : p.problems.map((q) => q.skillId))))];
  const verdicts = Object.values(progress.work).filter((w) => w.verdict);
  const pendingSlips = verdicts.filter((w) => w.verdict === "slip" && !w.slipAnswer).length;
  return (
    <section className="part summary">
      <h2>
        <span className="part-n">Done</span>
        Quest finished
      </h2>
      <p className="summary-points">
        +{total} points <span className="quest-muted">({earned} from problems, {CONFIG.points.quest_finished} for finishing)</span>
      </p>
      <p>
        Active time {clock(spentSeconds)} against a plan of about {quest.plannedMinutes} min. These times train your estimates, so tomorrow's quest fits better.
      </p>
      {pendingSlips > 0 && <p className="part-note is-warn">Answer the slip {pendingSlips === 1 ? "question" : "questions"} above so your streaks count correctly.</p>}
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
