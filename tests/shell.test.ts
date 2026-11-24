import { describe, expect, it } from "vitest";
import { countdown, upcoming } from "../src/shell/upcoming";

const sem = {
  courses: [
    { id: "c1", name: "Calculus 1", short: "Calc", teachingLanguage: "English", topics: [] },
    { id: "c2", name: "Linear Algebra", short: "LA", teachingLanguage: "English", topics: [] },
  ],
  assignments: [
    { id: "s4", courseId: "c1", title: "Sheet 4", dueAt: "2026-11-21T11:00", tasks: [] },
    { id: "s3", courseId: "c1", title: "Sheet 3", dueAt: "2026-11-14T11:00", tasks: [] },
    { id: "s9", courseId: "c2", title: "Far away", dueAt: "2027-03-01T08:00", tasks: [] },
  ],
  keyDates: [
    { courseId: "c2", date: "2026-11-21", kind: "quiz" as const, title: "Quiz 2", skillIds: [] },
    { courseId: "c1", date: "2026-12-18", kind: "exam" as const, title: "Midterm", skillIds: [] },
  ],
};

describe("coming up", () => {
  it("lists hand-ins and key dates in the window, soonest first, timed items before untimed ones on a day", () => {
    const list = upcoming(sem, "2026-11-20");
    expect(list.map((i) => i.title)).toEqual(["Sheet 4", "Quiz 2", "Midterm"]);
    expect(list[0]).toMatchObject({ kind: "homework", courseName: "Calculus 1", date: "2026-11-21", time: "11:00", inDays: 1 });
    expect(list[2]).toMatchObject({ kind: "exam", inDays: 28 });
  });
  it("can start earlier, with past items counted back", () => {
    const list = upcoming(sem, "2026-11-20", 42, "2026-11-01");
    expect(list[0]).toMatchObject({ title: "Sheet 3", inDays: -6 });
  });
  it("words the countdown", () => {
    expect([0, 1, 5].map(countdown)).toEqual(["today", "tomorrow", "in 5 days"]);
  });
});
