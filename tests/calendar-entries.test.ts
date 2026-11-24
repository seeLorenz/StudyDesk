import { describe, expect, it, vi } from "vitest";
import { applyWant, busyLines, calendarTaskSetup, calendarWant, parseTimes, pickTimes, planStep, studyEntries, type CalendarWritten } from "../src/quests/times";
import { aheadIsStale } from "../src/platform/calendar";
import type { QuestRecord } from "../src/quests/types";
import { toEvents } from "../src/platform/calendar";
import { calendarTaskNotice } from "../src/orchestrator/signals";

const want = (times: { start: string; end: string }[], day = "2026-11-24", questId = "q1") =>
  calendarWant(day, questId, studyEntries({ day, times, courseName: "Analysis", reason: "Exam on Friday.", timeZone: "Europe/Vienna", url: null }));
const rec = (id: string, handedIn: string[] = [], date = "2026-11-24") =>
  ({ quest: { id, date, parts: [{ id: "p1" }, { id: "p2" }] }, progress: { handedIn } }) as unknown as QuestRecord;

describe("study times", () => {
  it("reads blocks from a reply: sorted, valid, no overlaps, at most three", () => {
    expect(parseTimes("16:00-17:00\n9:30 – 10:15\n16:30-16:45\n25:00-26:00\n18:00-17:00\n19:00-19:30\n20:00-20:30")).toEqual([
      { start: "09:30", end: "10:15" },
      { start: "16:00", end: "17:00" },
      { start: "19:00", end: "19:30" },
    ]);
    expect(parseTimes("no time tomorrow")).toEqual([]);
  });

  it("keys the plan by day and times, so only a changed plan is written again", () => {
    expect(want([{ start: "16:00", end: "17:00" }]).key).toBe(want([{ start: "16:00", end: "17:00" }]).key);
    expect(want([{ start: "16:00", end: "17:00" }]).key).not.toBe(want([{ start: "16:30", end: "17:30" }]).key);
  });

  it("replaces the earlier entries and records the new ones", async () => {
    const remove = vi.fn(async () => {});
    const create = vi.fn(async () => "new1");
    const old: CalendarWritten = { key: "old", day: "2026-11-23", ids: ["old1"], taskSeenAt: 5 };
    const w = want([{ start: "16:00", end: "17:00" }]);
    const next = await applyWant(w, old, "2026-11-23", { create, remove });
    expect(remove).toHaveBeenCalledWith(["old1"]);
    expect(next).toEqual({ key: w.key, day: w.day, ids: ["new1"], sigs: ["2026-11-24 16:00-17:00 Study · Analysis"], taskSeenAt: 5 });
    expect(await applyWant(w, next, "2026-11-23", { create, remove })).toBeNull();
    expect(await applyWant(w, null, "2026-11-25", { create, remove })).toBeNull();
  });

  it("saves a half-written plan without its key, so the next try starts clean", async () => {
    let n = 0;
    const create = async () => {
      if (n++) throw new Error("quota");
      return "a";
    };
    const next = await applyWant(want([{ start: "08:00", end: "09:00" }, { start: "10:00", end: "11:00" }]), null, "2026-11-24", { create, remove: async () => {} });
    expect(next).toMatchObject({ key: "", ids: ["a"], sigs: ["2026-11-24 08:00-09:00 Study · Analysis"] });
  });

  it("keeps entries that stay and only touches what changed", async () => {
    const two = want([{ start: "08:00", end: "09:00" }, { start: "16:00", end: "17:00" }]);
    const written = (await applyWant(two, null, "2026-11-24", { create: async (e) => e.start, remove: async () => {} }))!;
    const remove = vi.fn(async () => {});
    const create = vi.fn(async () => "x");
    const next = await applyWant(want([{ start: "08:00", end: "09:00" }]), written, "2026-11-24", { create, remove });
    expect(remove).toHaveBeenCalledWith(["16:00"]);
    expect(create).not.toHaveBeenCalled();
    expect(next?.ids).toEqual(["08:00"]);
  });

  it("never treats StudyDesk's own entries as commitments", () => {
    const raw = [
      { summary: "Study · Analysis", description: "[StudyDesk] Exam on Friday.", start: { dateTime: "2026-11-24T16:00:00+01:00" }, end: { dateTime: "2026-11-24T17:00:00+01:00" } },
      { summary: "Lecture", start: { dateTime: "2026-11-24T08:00:00+01:00" }, end: { dateTime: "2026-11-24T10:00:00+01:00" } },
    ];
    expect(toEvents(raw).map((e) => e.title)).toEqual(["Lecture"]);
  });
});

describe("never on top of a lecture (24 Nov: a block sat on the Physik VU)", () => {
  const quest = { plannedMinutes: 180, parts: [{ title: "Lesson" }] } as never;

  it("drops a picked block that overlaps something fixed, or starts before now", async () => {
    const times = await pickTimes(async () => "10:30-11:30\n13:00-14:05\n15:00-16:00", { quest, courseName: "Math", weekday: "Tuesday", events: ["10:15-11:45 Physik VU"], notes: "", after: "10:20" });
    expect(times.map((t) => t.start)).toEqual(["13:00", "15:00"]);
    const early = await pickTimes(async () => "09:00-10:00\n12:00-13:00", { quest, courseName: "Math", weekday: "Tuesday", events: [], notes: "", after: "11:00" });
    expect(early.map((t) => t.start)).toEqual(["12:00"]);
  });

  it("counts the weekly timetable too, once per slot", () => {
    const timetable = [
      { weekday: 2, start: "10:15", end: "11:45", kind: "lecture", title: "Physik VU", courseId: null },
      { weekday: 2, start: "16:00", end: "17:30", kind: "exercise", title: "Math UE", courseId: null },
      { weekday: 3, start: "08:00", end: "09:00", kind: "lecture", title: "Other day", courseId: null },
    ] as never;
    expect(busyLines(["10:15-11:45 Physik für EEE VU, Gruppe 5"], timetable, 2)).toEqual(["10:15-11:45 Physik für EEE VU, Gruppe 5", "16:00-17:30 Math UE"]);
  });

  it("reads the calendar again when the last read has no timed events (made before this update)", () => {
    const now = Date.now();
    expect(aheadIsStale({ readAt: now, from: "2026-11-24", days: 14, busy: {} }, "2026-11-24", now)).toBe(true);
    expect(aheadIsStale({ readAt: now, from: "2026-11-24", days: 14, busy: {}, events: {} }, "2026-11-24", now)).toBe(false);
  });

  it("keeps the entry's note short", () => {
    const [e] = studyEntries({ day: "2026-11-24", times: [{ start: "13:00", end: "14:00" }], courseName: "Math", reason: "Sheet 7 is due tomorrow 11:00. Beispiel 7.1 and 7.2 need a lot.", timeZone: "Europe/Vienna", url: null });
    expect(e.description).toBe("[StudyDesk] Sheet 7 is due tomorrow 11:00.");
  });
});

describe("today's quest and its entries", () => {
  it("picks times for a quest the page wrote or a replacement, but not for a finished one", () => {
    expect(planStep(null, rec("q1"), "2026-11-24", "10:00")).toBe("pick");
    expect(planStep(want([{ start: "16:00", end: "17:00" }], "2026-11-24", "old"), rec("q2"), "2026-11-24", "10:00")).toBe("pick");
    expect(planStep(null, rec("q1", ["p1", "p2"]), "2026-11-24", "10:00")).toBeNull();
    expect(planStep(want([{ start: "16:00", end: "17:00" }]), rec("q1"), "2026-11-24", "10:00")).toBeNull();
  });

  it("never replaces tomorrow's plan from the nightly run", () => {
    expect(planStep(want([{ start: "09:00", end: "10:00" }], "2026-11-25", "qt"), rec("q1"), "2026-11-24", "22:30")).toBeNull();
  });

  it("drops the entries still ahead once the quest is finished early", () => {
    const w = want([{ start: "09:00", end: "10:00" }, { start: "16:00", end: "17:00" }]);
    const trimmed = planStep(w, rec("q1", ["p1", "p2"]), "2026-11-24", "11:00");
    expect(trimmed !== "pick" && trimmed?.entries.map((e) => e.start)).toEqual(["09:00"]);
    expect(planStep(trimmed as never, rec("q1", ["p1", "p2"]), "2026-11-24", "11:30")).toBeNull();
  });
});

describe("the calendar task notice", () => {
  const setup = calendarTaskSetup("https://claude.ai/artifact/x", "Europe/Vienna", "22:00");
  const base = { planned: true, taskSeenAt: null, setup, sent: [], today: "2026-11-24" };

  it("runs the task 90 minutes after the nightly run, with the student's calendar connector", () => {
    expect(setup).toContain("every day at 23:30 in Europe/Vienna");
    expect(setup).toContain("Google Calendar connector");
  });

  it("speaks once the first plan exists, and only once", () => {
    expect(calendarTaskNotice({ ...base, planned: false })).toBeNull();
    const n = calendarTaskNotice(base)!;
    expect(n.text).toContain(setup);
    expect(calendarTaskNotice({ ...base, sent: [{ key: n.key } as never] })).toBeNull();
  });

  it("stays quiet while the task runs, and speaks again when it has gone quiet", () => {
    const ran = (day: string) => new Date(`${day}T23:30`).getTime();
    expect(calendarTaskNotice({ ...base, taskSeenAt: ran("2026-11-23") })).toBeNull();
    const again = calendarTaskNotice({ ...base, taskSeenAt: ran("2026-11-20"), sent: [{ key: "calendar-task" } as never] })!;
    expect(again.key).toBe("calendar-task:2026-11-20");
    expect(again.text).toContain("hasn't run since 2026-11-20");
  });
});
