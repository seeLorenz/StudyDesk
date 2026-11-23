import { describe, expect, it } from "vitest";
import { capabilityBlock, WISH_URL } from "../src/agents/capabilities";
import { applyOps, undoChange, type Desk } from "../src/orchestrator/changes";
import { applySheetUpdate } from "../src/onboarding/agent";
import type { Profile, SemesterDraft } from "../src/onboarding/types";

const profile: Profile = { level: "university", school: "TU", country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 }, program: "", year: "", updatedAt: 0 };
const draft = { id: "s", name: "WS", startDate: "2026-10-01", endDate: "2027-02-28", status: "active", setupStep: "done", courseIndex: 0, courses: [], timetable: [], studyGoal: [0, 0, 0, 0, 0, 0, 0], uploads: [], facts: [], results: {}, createdAt: 0, updatedAt: 0 } as unknown as SemesterDraft;

describe("capabilities", () => {
  it("tells each chat what it can do, what only the other can, and what nobody can", () => {
    const panel = capabilityBlock("panel");
    expect(panel).toContain("- start a job");
    expect(panel).toContain("read a kept file (in the Organize page)");
    expect(panel).toContain("change how the app looks");
    expect(capabilityBlock("organize")).toContain("start a job that reads new material or a course again (in the StudyDesk chat (Ctrl J))");
  });

  it("saves a wish from either chat on the profile", () => {
    const desk: Desk = { draft, profile };
    const r = applyOps(desk, [{ op: "add_wish", text: "make coming calendar entries red" }], { studentWords: "", now: 1 });
    expect(r.desk.profile.wishes).toEqual([{ text: "make coming calendar entries red", at: 1 }]);
    // The card's button opens a pre-filled issue with the wish and nothing about the student.
    const link = /\((https:[^)]+)\)/.exec(r.change!.lines[0])![1];
    expect(link.startsWith(WISH_URL)).toBe(true);
    expect(decodeURIComponent(link)).toContain("make coming calendar entries red");
    expect(decodeURIComponent(link)).not.toContain("TU");
    expect(undoChange(r.desk, r.change!).ok && profile.wishes).toBeUndefined();
    expect(applySheetUpdate(draft, profile, { wish: "dark mode" }, 2).profile.wishes).toEqual([{ text: "dark mode", at: 2 }]);
  });
});
