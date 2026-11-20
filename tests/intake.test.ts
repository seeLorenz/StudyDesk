// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { buildOutline, classify, expandDrop, selectPart, walkZip, zipEntries } from "../src/lib/intake";
import { officeText, odfText } from "../src/lib/office";
import { courseFileList, describeCounts, describeVideo, filesOf, keepDrop, keepFraction, originalType, unsortedList, zipInventory, type KeepProgress } from "../src/lib/keep";
import { fileTools, inventoryLine, setupTurns, type FileForSetup, type SetupInput } from "../src/onboarding/setup";
import { startJob } from "../src/orchestrator/jobs";
import { jobInstructions } from "../src/platform/handoff";
import type { DraftCourse, Profile, SemesterDraft, Upload } from "../src/onboarding/types";

const up = (p: Partial<Upload> & { id: string }): Upload => ({ courseId: null, fileName: p.id, type: "pdf", studentNote: "", addedAt: 0, cataloguedAt: null, assetId: null, pages: null, state: "readable", ...p });

describe("classify", () => {
  it("sorts files by what StudyDesk can do with them", () => {
    expect(classify("Mathe.zip")).toBe("zip");
    expect(classify("Skript.PDF")).toBe("pdf");
    expect(classify("VO 04.pptx")).toBe("office");
    expect(classify("scan.jpg")).toBe("image");
    expect(classify("VO 04 Integrale.mp4")).toBe("video");
    expect(classify("aufgabe.m")).toBe("text");
    expect(classify("__MACOSX/x/._a.pdf")).toBe("junk");
    expect(classify("folder/.DS_Store")).toBe("junk");
    expect(classify("model.slx")).toBe("other");
  });
});

describe("zips", () => {
  const inner = zipSync({ "Blatt1.pdf": strToU8("%PDF inner") });
  const zip = zipSync({
    "Mathematik A/Organisatorisches/Syllabus.pdf": strToU8("%PDF syllabus"),
    "Mathematik A/Übungen/Blatt 3.txt": strToU8("Aufgabe 1"),
    "Mathematik A/VO/VO 01.mp4": new Uint8Array(5000),
    "Mathematik A/.DS_Store": strToU8("x"),
    "__MACOSX/Mathematik A/._Syllabus.pdf": strToU8("x"),
    "Mathematik A/alt.zip": inner,
  });

  it("lists a zip's files without unpacking them, and unpacks one on demand", async () => {
    const blob = new Blob([zip]);
    const entries = await zipEntries(blob);
    expect(entries.map((e) => e.name).sort()).toContain("Mathematik A/VO/VO 01.mp4");
    expect(entries.find((e) => e.name.endsWith(".mp4"))!.usize).toBe(5000);
    const found = { name: "M.zip", files: 0, skippedJunk: 0 };
    const walked = [];
    for await (const f of walkZip(blob, "M.zip", found)) walked.push(f);
    expect(walked.find((f) => f.cls === "video")!.read).toBeUndefined();
    const sheet = walked.find((f) => f.name === "Blatt 3.txt")!;
    expect(await (await sheet.read!()).text()).toBe("Aufgabe 1");
  });

  it("reads stored (uncompressed) entries and refuses a broken zip plainly", async () => {
    const stored = zipSync({ "a.txt": [strToU8("plain"), { level: 0 }] });
    const [e] = await zipEntries(new Blob([stored]));
    expect(e.method).toBe(0);
    await expect(zipEntries(new Blob([strToU8("not a zip at all")]))).rejects.toThrow("couldn't be opened");
  });

  it("opens zips with folder paths, nested zips, videos listed, junk left out", async () => {
    const r = await expandDrop([new File([zip], "Mathe.zip", { type: "application/zip" })]);
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual(["Mathematik A/Organisatorisches/Syllabus.pdf", "Mathematik A/VO/VO 01.mp4", "Mathematik A/alt/Blatt1.pdf", "Mathematik A/Übungen/Blatt 3.txt"]);
    const video = r.files.find((f) => f.cls === "video")!;
    expect(video.blob).toBeNull();
    expect(r.files.every((f) => f.zip === "Mathe.zip")).toBe(true);
    expect(r.zips[0].skippedJunk).toBe(2);
  });

  it("keeps loose files as they are", async () => {
    const r = await expandDrop([new File(["x"], "notes.md"), new File(["x"], "lecture.mov")]);
    expect(r.files.map((f) => [f.cls, f.blob ? "kept" : "listed"])).toEqual([
      ["text", "kept"],
      ["video", "listed"],
    ]);
  });
});

describe("office files", () => {
  it("reads Word paragraphs", () => {
    const docx = zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; more</w:t></w:r></w:p><w:p><w:r><w:tab/><w:t>Second</w:t></w:r></w:p></w:body></w:document>') });
    expect(officeText("a.docx", docx)).toBe("Hello world & more\nSecond");
  });

  it("marks PowerPoint slides in order", () => {
    const slide = (t: string) => strToU8(`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
    const pptx = zipSync({ "ppt/slides/slide10.xml": slide("Ten"), "ppt/slides/slide2.xml": slide("Two"), "ppt/slides/slide1.xml": slide("One") });
    expect(officeText("a.pptx", pptx)).toBe("--- slide 1 ---\nOne\n\n--- slide 2 ---\nTwo\n\n--- slide 3 ---\nTen");
  });

  it("reads Excel cells with shared strings", () => {
    const xlsx = zipSync({
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Name</t></si><si><t>Points</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="inlineStr"><is><t>Anna</t></is></c><c><v>17</v></c></row></sheetData></worksheet>'),
    });
    expect(officeText("a.xlsx", xlsx)).toBe("--- sheet 1 ---\nName | Points\nAnna | 17");
  });

  it("reads OpenDocument text with spans", () => {
    expect(odfText('<office:text><text:h text:outline-level="1">Kapitel 1</text:h><text:p>Eine <text:span>Zeile</text:span><text:s/>hier</text:p></office:text>')).toBe("Kapitel 1\nEine Zeile hier");
  });
});

describe("outlines and opening parts", () => {
  const pdf = "--- page 1 ---\nAnalysis 1\nOrganisatorisches\n\n--- page 2 ---\n1 Folgen\ntext\n\n--- page 3 ---\n\n\n--- page 4 ---\n2 Reihen";

  it("lists the first line of each page", () => {
    expect(buildOutline(pdf)).toBe("p. 1: Analysis 1\np. 2: 1 Folgen\np. 3: (no text)\np. 4: 2 Reihen");
  });

  it("uses bookmarks when the PDF has them", () => {
    expect(buildOutline(pdf, [{ title: "Folgen", page: 2, depth: 0 }, { title: "Grenzwerte", page: 3, depth: 1 }])).toBe("p. 2: Folgen\n  p. 3: Grenzwerte");
  });

  it("finds headings in text files, or samples lines", () => {
    expect(buildOutline("# Intro\ntext\n## Part A\nmore\n## Part B")).toBe("l. 1: # Intro\nl. 3: ## Part A\nl. 5: ## Part B");
    expect(buildOutline("alpha\nbeta\ngamma").split("\n")[0]).toBe("l. 1: alpha");
  });

  it("caps long outlines", () => {
    const long = Array.from({ length: 400 }, (_, i) => `--- page ${i + 1} ---\nA heading for page number ${i + 1}`).join("\n\n");
    const o = buildOutline(long);
    expect(o.length).toBeLessThan(4200);
    expect(o).toContain("400 lines in all");
  });

  it("opens pages, page lists and line ranges", () => {
    expect(selectPart(pdf, "2").text).toBe("--- page 2 ---\n1 Folgen\ntext");
    expect(selectPart(pdf, "p. 2,4").text).toContain("2 Reihen");
    expect(selectPart(pdf, "2,4").text).not.toContain("Analysis 1");
    expect(selectPart(pdf, "9").text).toBe("(No such pages in this file.)");
    expect(selectPart("a\nb\nc\nd", "l. 2-3").text).toBe("2: b\n3: c");
    expect(selectPart("x".repeat(100), "all", 10)).toEqual({ text: "xxxxxxxxxx\n[…cut: ask for fewer pages at a time]", cut: true });
  });
});

describe("keeping a drop", () => {
  const zipFiles = [up({ id: "u1", zipId: "zip_a", path: "M/Syllabus.pdf", pages: 3 }), up({ id: "u2", zipId: "zip_a", path: "M/VO/VO 01.mp4", type: "video", state: "listed" }), up({ id: "u3", zipId: "zip_a", path: "M/scan.pdf", state: "agent", pages: 5 })];
  const loose = up({ id: "u4", fileName: "sheet.png", type: "image" });
  const zips = [{ id: "zip_a", fileName: "Mathe.zip", courseId: null, addedAt: 0, files: 3 }];

  it("counts in plain words", () => {
    expect(describeCounts([...zipFiles, loose])).toBe("1 PDF, 1 image, 1 scan for the agent, 1 video");
  });

  it("lists a zip's folders and files for Claude", () => {
    const inv = zipInventory(zips[0], zipFiles);
    expect(inv).toContain('Zip zip_a "Mathe.zip": 3 files');
    expect(inv).toContain("Folders: M (2), M/VO (1)");
    expect(inv).toContain("- M/VO/VO 01.mp4 [name only]");
    expect(inv).toContain("- M/scan.pdf (5 p.) [scan]");
  });

  it("refers to a whole zip by its id", () => {
    const all = [...zipFiles, loose];
    expect(filesOf("zip_a", all)).toEqual(["u1", "u2", "u3"]);
    expect(filesOf("u4", all)).toEqual(["u4"]);
    expect(filesOf("nope", all)).toEqual([]);
    expect(unsortedList(all, zips)).toEqual([
      { uploadId: "u4", name: "sheet.png", type: "image", pages: null },
      { uploadId: "zip_a", name: "Mathe.zip", files: 3 },
    ]);
    expect(courseFileList(all.map((u) => ({ ...u, courseId: "c1" })), zips, "c1")).toEqual(["sheet.png", "Mathe.zip (3 files)"]);
  });

  it("keeps a video's description as what the student said about it", () => {
    const d = describeVideo({ uploads: zipFiles }, "u2", "Integrals by substitution, worked examples");
    expect(d.uploads.find((u) => u.id === "u2")!.studentNote).toBe("Integrals by substitution, worked examples");
  });

  it("stores originals only in types the file store takes", () => {
    expect(originalType("a.pdf", "pdf")).toBe("application/pdf");
    expect(originalType("a.py", "text")).toBe("text/plain");
    expect(originalType("a.pptx", "office")).toBeNull();
  });
});

describe("reading by reason", () => {
  const profile: Profile = { level: "university", school: "", country: "", gradeScale: { name: "AT", best: 1, worst: 4, passing: 4 } as never, program: "", year: "", updatedAt: 0 };
  const course = { id: "c1", name: "Analysis", short: "AN", credits: null, teachingLanguage: "", targetGrade: 2, setupStatus: "waiting" } as DraftCourse;
  const files: FileForSetup[] = [
    { upload: up({ id: "u1", path: "AN/Syllabus.pdf", pages: 2, assetId: "a1" }), text: "--- page 1 ---\nGrading: exam 100%\n\n--- page 2 ---\nTopics", image: null, outline: "p. 1: Grading: exam 100%\np. 2: Topics" },
    { upload: up({ id: "u2", path: "AN/VO 01.mp4", type: "video", state: "listed", studentNote: "limits" }), text: null, image: null },
    { upload: up({ id: "u3", path: "AN/scan.pdf", state: "agent", pages: 4 }), text: null, image: null },
  ];
  const input: SetupInput = { profile, draft: { name: "WS", startDate: "2026-10-01", endDate: "2027-02-28" }, course, facts: [], files, today: "2026-11-20", priorFundamentals: [] };

  it("describes each file in one inventory line", () => {
    expect(inventoryLine("F2", files[1])).toBe('- F2: AN/VO 01.mp4 (a video (Claude can\'t watch or listen)) the student says: "limits"');
    expect(inventoryLine("F3", files[2])).toBe("- F3: AN/scan.pdf (a scan, 4 pages, no text)");
  });

  it("sends an inventory, not the text, and says how to navigate", () => {
    const page = setupTurns(input, { navigate: "page" }).turns[0].content;
    expect(page).toContain("- F1: AN/Syllabus.pdf (pdf, 2 pages)");
    expect(page).toContain("p. 1: Grading: exam 100%");
    expect(page).not.toContain('"""');
    expect(page).toContain("outline(file)");
    expect(page).toContain("by reason");
    const cloud = setupTurns(input, { navigate: "cloud", web: true }).turns[0].content;
    expect(cloud).toContain("[upload u1, asset a1]");
    expect(cloud).toContain('collection "data/users/me/files/uploads"');
  });

  it("marks new files when a course is read again", () => {
    const again = { ...input, files: [{ ...files[0], upload: { ...files[0].upload, cataloguedAt: 1 } }, files[1]] };
    const t = setupTurns(again, { navigate: "page" }).turns[0].content;
    expect(t).toContain("- F2: NEW AN/VO 01.mp4");
    expect(t).toContain("Files marked NEW arrived since");
  });

  it("opens only the asked pages and logs why", async () => {
    const log: string[] = [];
    const [outline, open] = fileTools(files, (l) => log.push(l));
    const ctx = {} as never;
    expect(await outline.execute!({ file: "F1" }, ctx)).toBe("p. 1: Grading: exam 100%\np. 2: Topics");
    expect(await open.execute!({ file: "f1", part: "1", why: "grading rules" }, ctx)).toBe("--- page 1 ---\nGrading: exam 100%");
    expect(await open.execute!({ file: "F3", part: "1", why: "check" }, ctx)).toContain("A scan without text");
    expect(await open.execute!({ file: "F9", part: "1", why: "x" }, ctx)).toContain("No file F9");
    expect(log).toEqual(["Looking at the outline of F1 (AN/Syllabus.pdf)", "Opening F1 (AN/Syllabus.pdf) p. 1: grading rules", "Opening F3 (AN/scan.pdf) p. 1: check"]);
  });

  it("lets a cloud session save scan text and nothing else", () => {
    const t = jobInstructions({ jobId: "j", title: "T", body: "B", alsoWrite: "add text to scans" });
    expect(t).toContain("Apart from that, you may only add text to scans.");
    expect(jobInstructions({ jobId: "j", title: "T", body: "B" })).not.toContain("Apart from that");
  });
});

describe("assigning a whole zip", () => {
  it("gives every file of the zip its course in a job", () => {
    const draft = {
      courses: [{ id: "c1", name: "Analysis", short: "AN", setupStatus: "ready" }],
      uploads: [up({ id: "u1", zipId: "zip_a" }), up({ id: "u2", zipId: "zip_a" }), up({ id: "u3" })],
      zips: [{ id: "zip_a", fileName: "Mathe.zip", courseId: null, addedAt: 0, files: 2 }],
      facts: [],
      results: {},
    } as unknown as SemesterDraft;
    const r = startJob({ draft, profile: {} as Profile } as never, { kind: "new_material", courses: ["c1"], files: [{ uploadId: "zip_a", course: "c1" }], studentWords: "" }, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.desk.draft.uploads.map((u) => u.courseId)).toEqual(["c1", "c1", null]);
    expect(r.desk.draft.zips![0].courseId).toBe("c1");
    expect(r.job.uploadIds).toEqual(["u1", "u2"]);
  });
});

describe("room in the file store", () => {
  const fakeStore = (maxBytes: number) => {
    const stored: string[] = [];
    return {
      stored,
      store: {
        saveUploadContent: async () => undefined,
        storeOriginal: async (b: Blob) => (stored.push(String(b.size)), `asset${stored.length}`),
        storageUsage: async () => ({ files: 0, bytes: 0, maxFiles: 100, maxBytes }),
      },
    };
  };
  const zipOf = (files: Record<string, string>) => new File([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))], "C.zip");
  const drop = (f: File) => [{ id: "a", name: f.name, kind: "text" as const, status: "ready" as const, file: f, deferred: "zip" as const }];

  it("keeps every original when there is room", async () => {
    const { store, stored } = fakeStore(10_000);
    const r = await keepDrop(drop(zipOf({ "a.md": "# A\ntext", "b.md": "# B\ntext" })), store, () => undefined);
    expect(stored).toHaveLength(2);
    expect(r.uploads.every((u) => u.assetId)).toBe(true);
    expect(r.report!.lines).toEqual(["C.zip: 2 files, 2 text files."]);
  });

  it("hands each zip over as soon as it's kept", async () => {
    const { store } = fakeStore(10_000);
    const handed: string[][] = [];
    const r = await keepDrop(drop(zipOf({ "a.md": "# A", "b.md": "# B" })), store, () => undefined, { onZipKept: (us) => void handed.push(us.map((u) => u.path!)) });
    expect(handed).toEqual([["a.md", "b.md"]]);
    expect(r.uploads).toHaveLength(0);
    expect(r.report!.lines[0]).toBe("C.zip: 2 files, 2 text files.");
  });

  it("reports progress per zip, ending with every part done", async () => {
    const { store } = fakeStore(10_000);
    const seen: KeepProgress[] = [];
    await keepDrop(drop(zipOf({ "a.md": "# A", "b.md": "# B" })), store, () => undefined, { onProgress: (p) => seen.push(p) });
    expect(seen[0].items).toEqual([{ name: "C.zip", state: "working", done: 0, total: 0, problems: 0 }]);
    expect(seen.some((p) => p.items[0].total === 2 && p.items[0].state === "working")).toBe(true);
    expect(seen[seen.length - 1].items[0]).toMatchObject({ state: "done", done: 2, total: 2, problems: 0 });
    expect(keepFraction(seen[seen.length - 1])).toBe(1);
  });

  it("counts each part of a drop the same for the overall bar", () => {
    const p: KeepProgress = {
      items: [
        { name: "a.zip", state: "done", done: 10, total: 10, problems: 0 },
        { name: "b.zip", state: "working", done: 5, total: 10, problems: 0 },
        { name: "c.zip", state: "waiting", done: 0, total: 0, problems: 0 },
        { name: "d.zip", state: "failed", done: 0, total: 0, problems: 0 },
      ],
    };
    expect(keepFraction(p)).toBeCloseTo((1 + 0.5 + 0 + 1) / 4);
    expect(keepFraction({ items: [] })).toBe(0);
  });

  it("warns first, keeps the text, and stores only the originals that fit", async () => {
    const { store, stored } = fakeStore(30);
    const r = await keepDrop(drop(zipOf({ "a.md": "x".repeat(20), "b.md": "y".repeat(20) })), store, () => undefined);
    expect(stored).toHaveLength(1);
    expect(r.uploads).toHaveLength(2);
    expect(r.uploads.every((u) => u.state === "readable")).toBe(true);
    expect(r.report!.lines[0]).toContain("needs about 1 MB for its original files");
    expect(r.report!.lines).toContain("1 original (1 MB) didn't fit in the file store; their text is kept.");
    expect(r.previews.some((p) => p.includes("The file store is full"))).toBe(true);
  });
});

describe("leftovers from an import that didn't finish", async () => {
  const { leftoversOf } = await import("../src/platform/backup");
  const now = Date.parse("2026-11-20T18:00:00Z");
  const asset = (id: string, minsAgo: number, contentType = "application/pdf") => ({ id, sizeBytes: 1000, contentType, createdAt: new Date(now - minsAgo * 60_000).toISOString() });

  it("counts only old, unreferenced files, never backups", () => {
    const l = leftoversOf(new Set(["up_a"]), new Set(["a1"]), [asset("a1", 60), asset("a2", 60), asset("a3", 5), asset("b1", 60, "application/json")], ["up_a", "up_b", "other"], now);
    expect(l.assetIds).toEqual(["a2"]);
    expect(l.bytes).toBe(1000);
    expect(l.contentIds).toEqual(["up_b"]);
  });
});
