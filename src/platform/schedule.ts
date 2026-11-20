// The nightly run's schedule. design/scheduled-runs.md.
//
// The page creates one scheduled task in the student's Claude account, once:
// every day at 22:00 in the student's time zone it starts a fresh cloud
// session, which downloads StudyDesk's nightly program (routine.mjs, published
// next to the page) and runs it on the student's data. The page can only
// create and fire tasks, never change or delete them, so the task's prompt
// stays short and fixed; everything that may change lives in routine.mjs.
//
// A task carries a key. The profile keeps the key of the current task; a task
// whose key isn't the profile's (an old one, after a time-zone change) does
// nothing when it fires.

import type { ScheduleInfo } from "../routine/nightly";
import { callRemote, findId, type HandoffSetup } from "./handoff";

export const NIGHTLY_TIME = "22:00";
export const PROGRAM_PATH = "routine.mjs";

/** The task's schedule: 22:00 every day in the student's own time zone (daylight saving included). */
export function nightlyCron(timeZone: string, time = NIGHTLY_TIME): string {
  const [h, m] = time.split(":").map(Number);
  return `CRON_TZ=${timeZone} ${m} ${h} * * *`;
}

export function studentTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The task's own prompt. Fixed when the task is made; keep it about finding and running the program. */
export function schedulePrompt(key: string, artifactUrl?: string): string {
  const find = artifactUrl
    ? `Your StudyDesk is ${artifactUrl}.`
    : `Find your StudyDesk: Artifact action "list" (limit 50). For each artifact whose title contains "StudyDesk", try ArtifactData action "get" with collection "data/users/me" and doc_id "profile"; yours is the one whose "schedule" has "key": "${key}". Use its URL from then on.`;
  return `You are StudyDesk's nightly run for one student (schedule key ${key}). StudyDesk is the student's study app. Nobody reads this session and you can't ask anyone anything, so work on your own until the end. Don't create branches or pull requests, and don't write anywhere except your scratchpad directory and the student's own StudyDesk data.

1. If the Artifact or ArtifactData tool isn't loaded, load both with ToolSearch (query "select:Artifact,ArtifactData").
2. ${find}
3. Download StudyDesk's nightly program, which is published with the student's StudyDesk: Artifact action "read" with that url and path "${PROGRAM_PATH}", saving into a folder "studydesk" in your scratchpad directory.
4. Run it with Node: node <the saved ${PROGRAM_PATH}> --dir <your scratchpad>/night --key ${key} --url <the StudyDesk url>
5. It prints the next step (download the student's data, answer StudyDesk's questions to Claude, save the results). Do exactly that step, then run the same command again. Repeat until it prints "NIGHTLY RUN FINISHED", then reply with the log it gave and end.`;
}

const newKey = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** True when the saved schedule still fits: same environment's account, same time zone. */
export function scheduleFits(s: ScheduleInfo | undefined, timeZone: string): boolean {
  return !!s && s.timeZone === timeZone && s.time === NIGHTLY_TIME;
}

/**
 * Creates the nightly task. Returns what to save on the profile. The old task,
 * if any, keeps existing in the student's account but does nothing anymore
 * (its key no longer matches); the page can't delete it.
 */
export async function createSchedule(setup: HandoffSetup, timeZone: string): Promise<ScheduleInfo> {
  const key = newKey();
  const r = await callRemote<{ trigger?: { id?: string }; id?: string }>("create_trigger", {
    name: "StudyDesk nightly run",
    prompt: schedulePrompt(key, setup.artifactUrl),
    initiation: "human_request",
    cron_expression: nightlyCron(timeZone),
    create_new_session_on_fire: true,
    environment_id: setup.environmentId,
    notifications: {},
  });
  const triggerId = r?.trigger?.id ?? r?.id ?? findId(r, "trig_");
  if (!triggerId) throw { code: "tool_error", message: "The nightly task couldn't be created." };
  return { triggerId, key, timeZone, time: NIGHTLY_TIME, createdAt: Date.now() };
}

/** Starts tonight's run now, outside its schedule (for "Run tonight's check now"). */
export async function runScheduleNow(s: ScheduleInfo): Promise<void> {
  await callRemote("fire_trigger", { trigger_id: s.triggerId });
}
