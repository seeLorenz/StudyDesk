import { describe, expect, it } from "vitest";
import { byteLength, clipBytes, summarizeEvents } from "../src/platform/handoff";

const assistant = (content: unknown[]) => ({ id: "e", data: { assistant: { message: { content } } } });

describe("hand-off events", () => {
  it("turns tool calls and short notes into log lines, and finds the answer", () => {
    const { log, answer } = summarizeEvents([
      assistant([{ type: "text", text: "Looking up the course first." }]),
      assistant([{ type: "tool_use", name: "WebSearch", input: { query: "TU Graz Mathematik A EEE" } }]),
      assistant([{ type: "tool_use", name: "WebFetch", input: { url: "https://www.tugraz.at/x" } }]),
      assistant([{ type: "tool_use", name: "TodoWrite", input: {} }]),
      assistant([{ type: "text", text: "=== SUMMARY ===\nDone.\n=== SKILLS ===\ns1 | t1 | A" }]),
    ]);
    expect(log).toEqual(["Looking up the course first.", "Searching the web: TU Graz Mathematik A EEE", "Reading tugraz.at"]);
    expect(answer).toContain("=== SUMMARY ===");
  });
  it("prefers the result event's text", () => {
    expect(summarizeEvents([assistant([{ type: "text", text: "x" }]), { data: { result: { result: "final" } } }]).answer).toBe("final");
  });
  it("keeps job text under the byte limit, counting umlauts as two bytes", () => {
    const t = clipBytes("ä".repeat(1000), 500);
    expect(byteLength(t)).toBeLessThanOrEqual(500);
    expect(t).toContain("cut");
  });
});
