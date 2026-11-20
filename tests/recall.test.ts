import { afterEach, describe, expect, it } from "vitest";
import { earlierImageIds, readKeptFile, recallImages } from "../src/lib/keep";
import { dedupe, pickCalendars, readCalendar } from "../src/platform/calendar";
import type { Upload } from "../src/onboarding/types";

const up = (id: string, fileName: string, type: Upload["type"], extra: Partial<Upload> = {}): Upload => ({ id, courseId: null, fileName, type, studentNote: "", addedAt: 0, cataloguedAt: null, assetId: null, pages: null, state: "readable", ...extra });
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("earlier images in later turns", () => {
  const uploads = [up("up_a", "image.png", "image"), up("up_b", "timetable.png", "image"), up("up_c", "notes.pdf", "pdf")];

  it("finds earlier images newest first, by id or (older messages) by name", () => {
    const msgs = [
      { role: "user", files: ["image.png"] },
      { role: "assistant" },
      { role: "user", files: ["timetable.png", "notes.pdf"], uploadIds: ["up_b", "up_c"] },
    ];
    expect(earlierImageIds(msgs, uploads, new Set())).toEqual(["up_b", "up_a"]);
    expect(earlierImageIds(msgs, uploads, new Set(["up_b"]))).toEqual(["up_a"]);
    expect(earlierImageIds(msgs, uploads, new Set(), 1)).toEqual(["up_b"]);
  });

  it("loads them, numbers them after this turn's images, and caps the total", async () => {
    const msgs = [{ role: "user", uploadIds: ["up_a"] }, { role: "user", uploadIds: ["up_b"] }];
    const load = async () => ({ image: PNG });
    const r = await recallImages(msgs, uploads, 1, new Set(), load, 5);
    expect(r.images).toHaveLength(2);
    expect(r.images[0].type).toBe("image/png");
    expect(r.note).toContain('Image 2: file up_b "timetable.png"');
    expect(r.note).toContain('Image 3: file up_a "image.png"');
    expect((await recallImages(msgs, uploads, 5, new Set(), load, 5)).images).toHaveLength(0);
  });

  it("read_file opens a kept file's outline or the part asked for", async () => {
    const text = "--- page 1 ---\nIntro\n--- page 2 ---\nExam on 12 Feb\n--- page 3 ---\nEnd";
    const load = async () => ({ text, outline: "p.1 Intro; p.2 Exam" });
    expect(await readKeptFile({ file: "up_c" }, uploads, load)).toBe("p.1 Intro; p.2 Exam");
    expect(await readKeptFile({ file: "up_c", part: "2" }, uploads, load)).toContain("Exam on 12 Feb");
    expect(await readKeptFile({ file: "up_x" }, uploads, load)).toContain("No file");
  });
});

describe("calendar reads every calendar", () => {
  afterEach(() => {
    delete (globalThis as { claude?: unknown }).claude;
  });

  it("skips holiday, birthday and week-number calendars", () => {
    expect(pickCalendars([{ id: "me@gmail.com" }, { id: "abc@import.calendar.google.com" }, { id: "de.austrian#holiday@group.v.calendar.google.com" }, { id: "addressbook#contacts@group.v.calendar.google.com" }])).toEqual(["me@gmail.com", "abc@import.calendar.google.com"]);
    expect(pickCalendars([])).toEqual(["primary"]);
  });

  it("drops the same event in two calendars", () => {
    const e = { title: "Analysis VO", date: "2026-11-23", weekday: 1, start: "10:00", end: "11:30", recurring: true, location: "" };
    expect(dedupe([e, { ...e }, { ...e, date: "2026-11-30" }])).toHaveLength(2);
  });

  function mockCalendar(byCal: Record<string, unknown[]>, listFails = false) {
    const calls: Array<Record<string, unknown>> = [];
    const mcp = {
      callTool: async (_s: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, ...args });
        if (tool === "list_calendars") {
          if (listFails) throw { code: "not_granted" };
          return { payload: { calendars: Object.keys(byCal).map((id) => ({ id })) } };
        }
        const id = (args.calendarId as string) ?? Object.keys(byCal)[0];
        if (id === "broken@import.calendar.google.com") throw { code: "unavailable" };
        return { payload: { events: byCal[id] ?? [] } };
      },
    };
    (globalThis as { claude?: unknown }).claude = { use: async () => mcp };
    return calls;
  }

  const lecture = (day: string) => ({ summary: "Analysis VO", start: { dateTime: `${day}T10:00:00` }, end: { dateTime: `${day}T11:30:00` }, recurringEventId: "r1" });

  it("reads a subscribed timetable next to the primary calendar, past a broken one", async () => {
    const calls = mockCalendar({
      "me@gmail.com": [{ summary: "Gym", start: { dateTime: "2026-11-23T18:00:00" }, end: { dateTime: "2026-11-23T19:00:00" } }],
      "tug@import.calendar.google.com": [lecture("2026-11-23"), lecture("2026-11-30")],
      "broken@import.calendar.google.com": [],
    });
    const events = await readCalendar("2026-11-20", 14);
    expect(events.map((e) => e.title)).toEqual(["Analysis VO", "Gym", "Analysis VO"]);
    expect(calls.filter((c) => c.tool === "list_events").map((c) => c.calendarId)).toContain("tug@import.calendar.google.com");
  });

  it("falls back to the primary calendar when the list can't be read", async () => {
    const calls = mockCalendar({ "me@gmail.com": [lecture("2026-11-23")] }, true);
    expect(await readCalendar("2026-11-20", 14)).toHaveLength(1);
    expect(calls.filter((c) => c.tool === "list_events")[0].calendarId).toBeUndefined();
  });
});
