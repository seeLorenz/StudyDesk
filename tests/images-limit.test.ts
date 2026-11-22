import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the artifact runtime's Claude that allows `maxCount` images
// per call and rejects any call carrying a "bad" image, as claude.ai does.
let maxCount = 2;
const seen: Array<{ input: unknown; images: Blob[] }> = [];
const sample = Object.assign(
  vi.fn(async (input: unknown, opts: { images?: Blob[] }) => {
    const images = opts.images ?? [];
    seen.push({ input, images });
    if (images.length > maxCount || images.some((b) => b.type === "image/bad")) throw { code: "image_rejected", message: "rejected" };
    return { text: "ok", truncated: false, modelApplied: "x", modelTierApplied: "x" };
  }),
  { limits: async () => ({ maxPromptBytes: 262144, images: { maxCount, maxInputBytes: 20_000_000, mediaTypes: ["image/jpeg", "image/png", "image/bad"] } }) },
);
(globalThis as { claude?: unknown }).claude = Object.freeze({ use: async (n: string) => (n === "sample" ? sample : null) });
const { askClaude, fitImages, maxImages } = await import("../src/platform/claude");
afterAll(() => {
  delete (globalThis as { claude?: unknown }).claude;
});

const jpg = (name: string) => new Blob([name], { type: "image/jpeg" });
const lastTurn = (input: unknown) => {
  const turns = input as Array<{ content: string }>;
  return turns[turns.length - 1].content;
};

beforeEach(() => {
  seen.length = 0;
  maxCount = 2;
});

describe("images within the view's limit", () => {
  it("reads the limit from the view", async () => {
    maxCount = 3;
    expect(await maxImages()).toBe(3);
  });

  it("keeps this turn's images first, then earlier ones, and skips types or sizes the view refuses", () => {
    const limits = { maxCount: 3, maxInputBytes: 5, mediaTypes: ["image/jpeg"] };
    const now = [jpg("a"), new Blob(["b"], { type: "image/heic" }), jpg("c")];
    const earlier = [jpg("d"), jpg("toolarge"), jpg("e")];
    const fit = fitImages(now, earlier, limits);
    expect(fit.images).toEqual([now[0], now[2], earlier[0]]);
    expect(fit.leftOutNow).toBe(1);
    expect(fit.leftOutEarlier).toBe(2);
    expect(fitImages([jpg("a")], [], null)).toMatchObject({ images: [], leftOutNow: 1 });
  });

  it("never sends more images than allowed, and tells Claude which were left out", async () => {
    const answer = await askClaude([{ role: "user", content: "hi" }], { images: [jpg("1"), jpg("2"), jpg("3")], earlierImages: [jpg("old")] });
    expect(answer).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0].images).toHaveLength(2);
    expect(lastTurn(seen[0].input)).toContain("the last 1 is missing");
    expect(lastTurn(seen[0].input)).toContain("1 of the earlier images couldn't be attached");
  });

  it("a message without attachments still goes through when an earlier image is refused", async () => {
    const answer = await askClaude([{ role: "user", content: "just text" }], { images: [], earlierImages: [new Blob(["x"], { type: "image/bad" })] });
    expect(answer).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[1].images).toHaveLength(0);
    expect(lastTurn(seen[1].input)).toContain("earlier images couldn't be attached");
  });

  it("an image the student just sent that Claude refuses still shows the error", async () => {
    await expect(askClaude([{ role: "user", content: "look" }], { images: [new Blob(["x"], { type: "image/bad" })] })).rejects.toMatchObject({ code: "image_rejected" });
    expect(seen).toHaveLength(1);
  });

  it("asks without images exactly as before", async () => {
    await askClaude([{ role: "user", content: "plain" }]);
    expect(seen[0].images).toHaveLength(0);
    expect(lastTurn(seen[0].input)).toBe("plain");
  });

  it("with strictImages, fails instead of leaving any of this turn's images out", async () => {
    await expect(askClaude([{ role: "user", content: "grade" }], { images: [jpg("1"), jpg("2"), jpg("3")], strictImages: true })).rejects.toMatchObject({ code: "image_rejected" });
    expect(seen).toHaveLength(0);
  });
});
