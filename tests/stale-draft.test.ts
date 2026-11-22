import { describe, expect, it } from "vitest";
import { cloudStore, StaleDraft } from "../src/platform/onboardingStore";
import type { SemesterDraft } from "../src/onboarding/types";

// A tiny in-memory stand-in for the artifact database, shared by "tabs".
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({
    async get() {
      const d = docs.get(path);
      return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) };
    },
    async set(d: Record<string, unknown>) {
      docs.set(path, JSON.parse(JSON.stringify(d)));
    },
    async delete() {
      docs.delete(path);
    },
    collection: (name: string) => col(`${path}/${name}`),
  });
  const col = (path: string) => ({
    doc: (id: string) => ref(`${path}/${id}`),
    async get() {
      const pre = `${path}/`;
      return { docs: [...docs.entries()].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map(([k, v]) => ({ id: k.slice(pre.length), exists: true, data: () => v })) };
    },
  });
  return { db: { doc: ref, collection: col }, docs };
}

const draft = (step: SemesterDraft["setupStep"], updatedAt: number) => ({ id: "sem_1", status: step === "done" ? "active" : "setting_up", setupStep: step, courses: [], results: {}, updatedAt }) as unknown as SemesterDraft;

describe("saving the setup from two tabs", () => {
  it("never writes a stale tab's copy over newer work", async () => {
    const { db } = fakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = cloudStore(db as any, "u1", null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = cloudStore(db as any, "u1", null);
    await a.loadDraft();
    await a.saveDraft(draft("chat", 1));
    // Tab A stays open with the old setup; tab B loads it and finishes setup.
    expect((await b.loadDraft())?.setupStep).toBe("chat");
    await b.saveDraft(draft("done", 2));
    // Tab A goes into the background and tries to save its old copy: refused, and it gets the newer one.
    const err = await a.saveDraft(draft("chat", 3)).catch((e) => e);
    expect(err).toBeInstanceOf(StaleDraft);
    expect((err as StaleDraft).latest?.setupStep).toBe("done");
    expect((await b.loadDraft())?.setupStep).toBe("done");
    // Having taken over the newer version, tab A can save again.
    await a.saveDraft({ ...(err as StaleDraft).latest!, updatedAt: 4 });
    expect((await b.loadDraft())?.updatedAt).toBe(4);
  });

  it("keeps the version mark out of the setup it hands back", async () => {
    const { db } = fakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = cloudStore(db as any, "u1", null);
    await a.loadDraft();
    await a.saveDraft(draft("done", 1));
    expect(await a.loadDraft()).not.toHaveProperty("__rev");
  });
});

import { localMasteryStore } from "../src/platform/masteryStore";

describe("redoing the placement check", () => {
  it("deletes only the past stats, keeping skills and targets", async () => {
    const mem = new Map<string, string>();
    const ms = localMasteryStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) });
    await ms.putSkills([{ id: "s1" } as never]);
    await ms.putTarget({ courseId: "c1" } as never);
    await ms.appendAttempts([{ id: "a1" } as never]);
    await ms.putReview({ attemptId: "a1" } as never);
    await ms.clearStats();
    const d = await ms.load();
    expect(d.attempts).toEqual([]);
    expect(d.reviews).toEqual([]);
    expect(d.skills).toHaveLength(1);
    expect(d.targets).toHaveLength(1);
  });
});
