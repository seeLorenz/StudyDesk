// Keeps every open screen on the same version of the student's data.
//
// The setup screen, the quest page and the Orchestrator panel each hold the
// semester draft, the profile or the semester in memory and save it. When
// one of them changes something, it publishes the new version here, and the
// others take it over instead of later saving their older copy on top.

import type { Profile, SemesterDraft } from "../onboarding/types";
import type { Semester } from "../quests/types";

type Topics = { draft: SemesterDraft; profile: Profile; semester: Semester };
type Listener<K extends keyof Topics> = (value: Topics[K], from: string) => void;

const listeners: { [K in keyof Topics]: Set<Listener<K>> } = { draft: new Set(), profile: new Set(), semester: new Set() };
const latest: { [K in keyof Topics]?: Topics[K] } = {};

export function publish<K extends keyof Topics>(topic: K, value: Topics[K], from: string): void {
  latest[topic] = value;
  for (const l of listeners[topic]) l(value, from);
}

/** Calls `fn` for every version another screen publishes. Returns the unsubscribe function. */
export function subscribe<K extends keyof Topics>(topic: K, me: string, fn: (value: Topics[K]) => void): () => void {
  const l: Listener<K> = (v, from) => {
    if (from !== me) fn(v);
  };
  listeners[topic].add(l);
  return () => listeners[topic].delete(l);
}

export function latestOf<K extends keyof Topics>(topic: K): Topics[K] | undefined {
  return latest[topic];
}
