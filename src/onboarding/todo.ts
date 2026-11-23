// The done screen's to-do list: what the setup run still needs from the
// student, boiled down so it can be worked through one item at a time.
// Pure, so it is tested; the questions themselves come from the setup run.

import { toDay } from "../mastery/days";
import type { Day } from "../mastery/types";
import { MAX_QUESTIONS } from "./setup";
import type { DraftCourse, SemesterDraft } from "./types";

export type TodoItem = {
  /** "upload", "conflicts" or "q-<courseId>"; ticked-off keys live in draft.todoDone. */
  key: string;
  title: string;
  /** Markdown, shown with select-to-reply. */
  body: string;
  /** The text put into the chat when the student starts this item. */
  chatPrompt: string;
  done: boolean;
  /**
   * The single questions or disagreements of this item, each ticked off
   * on its own (key "<item key>:<id>", also in draft.todoDone). The item is done
   * once every sub-item is, or when it is ticked as a whole.
   */
  subs?: TodoSub[];
};

export type TodoSub = { key: string; text: string; done: boolean };

/** A short, stable id for a sub-item's text, so a tick survives re-ordering. */
export function subId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Builds an item with sub-items; the title, body and chat prompt name only what's still open. */
function withSubs(
  done: Set<string>,
  key: string,
  lines: string[],
  make: (open: string[], total: number) => { title: string; body: string; chatPrompt: string },
): TodoItem {
  const subs = lines.map((text) => {
    const k = `${key}:${subId(text)}`;
    return { key: k, text, done: done.has(k) || done.has(key) };
  });
  const open = subs.filter((x) => !x.done).map((x) => x.text);
  return { key, ...make(open.length ? open : lines, lines.length), done: done.has(key) || open.length === 0, subs };
}

/** A question that only asks for files: those are merged into one "upload" item. */
export const asksForFiles = (q: string) => /\b(upload|share|send)\b|\bsyllabus\b|LV-Beschreibung/i.test(q);

const label = (c: DraftCourse) => (c.short || c.name).trim();

/** Disagreements and questions shown per day, so the student is never handed a pile. */
export const ASKS_PER_DAY = 3;

export function setupTodo(draft: SemesterDraft, today: Day = toDay()): TodoItem[] {
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

  // Disagreements and questions, a few a day: those of the course with the
  // nearest exam or deadline first. Exam dates aren't listed: the Orchestrator
  // checks each one in the two weeks before it.
  const asks = results
    .flatMap((c) => {
      const r = draft.results[c.id];
      const at = [...r.keyDates.map((k) => k.date), ...r.assignments.map((x) => x.dueAt)].filter((d) => d >= today).sort()[0] ?? "~";
      return [
        ...r.conflicts.map((t) => ({ key: "conflicts", text: `**${label(c)}:** ${t}`, at })),
        ...r.questions.filter((q) => !asksForFiles(q)).slice(0, MAX_QUESTIONS).map((text) => ({ key: `q-${c.id}`, text, at })),
      ];
    })
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  let left = ASKS_PER_DAY - Object.entries(draft.todoDoneOn ?? {}).filter(([k, d]) => d === today && done.has(k)).length;
  const groups = new Map<string, string[]>();
  for (const x of asks) if (done.has(x.key) || done.has(`${x.key}:${subId(x.text)}`) || left-- > 0) groups.set(x.key, [...(groups.get(x.key) ?? []), x.text]);

  for (const [key, lines] of groups) {
    if (key === "conflicts") {
      items.push(
        withSubs(done, key, lines, (open) => ({
          title: `${open.length} ${open.length === 1 ? "place where your files disagree" : "places where your files disagree"} with you`,
          body: "Your word was used. Say if the file was right instead.",
          chatPrompt: `Next on your list: where your files disagree with what you told me. I went with your word; tell me if a file was right instead:\n\n${open.map((l) => `- ${l}`).join("\n")}`,
        })),
      );
      continue;
    }
    const c = results.find((x) => `q-${x.id}` === key)!;
    items.push(
      withSubs(done, key, lines, (open, total) => ({
        title: `${label(c)}: ${open.length === total ? `${total} ${total === 1 ? "question" : "questions"}` : `${open.length} of ${total} questions left`}`,
        body: "Answer whatever you know, skip the rest.",
        chatPrompt: `Next on your list: ${c.name}. ${open.length === 1 ? "One question" : `${open.length} quick questions`}. Answer whatever you know, skip the rest:\n\n${open.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
      })),
    );
  }
  return items;
}

/** Every key Claude may tick: items and their sub-items. */
export function todoKeys(items: TodoItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of items) {
    out.set(t.key, t.title);
    for (const x of t.subs ?? []) out.set(x.key, x.text);
  }
  return out;
}

/** Courses whose answers or files changed since they were set up, so re-reading them would change something. */
export function staleCourses(draft: SemesterDraft): DraftCourse[] {
  return draft.courses.filter((c) => {
    const r = draft.results[c.id];
    if (!r) return false;
    return draft.uploads.some((u) => u.courseId === c.id && u.addedAt > r.finishedAt) || draft.facts.some((f) => f.courseId === c.id && f.addedAt > r.finishedAt);
  });
}
