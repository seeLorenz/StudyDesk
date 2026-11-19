import { describe, expect, it } from "vitest";
import { anchorFromRange, drawAnchor, findNth, occurrenceIndex } from "../src/lib/highlight";

function body(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("anchors", () => {
  it("counts occurrences before a position", () => {
    expect(occurrenceIndex("a b a b a", "a", 4)).toBe(1);
    expect(findNth("a b a b a", "a", 2)).toBe(8);
    expect(findNth("abc", "z", 0)).toBe(-1);
  });

  it("anchors the second occurrence and draws it across elements", () => {
    const el = body("<p>The cell divides. Then the <strong>cell</strong> divides again.</p>");
    const strong = el.querySelector("strong")!.firstChild!;
    const after = el.querySelector("strong")!.nextSibling!;
    const r = document.createRange();
    r.setStart(strong, 0);
    r.setEnd(after, 8); // "cell divides"
    const a = anchorFromRange(el, r, "cell divides")!;
    expect(a.quote).toBe("cell divides");
    expect(a.nth).toBe(1);

    // Re-render from scratch, as happens on reload.
    el.innerHTML = "<p>The cell divides. Then the <strong>cell</strong> divides again.</p>";
    expect(drawAnchor(el, "n1", a, 3, true)).toBe(true);
    const marks = el.querySelectorAll('mark[data-note="n1"]');
    expect(marks.length).toBe(2);
    expect(Array.from(marks).map((m) => m.textContent).join("")).toBe("cell divides");
    expect(el.querySelector("strong mark")).not.toBeNull();
    expect(el.querySelector("sup.sd-ref")!.textContent).toBe("3");
    expect(el.textContent).toBe("The cell divides. Then the cell3 divides again.".replace("cell3 divides", "cell divides3"));
  });

  it("trims whitespace and reports missing passages", () => {
    const el = body("<p>  hello world  </p>");
    const t = el.querySelector("p")!.firstChild!;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 9);
    const a = anchorFromRange(el, r, "  hello w")!;
    expect(a.quote).toBe("hello w");
    el.innerHTML = "<p>something else</p>";
    expect(drawAnchor(el, "n2", a, 1, false)).toBe(false);
  });
});
