// Organization agent jobs started from the Orchestrator chat.
// design/orchestrator.md, "Jobs for the organization agent".
//
// A job runs as the setup run of its courses (the same reading the semester
// setup does, in a cloud session when hand-off is on, in the page otherwise):
// starting one records what the student said and the files as facts and
// uploads of the course, and marks the course for reading. Its state is read
// back from those courses. Pure, so it is tested.

import { uid } from "../chat/types";
import type { SemesterDraft } from "../onboarding/types";
import { findCourse, type Desk } from "./changes";
import type { Job, JobRequest } from "./types";

export type JobFile = { uploadId: string; course: string; note?: string };

const busy = (d: SemesterDraft, id: string) => {
  const c = d.courses.find((x) => x.id === id);
  return c?.setupStatus === "waiting" || c?.setupStatus === "reading";
};

const counts = (d: SemesterDraft, id: string) => {
  const r = d.results[id];
  return { skills: r?.skills.length ?? 0, assignments: r?.assignments.length ?? 0, keyDates: r?.keyDates.length ?? 0 };
};

/** Marks the job's courses for reading. Used when a job starts, and when a queued one gets its turn. */
function launch(draft: SemesterDraft, courseIds: string[]): SemesterDraft {
  const ids = new Set(courseIds);
  return {
    ...draft,
    setupStep: "running",
    courses: draft.courses.map((c) => (ids.has(c.id) ? { ...c, setupStatus: "waiting", cloudFailed: undefined, job: undefined, setupError: undefined } : c)),
  };
}

export function startJob(
  desk: Desk,
  input: { kind: JobRequest["kind"]; courses: unknown[]; files?: JobFile[]; studentWords: string },
  running: Job[],
  now = Date.now(),
): { ok: true; desk: Desk; job: Job; note: string } | { ok: false; reason: string } {
  let draft = { ...desk.draft };
  const courses = input.courses.map((c) => findCourse(draft, c));
  if (!courses.length || courses.some((c) => !c)) return { ok: false, reason: `Unknown course: ${input.courses.map(String).join(", ")}. Courses: ${draft.courses.map((c) => `${c.name} (${c.id})`).join(", ")}.` };
  const ids = [...new Set(courses.map((c) => c!.id))];
  const files = input.files ?? [];
  const uploadIds: string[] = [];
  for (const f of files) {
    const u = draft.uploads.find((x) => x.id === f.uploadId);
    const c = findCourse(draft, f.course);
    if (!u || !c) return { ok: false, reason: `File ${f.uploadId} can't be assigned: ${!u ? "no such file" : "no such course"}.` };
    draft = { ...draft, uploads: draft.uploads.map((x) => (x.id === u.id ? { ...x, courseId: c.id, studentNote: f.note?.trim() || x.studentNote } : x)) };
    uploadIds.push(u.id);
    if (!ids.includes(c.id)) ids.push(c.id);
  }
  const words = input.studentWords.trim();
  if (words) draft = { ...draft, facts: [...draft.facts, ...ids.map((id) => ({ id: uid(), courseId: id, text: words, addedAt: now }))] };

  const queued = ids.some((id) => busy(draft, id) || running.some((j) => (j.status === "running" || j.status === "queued") && j.courseIds.includes(id)));
  if (!queued) draft = launch(draft, ids);
  const before = Object.fromEntries(ids.map((id) => [id, counts(desk.draft, id)]));
  const job: Job = { id: `job_${uid()}`, kind: input.kind, courseIds: ids, studentWords: words, uploadIds, startedAt: now, before, status: queued ? "queued" : "running", finishedAt: null, result: [] };
  return {
    ok: true,
    desk: { ...desk, draft: { ...draft, updatedAt: now } },
    job,
    note: queued ? "Queued: one of these courses is being read right now; this job starts when that's done." : "Started.",
  };
}

/**
 * Brings jobs up to date with their courses: finishes jobs whose courses were
 * read since they started, and launches queued jobs whose courses are free.
 */
export function advanceJobs(draft0: SemesterDraft, jobs: Job[], now = Date.now()): { draft: SemesterDraft; jobs: Job[]; changed: boolean } {
  let draft = draft0;
  let changed = false;
  const names = new Map(draft.courses.map((c) => [c.id, c.name]));
  const next = jobs.map((j) => {
    if (j.status !== "running") return j;
    const cs = j.courseIds.map((id) => draft.courses.find((c) => c.id === id));
    if (cs.some((c) => c && (c.setupStatus === "waiting" || c.setupStatus === "reading"))) return j;
    const failed = cs.filter((c) => !c || c.setupStatus === "failed" || !draft.results[c.id] || draft.results[c.id].finishedAt < j.startedAt);
    const result = j.courseIds.map((id) => {
      const c = draft.courses.find((x) => x.id === id);
      const r = draft.results[id];
      if (!c) return `${names.get(id) ?? id}: no longer in the semester`;
      if (c.setupStatus === "failed" || !r || r.finishedAt < j.startedAt) return `${c.name}: couldn't be read${c.setupError ? ` (${c.setupError})` : ""}`;
      const b = j.before[id] ?? { skills: 0, assignments: 0, keyDates: 0 };
      const d = (n: number, word: string) => (n > 0 ? `${n} new ${word}` : n < 0 ? `${-n} fewer ${word}` : "");
      const parts = [d(r.skills.length - b.skills, "skills"), d(r.assignments.length - b.assignments, "homework sheets"), d(r.keyDates.length - b.keyDates, "dates")].filter(Boolean);
      const qs = r.questions.length ? `, ${r.questions.length} ${r.questions.length === 1 ? "question" : "questions"} for you` : "";
      return `${c.name}: ${parts.length ? parts.join(", ") : "read again, nothing new to count"}${qs}`;
    });
    changed = true;
    return { ...j, status: failed.length === cs.length ? ("failed" as const) : ("done" as const), finishedAt: now, result };
  });
  // Queued jobs start once none of their courses is still being read.
  const out = next.map((j) => {
    if (j.status !== "queued") return j;
    const blocked = j.courseIds.some((id) => busy(draft, id) || next.some((o) => o !== j && o.status === "running" && o.courseIds.includes(id)));
    if (blocked) return j;
    draft = launch(draft, j.courseIds);
    changed = true;
    return { ...j, status: "running" as const, startedAt: now };
  });
  return { draft, jobs: out, changed };
}
