// Hand-off: long, agentic work goes to Claude sessions in the cloud.
//
// The page starts Claude Code cloud sessions through the student's own
// "Claude Code Remote" connector (the artifact `mcp` capability). Pages may
// only list environments, create a saved task and fire it; they can't read,
// tag or archive sessions. So the session reports back by itself: the page
// writes a job document into the student's own data (data/users/<uid>/job-<id>),
// fires the "StudyDesk agent" task with the job's instructions, and the
// session writes its progress and final answer into that document with its
// ArtifactData tool. The page watches the document and deletes it once read.
// Sessions a task starts don't show up in the student's regular session list.
//
// Everything here is plumbing (one right answer); what a job does is up to
// the prompt that the caller writes.

import { host } from "./host";

export const HANDOFF_SERVER = "Claude Code Remote";
/** All a page gets, and all hand-off needs. */
export const HANDOFF_TOOLS = ["list_environments", "create_trigger", "fire_trigger"] as const;
/** fire_trigger takes at most 64 KiB of text; leave room for the envelope and the reporting rules. */
export const MAX_JOB_BYTES = 56_000;
/** A job nobody picked up, or that went quiet, counts as failed after these. */
export const START_TIMEOUT_MS = 15 * 60_000;
export const QUIET_TIMEOUT_MS = 40 * 60_000;

export type HandoffSetup = { environmentId: string; triggerId: string; artifactUrl?: string };

export type HandoffState =
  | { kind: "ready"; setup: HandoffSetup }
  /** The connector exists but the viewer hasn't allowed it yet: one click on "Connect" asks. */
  | { kind: "ask" }
  /** No Claude Code on the web (connector missing or no cloud environment yet). */
  | { kind: "off"; reason: "no_connector" | "no_environment" | "no_tools"; detail?: string }
  | { kind: "declined" }
  | { kind: "unavailable"; detail: string };

/** What a session writes into its job document. */
export type JobDoc = {
  status: "queued" | "working" | "done" | "failed";
  title?: string;
  createdAt?: number;
  log?: string[];
  answer?: string;
  error?: string;
  artifactUrl?: string;
  updatedAt?: number | string;
};

export type JobProgress = {
  status: "waiting" | "working" | "done" | "failed";
  log: string[];
  answer: string | null;
  error: string | null;
  artifactUrl: string | null;
};

type Mcp = typeof Claude.mcp;
let mcpPromise: Promise<Mcp | null> | null = null;
function getMcp(): Promise<Mcp | null> {
  if (!mcpPromise) {
    const c = host();
    mcpPromise = c?.use ? c.use("mcp").catch(() => null) : Promise.resolve(null);
  }
  return mcpPromise;
}

/** One Claude Code Remote tool call from the page. */
export async function callRemote<T = unknown>(tool: string, input: Record<string, unknown>): Promise<T> {
  return call<T>(tool, input);
}

async function call<T = unknown>(tool: string, input: Record<string, unknown>): Promise<T> {
  const mcp = await getMcp();
  if (!mcp) throw { code: "capability_disabled", message: "No connectors in this view." };
  const r = await mcp.callTool(HANDOFF_SERVER, tool, input);
  return (r.payload ?? r.content) as T;
}

const codeOf = (e: unknown) => String((e as { code?: unknown })?.code ?? "");
const messageOf = (e: unknown) => String((e as { message?: unknown })?.message ?? e);

/**
 * Where hand-off stands for this viewer. With `connect` false it never asks
 * the viewer anything (safe on load); with `connect` true the first call may
 * show the connector's permission prompt, so only pass it from a click.
 */
export async function checkHandoff(saved: Partial<HandoffSetup> | undefined, connect: boolean): Promise<HandoffState> {
  const mcp = await getMcp();
  if (!mcp) return { kind: "unavailable", detail: "Connectors can't be used in this view." };
  let tools: string[] = [];
  let auth = "unknown";
  try {
    const list = await mcp.listTools(HANDOFF_SERVER);
    const s = list.servers.find((x) => x.server === HANDOFF_SERVER);
    if (!s) return { kind: "off", reason: "no_connector" };
    tools = s.tools.map((t) => t.name);
    auth = s.authStatus;
  } catch (e) {
    return codeOf(e) === "server_not_connected" ? { kind: "off", reason: "no_connector" } : { kind: "unavailable", detail: messageOf(e) };
  }
  const missing = tools.length ? HANDOFF_TOOLS.filter((t) => !tools.includes(t)) : [];
  if (missing.length) return { kind: "off", reason: "no_tools", detail: `Missing for this page: ${missing.join(", ")}. Available: ${tools.join(", ") || "none"}.` };
  if (auth !== "connected" && !connect) return { kind: "ask" };
  try {
    const envs = await call<{ environments?: Array<{ environment_id: string; state?: string; kind?: string }> }>("list_environments", { limit: 20 });
    const active = (envs.environments ?? []).filter((e) => !e.state || e.state === "active");
    const env = active.find((e) => e.environment_id === saved?.environmentId) ?? active.find((e) => e.kind === "anthropic_cloud") ?? active[0];
    if (!env) return { kind: "off", reason: "no_environment" };
    const same = saved?.environmentId === env.environment_id;
    const triggerId = (same && saved?.triggerId) || (await createAgentTask(env.environment_id));
    return { kind: "ready", setup: { environmentId: env.environment_id, triggerId, ...(saved?.artifactUrl ? { artifactUrl: saved.artifactUrl } : {}) } };
  } catch (e) {
    const code = codeOf(e);
    if (code === "not_granted") return { kind: "declined" };
    if (code === "server_not_connected" || code === "needs_reauth") return { kind: "off", reason: "no_connector" };
    if (code === "blocked_by_policy") return { kind: "off", reason: "no_tools", detail: `Blocked by a policy: ${messageOf(e)}` };
    return { kind: "unavailable", detail: messageOf(e) };
  }
}

/** The saved task's own prompt. It runs as the session's first turn; the job follows as the next message. */
export const AGENT_PROMPT = `You are an agent of StudyDesk, a study app. StudyDesk starts this session for one job, and the job's full instructions arrive as the next message. Right now, reply only "Waiting for the job." and do nothing else. When the job arrives, work on your own: nobody reads this session, and you can't ask questions. Report exactly as the job says. Do not create files, branches or pull requests.`;

async function createAgentTask(environmentId: string): Promise<string> {
  const r = await call<{ trigger?: { id?: string }; id?: string }>("create_trigger", {
    name: "StudyDesk agent",
    prompt: AGENT_PROMPT,
    initiation: "human_request",
    create_new_session_on_fire: true,
    environment_id: environmentId,
    notifications: {},
  });
  const id = r?.trigger?.id ?? r?.id ?? findId(r, "trig_");
  if (!id) throw { code: "tool_error", message: "The StudyDesk agent task couldn't be created." };
  return id;
}

export function findId(value: unknown, prefix: string): string | null {
  const m = JSON.stringify(value ?? "").match(new RegExp(`${prefix}[A-Za-z0-9]+`));
  return m ? m[0] : null;
}

// ---------- jobs ----------

export const jobDocId = (jobId: string) => `job-${jobId}`;

/** The rules a session follows to report through the student's own StudyDesk data. Pure, tested. */
export function jobInstructions(o: { jobId: string; title: string; body: string; artifactUrl?: string; alsoWrite?: string }): string {
  const doc = jobDocId(o.jobId);
  const where = o.artifactUrl
    ? `Your StudyDesk is ${o.artifactUrl}.`
    : `Find your StudyDesk first: Artifact action "list" (limit 50). For each artifact whose title contains "StudyDesk", try ArtifactData action "get" with collection "data/users/me" and doc_id "${doc}". The one where that document exists is yours; use its URL from then on.`;
  return `# ${o.title}

## How you report (do this exactly)
StudyDesk can't read this session. You report by writing into the student's own StudyDesk data with the ArtifactData tool. If ArtifactData or Artifact isn't loaded, load it with ToolSearch (query "select:ArtifactData,Artifact").

${where}
Your job's document: collection "data/users/me", doc_id "${doc}". Change only that document, always with ArtifactData action "update". Every update needs "if_version": first "get" the document to learn its version; each update's result gives the next version. If an update is refused because the version changed, "get" it again and redo the update.

1. Right away: update with {"status": "working", "artifactUrl": "<the StudyDesk URL>", "log": ["Started"]}.
2. Every few minutes, after a step the student would like to see (a web search, a file read, a section drafted): update with the full "log" list so far, short plain lines, newest last, at most 20.
3. When finished: update with {"status": "done", "answer": "<your complete reply, exactly in the format the job asks for>"}. That is the only place your answer counts.
4. If you can't do the job: update with {"status": "failed", "error": "<one plain sentence why>"}.

${o.alsoWrite ? `Apart from that, you may only ${o.alsoWrite}. Don't write anywhere else in StudyDesk's data.` : "Don't write anywhere else in StudyDesk's data."} Don't create files, branches or pull requests.

## The job

${o.body}`;
}

/** Where a job stands, from its document. `changedAt` is when the page last saw the document change. Pure, tested. */
export function jobProgress(doc: JobDoc | null, job: { startedAt: number; changedAt: number }, now: number): JobProgress {
  const base = { log: (doc?.log ?? []).filter((l) => typeof l === "string").slice(-20), answer: null, error: null, artifactUrl: doc?.artifactUrl && /^https:\/\/claude\.ai\//.test(doc.artifactUrl) ? doc.artifactUrl : null };
  if (!doc) return { ...base, status: "failed", error: "The cloud session's report went missing." };
  if (doc.status === "done") return typeof doc.answer === "string" && doc.answer.trim() ? { ...base, status: "done", answer: doc.answer } : { ...base, status: "failed", error: "The cloud session finished without an answer." };
  if (doc.status === "failed") return { ...base, status: "failed", error: doc.error ? `The cloud session gave up: ${doc.error}` : "The cloud session gave up." };
  if (doc.status === "queued" || !doc.status) {
    if (now - job.startedAt > START_TIMEOUT_MS) return { ...base, status: "failed", error: "The cloud session never picked up the job." };
    return { ...base, status: "waiting" };
  }
  if (now - job.changedAt > QUIET_TIMEOUT_MS) return { ...base, status: "failed", error: "The cloud session stopped reporting." };
  return { ...base, status: "working" };
}

type JobRef = { get(): Promise<{ exists: boolean; data(): unknown }>; set(d: unknown): Promise<unknown>; delete(): Promise<unknown> };

async function jobRef(jobId: string): Promise<JobRef> {
  const c = host();
  const [db, user] = c?.use ? await Promise.all([c.use("db").catch(() => null), c.use("user").catch(() => null)]) : [null, null];
  const uid = user ? await (user as { id(): Promise<string> }).id().catch(() => null) : null;
  if (!db || !uid) throw { code: "capability_disabled", message: "StudyDesk can't save here, so a cloud session couldn't report back." };
  return (db as DB).doc(`data/users/${uid}/${jobDocId(jobId)}`) as unknown as JobRef;
}

const newJobId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Starts one job: writes its document, then fires a fresh cloud session with
 * the instructions. When the saved task is gone, makes a new one; the
 * returned setup then differs and should be saved.
 */
export async function startJob(setup: HandoffSetup, title: string, body: string, alsoWrite?: string): Promise<{ jobId: string; sessionId: string | null; setup: HandoffSetup }> {
  const jobId = newJobId();
  const ref = await jobRef(jobId);
  await ref.set({ status: "queued", title, createdAt: Date.now(), log: [] } satisfies JobDoc);
  const text = clipBytes(jobInstructions({ jobId, title, body, artifactUrl: setup.artifactUrl, alsoWrite }), 63_000);
  let used = setup;
  let fired: unknown;
  try {
    fired = await call("fire_trigger", { trigger_id: setup.triggerId, text });
  } catch (e) {
    if (!/not.?found|no such|unknown trigger|404|deleted/i.test(messageOf(e))) {
      await ref.delete().catch(() => undefined);
      throw e;
    }
    used = { ...setup, triggerId: await createAgentTask(setup.environmentId) };
    fired = await call("fire_trigger", { trigger_id: used.triggerId, text });
  }
  // fire_trigger names the session "cse_…"; on claude.ai it is "session_…" with the same suffix.
  const raw = (fired as { session_id?: string } | null)?.session_id ?? findId(fired, "(?:session|cse)_");
  return { jobId, sessionId: raw ? raw.replace(/^cse_/, "session_") : null, setup: used };
}

/** Reads a job's document (null when it's gone). */
export async function readJobDoc(jobId: string): Promise<JobDoc | null> {
  const s = await (await jobRef(jobId)).get();
  return s.exists ? (s.data() as JobDoc) : null;
}

/** Removes a job's document once its answer is saved, or the job is given up. */
export async function removeJob(jobId: string): Promise<void> {
  await (await jobRef(jobId)).delete().catch(() => undefined);
}

export function clipBytes(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(text.slice(0, mid)).length <= max - 40) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "\n[…cut: too long for one job]";
}

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

export const sessionUrl = (sessionId: string) => `https://claude.ai/code/${sessionId}`;
