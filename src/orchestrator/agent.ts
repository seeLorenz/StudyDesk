// The Orchestrator's conversation: what it sees each turn, its rules, its page
// tools, and its memory summary. design/orchestrator.md.

import { unsortedList } from "../lib/keep";
import type { Turn } from "../platform/claude";
import { courseSignals, ORCH_CONFIG, speed } from "./signals";
import { setupTodo } from "../onboarding/todo";
import type { Profile, SemesterDraft } from "../onboarding/types";
import type { Attempt, Day, ReviewItem } from "../mastery/types";
import type { QuestRecord, Semester } from "../quests/types";
import { addDays } from "../mastery/days";
import { questSettingsNow } from "../quests/config";
import type { Change, Job, Memory, OrchMessage, OrchState } from "./types";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type SnapshotInput = {
  draft: SemesterDraft;
  profile: Profile;
  semester: Semester | null;
  attempts: Attempt[];
  reviews: ReviewItem[];
  records: QuestRecord[];
  state: OrchState;
  today: Day;
  screen: string;
  cloudSessions: "on" | "off" | "unknown";
  /** The nightly run as code knows it: settings, sweep dates, last night. */
  nightly?: Record<string, unknown>;
};

/** The desk as Claude sees it with every message: small, and every number computed by code. */
export function deskSnapshot(i: SnapshotInput): string {
  const { draft, profile, semester, today } = i;
  const until = addDays(today, 14);
  const sig = semester ? courseSignals(semester, i.attempts, i.reviews, today).signals : [];
  const sp = speed(i.records, today);
  const results = draft.results;
  const courses = draft.courses.map((c) => {
    const s = sig.find((x) => x.courseId === c.id);
    const r = results[c.id];
    const exams = (r?.keyDates ?? []).filter((k) => k.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
      id: c.id,
      name: c.name,
      short: c.short,
      targetGrade: c.targetGrade,
      language: r?.teachingLanguage || c.teachingLanguage || null,
      setup: c.setupStatus,
      ...(s
        ? {
            masteryTowardTarget: `${Math.round(s.mastery * 100)}%`,
            requiredSkillsMastered: `${s.mastered} of ${s.required}`,
            onTrack: s.status,
            questMinutesNeededPerStudyDay: s.neededPerDay,
            recentMinutesPerStudyDay: s.pacePerDay,
            deadline: s.deadline,
            lapsedSkills: s.lapsed,
            openMistakeReviews: s.openReviews,
          }
        : {}),
      nextExam: exams[0] ? `${exams[0].title} ${exams[0].date}` : null,
    };
  });
  const homework = Object.values(results)
    .flatMap((r) => r.assignments)
    .filter((a) => a.dueAt.slice(0, 10) >= today && a.dueAt.slice(0, 10) <= until)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
    .map((a) => `${a.dueAt.replace("T", " ")} ${draft.courses.find((c) => c.id === a.courseId)?.short ?? a.courseId}: ${a.title} (${a.tasks.length} tasks)`);
  const exams = Object.values(results)
    .flatMap((r) => r.keyDates)
    .filter((k) => k.date >= today && k.date <= addDays(today, 60))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((k) => `${k.date} ${draft.courses.find((c) => c.id === k.courseId)?.short ?? k.courseId}: ${k.title} (${k.kind})`);
  const quest = todaysQuest(i.records, today);
  return JSON.stringify(
    {
      today: `${today} (${DAY[new Date(`${today}T12:00`).getDay()]})`,
      studentIsOn: i.screen,
      profile: { school: profile.school, program: profile.program, year: profile.year, country: profile.country, gradeScale: profile.gradeScale },
      semester: { name: draft.name, start: draft.startDate, end: draft.endDate },
      studyGoalMinutes: Object.fromEntries([1, 2, 3, 4, 5, 6, 0].map((wd) => [DAY[wd], draft.studyGoal[wd] ?? 0])),
      daysOff: (draft.daysOff ?? []).filter((d) => d.date >= today).map((d) => `${d.date}${d.reason ? ` (${d.reason})` : ""}`),
      courses,
      examsNext60Days: exams,
      homeworkDueNext14Days: homework,
      todaysQuest: quest ? { course: quest.quest.courseId, plannedMinutes: quest.quest.plannedMinutes, started: questStarted(quest) } : null,
      questSettings: questSettingsNow(draft.questSettings),
      speedLastQuests: sp.ratio === null ? "not measured yet" : `${sp.actual} min actual vs ${sp.planned} min planned over ${sp.quests} quests`,
      openToDo: setupTodo(draft).filter((t) => !t.done).map((t) => ({ key: t.key, title: t.title, ...(t.subs ? { parts: t.subs.map((x) => ({ key: x.key, text: x.text, done: x.done })) } : {}) })),
      jobs: i.state.jobs.filter((j) => j.status === "running" || (j.finishedAt ?? 0) > Date.now() - 86_400_000).map((j) => ({ id: j.id, kind: j.kind, courses: j.courseIds, status: j.status, result: j.result })),
      recentChanges: i.state.changes.slice(-6).map((c) => ({ id: c.id, lines: c.lines, status: c.status })),
      unsortedFiles: unsortedList(draft.uploads, draft.zips),
      cloudSessions: i.cloudSessions,
      nightlyRun: i.nightly ?? "not set up (needs cloud sessions)",
    },
    null,
    1,
  );
}

export const RULES = `You are StudyDesk, the one assistant a student talks to about their study desk: their semester, courses, dates, homework, study time and progress. Internally you are the Orchestrator: you answer questions about the desk, make changes, and pass bigger work to the organization agent, which reads course materials in the background. The student never talks to that agent; you are its voice.

What you do:
- Answer questions about the desk from the snapshot (and look_up for details). Every number you give must come from the snapshot or a tool result. Never compute or guess mastery, times, grades or dates yourself.
- Make small changes with the change tool, right away, in the same reply: dates, homework due dates, target grades, study goal, days off, weekly slots, a course's teaching language, profile, results from school, and facts to remember (what the student says about a course, word for word). The student sees a card with what changed and an Undo button, so don't ask "are you sure?" for small things and don't repeat the card's lines in your text.
- Start a job with start_job for bigger work: new material (files the student drops: assign them to their course in the same call), a new course (add_course first, then start_job), or re-mapping a course when the student says something that changes what the course needs ("chapter 7 isn't in the exam", "the exam is oral now"); record that statement as a fact too. New files start a job automatically; re-reading everything a course already has asks the student first (the tool shows them a yes/no card).
- Dropping a course always needs the student's yes: call change with drop_course, and the student gets a yes/no card.
- After a change that affects today (todaysQuest exists and started is false), you may rebuild today's quest with rebuild_quest; the change card also offers it.
- When the student asks to redo or regenerate their placement check, first ask once whether they also want to delete their past stats (mastery progress, past attempts and the mistake review) for a clean start, or keep them. Only after they answer, call redo_placement with resetStats. It shows a yes/no card; nothing happens before their yes. If the placement came out in the wrong language, fix the courses' language with the change tool first.
- The nightly run (nightlyRun in the snapshot) grades at its time, runs the organization agent's check and deep sweeps, and writes tomorrow's quest. Change it with set_nightly (time, pause, turn parts off) and set_sweep (when a course is read again completely); start it at once with run_nightly_now only when the student asks.
- StudyDesk's own updates: update_studydesk. "check" answers questions about the version and what's new; when the student wants the new version, "update" shows the button card (never claim it's updating before they press it); "go_back" only when they ask to undo an update.
- Learning questions ("how does the chain rule work?", explaining a problem) belong to the tutor: call open_ask with the question and say in one line that you opened it there. Don't teach here.
- When the student is on a screen, "this" means what's on it (studentIsOn) or the quoted selection.

How to talk, like a good teacher and assistant:
- Short: two to four sentences usually. Plain, warm, direct. Reply in the student's language.
- Lead with the answer. Use real line breaks and short lists when listing.
- When the student is behind, say so honestly and kindly, with one concrete suggestion. When they do well, say that too.
- Never invent courses, dates, grades or numbers. If something is unclear, ask one short question.
- A remark the tutor passed on (marked "Passed on by the tutor") is a request from the student: handle it like any message.

Started quests are never rewritten: changes apply from the next quest.
The student's word wins over files: if what they say disagrees with what was read, use their version and mention the difference once.`;

export const CHANGE_TOOL = {
  name: "change",
  description:
    "Applies small changes to the student's desk. Each change is checked by code; invalid ones come back with the reason (then ask the student). Send several changes in one call. Returns what changed. drop_course is shown to the student as a yes/no card and applied only on their yes.",
  inputSchema: {
    type: "object",
    properties: {
      studentWords: { type: "string", description: "What the student said that asks for this, word for word." },
      changes: {
        type: "array",
        items: {
          type: "object",
          description: `One operation. "course" is a course id, name or short name. Dates YYYY-MM-DD; due dates YYYY-MM-DD or YYYY-MM-DDTHH:MM.
- {op:"set_target_grade", course, grade}
- {op:"set_exam_date", course, title, date, kind?: "exam"|"quiz"} (moves the date of that title, or adds it)
- {op:"remove_exam_date", course, title}
- {op:"set_due", course, homework (title or id), dueAt}
- {op:"add_homework", course, title, dueAt, tasks:[{label, text (word for word), skill (skill id or name, look_up skills), points?}]} (only for courses already read; otherwise start_job with the sheet)
- {op:"remove_homework", course, homework}
- {op:"set_study_goal", minutes:{Mon:120, Sat:0, ...}} (lectures included, only days that change)
- {op:"set_day_off", date, reason?} / {op:"remove_day_off", date}
- {op:"add_slot", weekday, start, end, kind:"lecture"|"exercise"|"fixed", title, course?} / {op:"remove_slot", weekday, start}
- {op:"set_calendar_live", on: bool} (calendar data is live by default: it's read again whenever StudyDesk is open and each day's quest is sized from it. Only set on:false when the student explicitly asks to stop following their calendar)
- {op:"tick_todo", key, done?: bool} (keep the to-do list current: tick each part of an openToDo item (parts[].key: one question, one date, one disagreement) as soon as it's answered or confirmed, even one of three, in the same change that records the answer; an item ticks itself off when all its parts are done. Tick an item's own key only when it has no parts (files: once dropped and assigned). Never ask the student to tick. done:false opens it again)
- {op:"set_language", course, language}
- {op:"set_quest_settings", hints?: 0-5 (per homework task), lessonMinutes?: 2-15 (reading part of a lesson), newSkillsPerQuest?: 0-4}
- {op:"set_nightly", time?: "HH:MM", paused?: bool, grading?: bool, check?: bool, quest?: bool} (the nightly run: when it runs, pause it, or turn off grading / the courses' check / writing tomorrow's quest)
- {op:"set_sweep", course, date: "YYYY-MM-DD" or "none"} (when the organization agent reads a course again completely, at night)
- {op:"add_fact", course?, text} (word for word)
- {op:"set_profile", school?, country?, program?, year?}
- {op:"add_result", course, component, points, maxPoints, date, skills?: [skill ids]} (a real result from school; can't be undone)
- {op:"add_course", name, short?, credits?, targetGrade?} (then start_job kind new_course)
- {op:"drop_course", course}`,
          properties: { op: { type: "string" } },
          required: ["op"],
        },
      },
    },
    required: ["studentWords", "changes"],
  },
} as const;

export const JOB_TOOL = {
  name: "start_job",
  description:
    "Starts organization agent work in the background: reading new material, setting up a new course, or re-mapping a course after something changed. The student sees a job card with progress, and you'll be told when it's done. Returns the job id, or that it was queued or needs the student's yes.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { enum: ["new_material", "new_course", "remap"] },
      courses: { type: "array", items: { type: "string" }, description: "Course ids or names." },
      files: { type: "array", description: "Files the student dropped (uploadId from unsortedFiles), each assigned to its course. A zip id (zip_…) assigns all files of that zip.", items: { type: "object", properties: { uploadId: { type: "string" }, course: { type: "string" }, note: { type: "string", description: "What the file is, e.g. 'exercise sheet 5, due Thu'." } }, required: ["uploadId", "course"] } },
      studentWords: { type: "string", description: "What the student said, word for word: it's passed to the organization agent." },
      rereadAll: { type: "boolean", description: "True only to re-read every file the course already has (asks the student first)." },
    },
    required: ["kind", "courses", "studentWords"],
  },
} as const;

export const LOOKUP_TOOL = {
  name: "look_up",
  description: "Reads details that aren't in the snapshot. Read only.",
  inputSchema: {
    type: "object",
    properties: {
      what: { enum: ["skills", "homework", "dates", "facts", "files", "timetable", "quests", "results", "changes", "memory"] },
      course: { type: "string", description: "Course id or name, where it applies." },
    },
    required: ["what"],
  },
} as const;

export const ASK_TOOL = {
  name: "open_ask",
  description: "Opens the tutor (Ask) with a learning question already filled in and sent. Use it for learning questions instead of teaching here.",
  inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
} as const;

export const CALENDAR_TOOL = {
  name: "read_calendar",
  description: "Reads the student's Google Calendar through their own connector: repeating weekly events of the next two weeks and one-off events of the next four months. Use when the student asks to import or update from their calendar, then add or remove weekly slots and exam dates with change. It reads every calendar the student has in Google Calendar, including subscribed ones (a university timetable added by URL, like TUGonline's iCal link). You can't open links yourself: if the student pastes an iCal link, tell them to add it in Google Calendar (Other calendars, +, From URL) and don't repeat the link, since it holds a private token; then read again. A newly added subscription can take a few minutes to fill. Each event comes with its room and its description: read the descriptions, since they often say what an exam covers, where it is, or what to prepare or hand in, and record what matters as facts of the course (word for word) or as exam dates and homework.",
  inputSchema: { type: "object", properties: {} },
} as const;

/** Words in a list of messages, to decide when the memory needs a new summary. */
export const wordCount = (ms: OrchMessage[]) => ms.reduce((n, m) => n + m.text.split(/\s+/).filter(Boolean).length, 0);

/** Time to rewrite the memory summary: enough new words, or a new day with unsummarized messages. */
export function needsSummary(messages: OrchMessage[], memory: Memory, today: Day): boolean {
  const fresh = messages.filter((m) => m.createdAt > memory.coversUpTo && !m.error);
  if (!fresh.length) return false;
  if (wordCount(fresh) >= ORCH_CONFIG.memoryWords) return true;
  return memory.day !== null && memory.day < today && fresh.some((m) => dayOfTs(m.createdAt) < today);
}

const dayOfTs = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The prompt that rewrites the memory summary. */
export function summaryTurns(memory: Memory, messages: OrchMessage[], seed = ""): Turn[] {
  const chat = messages
    .filter((m) => !m.error && m.text.trim())
    .map((m) => `${m.role === "user" ? "Student" : "StudyDesk"} (${new Date(m.createdAt).toISOString().slice(0, 10)}): ${m.text}`)
    .join("\n\n");
  return [
    {
      role: "user",
      content: `You keep StudyDesk's memory of one student: a short summary that is sent with every future message instead of the old chat.

Rewrite the summary from the old summary and the new messages. Keep:
- preferences and how they like to work ("prefers short evening sessions"),
- what was agreed ("no studying on Sundays in exam weeks"),
- how they are doing and feeling, and what seems to block them,
- open threads (waiting for an answer from a professor, something to follow up),
- anything they asked you to remember.
Throw out: questions that led nowhere, small talk, explanations of course content (those belong to the tutor), and changes already made (they're kept in the change log and the records).

Plain short bullet points under a few headings, at most about 400 words. Write in English. Reply with the summary only.

<old_summary>
${memory.text || "(empty)"}
</old_summary>
${seed ? `\n<setup_chat>\n${seed}\n</setup_chat>\n` : ""}
<new_messages>
${chat || "(none)"}
</new_messages>`,
    },
  ];
}

/** The conversation for one answer: rules and memory, the last messages, the snapshot with the newest one. */
export function orchTurns(memory: Memory, messages: OrchMessage[], snapshot: string, extra = ""): Turn[] {
  const recent = messages.filter((m) => !(m.error && m.role === "assistant")).slice(-ORCH_CONFIG.historyMessages);
  const turns: Turn[] = [{ role: "user", content: `${RULES}\n\n<memory>\n${memory.text || "(nothing yet)"}\n</memory>\n\nThe recent chat follows.` }];
  for (const m of recent) {
    const head = m.role === "user" ? [m.fromTutor ? "(Passed on by the tutor)" : "", m.screen ? `[on: ${m.screen}]` : "", m.quote ? `[about the selected text: "${m.quote}"]` : ""].filter(Boolean).join(" ") : "";
    const text = `${head ? `${head}\n` : ""}${m.text}${m.files?.length ? `\n[Dropped: ${m.files.join(", ")}]` : ""}`;
    if (!text.trim()) continue;
    const last = turns[turns.length - 1];
    if (last.role === m.role) last.content += `\n\n${text}`;
    else turns.push({ role: m.role, content: text });
  }
  const tail = `${extra ? `\n\n${extra}` : ""}\n\n<desk>\n${snapshot}\n</desk>`;
  const last = turns[turns.length - 1];
  if (last.role === "user") last.content += tail;
  else turns.push({ role: "user", content: `(No new message from the student.)${tail}` });
  return turns;
}

/** The prompt that turns check-in facts into one short message. */
export function checkinTurns(memory: Memory, facts: string[], snapshot: string): Turn[] {
  return [
    {
      role: "user",
      content: `${RULES}\n\n<memory>\n${memory.text || "(nothing yet)"}\n</memory>\n\nStudyDesk's code found reasons to speak to the student first. Write ONE short message to them covering these points, most important first: like a teacher who keeps an eye on them, warm and honest, two to five sentences, or a very short list if there are several points. Use only the numbers given. If a point asks the student something, end with that question. Don't greet at length.\n\n<points>\n${facts.map((f) => `- ${f}`).join("\n")}\n</points>\n\n<desk>\n${snapshot}\n</desk>`,
    },
  ];
}

/** Without Claude (local preview): the points as plain lines. */
export function localCheckin(facts: string[]): string {
  return facts.map((f) => `- ${f}`).join("\n");
}

/** One line per job for the job card. */
export function jobTitle(j: Job, names: Map<string, string>): string {
  const cs = j.courseIds.map((id) => names.get(id) ?? id).join(", ");
  return j.kind === "new_course" ? `Setting up ${cs}` : j.kind === "remap" ? `Re-mapping ${cs}` : `Reading new material for ${cs}`;
}

export type { Change };

/** Today's quest as the quest page shows it: the newest one of today that wasn't replaced. */
export function todaysQuest(records: QuestRecord[], today: Day): QuestRecord | null {
  return records.filter((r) => r.quest.date === today && !r.progress.replacedAt).sort((a, b) => b.quest.createdAt - a.quest.createdAt)[0] ?? null;
}

/** True once the student did anything on a quest: then it's never rewritten. */
export function questStarted(r: QuestRecord): boolean {
  return r.progress.handedIn.length > 0 || Object.values(r.progress.work).some((w) => w.activeSeconds > 0 || w.answerText.trim() !== "" || w.files.length > 0 || w.hintsShown > 0);
}

export const NIGHTLY_TOOL = {
  name: "run_nightly_now",
  description:
    "Starts the nightly run right now instead of waiting for its time: grades what's handed in, checks the courses, writes tomorrow's quest. Results arrive within about 15 minutes. Only when the student asks for it.",
  inputSchema: { type: "object", properties: {} },
} as const;

export const UPDATE_TOOL = {
  name: "update_studydesk",
  description:
    'StudyDesk\'s own version and updates. action "check": the installed version, the newest release and its notes. action "update": shows the student a card with the release notes and the "Update to vX" button (nothing starts until they press it; their data stays). action "go_back": shows a card to return to the version before the last update, which loses everything done since that update; only when the student asks to undo an update.',
  inputSchema: { type: "object", properties: { action: { type: "string", enum: ["check", "update", "go_back"] } }, required: ["action"] },
} as const;

export const PLACEMENT_TOOL = {
  name: "redo_placement",
  description: "Writes a new placement check (it replaces the current one). resetStats: true also deletes the student's past stats (every attempt, mastery progress and the mistake review) for a clean start; false keeps them. Ask the student which they want before calling. Shows a yes/no card; it only happens on their yes.",
  inputSchema: { type: "object", properties: { resetStats: { type: "boolean" } }, required: ["resetStats"] },
} as const;

export const REBUILD_TOOL = {
  name: "rebuild_quest",
  description: "Writes today's quest again from the current desk (after a change that affects today: a nearer exam, homework due tomorrow, a different study goal). Only works while today's quest hasn't been started; a started quest is never rewritten.",
  inputSchema: { type: "object", properties: {} },
} as const;
