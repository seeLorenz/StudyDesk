// Keeps StudyDesk's study entries in the student's calendar in step with
// today's quest, while the page is open. design/scheduled-runs.md, "Study
// times in the calendar". Plumbing; the decisions are in src/quests/times.ts.

import { createEntry, dayLines, deleteEntries, readCalendar } from "./calendar";
import { askClaude } from "./claude";
import { openOnboardingStore } from "./onboardingStore";
import { openOrchestratorStore } from "./orchestratorStore";
import type { QuestStore } from "./questStore";
import { studentTimeZone } from "./schedule";
import { applyWant, busyLines, calendarWant, pickTimes, planStep, studyEntries } from "../quests/times";
import type { Day } from "../mastery/types";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function syncStudyEntries(qs: QuestStore, today: Day): Promise<void> {
  const [{ want, written }, records, semester] = await Promise.all([qs.loadEntries(), qs.loadRecords(), qs.loadSemester()]);
  const rec = records.filter((r) => r.quest.date === today && !r.progress.replacedAt).sort((a, b) => b.quest.createdAt - a.quest.createdAt)[0] ?? null;
  const d = new Date();
  const now = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  let plan = want;
  const step = planStep(want, rec, today, now);
  if (step === "pick" && rec) {
    // Today's calendar, read now: placing study time on a stale or empty read is how a block lands on a lecture.
    const [events, orch, profile] = await Promise.all([readCalendar(today, 1), openOrchestratorStore().then((o) => o.loadState()), openOnboardingStore().then((o) => o.loadProfile())]);
    const courseName = semester?.courses.find((c) => c.id === rec.quest.courseId)?.name ?? "Quest";
    const times = await pickTimes((t, o) => askClaude(t, { ...o, background: true }), {
      quest: rec.quest,
      courseName,
      weekday: WEEKDAY[d.getDay()],
      events: busyLines(dayLines(events, today), semester?.timetable ?? [], d.getDay()),
      notes: orch.memory.text,
      after: now,
    });
    plan = calendarWant(today, rec.quest.id, studyEntries({ day: today, times, courseName, reason: rec.quest.reason, timeZone: studentTimeZone(), url: profile?.handoff?.artifactUrl ?? null }));
  } else if (step && step !== "pick") plan = step;
  if (plan !== want) await qs.saveWant(plan!);
  const next = await applyWant(plan, written, today, { create: createEntry, remove: deleteEntries });
  if (next) await qs.saveWritten(next);
}
