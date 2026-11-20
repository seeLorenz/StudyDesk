import { describe, expect, it } from "vitest";
import { byteLength, clipBytes, jobInstructions, jobProgress, QUIET_TIMEOUT_MS, START_TIMEOUT_MS } from "../src/platform/handoff";

describe("hand-off jobs", () => {
  it("tells the session where to report, and finds the StudyDesk when its address isn't known", () => {
    const t = jobInstructions({ jobId: "abc", title: "Set up the course", body: "=== SUMMARY ===" });
    expect(t).toContain('doc_id "job-abc"');
    expect(t).toContain('collection "data/users/me"');
    expect(t).toContain('Artifact action "list"');
    expect(t.endsWith("=== SUMMARY ===")).toBe(true);
    const known = jobInstructions({ jobId: "abc", title: "x", body: "y", artifactUrl: "https://claude.ai/artifact/X" });
    expect(known).toContain("Your StudyDesk is https://claude.ai/artifact/X.");
    expect(known).not.toContain('action "list"');
  });
  it("reads a report: waiting, working, done, failed", () => {
    const job = { startedAt: 0, changedAt: 0 };
    expect(jobProgress({ status: "queued" }, job, 1000).status).toBe("waiting");
    expect(jobProgress({ status: "queued" }, job, START_TIMEOUT_MS + 1).status).toBe("failed");
    const w = jobProgress({ status: "working", log: ["Started", "Searching"], artifactUrl: "https://claude.ai/artifact/X" }, job, 1000);
    expect(w).toMatchObject({ status: "working", log: ["Started", "Searching"], artifactUrl: "https://claude.ai/artifact/X" });
    expect(jobProgress({ status: "working" }, job, QUIET_TIMEOUT_MS + 1).status).toBe("failed");
    expect(jobProgress({ status: "done", answer: "=== SUMMARY ===" }, job, 1000)).toMatchObject({ status: "done", answer: "=== SUMMARY ===" });
    expect(jobProgress({ status: "done" }, job, 1000).status).toBe("failed");
    expect(jobProgress({ status: "failed", error: "No access" }, job, 1000).error).toContain("No access");
    expect(jobProgress(null, job, 1000).status).toBe("failed");
  });
  it("only trusts claude.ai addresses from a report", () => {
    expect(jobProgress({ status: "working", artifactUrl: "https://evil.example/x" }, { startedAt: 0, changedAt: 0 }, 1).artifactUrl).toBeNull();
  });
  it("keeps job text under the byte limit, counting umlauts as two bytes", () => {
    const t = clipBytes("ä".repeat(1000), 500);
    expect(byteLength(t)).toBeLessThanOrEqual(500);
    expect(t).toContain("cut");
  });
});
