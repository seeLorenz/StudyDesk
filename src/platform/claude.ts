// The only module that talks to Claude. Everything else calls askClaude().
// Today it uses the claude.ai artifact `sample` capability (runs on the
// viewer's own Claude plan). Moving to an API key later means changing this
// file only.
import { host } from "./host";

export type Turn = { role: "user" | "assistant"; content: string };

export type AskOptions = {
  images?: Blob[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  /** Kept for later token tuning; today every call asks for Opus (see MODEL). */
  tier?: "quick" | "default" | "complex";
  /** Page functions Claude may call while answering (never cached). */
  tools?: Claude.sample.SampleTool[];
};

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
  const sample = await getSample();
  if (!sample) return false;
  const limits = await sample.limits().catch(() => null);
  return !!limits?.images;
}

/**
 * Ask Claude. `turns` must start and end with a user turn. Resolves with the
 * full answer; streams through onText. Rejects with an AskError.
 */
export async function askClaude(turns: Turn[], opts: AskOptions = {}): Promise<string> {
  const sample = await getSample();
  if (!sample) return mockAnswer(turns, opts);
  try {
    const res = await sample(turns, {
      ...(opts.tools ? { tools: opts.tools } : { cache: false }),
      signal: opts.signal,
      model: MODEL,
      modelTier: FALLBACK_TIER,
      images: opts.images && opts.images.length ? opts.images : undefined,
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
      return "One of the images couldn't be used. Try a JPEG or PNG under 20 MB.";
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
