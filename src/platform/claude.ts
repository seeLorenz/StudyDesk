// The only module that talks to Claude. Everything else calls askClaude().
// Today it uses the claude.ai artifact `sample` capability (runs on the
// viewer's own Claude plan). Moving to an API key later means changing this
// file only.
import { host } from "./host";

export type Turn = { role: "user" | "assistant"; content: string };

export type AskOptions = {
  /** Images for this turn, most important first: past the view's limit the last ones are left out. */
  images?: Blob[];
  /**
   * Images from earlier turns, attached again so Claude can still see them.
   * They come after `images`, are left out first when the view allows fewer,
   * and are dropped (with a line telling Claude) when Claude can't take the
   * images, so one old image can never block every later message.
   */
  earlierImages?: Blob[];
  /**
   * Every one of `images` must reach Claude: if the view can't take them all
   * (too many, or a type or size it refuses), the call fails with
   * `image_rejected` instead of going ahead without some. Grading uses it, so
   * a problem is never graded without the photo of its work.
   */
  strictImages?: boolean;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  /** Kept for later token tuning; today every call asks for Opus (see MODEL). */
  tier?: "quick" | "default" | "complex";
  /** Page functions Claude may call while answering (never cached). */
  tools?: Claude.sample.SampleTool[];
  /**
   * Work nobody is waiting for (check-ins, memory summaries, update notes).
   * It is skipped (rejects with code "skipped") while any other call is
   * running, so it never competes with what the student asked.
   */
  background?: boolean;
};

/** Calls running right now; background work waits its turn. */
let inFlight = 0;
/** Waits before asking again after Claude said it's busy, in ms. */
export const BUSY_RETRY_MS = [8_000, 20_000];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject({ code: "cancelled", message: "Stopped." });
    });
  });

/**
 * Every agent in StudyDesk asks for Opus (the student's choice, 2026-11-20).
 * If this viewer's plan or app can't run it, the call falls back to the most
 * capable tier instead, and lastModel() says so.
 */
export const MODEL = "claude-opus-5-5";
const FALLBACK_TIER = "complex" as const;

export type ModelUsed = { opus: boolean; tier: string } | null;
let lastUsed: ModelUsed = null;
/** Which model answered the most recent call (null before the first one). */
export function lastModel(): ModelUsed {
  return lastUsed;
}

export type AskError = { code: string; message: string; text?: string };

type SampleFn = typeof Claude.sample;

let samplePromise: Promise<SampleFn | null> | null = null;

function getSample(): Promise<SampleFn | null> {
  if (!samplePromise) {
    const c = host();
    samplePromise = c?.use ? c.use("sample").catch(() => null) : Promise.resolve(null);
  }
  return samplePromise;
}

/** True when this view can reach Claude (inside a claude.ai artifact). */
export async function claudeAvailable(): Promise<boolean> {
  return (await getSample()) !== null;
}

/** True when this view lets Claude call page functions. */
export async function canUseTools(): Promise<boolean> {
  const sample = await getSample();
  if (!sample) return false;
  const limits = await sample.limits().catch(() => null);
  return !!limits?.tools;
}

export async function canSendImages(): Promise<boolean> {
  return (await maxImages()) > 0;
}

/** How many images one question may carry in this view (0: none). */
export async function maxImages(): Promise<number> {
  const sample = await getSample();
  if (!sample) return 0;
  const limits = await sample.limits().catch(() => null);
  return limits?.images ? Math.max(0, limits.images.maxCount) : 0;
}

type ImageLimits = { maxCount: number; maxInputBytes: number; mediaTypes: string[] };

/**
 * Picks the images one call may carry: only accepted types and sizes, this
 * turn's first, then earlier ones, up to the view's count. Says what was left
 * out, for a line to Claude. Pure.
 */
export function fitImages(now: Blob[], earlier: Blob[], limits: ImageLimits | null | undefined): { images: Blob[]; leftOutNow: number; leftOutEarlier: number } {
  if (!limits) return { images: [], leftOutNow: now.length, leftOutEarlier: earlier.length };
  const ok = (b: Blob) => (!limits.mediaTypes?.length || limits.mediaTypes.includes(b.type)) && (!limits.maxInputBytes || b.size <= limits.maxInputBytes);
  const room = Math.max(0, limits.maxCount);
  const n = now.filter(ok).slice(0, room);
  const e = earlier.filter(ok).slice(0, room - n.length);
  return { images: [...n, ...e], leftOutNow: now.length - n.length, leftOutEarlier: earlier.length - e.length };
}

/** Adds a line for Claude to the last (user) turn. */
function withNote(turns: Turn[], note: string): Turn[] {
  if (!note) return turns;
  const out = turns.map((t) => ({ ...t }));
  out[out.length - 1].content += `\n\n${note}`;
  return out;
}

function leftOutNote(leftOutNow: number, leftOutEarlier: number): string {
  return [
    leftOutNow ? `(StudyDesk could attach only some of this turn's images: the last ${leftOutNow} ${leftOutNow === 1 ? "is" : "are"} missing. Tell the student which ones you can't see, and ask them to send those again in a later message.)` : "",
    leftOutEarlier ? `(${leftOutEarlier} of the earlier images couldn't be attached again this turn. Go by what was already said about ${leftOutEarlier === 1 ? "it" : "them"}.)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Ask Claude. `turns` must start and end with a user turn. Resolves with the
 * full answer; streams through onText. Rejects with an AskError.
 */
export async function askClaude(turns: Turn[], opts: AskOptions = {}): Promise<string> {
  const sample = await getSample();
  if (!sample) return mockAnswer(turns, opts);
  if (opts.background && inFlight > 0) throw { code: "skipped", message: "Another call is running." } satisfies AskError;
  inFlight++;
  try {
    // A busy answer before anything was streamed is asked again a little later
    // (twice) for what the student is waiting on, instead of failing at once.
    for (let attempt = 0; ; attempt++) {
      let streamed = false;
      try {
        return await askOnce(sample, turns, { ...opts, onText: opts.onText ? (t) => ((streamed = true), opts.onText!(t)) : undefined });
      } catch (e) {
        const err = e as AskError;
        if (err.code !== "rate_limited" || streamed || opts.background || attempt >= BUSY_RETRY_MS.length || opts.signal?.aborted) throw err;
        await sleep(BUSY_RETRY_MS[attempt], opts.signal);
      }
    }
  } finally {
    inFlight--;
  }
}

async function askOnce(sample: NonNullable<Awaited<ReturnType<typeof getSample>>>, turns: Turn[], opts: AskOptions): Promise<string> {
  const now = opts.images ?? [];
  const earlier = opts.earlierImages ?? [];
  if (!now.length && !earlier.length) return askWith(sample, turns, opts, []);
  const limits = await sample.limits().catch(() => null);
  const fit = fitImages(now, earlier, limits?.images);
  if (opts.strictImages && fit.leftOutNow) throw { code: "image_rejected", message: `${fit.leftOutNow} of ${now.length} images can't be sent in one question here.` } satisfies AskError;
  try {
    return await askWith(sample, withNote(turns, leftOutNote(fit.leftOutNow, fit.leftOutEarlier)), opts, fit.images);
  } catch (e) {
    // Claude couldn't take the images: ask once more without the earlier ones,
    // which the student didn't just send. This turn's own images still fail
    // visibly, so the student knows to send another file.
    const err = e as AskError;
    const sentEarlier = fit.images.length - (now.length - fit.leftOutNow);
    if (err?.code !== "image_rejected" || err.text || sentEarlier <= 0 || opts.signal?.aborted) throw err;
    const onlyNow = fit.images.slice(0, fit.images.length - sentEarlier);
    return askWith(sample, withNote(turns, leftOutNote(fit.leftOutNow, earlier.length)), opts, onlyNow);
  }
}

async function askWith(sample: NonNullable<Awaited<ReturnType<typeof getSample>>>, turns: Turn[], opts: AskOptions, images: Blob[]): Promise<string> {
  try {
    const res = await sample(turns, {
      ...(opts.tools ? { tools: opts.tools } : { cache: false }),
      signal: opts.signal,
      model: MODEL,
      modelTier: FALLBACK_TIER,
      images: images.length ? images : undefined,
      onText: opts.onText ? ({ text }) => opts.onText!(text) : undefined,
    });
    const { text, truncated } = res;
    lastUsed = { opus: res.modelApplied === MODEL, tier: res.modelTierApplied };
    return truncated ? text + "\n\n*(The answer was cut short. Ask for less at a time.)*" : text;
  } catch (e) {
    throw normalize(e);
  }
}

function normalize(e: unknown): AskError {
  if (e && typeof e === "object" && "code" in e) return e as AskError;
  return { code: "upstream_error", message: String(e) };
}

/** What to tell the viewer for each failure. */
export function errorCopy(e: AskError): string {
  switch (e.code) {
    case "cancelled":
      return "Stopped.";
    case "not_granted":
    case "sampling_disabled":
      return "StudyDesk isn't allowed to use Claude in this view. Allow it in the artifact's permissions, then try again.";
    case "rate_limited":
      return "Claude is busy: StudyDesk sent too many requests at once, or your Claude plan reached its usage limit for now. Wait a minute, then try again.";
    case "session_expired":
      return "Your claude.ai session expired. Sign in again, then retry.";
    case "prompt_too_large":
      return "That's too much text for one question. Start a new chat or attach a smaller file.";
    case "image_rejected":
      return "Claude couldn't take one of the images you just sent (an unsupported type, a damaged file, or too many at once). Send fewer images at a time, or a screenshot or JPEG instead.";
    case "images_unavailable":
      return "Images can't be sent from this view. Describe the image in text instead.";
    case "refused":
      return "Claude declined to answer that. Try rephrasing the question.";
    default:
      return "Something went wrong reaching Claude. Try again.";
  }
}

// Outside claude.ai (local development) there is no Claude: answer with a
// canned reply so the interface can still be exercised.
async function mockAnswer(turns: Turn[], opts: AskOptions): Promise<string> {
  const last = turns[turns.length - 1]?.content ?? "";
  const isNote = last.includes("HIGHLIGHTED PASSAGE") || turns.some((t) => t.content.includes("HIGHLIGHTED PASSAGE"));
  const text = isNote
    ? "**Short answer:** this is a local preview, so no real Claude is connected.\n\nInside claude.ai this box would explain the highlighted passage, using the whole chat as context, without adding anything to the main conversation."
    : "Here's a sample answer from the local preview.\n\n## Photosynthesis in one paragraph\n\nPlants turn light energy into chemical energy. In the **light-dependent reactions**, water is split and ATP and NADPH are made. In the **Calvin cycle**, that energy fixes CO₂ into glucose:\n\n$$6\\,CO_2 + 6\\,H_2O \\xrightarrow{light} C_6H_{12}O_6 + 6\\,O_2$$\n\n### Watch out for\n\n- Include **zero coefficients** for missing powers. For $x^3 + 4$, use $1, 0, 0, 4$.\n- A divisor $(x + 2)$ means $c = -2$, so mind the sign.\n\nSelect any part of this answer and press **Reply** to ask about it in a side note.";
  let out = "";
  for (const word of text.split(/(?<= )/)) {
    if (opts.signal?.aborted) throw { code: "cancelled", message: "aborted", text: out } satisfies AskError;
    await new Promise((r) => setTimeout(r, 12));
    out += word;
    opts.onText?.(out);
  }
  return out;
}
