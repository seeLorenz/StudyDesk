// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HEIC_FAILED, isHeic, jpegName } from "../src/lib/heic";
import { classify } from "../src/lib/intake";

describe("iPhone photos (HEIC)", () => {
  it("are recognised by name or type", () => {
    expect(isHeic("IMG_5334.HEIC")).toBe(true);
    expect(isHeic("photo.heif")).toBe(true);
    expect(isHeic("pasted", "image/heic")).toBe(true);
    expect(isHeic("pasted", "image/heif-sequence")).toBe(true);
    expect(isHeic("scan.jpg", "image/jpeg")).toBe(false);
    expect(isHeic("heic-notes.pdf")).toBe(false);
  });

  it("count as images, also inside zips", () => {
    expect(classify("Uebung/IMG_5334.HEIC")).toBe("image");
    expect(classify("x", "image/heic")).toBe("image");
  });

  it("are renamed to .jpg once converted", () => {
    expect(jpegName("IMG_5334.HEIC")).toBe("IMG_5334.jpg");
    expect(jpegName("a.b.heif")).toBe("a.b.jpg");
    expect(jpegName("")).toBe("photo.jpg");
  });

  it("explain what to do when they can't be opened", () => {
    expect(HEIC_FAILED).toMatch(/Most Compatible/);
  });
});
