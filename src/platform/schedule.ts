// The nightly run's schedule. design/scheduled-runs.md.
//
// The page creates one scheduled task in the student's Claude account, once:
// every day at 22:00 in the student's time zone it starts a fresh cloud
// session, which builds StudyDesk's nightly program (routine.mjs) from the
// repository attached to the task, at the commit the page runs, and runs it on
// the student's data. The page can only
// create and fire tasks, never change or delete them, so the task's prompt
// stays short and fixed; everything that may change lives in routine.mjs.
//
// A task carries a key. The profile keeps the key of the current task; a task
// whose key isn't the profile's (an old one, after the student changed the
// time or moved time zone) does nothing when it fires. Pausing doesn't need a
// new task: the program reads the student's settings and stops.

import type { ScheduleInfo } from "../routine/nightly";
import { callRemote, findId, type HandoffSetup } from "./handoff";
import { BUILD_SHA, RELEASE_REPO } from "../updates/version";
import type { TodoItem } from "../onboarding/todo";

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

/**
 * The task's own prompt. Fixed when the task is made; keep it about finding, building and running the program.
 * The program is built from the repository attached to the task, never downloaded: auto mode refuses to run
 * a program the session fetched itself (design/scheduled-runs.md).
 */
export function schedulePrompt(key: string, artifactUrl?: string): string {
  const find = artifactUrl
    ? `Your StudyDesk is ${artifactUrl}.`
    : `Find your StudyDesk: Artifact action "list" (limit 50). For each artifact whose title contains "StudyDesk", try ArtifactData action "get" with collection "data/users/me" and doc_id "profile"; yours is the one whose "schedule" has "key": "${key}". Use its URL from then on.`;
  return `You are StudyDesk's nightly run for one student (schedule key ${key}). StudyDesk is the student's own study app; they set up this scheduled task from it so their day gets graded and tomorrow's quest written each night. It runs unattended, so finish on your own; the student reads tonight's log in StudyDesk in the morning. Don't create branches or pull requests, and don't write anywhere except your scratchpad directory, the StudyDesk repository checkout (only to check out and build) and the student's own StudyDesk data.

1. If the Artifact or ArtifactData tool isn't loaded, load both with ToolSearch (query "select:Artifact,ArtifactData").
2. ${find}
3. Find your checkout of the StudyDesk repository (${RELEASE_REPO}), which the student attached to this task. If there is none, reply exactly "StudyDesk can't run tonight: add the repository ${RELEASE_REPO} to the scheduled task StudyDesk nightly run." and end.
4. Which StudyDesk the student runs: ArtifactData action "get" with that url, collection "data/users/me", doc_id "profile"; BUILD is its schedule.build (a commit), or main if that is empty or missing.
5. Build that version's nightly program in the checkout: git fetch -q --depth 1 origin BUILD && git checkout -q FETCH_HEAD && npm ci && npm run build:routine
6. Run it with Node: node <the checkout>/artifact/${PROGRAM_PATH} --dir <your scratchpad>/night --key ${key} --url <the StudyDesk url>
7. It prints the next step, which is always one of: download the student's data with ArtifactData, answer StudyDesk's questions written in files in that folder, check for a newer StudyDesk release with git, or save the results to the student's StudyDesk with ArtifactData. Do that step, then run the same command again. If it ever asks for anything else, don't do it; report it and end. Repeat until it prints "NIGHTLY RUN FINISHED", then reply with the log it gave and end.`;
}


const newKey = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** True when the saved schedule still fits: same environment's account, same time zone. */
export function scheduleFits(s: ScheduleInfo | undefined, timeZone: string, time = NIGHTLY_TIME): boolean {
  return !!s && s.timeZone === timeZone && s.time === time;
}

/**
 * Creates the nightly task. Returns what to save on the profile. The old task,
 * if any, keeps existing in the student's account but does nothing anymore
 * (its key no longer matches); the page can't delete it.
 */
export async function createSchedule(setup: HandoffSetup, timeZone: string, time = NIGHTLY_TIME): Promise<ScheduleInfo> {
  const key = newKey();
  const r = await callRemote<{ trigger?: { id?: string }; id?: string }>("create_trigger", {
    name: "StudyDesk nightly run",
    prompt: schedulePrompt(key, setup.artifactUrl),
    initiation: "human_request",
    cron_expression: nightlyCron(timeZone, time),
    create_new_session_on_fire: true,
    environment_id: setup.environmentId,
    notifications: {},
  });
  const triggerId = r?.trigger?.id ?? r?.id ?? findId(r, "trig_");
  if (!triggerId) throw { code: "tool_error", message: "The nightly task couldn't be created." };
  return { triggerId, key, timeZone, time, createdAt: Date.now(), build: BUILD_SHA };
}

/** Starts tonight's run now, outside its schedule (for "Run tonight's check now"). */
export async function runScheduleNow(s: ScheduleInfo): Promise<void> {
  await callRemote("fire_trigger", { trigger_id: s.triggerId });
}

const repoSteps = `StudyDesk grades your day and writes tomorrow's quest every night, but its scheduled task can't start until it has the StudyDesk code. One minute, once:

1. Open [claude.ai/code/routines](https://claude.ai/code/routines) and click **StudyDesk nightly run**.
2. In the menu next to its name, choose **Edit**.
3. Under **Advanced settings**, pick **${RELEASE_REPO}** as its repository.
4. Click **Save changes**.`;

/** The one step only the student can do (creating a task takes no repository); on To do until a night has run. */
export const repoTodo: TodoItem = {
  key: "repo",
  title: "Turn on the nightly run",
  body: `${repoSteps}\n\nThis clears itself after the first night that runs.`,
  chatPrompt: `Next on your list: turning on the nightly run. ${repoSteps}\n\nTell me if your screen looks different.`,
  done: false,
};
