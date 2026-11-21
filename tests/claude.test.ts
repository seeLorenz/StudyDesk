import { afterAll, describe, expect, it, vi } from "vitest";

// A stand-in for the artifact runtime's Claude: busy for the first `busy` calls.
let calls = 0;
let busy = 0;
let release: (() => void) | null = null;
const sample = vi.fn(async () => {
  calls++;
  if (calls <= busy) throw { code: "rate_limited", message: "busy" };
  if (release === null) return { text: "ok", truncated: false, modelApplied: "x", modelTierApplied: "x" };
  await new Promise<void>((r) => (release = r));
  return { text: "slow", truncated: false, modelApplied: "x", modelTierApplied: "x" };
});
(globalThis as { claude?: unknown }).claude = Object.freeze({ use: async (n: string) => (n === "sample" ? sample : null) });
const { askClaude } = await import("../src/platform/claude");
afterAll(() => {
  delete (globalThis as { claude?: unknown }).claude;
});

describe("asking Claude when it's busy", () => {
  it("asks again a little later instead of failing at once", async () => {
    vi.useFakeTimers();
    calls = 0;
    busy = 1;
    const p = askClaude([{ role: "user", content: "hi" }]);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("skips background work while the student's question runs", async () => {
    calls = 0;
    busy = 0;
    release = () => {};
    const fg = askClaude([{ role: "user", content: "question" }]);
    await Promise.resolve();
    await expect(askClaude([{ role: "user", content: "check-in" }], { background: true })).rejects.toMatchObject({ code: "skipped" });
    release!();
    await expect(fg).resolves.toBe("slow");
    release = null;
    await expect(askClaude([{ role: "user", content: "check-in" }], { background: true })).resolves.toBe("ok");
  });
});
