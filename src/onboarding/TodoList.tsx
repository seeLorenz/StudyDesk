import { useState, type ReactNode } from "react";
import { toDay } from "../mastery/days";
import { setupTodo, type TodoItem } from "./todo";
import { repoTodo } from "../platform/schedule";
import type { SemesterDraft } from "./types";

type Props = {
  draft: SemesterDraft;
  update: (fn: (d: SemesterDraft) => SemesterDraft) => void;
  md: (blockId: string, text: string, label: string) => ReactNode;
  /** Puts the item's questions into the StudyDesk chat. */
  onStart: (item: TodoItem) => void;
  /** The nightly task still needs its repository (src/platform/schedule.ts). */
  repoStep: boolean;
};

/** What StudyDesk still needs from the student, one item at a time (Organize's right side). */
export function TodoList({ draft, update, md, onStart, repoStep }: Props) {
  const todo = repoStep ? [repoTodo, ...setupTodo(draft)] : setupTodo(draft);
  const left = todo.filter((t) => !t.done);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Done items fold into one line so the open ones stay in view.
  const [showDone, setShowDone] = useState(false);
  const done = todo.length - left.length;
  const shownKey = openKey ?? left[0]?.key ?? null;
  // Unticking an item opens all its parts; unticking a part opens its item.
  const tick = (key: string, on: boolean) =>
    update((d) => ({
      ...d,
      todoDone: on ? [...new Set([...(d.todoDone ?? []), key])] : (d.todoDone ?? []).filter((k) => k !== key && k !== key.split(":")[0] && !k.startsWith(`${key}:`)),
      ...(on && { todoDoneOn: { ...d.todoDoneOn, [key]: toDay() } }),
    }));
  if (!todo.length) return <p className="quest-muted">Nothing left to do. StudyDesk has what it needs.</p>;
  return (
    <>
      <p className="quest-muted setup-todo-count">{left.length ? `${left.length} left` : "All done"}</p>
      <ol className="setup-todo">
        {todo.filter((t) => showDone || !t.done).map((t) => (
          <li key={t.key} className={t.done ? "is-done" : ""}>
            <div className="setup-todo-head">
              <input type="checkbox" checked={t.done} disabled={t.key === "repo"} aria-label={`Mark "${t.title}" done`} onChange={(e) => tick(t.key, e.target.checked)} />
              <button type="button" className="setup-todo-title" aria-expanded={shownKey === t.key} onClick={() => setOpenKey(shownKey === t.key ? "" : t.key)}>
                {t.title}
              </button>
            </div>
            {shownKey === t.key && (
              <div className="setup-todo-body">
                {md(`todo-${t.key}`, t.body, `the to-do list ("${t.title}")`)}
                {t.subs && (
                  <ul className="setup-todo-subs">
                    {t.subs.map((x) => (
                      <li key={x.key} className={x.done ? "is-done" : ""}>
                        <input type="checkbox" checked={x.done} aria-label={x.done ? "Done" : "Mark done"} onChange={(e) => tick(x.key, e.target.checked)} />
                        <div className="setup-todo-sub">{md(`todo-${x.key}`, x.text, `the to-do list ("${t.title}")`)}</div>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="mini-btn" onClick={() => (setOpenKey(t.key), onStart(t))}>
                  {t.key === "upload" ? "Add files in the chat" : t.key === "repo" ? "Ask for help in the chat" : "Answer in the chat"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {done > 0 && (
        <button type="button" className="setup-todo-done" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
          <span>✓ {done} done</span>
          {showDone ? "Hide" : "Show"}
        </button>
      )}
    </>
  );
}
