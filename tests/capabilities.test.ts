import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CAPABILITIES, capabilityBlock, WISH_URL, type Chat } from "../src/agents/capabilities";
import * as orch from "../src/orchestrator/agent";
import { READ_FILE_TOOL } from "../src/lib/keep";
import { applyOps, undoChange, type Desk } from "../src/orchestrator/changes";
import { applySheetUpdate } from "../src/onboarding/agent";
import type { Profile, SemesterDraft } from "../src/onboarding/types";

const profile: Profile = { level: "university", school: "TU", country: "Austria", gradeScale: { name: "Austrian 1–5", best: 1, worst: 5 }, program: "", year: "", updatedAt: 0 };
const draft = { id: "s", name: "WS", startDate: "2026-10-01", endDate: "2027-02-28", status: "active", setupStep: "done", courseIndex: 0, courses: [], timetable: [], studyGoal: [0, 0, 0, 0, 0, 0, 0], uploads: [], facts: [], results: {}, createdAt: 0, updatedAt: 0 } as unknown as SemesterDraft;

describe("capabilities", () => {
  it("tells each chat what it can do, what only the other can, and what nobody can", () => {
    const panel = capabilityBlock("panel");
    expect(panel).toContain("- start a job");
    expect(panel).toContain("read the courses that changed again (in the semester setup page)");
    expect(panel).toContain("change how the app looks");
    expect(capabilityBlock("setup")).toContain("start a job that reads new material or a course again (in the StudyDesk chat (Ctrl J, and on the Organize page))");
  });

  it("saves a wish from either chat on the profile", () => {
    const desk: Desk = { draft, profile };
    const wish = { text: "make coming calendar entries red", title: "Color upcoming calendar entries", asked: "Upcoming entries should stand out.", missing: "Entries use one color.", fix: "Set colorId on entries in the future." };
    const r = applyOps(desk, [{ op: "add_wish", ...wish }], { studentWords: "", now: 1 });
    expect(r.desk.profile.wishes).toEqual([{ text: "make coming calendar entries red", at: 1 }]);
    // The card's button opens a pre-filled issue Claude wrote: title, why, what's missing, a fix; never the raw words or the student.
    const link = /\((https:[^)]+)\)/.exec(r.change!.lines[0])![1];
    expect(link.startsWith(WISH_URL)).toBe(true);
    const issue = decodeURIComponent(link);
    for (const s of ["title=Color upcoming calendar entries", "### What the student asked\nUpcoming", "### What StudyDesk can't do yet\nEntries", "### Proposed fix\nSet colorId"]) expect(issue).toContain(s);
    expect(issue).not.toContain("make coming");
    expect(issue).not.toContain("TU");
    expect(undoChange(r.desk, r.change!).ok && profile.wishes).toBeUndefined();
    expect(applySheetUpdate(draft, profile, { wish: { ...wish, text: "dark mode" } }, 2).profile.wishes).toEqual([{ text: "dark mode", at: 2 }]);
  });
});

describe("each chat gets exactly the tools the list names", () => {
  // Read the tools each chat really builds from its source, so a new tool can't skip the list.
  const consts: Record<string, string> = { ...Object.fromEntries(Object.entries(orch).filter(([k]) => k.endsWith("_TOOL")).map(([k, v]) => [k, (v as { name: string }).name])), READ_FILE_TOOL: READ_FILE_TOOL.name };
  const built = (file: string, chat: Chat) => {
    const src = readFileSync(file, "utf8");
    const block = src.slice(src.indexOf(`toolsFor("${chat}", [`), src.indexOf("]),", src.indexOf(`toolsFor("${chat}", [`)));
    return [...block.matchAll(/^\s{12,14}(?:\{ )?(?:\.\.\.(\w+_TOOL)|name: "(\w+)")/gm)].map((m) => (m[1] ? consts[m[1]] : m[2]));
  };
  it.each([
    ["src/orchestrator/OrchestratorPanel.tsx", "panel"],
    ["src/onboarding/OnboardingPage.tsx", "setup"],
  ] as const)("%s", (file, chat) => {
    const names = built(file, chat);
    expect(names.length).toBeGreaterThan(2);
    expect(new Set(names)).toEqual(new Set(CAPABILITIES.flatMap((c) => (c.in[chat] ? [c.in[chat]] : []))));
  });
});
