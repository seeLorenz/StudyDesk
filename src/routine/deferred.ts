// Claude calls inside the nightly run, answered by the cloud session itself.
//
// The nightly run is StudyDesk's own code (plan, grading rules, parsers)
// running in a cloud session. That code asks Claude through an `Ask`
// function, like in the page. Here the Claude that answers is the session
// that runs the script: every call is looked up by a fingerprint of its
// turns; a call without an answer yet is written down as "pending", and the
// script stops so the session can answer it and run the script again. All
// other inputs (time, ids) are fixed for the night, so the same calls come
// back in the same order on every run.
//
// Pure apart from the `answers` map: the CLI loads it from disk.

import type { AskOptions, Turn } from "../platform/claude";
import type { Ask } from "../quests/write";

export type PendingCall = {
  id: string;
  /** What the call is for, shown to the session ("grading Tue's quest"). */
  label: string;
  turns: Turn[];
  images: Blob[];
  /** The session may search the web while answering. */
  web: boolean;
};

/** Thrown by a deferred ask that has no answer yet. Caught by the run, never shown. */
export class AnswerPending extends Error {
  constructor(public callId: string) {
    super(`Waiting for the answer to ${callId}`);
  }
}

/** A short stable fingerprint (FNV-1a, 2×32 bits) of a call's turns. */
export function callId(turns: Turn[], imageCount = 0): string {
  const text = JSON.stringify(turns) + `|${imageCount}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return `c${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export type DeferredAsk = {
  /** An Ask for one stage; `label` and `web` describe its calls to the session. */
  ask(label: string, web?: boolean): Ask;
  pending: PendingCall[];
  used: Set<string>;
};

export function deferredAsk(answers: Map<string, string>): DeferredAsk {
  const pending: PendingCall[] = [];
  const used = new Set<string>();
  return {
    pending,
    used,
    ask: (label, web = false) => async (turns: Turn[], opts?: AskOptions) => {
      const images = opts?.images ?? [];
      const id = callId(turns, images.length);
      const answer = answers.get(id);
      if (answer !== undefined) {
        used.add(id);
        return answer;
      }
      if (!pending.some((p) => p.id === id)) pending.push({ id, label, turns, images, web });
      throw new AnswerPending(id);
    },
  };
}

export const isPending = (e: unknown): e is AnswerPending =>
  e instanceof AnswerPending || (!!e && typeof e === "object" && "cause" in e && (e as { cause: unknown }).cause !== e && isPending((e as { cause: unknown }).cause));
