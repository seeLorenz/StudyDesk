import { describe, expect, it } from "vitest";
import { joinDoc, partIdsOf, readBig, splitDoc, SPLIT_BYTES, staleParts, SWEEP_AFTER_MS, writeBig } from "../src/platform/bigDoc";
import { emptySnapshot, joinSnapshot, splitWrites } from "../src/updates/layout";

const skill = (i: number) => ({ id: `s${i}`, courseId: `c${i % 11}`, topicId: `t${i % 40}`, name: `Löse Aufgabe Nummer ${i} mit Kirchhoff und Ersatzspannungsquelle`, difficulty: "medium", prereqSkillIds: [`s${i - 1}`], tier: 2, weight: 1, estMinutes: 12 });
const big = () => ({
  id: "sem_1",
  name: "WS 2026/27",
  skills: Array.from({ length: 1200 }, (_, i) => skill(i)),
  results: Object.fromEntries(Array.from({ length: 11 }, (_, c) => [`c${c}`, { topics: Array.from({ length: 15 }, (_, t) => ({ id: `t${t}`, name: `Topic ${t} `.repeat(20) })), notes: "x".repeat(20_000) }])),
  uploads: Array.from({ length: 900 }, (_, i) => ({ id: `up_${i}`, fileName: `Vorlesung/Folien/Kapitel ${i}.pdf`, type: "pdf" })),
  status: "active",
});
const size = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;

describe("big documents", () => {
  it("leaves a small document alone", () => {
    const r = splitDoc("semester", { a: 1, b: [1, 2] });
    expect(r.parts).toEqual({});
    expect(r.main).toEqual({ a: 1, b: [1, 2] });
  });

  it("splits a big one into parts that each fit, and joins it back exactly", () => {
    const doc = big();
    expect(size(doc)).toBeGreaterThan(262_144);
    const { main, parts } = splitDoc("onboarding", doc);
    expect(size(main)).toBeLessThanOrEqual(SPLIT_BYTES);
    for (const p of Object.values(parts)) expect(size(p)).toBeLessThan(262_144);
    expect(partIdsOf(main)).toEqual(Object.keys(parts));
    expect(joinDoc(main, (id) => parts[id])).toEqual(doc);
  });

  it("gives unchanged parts the same id, so they aren't written again", () => {
    const a = splitDoc("onboarding", big());
    const changed = big();
    changed.skills[0].name = "changed";
    const b = splitDoc("onboarding", changed);
    const same = Object.keys(b.parts).filter((id) => id in a.parts);
    expect(same.length).toBeGreaterThan(0);
    expect(same.length).toBeLessThan(Object.keys(b.parts).length);
  });

  it("refuses to return half a document when a part is missing", () => {
    const { main, parts } = splitDoc("onboarding", big());
    const [first] = Object.keys(parts);
    expect(() => joinDoc(main, (id) => (id === first ? null : parts[id]))).toThrow(/missing/);
  });

  it("sweeps only old parts nobody refers to", () => {
    const { main, parts } = splitDoc("semester", big(), 0);
    const old = { "semester.skills.zzz": { createdAt: 0 }, "semester.skills.new": { createdAt: SWEEP_AFTER_MS * 2 } };
    expect(staleParts({ ...parts, ...old }, [main], SWEEP_AFTER_MS * 2 + 1)).toEqual(["semester.skills.zzz"]);
  });

  it("writes through a database and reads back whole, skipping parts it just wrote", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const ref = (path: string) => ({
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      set: async (d: Record<string, unknown>) => void store.set(path, JSON.parse(JSON.stringify(d))),
      delete: async () => void store.delete(path),
    });
    const col = { doc: (id: string) => ref(`parts/${id}`), get: async () => ({ docs: [...store.keys()].filter((k) => k.startsWith("parts/")).map((k) => ({ id: k.slice(6), exists: true, data: () => store.get(k) })) }) };
    const written = new Map<string, number>();
    const doc = big();
    await writeBig("onboarding", doc, ref("onboarding"), col, written);
    expect(await readBig(ref("onboarding"), col)).toEqual(doc);
    let sets = 0;
    const counting = { ...col, doc: (id: string) => ({ ...ref(`parts/${id}`), set: async (d: Record<string, unknown>) => void (sets++, store.set(`parts/${id}`, d)) }) };
    doc.status = "done";
    await writeBig("onboarding", doc, ref("onboarding"), counting, written);
    expect(sets).toBe(0);
    expect((await readBig(ref("onboarding"), col))?.status).toBe("done");
  });

  it("splits snapshot writes (updates, imports) and joins snapshots on read", () => {
    const doc = big();
    const writes = splitWrites([{ path: ["semester"], data: doc }, { path: ["profile"], data: { a: 1 } }]);
    const parts = writes.filter((w) => w.path[0] === "parts");
    expect(parts.length).toBeGreaterThan(1);
    expect(writes.indexOf(parts[parts.length - 1])).toBeLessThan(writes.findIndex((w) => w.path[0] === "semester"));
    const s = emptySnapshot();
    s.semester = writes.find((w) => w.path[0] === "semester")!.data;
    const joined = joinSnapshot(s, Object.fromEntries(parts.map((p) => [p.path[2], p.data!])));
    expect(joined.semester).toEqual(doc);
  });
});
