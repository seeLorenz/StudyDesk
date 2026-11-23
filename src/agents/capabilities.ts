// What StudyDesk's chats can do, in one list. Each chat's prompt gets it, so
// Claude knows what it can do here, what only the other chat can do, and
// what StudyDesk can't do at all (then it says so and saves a wish).
// design/capabilities.md.

export type Chat = "panel" | "organize";
const NAMES: Record<Chat, string> = { panel: "the StudyDesk chat (Ctrl J)", organize: "the Organize page" };

export const CAPABILITIES: Array<{ what: string; in: Chat[] }> = [
  { what: "change dates, homework, target grades, the study goal, days off, the weekly timetable, quest settings, a course's language, the profile, results and the student's facts", in: ["panel"] },
  { what: "change the nightly run (time, pause, parts) and when a course is read again completely; start the nightly run now", in: ["panel"] },
  { what: "start a job that reads new material or a course again", in: ["panel"] },
  { what: "look up skills, quests, attempts, files and the change log", in: ["panel"] },
  { what: "rebuild today's quest (only before it's started); redo the placement check", in: ["panel"] },
  { what: "check for and install StudyDesk updates", in: ["panel"] },
  { what: "open a learning question in Ask (the tutor)", in: ["panel"] },
  { what: "fill the semester sheet: profile, semester dates, courses, weekly slots, the study goal, facts and which course a file is for", in: ["organize"] },
  { what: "read the courses that changed again", in: ["organize"] },
  { what: "read a kept file", in: ["organize"] },
  { what: "read the student's Google Calendar", in: ["panel", "organize"] },
  { what: "tick off the student's to-do items", in: ["panel", "organize"] },
  { what: "save a wish for something StudyDesk can't do yet", in: ["panel", "organize"] },
];

export const WISH_URL = "https://github.com/seeLorenz/StudyDesk/issues/new";

/** A "Send to developer" link: a pre-filled GitHub issue holding only the wish itself; the student presses Submit there. */
export const wishLink = (text: string) =>
  `[Send to developer](${WISH_URL}?title=${encodeURIComponent(`Wish: ${text.slice(0, 80)}`)}&body=${encodeURIComponent(`${text}\n\n(Sent from StudyDesk.)`)})`;

/** What StudyDesk can't do, so Claude says so instead of pretending. */
export const CANT = ["change how the app looks (colors, layout, fonts)", "send emails or messages", "open links or websites from the chat", "watch or listen to videos"];

/** The block each chat's rules end with. */
export function capabilityBlock(chat: Chat): string {
  const here = CAPABILITIES.filter((c) => c.in.includes(chat)).map((c) => `- ${c.what}`);
  const other = CAPABILITIES.filter((c) => !c.in.includes(chat)).map((c) => `- ${c.what} (in ${c.in.map((x) => NAMES[x]).join(" or ")})`);
  return `## What you can do
${here.join("\n")}

Only elsewhere in StudyDesk (tell the student where):
${other.join("\n")}

StudyDesk can't:
${CANT.map((c) => `- ${c}`).join("\n")}

Before acting on a request, check it against these lists. If it needs something that isn't on them, say plainly in one line that StudyDesk can't do that yet, never pretend or work around it with a fact, and save it as a wish (${chat === "panel" ? 'change with {op:"add_wish", text}' : "update_sheet's wish"}) in the student's words. Then give the student the "Send to developer" link it returns.`;
}
