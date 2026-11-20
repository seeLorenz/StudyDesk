// Hand-off: long, agentic work goes to Claude sessions in the cloud.
//
// The page starts Claude Code cloud sessions through the student's own
// "Claude Code Remote" connector (the artifact `mcp` capability). One saved
// task ("StudyDesk agent") is created once per student; each job fires it with
// the job's full instructions, which starts a fresh session. Sessions can
// search the web, work while the page is closed, are tagged "StudyDesk", and
// are archived once their answer is read, so they stay out of the student's
// normal Claude chat list. The page follows a session's progress and reads
// its final answer back from the session's events.
//
// Everything here is plumbing (one right answer); what a job does is up to
// the prompt that the caller writes.

export const HANDOFF_SERVER = "Claude Code Remote";
export const HANDOFF_TOOLS = [
  "list_environments",
  "create_trigger",
  "get_trigger",
  "fire_trigger",
  "get_session",
  "list_events",
  "set_session_tags",
  "archive_session",
] as const;
export const HANDOFF_TAG = "StudyDesk";
/** fire_trigger takes at most 64 KiB of text; leave room for the envelope. */
export const MAX_JOB_BYTES = 60_000;

export type HandoffSetup = { environmentId: string; triggerId: string };

export type HandoffState =
  | { kind: "ready"; setup: HandoffSetup }
  /** The connector exists but the viewer hasn't allowed it yet: one click on "Connect" asks. */
  | { kind: "ask" }
  /** No Claude Code on the web (connector missing or no cloud environment yet). */
  | { kind: "off"; reason: "no_connector" | "no_environment" | "no_tools" }
  | { kind: "declined" }
  | { kind: "unavailable"; detail: string };

export type JobProgress = {
  status: "working" | "done" | "failed";
  /** New lines for the live log since `after`. */
  log: string[];
  /** The session's final answer, once it has one. */
  answer: string | null;
  lastEventId: string | null;
};

type Mcp = typeof Claude.mcp;
let mcpPromise: Promise<Mcp | null> | null = null;
function getMcp(): Promise<Mcp | null> {
  if (!mcpPromise) {
    const c = (window as Window & { claude?: Claude }).claude;
    mcpPromise = c?.use ? c.use("mcp").catch(() => null) : Promise.resolve(null);
  }
  return mcpPromise;
}

async function call<T = unknown>(tool: string, input: Record<string, unknown>): Promise<T> {
  const mcp = await getMcp();
  if (!mcp) throw { code: "capability_disabled", message: "No connectors in this view." };
  const r = await mcp.callTool(HANDOFF_SERVER, tool, input);
  return (r.payload ?? r.content) as T;
}

const codeOf = (e: unknown) => String((e as { code?: unknown })?.code ?? "");

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
    return codeOf(e) === "server_not_connected" ? { kind: "off", reason: "no_connector" } : { kind: "unavailable", detail: String((e as Error)?.message ?? e) };
  }
  if (tools.length && !["create_trigger", "fire_trigger", "list_events"].every((t) => tools.includes(t))) return { kind: "off", reason: "no_tools" };
  if (auth !== "connected" && !connect) return { kind: "ask" };
  try {
    const envs = await call<{ environments?: Array<{ environment_id: string; state?: string; kind?: string }> }>("list_environments", { limit: 20 });
    const active = (envs.environments ?? []).filter((e) => !e.state || e.state === "active");
    const env = active.find((e) => e.environment_id === saved?.environmentId) ?? active.find((e) => e.kind === "anthropic_cloud") ?? active[0];
    if (!env) return { kind: "off", reason: "no_environment" };
    let triggerId = saved?.environmentId === env.environment_id ? saved?.triggerId : undefined;
    if (triggerId) {
      try {
        await call("get_trigger", { trigger_id: triggerId });
      } catch {
        triggerId = undefined;
      }
    }
    if (!triggerId) triggerId = await createAgentTask(env.environment_id);
    return { kind: "ready", setup: { environmentId: env.environment_id, triggerId } };
  } catch (e) {
    const code = codeOf(e);
    if (code === "not_granted") return { kind: "declined" };
    if (code === "server_not_connected" || code === "needs_reauth") return { kind: "off", reason: "no_connector" };
    if (code === "blocked_by_policy") return { kind: "off", reason: "no_tools" };
    return { kind: "unavailable", detail: String((e as { message?: string })?.message ?? e) };
  }
}

const AGENT_PROMPT = `You are an agent of StudyDesk, a study app. StudyDesk started this session for one job; the job's full instructions follow as the next message. Work on your own: nobody reads this session while it runs, and you can't ask questions. Use web search when the job says so. Do not create files, branches or pull requests. Your last message must be exactly the reply the job asks for, and nothing else.`;

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

function findId(value: unknown, prefix: string): string | null {
  const m = JSON.stringify(value ?? "").match(new RegExp(`${prefix}[A-Za-z0-9]+`));
  return m ? m[0] : null;
}

/** Starts one job: a fresh cloud session with `instructions`. Resolves with the session id. */
export async function startJob(setup: HandoffSetup, title: string, instructions: string): Promise<string> {
  const text = clipBytes(`# ${title}\n\n${instructions}`, MAX_JOB_BYTES);
  const fired = await call("fire_trigger", { trigger_id: setup.triggerId, text });
  let sessionId = findId(fired, "session_");
  for (let i = 0; !sessionId && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    sessionId = findId(await call("get_trigger", { trigger_id: setup.triggerId }), "session_");
  }
  if (!sessionId) throw { code: "tool_error", message: "The cloud session started, but StudyDesk couldn't find it." };
  await call("set_session_tags", { session_ids: [sessionId], add: [HANDOFF_TAG] }).catch(() => undefined);
  return sessionId;
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

/** Reads what a session did since `after` and whether it has finished. */
export async function readJob(sessionId: string, after: string | null): Promise<JobProgress> {
  const session = await call<{ status?: string; status_bucket?: string }>("get_session", { session_id: sessionId });
  const events: unknown[] = [];
  let cursor = after;
  let last = after;
  for (let page = 0; page < 10; page++) {
    const res = await call<{ data?: unknown[]; last_id?: string; has_more?: boolean }>("list_events", {
      session_id: sessionId,
      kinds: ["assistant", "result"],
      limit: 100,
      ...(cursor ? { after_id: cursor } : {}),
    });
    events.push(...(res.data ?? []));
    if (res.last_id) last = res.last_id;
    // Without a cursor the newest page comes back; from then on, page forward.
    if (!cursor || !res.has_more || !res.last_id) break;
    cursor = res.last_id;
  }
  const { log } = summarizeEvents(events);
  const bucket = session.status_bucket ?? "";
  if (bucket === "working" || bucket === "") return { status: "working", log, answer: null, lastEventId: last };
  if (bucket === "failed") return { status: "failed", log, answer: null, lastEventId: last };
  // The session stopped: its answer is in the newest events.
  const newest = await call<{ data?: unknown[] }>("list_events", { session_id: sessionId, kinds: ["assistant", "result"], limit: 100 });
  const { answer } = summarizeEvents(newest.data ?? []);
  return { status: answer ? "done" : "failed", log, answer, lastEventId: last };
}

/** Archives a finished session so it leaves the student's session list. */
export async function archiveJob(sessionId: string): Promise<void> {
  await call("archive_session", { session_id: sessionId }).catch(() => undefined);
}

export const sessionUrl = (sessionId: string) => `https://claude.ai/code/${sessionId}`;

// ---------- reading events (pure, tested) ----------

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };

function blocksOf(ev: unknown): { kind: "assistant" | "result" | null; blocks: Block[]; result?: string } {
  const e = ev as Record<string, unknown>;
  const data = (e?.data ?? e) as Record<string, unknown>;
  if (data?.result && typeof (data.result as Record<string, unknown>)?.result === "string") return { kind: "result", blocks: [], result: (data.result as { result: string }).result };
  if (typeof data?.result === "string") return { kind: "result", blocks: [], result: data.result };
  const a = (data?.assistant ?? (data?.type === "assistant" ? data : null)) as Record<string, unknown> | null;
  const content = (a?.message as { content?: unknown })?.content;
  if (Array.isArray(content)) return { kind: "assistant", blocks: content as Block[] };
  return { kind: null, blocks: [] };
}

const host = (url: unknown) => {
  try {
    return new URL(String(url)).host.replace(/^www\./, "");
  } catch {
    return String(url ?? "").slice(0, 60);
  }
};
const shorten = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** One plain line per thing the agent did: searches, pages and files read, and its short notes. */
export function describeTool(b: Block): string | null {
  const i = b.input ?? {};
  switch (b.name) {
    case "WebSearch":
      return `Searching the web: ${shorten(String(i.query ?? ""), 100)}`;
    case "WebFetch":
      return `Reading ${host(i.url)}`;
    case "Read":
      return `Reading ${String(i.file_path ?? "a file").split("/").pop()}`;
    case "Bash":
      return i.description ? shorten(String(i.description), 100) : "Running a command";
    case "Grep":
    case "Glob":
      return "Searching the files";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return null;
    default:
      return b.name ? `Using ${b.name}` : null;
  }
}

export function summarizeEvents(events: unknown[]): { log: string[]; answer: string | null } {
  const log: string[] = [];
  let lastText: string | null = null;
  let result: string | null = null;
  for (const ev of events) {
    const { kind, blocks, result: r } = blocksOf(ev);
    if (kind === "result") {
      if (r) result = r;
      continue;
    }
    for (const b of blocks) {
      if (b.type === "tool_use") {
        const line = describeTool(b);
        if (line && log[log.length - 1] !== line) log.push(line);
      } else if (b.type === "text" && b.text?.trim()) {
        lastText = b.text;
        // The final answer is long and sectioned; short notes along the way go into the log.
        const first = b.text.trim().split("\n")[0];
        if (!/^===/.test(first) && b.text.length < 400) log.push(shorten(first));
      }
    }
  }
  return { log, answer: result ?? lastText };
}
