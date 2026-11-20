// The nightly run's program, as the cloud session runs it:
//
//   node routine.mjs --dir <work folder> --key <schedule key>
//
// Built into one dependency-free file (vite.routine.config.ts) and published
// next to the page as routine.mjs, so the session runs exactly the code the
// student's StudyDesk runs. Every time it runs it prints the next step for the
// session: download the data, answer Claude calls, upload the results. The
// session repeats until it prints "NIGHTLY RUN FINISHED".
//
// Everything printed here is the session's instructions; keep it plain.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { MasteryData } from "../platform/masteryStore";
import type { OutboxDoc } from "./apply";
import { deferredAsk, type PendingCall } from "./deferred";
import { runNightly, type NightInput, type RoutineDoc, type ScheduleInfo, type Write } from "./nightly";

const ME = "data/users/me";
/** Collections to download (under data/users/me). Paths alternate collection/document. */
const COLLECTIONS = ["quests/records", "quests/images", "mastery/skills", "mastery/targets", "mastery/attempts", "mastery/reviews", "routine/outbox", "files/uploads"];
const DOCS = ["profile", "onboarding", "semester", "routine"];
const BATCH_BYTES = 800_000;

type Night = { now: number; today: string; nowLocal: string; timeZone: string; seed: number };

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? "" : null;
}

function say(lines: string[]): void {
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------- fixed time and ids for the whole night ----------

function localParts(ts: number, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function freeze(night: Night): void {
  process.env.TZ = night.timeZone;
  const realDate = Date;
  Date.now = () => night.now;
  void realDate;
  // A seeded generator, so ids come out the same on every run of the same night.
  let s = night.seed >>> 0 || 1;
  Math.random = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

// ---------- reading the downloaded data ----------

type Loaded = { data: Record<string, unknown>; version: number | null };

/** Every downloaded document, keyed by its path with the user's id written as "me". */
function loadAll(root: string): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        const rel = relative(root, p).split(sep).join("/").replace(/\.json$/, "");
        const key = rel.replace(/^(?:.*?\/)?data\/users\/[^/]+\//, `${ME}/`);
        try {
          out.set(key, unwrap(JSON.parse(readFileSync(p, "utf8"))));
        } catch {
          /* not a document */
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** A saved document may hold its fields directly, or under "data" next to "version"/"id". */
function unwrap(x: unknown): Loaded {
  const o = (x ?? {}) as Record<string, unknown>;
  if (o && typeof o === "object" && o.data && typeof o.data === "object" && ("version" in o || "id" in o || "doc_id" in o)) {
    const v = Number(o.version);
    return { data: o.data as Record<string, unknown>, version: Number.isFinite(v) ? v : null };
  }
  return { data: o, version: null };
}

function doc<T>(all: Map<string, Loaded>, path: string): T | null {
  return (all.get(`${ME}/${path}`)?.data as T | undefined) ?? null;
}

function collection<T>(all: Map<string, Loaded>, path: string): Array<{ id: string; data: T }> {
  const prefix = `${ME}/${path}/`;
  return [...all.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([k, v]) => ({ id: k.slice(prefix.length), data: v.data as T }));
}

// ---------- steps ----------

function downloadStep(dir: string, url: string | null): void {
  const data = join(dir, "data");
  const where = url ? `url "${url}"` : `the StudyDesk url`;
  say([
    "NEXT STEP: download the student's StudyDesk data (into files, not into this conversation).",
    "",
    `Use ArtifactData with ${where} and always out_dir "${data}":`,
    ...DOCS.map((d) => `- action "get", collection "${ME}", doc_id "${d}" (a missing document just answers "No document": that's fine)`),
    ...COLLECTIONS.map((c) => `- action "list", collection "${ME}/${c}", query {"limit": 1000}; while the result has a next_cursor, list again with query {"limit": 1000, "cursor": <next_cursor>}`),
    "",
    `When every call is done (empty collections are fine), create the empty file ${join(data, "READY")} and run this program again with the same arguments.`,
  ]);
}

function formatCall(c: PendingCall, dir: string): string {
  const parts = [
    `# ${c.label}`,
    "",
    `Answer this as StudyDesk's Claude. The conversation below is exactly what StudyDesk sends; reply as the assistant's next turn.`,
    `Write ONLY that reply, in exactly the format the conversation asks for, into the file ${join(dir, "answers", `${c.id}.md`)}. No preamble, no comments about this file.`,
    c.web ? "You may search the web and fetch pages for this one." : "Answer from the conversation alone; no web needed.",
  ];
  if (c.images.length) parts.push(`The student's photos for this call, in order (open each with Read): ${c.images.map((_, i) => join(dir, "calls", `${c.id}-${i + 1}.jpg`)).join(", ")}. "image N" in the text means the N-th of these.`);
  c.turns.forEach((t, i) => {
    parts.push("", `<<<<< TURN ${i + 1}: ${t.role.toUpperCase()} >>>>>`, t.content);
  });
  parts.push("", "<<<<< END OF CONVERSATION >>>>>");
  return parts.join("\n");
}

async function callsStep(dir: string, calls: PendingCall[]): Promise<void> {
  mkdirSync(join(dir, "calls"), { recursive: true });
  mkdirSync(join(dir, "answers"), { recursive: true });
  for (const c of calls) {
    writeFileSync(join(dir, "calls", `${c.id}.md`), formatCall(c, dir));
    for (let i = 0; i < c.images.length; i++) writeFileSync(join(dir, "calls", `${c.id}-${i + 1}.jpg`), Buffer.from(await c.images[i].arrayBuffer()));
  }
  say([
    `NEXT STEP: answer ${calls.length} ${calls.length === 1 ? "call" : "calls"} from StudyDesk.`,
    "",
    "Each file below is one conversation StudyDesk would send to Claude. Read it, answer it carefully with your full judgment (this is the real answer the student gets), and write only the reply into the answer file it names. Work through them one by one.",
    ...calls.map((c) => `- ${join(dir, "calls", `${c.id}.md`)}  (${c.label})`),
    "",
    "When every answer file is written, run this program again with the same arguments.",
  ]);
}

function uploadStep(dir: string, url: string, writes: Write[], versions: Map<string, number | null>): void {
  const up = join(dir, "upload");
  mkdirSync(up, { recursive: true });
  type Entry = { op: "set"; collection: string; doc_id: string; file_path: string; if_version?: number };
  const batches: Entry[][] = [[]];
  let size = 0;
  writes.forEach((w, i) => {
    const file = join(up, `${String(i).padStart(3, "0")}.json`);
    const text = JSON.stringify(w.data);
    writeFileSync(file, text);
    const path = w.path;
    const collection = [ME, ...path.slice(0, -1)].join("/");
    const entry: Entry = { op: "set", collection, doc_id: path[path.length - 1], file_path: file };
    const v = versions.get(`${ME}/${path.join("/")}`);
    if (w.mode === "replace" && v) entry.if_version = v;
    let batch = batches[batches.length - 1];
    if (batch.length >= 50 || size + text.length > BATCH_BYTES) {
      batch = [];
      batches.push(batch);
      size = 0;
    }
    batch.push(entry);
    size += text.length;
  });
  say([
    "NEXT STEP: save tonight's results into the student's StudyDesk.",
    "",
    `Use ArtifactData action "batch" with url "${url}", one call per list below, in this order. Use the entries exactly as given.`,
    "If a batch is refused because a document already exists or its version changed: for that document only, get it (action \"get\") to learn its version and redo the entry with \"if_version\". For mastery/attempts, mastery/reviews and quests/records documents that already exist, skip the entry instead (they were saved before).",
    ...batches.filter((b) => b.length).map((b, i) => `\nBatch ${i + 1}:\n${JSON.stringify(b)}`),
    "",
    `When every batch is saved, run this program again with the same arguments plus --saved.`,
  ]);
}

// ---------- main ----------

async function main(): Promise<void> {
  const dir = arg("dir");
  const key = arg("key");
  if (!dir || !key) {
    say(["Usage: node routine.mjs --dir <work folder> --key <schedule key> [--url <StudyDesk url>] [--dry-run --tz <IANA zone>]"]);
    process.exitCode = 2;
    return;
  }
  mkdirSync(dir, { recursive: true });
  const url = arg("url") || (existsSync(join(dir, "url.txt")) ? readFileSync(join(dir, "url.txt"), "utf8").trim() : null);
  if (url) writeFileSync(join(dir, "url.txt"), url);

  if (!existsSync(join(dir, "data", "READY"))) return downloadStep(dir, url);
  if (!url) {
    say([`Write the StudyDesk url into ${join(dir, "url.txt")} (or pass --url), then run this program again.`]);
    return;
  }
  const all = loadAll(join(dir, "data"));
  const profile = doc<NightInput["profile"] & { schedule?: ScheduleInfo }>(all, "profile");
  const schedule = profile?.schedule;
  const dry = process.argv.includes("--dry-run");
  if (!dry && (!schedule || schedule.key !== key)) {
    say([
      "STOP. This scheduled task was replaced by a newer one (or the nightly run was turned off), so it does nothing tonight.",
      "Don't write anything. Reply \"Replaced: nothing to do.\" and end. NIGHTLY RUN FINISHED",
    ]);
    return;
  }

  // The night's fixed clock.
  const nightFile = join(dir, "night.json");
  let night: Night;
  if (existsSync(nightFile)) night = JSON.parse(readFileSync(nightFile, "utf8"));
  else {
    const now = Date.now();
    const timeZone = schedule?.timeZone ?? arg("tz") ?? "UTC";
    const p = localParts(now, timeZone);
    night = { now, today: p.day, nowLocal: `${p.day}T${p.time}`, timeZone, seed: (now % 2_147_483_647) || 7 };
    writeFileSync(nightFile, JSON.stringify(night));
  }
  freeze(night);

  if (!dry && profile?.nightly?.paused) {
    say(["STOP. The student paused the nightly run. Don't write anything. Reply \"Paused: nothing to do.\" and end. NIGHTLY RUN FINISHED"]);
    return;
  }
  const routine = doc<RoutineDoc>(all, "routine");
  // Fired twice by mistake: the second stops. (A run the student started earlier in the day doesn't block tonight's.)
  if (!dry && routine?.nights.some((n) => n.day === night.today && n.status === "done" && night.now - n.startedAt < 3 * 3_600_000) && !process.argv.includes("--saved")) {
    say([`A run already finished in the last few hours (${night.today}). Don't write anything. NIGHTLY RUN FINISHED`]);
    return;
  }

  const answers = new Map<string, string>();
  const ansDir = join(dir, "answers");
  if (existsSync(ansDir)) for (const f of readdirSync(ansDir)) if (f.endsWith(".md")) answers.set(f.slice(0, -3), readFileSync(join(ansDir, f), "utf8").trim());

  const images = new Map(collection<{ dataUrl?: string }>(all, "quests/images").filter((x) => x.data.dataUrl).map((x) => [x.id, x.data.dataUrl!]));
  const uploads = new Map(collection<{ text?: string; image?: string }>(all, "files/uploads").map((x) => [x.id, x.data]));
  const mastery: MasteryData = {
    skills: collection<MasteryData["skills"][number]>(all, "mastery/skills").map((x) => x.data),
    targets: collection<MasteryData["targets"][number]>(all, "mastery/targets").map((x) => x.data),
    attempts: collection<MasteryData["attempts"][number]>(all, "mastery/attempts").map((x) => x.data),
    reviews: collection<MasteryData["reviews"][number]>(all, "mastery/reviews").map((x) => x.data),
  };
  const input: NightInput = {
    today: night.today,
    nowLocal: night.nowLocal,
    now: night.now,
    profile,
    draft: doc(all, "onboarding"),
    semester: doc(all, "semester"),
    records: collection<NightInput["records"][number]>(all, "quests/records").map((x) => x.data),
    mastery,
    outbox: collection<OutboxDoc>(all, "routine/outbox").map((x) => x.data),
    routine,
    images,
    uploads,
  };

  const d = deferredAsk(answers);
  const result = await runNightly(input, d);
  if (result.kind === "pending") {
    if (!d.pending.length) {
      say(["Something stopped without a call to answer. Reply with the log below and end.", ...result.log, "NIGHTLY RUN FINISHED"]);
      return;
    }
    return callsStep(dir, d.pending);
  }
  if (dry) {
    say([
      "NIGHTLY RUN FINISHED (dry run: nothing is saved).",
      `It would save ${result.writes.length} documents: ${result.writes.map((w) => w.path.join("/")).join(", ")}`,
      "Tonight's log would be:",
      ...result.log.map((l) => `- ${l}`),
      "",
      "Reply with that and end. Don't write anything into StudyDesk.",
    ]);
    return;
  }
  if (process.argv.includes("--saved")) {
    say([
      "NIGHTLY RUN FINISHED. Tonight's log for the student:",
      ...result.log.map((l) => `- ${l}`),
      "",
      "Reply with that log and end the session. Don't write anything else.",
    ]);
    return;
  }
  const versions = new Map([...all.entries()].map(([k, v]) => [k, v.version]));
  uploadStep(dir, url, result.writes, versions);
}

main().catch((e) => {
  say([`The nightly program failed: ${(e as Error)?.stack ?? String(e)}`, "Reply with this error and end. NIGHTLY RUN FINISHED"]);
  process.exitCode = 1;
});
