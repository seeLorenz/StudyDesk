import { describe, expect, it } from "vitest";
import { FRESH_START_REMOVES, originalsIn } from "../src/platform/backup";

describe("backup", () => {
  it("finds original files across the setup, semester and archive, once each, with course names", () => {
    const up = (assetId: string | null, fileName: string, courseId: string | null) => ({ assetId, fileName, courseId });
    const found = originalsIn({
      setup: { courses: [{ id: "c1", name: "Analysis" }], uploads: [up("a1", "skript.pdf", "c1"), up(null, "pasted.txt", "c1")] },
      semester: { courses: [{ id: "c1", name: "Analysis" }], uploads: [up("a1", "skript.pdf", "c1")] },
      archivedSemesters: { old: { courses: [], uploads: [up("a2", "old.pdf", null)] } },
    });
    expect(found).toEqual([
      { assetId: "a1", fileName: "skript.pdf", courseName: "Analysis" },
      { assetId: "a2", fileName: "old.pdf", courseName: null },
    ]);
  });
  it("never removes mastery or stats in a fresh start", () => {
    expect(FRESH_START_REMOVES.some((k) => k.startsWith("mastery"))).toBe(false);
  });
});
