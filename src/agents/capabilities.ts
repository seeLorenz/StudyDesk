// What StudyDesk's chats can do, in one list. Each chat's prompt gets it, so
// Claude knows what it can do here, what only the other chat can do, and
// what StudyDesk can't do at all (then it says so and saves a wish).
// design/capabilities.md.

export type Chat = "panel" | "organize";
const NAMES: Record<Chat, string> = { panel: "the StudyDesk chat (Ctrl J)", organize: "the Organize page" };

/** Each capability names, per chat, the tool that provides it there. A chat gets exactly the tools listed here (toolsFor). */
export const CAPABILITIES: Array<{ what: string; in: Partial<Record<Chat, string>> }> = [
  { what: "change dates, homework, target grades, the study goal, days off, the weekly timetable, quest settings, a course's language, the profile, results and the student's facts", in: { panel: "change" } },
  { what: "change the nightly run (time, pause, parts) and when a course is read again completely", in: { panel: "change" } },
  { what: "start the nightly run now", in: { panel: "run_nightly_now" } },
  { what: "start a job that reads new material or a course again", in: { panel: "start_job" } },
  { what: "look up skills, quests, attempts, files and the change log", in: { panel: "look_up" } },
  { what: "rebuild today's quest (only before it's started)", in: { panel: "rebuild_quest" } },
  { what: "redo the placement check", in: { panel: "redo_placement" } },
  { what: "check for and install StudyDesk updates", in: { panel: "update_studydesk" } },
  { what: "open a learning question in Ask (the tutor)", in: { panel: "open_ask" } },
  { what: "fill the semester sheet: profile, semester dates, courses, weekly slots, the study goal, facts and which course a file is for", in: { organize: "update_sheet" } },
  { what: "read the courses that changed again", in: { organize: "start_setup" } },
  { what: "read a kept file", in: { panel: "read_file", organize: "read_file" } },
  { what: "read the student's Google Calendar", in: { panel: "read_calendar", organize: "read_calendar" } },
  { what: "tick off the student's to-do items", in: { panel: "change", organize: "update_sheet" } },
  { what: "save a wish for something StudyDesk can't do yet", in: { panel: "change", organize: "update_sheet" } },
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

/** A "Send to developer" link: a pre-filled GitHub issue holding only the wish itself; the student presses Submit there. */
export const wishLink = (text: string) =>
  `[Send to developer](${WISH_URL}?title=${encodeURIComponent(`Wish: ${text.slice(0, 80)}`)}&body=${encodeURIComponent(`${text}\n\n(Sent from StudyDesk.)`)})`;

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

Before acting on a request, check it against these lists. If it needs something that isn't on them, say plainly in one line that StudyDesk can't do that yet, never pretend or work around it with a fact, and save it as a wish (${chat === "panel" ? 'change with {op:"add_wish", text}' : "update_sheet's wish"}) in the student's words. Then give the student the "Send to developer" link it returns.`;
}
