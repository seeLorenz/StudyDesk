// The done screen's to-do list: what the setup run still needs from the
// student, boiled down so it can be worked through one item at a time.
// Pure, so it is tested; the questions themselves come from the setup run.

import { MAX_QUESTIONS } from "./setup";
import type { DraftCourse, SemesterDraft } from "./types";

export type TodoItem = {
  /** "upload" or "q-<courseId>"; ticked-off keys live in draft.todoDone. */
  key: string;
  title: string;
  /** Markdown, shown with select-to-reply. */
  body: string;
  /** The text put into the chat when the student starts this item. */
  chatPrompt: string;
  done: boolean;
};

/** A question that only asks for files: those are merged into one "upload" item. */
export const asksForFiles = (q: string) => /\b(upload|share|send)\b|\bsyllabus\b|LV-Beschreibung/i.test(q);

const label = (c: DraftCourse) => c.short || c.name;

export function setupTodo(draft: SemesterDraft): TodoItem[] {
  const done = new Set(draft.todoDone ?? []);
  const items: TodoItem[] = [];
  const results = draft.courses.filter((c) => draft.results[c.id]);

  const needFiles = results.filter((c) => {
    const r = draft.results[c.id];
    return r.basis === "general" || r.questions.some(asksForFiles);
  });
  if (needFiles.length) {
    const names = needFiles.map(label).join(", ");
    items.push({
      key: "upload",
      title: `Add materials for ${needFiles.length} ${needFiles.length === 1 ? "course" : "courses"}`,
      body: `StudyDesk only guessed what **${names}** ${needFiles.length === 1 ? "covers" : "cover"}, or is missing sheets. Drop the course description with the weekly schedule and any current exercise sheets into the chat, and say which course each is for.`,
      chatPrompt: `Next on your list: materials. I only guessed what ${names} ${needFiles.length === 1 ? "covers" : "cover"}, or I'm missing sheets. Drop the course description (with the weekly schedule) and any current exercise sheets here, one course at a time, and tell me which course each file is for.`,
      done: done.has("upload"),
    });
  }

  for (const c of results) {
    const qs = draft.results[c.id].questions.filter((q) => !asksForFiles(q)).slice(0, MAX_QUESTIONS);
    if (!qs.length) continue;
    const key = `q-${c.id}`;
    items.push({
      key,
      title: `${label(c)}: ${qs.length} ${qs.length === 1 ? "question" : "questions"}`,
      body: qs.map((q) => `- ${q}`).join("\n"),
      chatPrompt: `Next on your list: ${c.name}. ${qs.length === 1 ? "One question" : `${qs.length} quick questions`}. Answer whatever you know, skip the rest:\n\n${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
      done: done.has(key),
    });
  }
  return items;
}

/** Courses whose answers or files changed since they were set up, so re-reading them would change something. */
export function staleCourses(draft: SemesterDraft): DraftCourse[] {
  return draft.courses.filter((c) => {
    const r = draft.results[c.id];
    if (!r) return false;
    return draft.uploads.some((u) => u.courseId === c.id && u.addedAt > r.finishedAt) || draft.facts.some((f) => f.courseId === c.id && f.addedAt > r.finishedAt);
  });
}
