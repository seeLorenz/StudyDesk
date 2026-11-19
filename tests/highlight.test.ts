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

import { placeHost, readableText } from "../src/lib/highlight";

describe("notes inside the message", () => {
  it("ignores note numbers and open notes when anchoring", () => {
    const el = body("<p>alpha beta gamma</p><p>delta beta</p>");
    const first = { quote: "alpha", label: "alpha", nth: 0 };
    drawAnchor(el, "a", first, 1, true);
    const host = document.createElement("div");
    host.className = "note-host";
    host.textContent = "beta beta beta";
    placeHost(el, "a", host);
    expect(el.children[1]).toBe(host); // right under the first paragraph
    // Select "beta" in the second paragraph: it is still the 2nd "beta" of the message.
    const t = el.querySelectorAll("p")[1].firstChild!;
    const r = document.createRange();
    r.setStart(t, 6);
    r.setEnd(t, 10);
    const a = anchorFromRange(el, r)!;
    expect(a).toMatchObject({ quote: "beta", nth: 1 });
  });

  it("puts a note inside its list item, before nested lists", () => {
    const el = body("<ul><li>one <ul><li>sub</li></ul></li></ul>");
    drawAnchor(el, "n", { quote: "one", label: "one", nth: 0 }, 1, true);
    const host = document.createElement("div");
    host.className = "note-host";
    placeHost(el, "n", host);
    expect(host.parentElement!.tagName).toBe("LI");
    expect(host.nextElementSibling!.tagName).toBe("UL");
  });

  it("reads math as TeX", () => {
    const el = body('<p>use <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^3</annotation></semantics></math></span><span class="katex-html">x3</span></span> here</p>');
    const r = document.createRange();
    r.selectNodeContents(el.querySelector("p")!);
    expect(readableText(r)).toBe("use $x^3$ here");
  });
});
