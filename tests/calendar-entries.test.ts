import { describe, expect, it, vi } from "vitest";
import { applyWant, calendarTaskSetup, calendarWant, parseTimes, type CalendarWritten } from "../src/quests/times";
import { toEvents } from "../src/platform/calendar";
import { calendarTaskNotice } from "../src/orchestrator/signals";

const want = (times: { start: string; end: string }[], day = "2026-11-24") => calendarWant({ day, times, courseName: "Analysis", reason: "Exam on Friday.", timeZone: "Europe/Vienna", url: null });

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
    expect(next).toEqual({ key: w.key, day: w.day, ids: ["new1"], taskSeenAt: 5 });
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
    expect(next).toMatchObject({ key: "", ids: ["a"] });
  });

  it("never treats StudyDesk's own entries as commitments", () => {
    const raw = [
      { summary: "Study · Analysis", description: "[StudyDesk] Exam on Friday.", start: { dateTime: "2026-11-24T16:00:00+01:00" }, end: { dateTime: "2026-11-24T17:00:00+01:00" } },
      { summary: "Lecture", start: { dateTime: "2026-11-24T08:00:00+01:00" }, end: { dateTime: "2026-11-24T10:00:00+01:00" } },
    ];
    expect(toEvents(raw).map((e) => e.title)).toEqual(["Lecture"]);
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
