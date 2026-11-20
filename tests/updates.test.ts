// @vitest-environment node
// (jsdom's Uint8Array differs from Node's, which confuses fflate in tests only.)
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { compareVersions, newestRelease, parseVersion } from "../src/updates/version";
import { countDocs, diffSnapshots, docPath, emptySnapshot, kindOf, toSnapshot, type Snapshot } from "../src/updates/layout";
import { dataVersionOf, mapDocs, upgrade, type Step } from "../src/updates/migrations";
import { validateSnapshot } from "../src/updates/validate";
import { emptyUpdates, goBackTarget, keepBackups, offer, planLoad, publishJobBody, readUpdates, type Pending, type UpdatesDoc } from "../src/updates/plan";
import { contentTypeOf, parseBackupZip, prepareImport, relink } from "../src/updates/importZip";
import { parseLatest, tagsFromLsRemote } from "../src/routine/release";
import { whatsNewTurns, plainNote } from "../src/updates/whatsNew";
import { host, ReadOnlyError, setReadOnly } from "../src/platform/host";
import { zipPaths } from "../src/platform/backup";

/** A small desk with one of most kinds, shaped like real data. */
function desk(): Snapshot {
  const s = emptySnapshot();
  s.profile = { level: "university", school: "", country: "", updatedAt: 1, handoff: { environmentId: "env_1", triggerId: "trig_1", artifactUrl: "https://claude.ai/artifact/old" }, schedule: { key: "n1" } };
  s.setup = { id: "sem1", name: "Winter", status: "active", courses: [{ id: "c1", name: "Analysis" }], uploads: [{ id: "u1", assetId: "a1", fileName: "skript.pdf", courseId: "c1" }], facts: [], results: {} };
  s.semester = { id: "sem1", name: "Winter", courses: [{ id: "c1" }], skills: [], targets: [], uploads: [{ id: "u1", assetId: "a1", fileName: "skript.pdf", courseId: "c1" }] };
  s.askChats = { ch1: { id: "ch1", title: "Limits", messages: [], notes: [] } };
  s.questRecords = { q1: { quest: { id: "q1", date: "2026-11-19", courseId: "c1" }, progress: {} } };
  s.masteryAttempts = { at1: { id: "at1", skillId: "s1", day: "2026-11-19", verdict: "solved", points: 2, maxPoints: 2 } };
  s.masteryReviews = { at1: { attemptId: "at1", status: "open" } };
  s.masterySkills = { s1: { id: "s1", courseId: "c1", name: "Epsilon-delta" } };
  s.orchestratorChat = { "sem1_2026-11-19": { semesterId: "sem1", day: "2026-11-19", messages: [] } };
  s.routineOutbox = { b1: { id: "b1", kind: "grading" } };
  return s;
}

describe("versions", () => {
  it("reads and orders release tags; dev is older than any release", () => {
    expect(parseVersion("v1.10.2")).toEqual([1, 10, 2]);
    expect(parseVersion("dev")).toBeNull();
    expect(compareVersions("v1", "v1.0")).toBe(0);
    expect(compareVersions("v1.2", "v1.10")).toBeLessThan(0);
    expect(compareVersions("dev", "v1")).toBeLessThan(0);
    expect(newestRelease(["v1", "v1.10", "v1.9", "nightly", "v1.2"])).toBe("v1.10");
  });
});

describe("snapshots", () => {
  it("fills missing kinds and drops unknown keys", () => {
    const s = toSnapshot({ profile: { a: 1 }, askChats: { x: { id: "x", messages: [] }, bad: 3 }, mode: "cloud", exportedAt: "…" });
    expect(s.setup).toBeNull();
    expect(Object.keys(s.askChats)).toEqual(["x"]);
    expect("mode" in s).toBe(false);
  });
  it("diffs into sets and deletes, deletes last", () => {
    const a = desk();
    const b = toSnapshot(JSON.parse(JSON.stringify(a)));
    b.askChats.ch2 = { id: "ch2", messages: [] };
    delete b.routineOutbox.b1;
    b.semester = null;
    const w = diffSnapshots(a, b);
    expect(w.map((x) => [x.path.join("/"), x.data === null])).toEqual([
      ["profile/chats/ch2", false],
      ["semester", true],
      ["routine/outbox/b1", true],
    ]);
    expect(diffSnapshots(a, a)).toEqual([]);
  });
  it("maps paths to kinds and back", () => {
    expect(docPath("questRecords", "q1")).toEqual(["quests", "records", "q1"]);
    expect(kindOf(["quests", "records", "q1"])).toEqual({ kind: "questRecords", id: "q1" });
    expect(kindOf(["onboarding"])).toEqual({ kind: "setup", id: null });
    expect(kindOf(["job-abc"])).toBeNull();
    expect(countDocs(desk())).toBe(10);
  });
});

describe("upgrade steps", () => {
  const steps: Record<number, Step> = {
    1: (s) => ({ ...s, masteryAttempts: mapDocs(s.masteryAttempts, (a) => ({ ...a, seconds: a.seconds ?? null })) }),
    2: (s) => ({ ...s, profile: s.profile ? { ...s.profile, language: "en" } : null }),
  };
  it("runs every step in order, without changing the input", () => {
    const before = desk();
    const copy = JSON.stringify(before);
    const r = upgrade(before, 1, 3, steps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ran).toEqual([1, 2]);
    expect(r.snapshot.masteryAttempts.at1.seconds).toBeNull();
    expect(r.snapshot.profile?.language).toBe("en");
    expect(JSON.stringify(before)).toBe(copy);
  });
  it("starts where the data is", () => {
    const r = upgrade(desk(), 2, 3, steps);
    expect(r.ok && r.ran).toEqual([2]);
  });
  it("refuses newer data, a missing step, and reports a step that throws", () => {
    expect(upgrade(desk(), 4, 3, steps)).toMatchObject({ ok: false });
    expect(upgrade(desk(), 1, 3, { 1: steps[1] })).toMatchObject({ ok: false, error: expect.stringContaining("2 to 3") });
    expect(upgrade(desk(), 1, 2, { 1: () => { throw new Error("boom"); } })).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
  });
  it("has nothing to do on today's data version", () => {
    expect(upgrade(desk(), 1)).toMatchObject({ ok: true, ran: [] });
  });
  it("treats data from before updates existed as version 1", () => {
    expect(dataVersionOf(desk())).toBe(1);
    expect(dataVersionOf({ updates: { dataVersion: 3 } })).toBe(3);
  });
});

describe("checking the data", () => {
  it("accepts a normal desk", () => {
    expect(validateSnapshot(desk())).toEqual({ ok: true, problems: [] });
    expect(validateSnapshot(emptySnapshot()).ok).toBe(true);
  });
  it("names what doesn't fit", () => {
    const s = desk();
    s.masteryAttempts.at1 = { id: "at1", day: "2026-11-19", verdict: "solved", points: "2" };
    s.questRecords.q1 = { quest: { id: "q1" }, progress: {} };
    const v = validateSnapshot(s);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain('masteryAttempts/at1: "skillId" is missing');
    expect(v.problems).toContain('masteryAttempts/at1: "points" should be a number');
    expect(v.problems.some((p) => p.startsWith("questRecords/q1/quest"))).toBe(true);
  });
});

describe("what the page does on load", () => {
  const doc = (p: Partial<UpdatesDoc> = {}): UpdatesDoc => ({ ...emptyUpdates(), ...p });
  const pending = (p: Partial<Pending>): Pending => ({ kind: "update", from: "v1", to: "v1.1", jobId: "j", startedAt: 1, backupId: "b", ...p });
  it("does nothing normally", () => {
    expect(planLoad("v1", doc())).toEqual({ kind: "ok" });
  });
  it("upgrades older data", () => {
    expect(planLoad("v2", doc({ dataVersion: 1 }), 2)).toEqual({ kind: "upgrade", from: 1, pending: null });
  });
  it("checks the data once a new version arrived, even with no upgrade step", () => {
    const p = pending({});
    expect(planLoad("v1.1", doc({ pending: p }))).toEqual({ kind: "upgrade", from: 1, pending: p });
    // Still the old version: the update is under way, nothing to do here.
    expect(planLoad("v1", doc({ pending: p }))).toEqual({ kind: "ok" });
  });
  it("is read-only on data from a newer version", () => {
    expect(planLoad("v1", doc({ dataVersion: 2 }), 1)).toEqual({ kind: "newer-data", dataVersion: 2 });
  });
  it("finishes a rollback when the old version is there, and waits for it otherwise", () => {
    const p = pending({ kind: "rollback", from: "v1.1", to: "v1", restore: true });
    expect(planLoad("v1", doc({ pending: p, dataVersion: 2 }), 1)).toEqual({ kind: "finish-rollback", pending: p });
    expect(planLoad("v1.1", doc({ pending: p }))).toEqual({ kind: "rolling-back", pending: p });
  });
  it("tries a failed upgrade again on the same version", () => {
    const failure = { from: "v1", to: "v1.1", at: 1, error: "x", partial: false, backupId: null };
    expect(planLoad("v1.1", doc({ failure }))).toMatchObject({ kind: "upgrade" });
    expect(planLoad("v1", doc({ failure }))).toEqual({ kind: "ok" });
  });
  it("reads a stored state with missing or broken fields", () => {
    expect(readUpdates({ dataVersion: "x", backups: [{ assetId: "a" }, null] })).toMatchObject({ dataVersion: 1, backups: [{ assetId: "a" }], pending: null });
  });
});

describe("offering an update, going back, keeping backups", () => {
  const rel = (latest: string, dataVersion: number | null = 1) => ({ latest, notes: "New", dataVersion, checkedAt: 1 });
  it("offers only a newer release that can read the data", () => {
    expect(offer("v1", rel("v1.1"), emptyUpdates())?.latest).toBe("v1.1");
    expect(offer("v1.1", rel("v1.1"), emptyUpdates())).toBeNull();
    expect(offer("v1.2", rel("v1.1"), emptyUpdates())).toBeNull();
    expect(offer("dev", rel("v1"), emptyUpdates())?.latest).toBe("v1");
    expect(offer("dev", rel("v1", 1), { ...emptyUpdates(), dataVersion: 2 })).toBeNull();
    expect(offer("v1", null, emptyUpdates())).toBeNull();
  });
  it("goes back only to a real release", () => {
    const last = { kind: "update" as const, from: "v1", to: "v1.1", at: 1, backupId: "b", notes: null, ran: [], announced: true };
    expect(goBackTarget({ ...emptyUpdates(), lastUpdate: last })).toBe("v1");
    expect(goBackTarget({ ...emptyUpdates(), lastUpdate: { ...last, from: "dev" } })).toBeNull();
    expect(goBackTarget({ ...emptyUpdates(), failure: { from: "v1", to: "v1.1", at: 1, error: "", partial: true, backupId: "b" } })).toBe("v1");
  });
  it("keeps the newest three backups", () => {
    const b = (n: number) => ({ assetId: `a${n}`, appVersion: "v1", dataVersion: 1, at: n, bytes: 10 });
    const r = keepBackups([b(1), b(2), b(3)], b(4));
    expect(r.keep.map((x) => x.assetId)).toEqual(["a2", "a3", "a4"]);
    expect(r.drop.map((x) => x.assetId)).toEqual(["a1"]);
  });
  it("tells the session to publish the release onto the same link, with its program and capabilities", () => {
    const body = publishJobBody("v1.1", "update", "someone/studydesk");
    expect(body).toContain("git clone --depth 1 --branch releases https://github.com/someone/studydesk.git");
    expect(body).toContain('Artifact action "read"');
    expect(body).toContain("/v1.1/index.html");
    expect(body).toContain('"routine.mjs"');
    expect(body).toContain("capabilities.json");
    expect(body).toMatch(/never publish without it/);
    expect(publishJobBody("v1", "rollback")).toContain('"Go back to v1"');
  });
  it("writes the what's-new prompt from the notes only", () => {
    const u = { kind: "update" as const, from: "v1", to: "v1.1", at: 1, backupId: null, notes: "Grading shows the first wrong step.", ran: [], announced: false };
    expect(whatsNewTurns(u, "Speaks German.")[0].content).toContain("Grading shows the first wrong step.");
    expect(plainNote({ ...u, kind: "rollback", to: "v1" })).toContain("back on v1");
  });
});

describe("restoring an exported zip", () => {
  function zip(data: Record<string, unknown>, extra: Record<string, Uint8Array> = {}) {
    return zipSync({ "studydesk-data.json": strToU8(JSON.stringify(data)), ...extra });
  }
  it("reads a current zip with its file list and links files to new ids", () => {
    const d = desk();
    const z = zip({ mode: "cloud", dataVersion: 1, appVersion: "v1", ...d }, { "files.json": strToU8(JSON.stringify({ "files/Analysis/skript.pdf": "a1" })), "files/Analysis/skript.pdf": new Uint8Array([1, 2]) });
    const p = parseBackupZip(z);
    expect(p.mode).toBe("cloud");
    if (p.mode !== "cloud") return;
    expect(p.files).toEqual([{ path: "files/Analysis/skript.pdf", oldAssetId: "a1", bytes: new Uint8Array([1, 2]) }]);
    const ready = prepareImport(p);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    const s = relink(ready.snapshot, new Map([["a1", "new1"]]));
    expect((s.semester!.uploads as Array<{ assetId: string }>)[0].assetId).toBe("new1");
    expect((s.setup!.uploads as Array<{ assetId: string }>)[0].assetId).toBe("new1");
    // The old desk's nightly task and link don't come along; the outbox is the old page's.
    expect(s.profile!.schedule).toBeUndefined();
    expect(s.profile!.handoff).toEqual({ environmentId: "env_1", triggerId: "trig_1" });
    expect(s.routineOutbox).toEqual({});
  });
  it("reads an older zip (no version, no file list) by naming files the way the export did", () => {
    const d = desk();
    const z = zip({ mode: "cloud", ...d }, { "files/Analysis/skript.pdf": new Uint8Array([7]) });
    const p = parseBackupZip(z);
    expect(p.mode === "cloud" && p.dataVersion).toBe(1);
    expect(p.mode === "cloud" && p.files.map((f) => f.oldAssetId)).toEqual(["a1"]);
  });
  it("names duplicate files exactly like older exports did", () => {
    const o = (id: string) => ({ assetId: id, fileName: "a.pdf", courseName: null });
    expect([...zipPaths([o("1"), o("2"), o("3")]).values()]).toEqual(["files/a.pdf", "files/a (2).pdf", "files/a (2) (3).pdf"]);
  });
  it("refuses a zip from a newer StudyDesk, and anything that isn't a backup", () => {
    const p = parseBackupZip(zip({ mode: "cloud", dataVersion: 99, appVersion: "v9" }));
    expect(p.mode === "cloud" && prepareImport(p)).toMatchObject({ ok: false, error: expect.stringContaining("newer StudyDesk (v9)") });
    expect(() => parseBackupZip(new Uint8Array([1, 2, 3]))).toThrow(/zip/);
    expect(() => parseBackupZip(zipSync({ "x.txt": strToU8("hi") }))).toThrow(/isn't a StudyDesk backup/);
  });
  it("stores files with a type the file store takes", () => {
    expect(contentTypeOf("Blatt 3.PDF")).toBe("application/pdf");
    expect(contentTypeOf("notes.docx")).toBeNull();
  });
});

describe("the nightly release check", () => {
  it("reads latest.json and the tags", () => {
    expect(parseLatest('{"version":"v1.1","notes":"New things","dataVersion":1}', 5)).toEqual({ latest: "v1.1", notes: "New things", dataVersion: 1, checkedAt: 5 });
    expect(parseLatest('{"version":"main"}', 5)).toBeNull();
    expect(parseLatest("not json", 5)).toBeNull();
    expect(tagsFromLsRemote("abc\trefs/tags/v1\nabd\trefs/tags/v1^{}\nabe\trefs/tags/v1.2\nabf\trefs/tags/test")).toBe("v1.2");
  });
});

describe("read-only mode", () => {
  it("refuses writes through the stores but lets reads and job reports through", async () => {
    const calls: string[] = [];
    const ref = (path: string): Record<string, unknown> =>
      Object.freeze({
        path,
        get: async () => (calls.push(`get ${path}`), { exists: false }),
        set: async () => void calls.push(`set ${path}`),
        delete: async () => void calls.push(`delete ${path}`),
        collection: (c: string) => Object.freeze({ path: `${path}/${c}`, doc: (id: string) => ref(`${path}/${c}/${id}`) }),
      });
    const db = Object.freeze({ doc: (p: string) => ref(p) });
    (globalThis as { claude?: unknown }).claude = Object.freeze({ use: async (n: string) => (n === "db" ? db : null) });
    try {
      const guarded = (await host()!.use("db")) as unknown as { doc(p: string): { get(): Promise<unknown>; set(): Promise<void>; collection: unknown } };
      setReadOnly("testing");
      await guarded.doc("data/users/u/profile").get();
      await expect(guarded.doc("data/users/u/profile").set()).rejects.toBeInstanceOf(ReadOnlyError);
      const chats = (guarded.doc("data/users/u/profile").collection as (c: string) => { doc(id: string): { set(): Promise<void> } })("chats");
      await expect(chats.doc("c1").set()).rejects.toBeInstanceOf(ReadOnlyError);
      await guarded.doc("data/users/u/job-1").set();
      // The update itself writes through the raw runtime.
      await ((await host({ raw: true })!.use("db")) as unknown as { doc(p: string): { set(): Promise<void> } }).doc("data/users/u/updates").set();
      setReadOnly(null);
      await guarded.doc("data/users/u/profile").set();
      expect(calls).toEqual(["get data/users/u/profile", "set data/users/u/job-1", "set data/users/u/updates", "set data/users/u/profile"]);
    } finally {
      setReadOnly(null);
      delete (globalThis as { claude?: unknown }).claude;
    }
  });
});
