// What StudyDesk's chats can do, in one list. Each chat's prompt gets it, so
// Claude knows what it can do here, what only the other chat can do, and
// what StudyDesk can't do at all (then it says so and saves a wish).
// design/capabilities.md.

import { APP_VERSION } from "../updates/version";

export type Chat = "panel" | "setup";
const NAMES: Record<Chat, string> = { panel: "the StudyDesk chat (Ctrl J, and on the Organize page)", setup: "the semester setup page" };

/** Each capability names, per chat, the tool that provides it there. A chat gets exactly the tools listed here (toolsFor). */
export const CAPABILITIES: Array<{ what: string; in: Partial<Record<Chat, string>> }> = [
  { what: "change dates, homework, target grades, the study goal, days off, the weekly timetable, quest settings, a course's language, which course a file belongs to, the profile, results and the student's facts", in: { panel: "change" } },
  { what: "change the nightly run (time, pause, parts) and when a course is read again completely", in: { panel: "change" } },
  { what: "turn Anki decks on or off: by-heart material (vocabulary, terms, fixed facts) becomes Anki cards; the student exports each quest's deck with its \"Export deck\" button and imports it into Anki (no live sync)", in: { panel: "change" } },
  { what: "start the nightly run now", in: { panel: "run_nightly_now" } },
  { what: "start a job that reads new material or a course again", in: { panel: "start_job" } },
  { what: "look up skills, quests, attempts, files and the change log", in: { panel: "look_up" } },
  { what: "write today's quest again (only before it's started), or one more quest once it's handed in, optionally with a length and a course", in: { panel: "new_quest" } },
  { what: "dismiss today's quest or parts of it (they earn nothing; handed-in parts are still graded)", in: { panel: "dismiss" } },
  { what: "set a focus: quests stick to one course until a date", in: { panel: "change" } },
  { what: "redo the placement check", in: { panel: "redo_placement" } },
  { what: "check for and install StudyDesk updates", in: { panel: "update_studydesk" } },
  { what: "open a learning question in Ask (the tutor)", in: { panel: "open_ask" } },
  { what: "fill the semester sheet: profile, semester dates, courses, weekly slots, the study goal, facts and which course a file is for", in: { setup: "update_sheet" } },
  { what: "read the courses that changed again", in: { setup: "start_setup" } },
  { what: "read a kept file", in: { panel: "read_file", setup: "read_file" } },
  { what: "read the student's Google Calendar", in: { panel: "read_calendar", setup: "read_calendar" } },
  { what: "tick off the student's to-do items", in: { panel: "change", setup: "update_sheet" } },
  { what: "save a wish for something StudyDesk can't do yet", in: { panel: "change", setup: "update_sheet" } },
];

/**
 * The tools a chat may use: those the list grants it. A tool missing from the
 * list, or a listed one the chat doesn't build, is reported, so the list the
 * chat reads and the tools it has can't drift apart.
 */
export function toolsFor<T extends { name: string }>(chat: Chat, tools: T[]): T[] {
  const granted = new Set(CAPABILITIES.flatMap((c) => (c.in[chat] ? [c.in[chat]!] : [])));
  const given = new Set(tools.map((t) => t.name));
  const drift = [...tools.filter((t) => !granted.has(t.name)).map((t) => `${t.name} isn't listed`), ...[...granted].filter((n) => !given.has(n)).map((n) => `${n} is listed but not built`)];
  if (drift.length) console.error(`Capability list (${chat}): ${drift.join("; ")}. Fix src/agents/capabilities.ts.`);
  return tools.filter((t) => granted.has(t.name));
}

export const WISH_URL = "https://github.com/seeLorenz/StudyDesk/issues/new";

/** The issue Claude writes for a wish: the developer reads it, so it's anonymous and says why StudyDesk sent it. */
export type Wish = { text: string; title?: string; asked?: string; missing?: string; fix?: string };
export const WISH_FIELDS = `text (the student's words, kept on their desk only), and for the developer's public GitHub issue: title (what to build, under 80 characters), asked (what the student wanted and why), missing (what StudyDesk does today and what's missing), fix (a concrete proposed change). The issue is public: no names, school, course names, dates or anything else about the student, so describe it generally ("a course with an exam this week")`;

/** A "Send to developer" link: a pre-filled GitHub issue written by Claude (never the student's raw words); the student reviews it and presses Submit there. Fields are capped so the link stays well under GitHub's URL limit. */
export const wishLink = (w: Wish, chat: Chat) => {
  const cap = (s = "", n = 600) => s.trim().slice(0, n);
  // Parentheses too, or the Markdown link ends at the first ")".
  const enc = (s: string) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
  const body = `_Sent from StudyDesk ${APP_VERSION}, ${chat} chat. Written by StudyDesk's Claude from a student's request._

### What the student asked
${cap(w.asked) || "Not given."}

### What StudyDesk can't do yet
${cap(w.missing) || "Not given."}

### Proposed fix
${cap(w.fix) || "Not given."}`;
  return `[Send to developer](${WISH_URL}?title=${enc(cap(w.title, 80) || "Wish from StudyDesk")}&body=${enc(body)})`;
};

/** What StudyDesk can't do, so Claude says so instead of pretending. */
export const CANT = ["change how the app looks (colors, layout, fonts)", "send emails or messages", "open links or websites from the chat", "watch or listen to videos"];

/** The block each chat's rules end with. */
export function capabilityBlock(chat: Chat): string {
  const here = CAPABILITIES.filter((c) => c.in[chat]).map((c) => `- ${c.what}`);
  const other = CAPABILITIES.filter((c) => !c.in[chat]).map((c) => `- ${c.what} (in ${(Object.keys(c.in) as Chat[]).map((x) => NAMES[x]).join(" or ")})`);
  return `## What you can do
${here.join("\n")}

Only elsewhere in StudyDesk (tell the student where):
${other.join("\n")}

StudyDesk can't:
${CANT.map((c) => `- ${c}`).join("\n")}

Before acting on a request, check it against these lists. If it needs something that isn't on them, say plainly in one line that StudyDesk can't do that yet, never pretend or work around it with a fact, and save it as a wish (${chat === "panel" ? 'change with {op:"add_wish", ...}' : "update_sheet's wish"}): ${WISH_FIELDS}. ${chat === "panel" ? 'The change card already shows the "Send to developer" button, so don\'t repeat the link or the wish in your reply.' : 'Then give the student the "Send to developer" link it returns, on its own line.'}`;
}
