import { describe, expect, it } from "vitest";
import { chunkDocument, type Chunk } from "../src/index";
import { findHeadingCandidates } from "../src/detect";
import { buildSections, selectHeadings } from "../src/headings";

/** The guarantees every result must satisfy, whatever the input. */
function expectValid(text: string, chunks: Chunk[], maxChars: number): void {
  let position = 0;
  chunks.forEach((chunk, i) => {
    expect(chunk.index).toBe(i);
    expect(chunk.start).toBe(position);
    expect(chunk.end).toBeGreaterThan(chunk.start);
    expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    position = chunk.end;
  });
  expect(position).toBe(text.length);
  expect(chunks.map((c) => c.text).join("")).toBe(text);
}

const labels = (text: string): (string | null)[] =>
  buildSections(text.length, selectHeadings(findHeadingCandidates(text))).map((s) => s.label);

describe("selectHeadings", () => {
  it("ignores cross-references between real headings", () => {
    const text = "17.1 Default. Text.\n17.2 Notice. As described. Section 5.3 applies.\n17.3 Cure.";
    expect(labels(text)).toEqual(["17.1 Default", "17.2 Notice", "17.3 Cure"]);
  });

  it("resyncs after a heading that PDF extraction garbled", () => {
    // "1.2" is missing; 1.3, 1.4, 1.5 form a chain, so they are accepted anyway.
    const text = "1 Fees.\n1.1 Amount.\n1.3 Late.\n1.4 Taxes.\n1.5 Currency.\n2 Term.";
    expect(labels(text)).toEqual([
      "1 Fees",
      "1.1 Amount",
      "1.3 Late",
      "1.4 Taxes",
      "1.5 Currency",
      "2 Term",
    ]);
  });

  it("restarts after a table of contents", () => {
    const text =
      "1. Scope\n2. Term\n3. Fees\n1. Scope. Body.\n1.1 Services. Body.\n1.2 Levels. Body.";
    expect(labels(text).filter((l) => l === "1 Scope")).toHaveLength(2);
    expect(labels(text)).toContain("1.2 Levels");
  });

  it("restarts numbering in an exhibit", () => {
    const text = "1. Term.\n2. Fees.\nEXHIBIT A\n1. Form. Text.";
    expect(labels(text)).toEqual(["1 Term", "2 Fees", "EXHIBIT A", "1 Form"]);
  });
});

describe("sections", () => {
  it("builds nested paths", () => {
    const text =
      "Preamble.\nARTICLE 7\nTRAINING\n7.1 Initial. Text.\n7.1.1 Costs. Text.\n7.2 Later.";
    const sections = buildSections(text.length, selectHeadings(findHeadingCandidates(text)));
    expect(sections.map((s) => s.path)).toEqual([
      [],
      ["ARTICLE 7 TRAINING"],
      ["ARTICLE 7 TRAINING", "7.1 Initial"],
      ["ARTICLE 7 TRAINING", "7.1 Initial", "7.1.1 Costs"],
      ["ARTICLE 7 TRAINING", "7.2 Later"],
    ]);
  });
});

describe("chunkDocument", () => {
  it("returns nothing for an empty document", () => {
    expect(chunkDocument("")).toEqual({ chunks: [], sections: [], definitions: [] });
  });

  it("merges short neighbouring sections and keeps their shared path", () => {
    const text = "1 Fees.\n1.1 Amount. Pay 10.\n1.2 Late. Pay 2.";
    const { chunks } = chunkDocument(text, { targetChars: 200, maxChars: 400 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionPath).toEqual(["1 Fees"]);
    expect(chunks[0]?.heading).toBe("1 Fees");
  });

  it("starts a new chunk at a new article unless the current chunk is tiny", () => {
    // Each article is ~165 characters: together within the 400 target, but not tiny (< 100).
    const body = "y".repeat(150);
    const text = `1 A.\n1.1 X. ${body}\n2 B.\n2.1 Y. ${body}`;
    const { chunks } = chunkDocument(text, { targetChars: 400, maxChars: 800 });
    expect(chunks.map((c) => c.sectionPath)).toEqual([["1 A"], ["2 B"]]);

    const tiny = "1 A. Short.\n2 B. Short.";
    expect(chunkDocument(tiny, { targetChars: 400, maxChars: 800 }).chunks).toHaveLength(1);
  });

  it("never merges past the target size", () => {
    const body = "x".repeat(150);
    const text = `1 A. ${body}\n2 B. ${body}\n3 C. ${body}`;
    const { chunks } = chunkDocument(text, { targetChars: 200, maxChars: 400 });
    expect(chunks.map((c) => c.heading)).toEqual(["1 A", "2 B", "3 C"]);
    expectValid(text, chunks, 400);
  });

  it("splits an oversized section at list items before anything else", () => {
    const item = "word ".repeat(30);
    const text = `1 Duties. The Supplier shall: (a) ${item}; (b) ${item}; (c) ${item}; (d) ${item}.`;
    const { chunks } = chunkDocument(text, { targetChars: 200, maxChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) expect(chunk.text).toMatch(/^\([a-d]\)/);
    expect(chunks.every((c) => c.heading === "1 Duties")).toBe(true);
    expectValid(text, chunks, 400);
  });

  it("falls back to sentences, then whitespace, then a hard cut", () => {
    const sentences = "This is one sentence of the clause. ".repeat(40);
    const words = "word ".repeat(300);
    const solid = "x".repeat(1000);
    for (const text of [sentences, words, solid]) {
      expectValid(text, chunkDocument(text, { targetChars: 200, maxChars: 400 }).chunks, 400);
    }
  });

  it("never cuts an emoji in half", () => {
    const text = "😀".repeat(500);
    const { chunks } = chunkDocument(text, { targetChars: 200, maxChars: 401 });
    expectValid(text, chunks, 401);
    for (const chunk of chunks) expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/);
  });

  it("keeps Windows line endings and exact offsets", () => {
    const text = "1. Term\r\nText here.\r\n\r\n2. Fees\r\nMore text.\r\n";
    const { chunks, sections } = chunkDocument(text, { targetChars: 200, maxChars: 400 });
    expect(sections.map((s) => s.label)).toEqual(["1 Term", "2 Fees"]);
    expectValid(text, chunks, 400);
  });

  it("rejects invalid options", () => {
    expect(() => chunkDocument("x", { targetChars: 500, maxChars: 300 })).toThrow();
    expect(() => chunkDocument("x", { targetChars: 10 })).toThrow();
  });

  it("holds its guarantees on random text (seeded)", () => {
    // Small deterministic generator, so a failure is reproducible.
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pieces = [
      "1. ",
      "2.1 ",
      "7.1.2 ",
      "ARTICLE IV ",
      "Section 3.2 ",
      "EXHIBIT A\n",
      "## Notes\n",
      "(a) ",
      "(iv) ",
      '"Term" means ',
      "the Supplier ",
      "shall pay ",
      "thirty (30) days",
      ". ",
      "; ",
      "\n",
      "\r\n",
      "\n\n",
      "😀",
      "é",
      "x".repeat(300),
      "Word ",
    ];
    for (let run = 0; run < 200; run++) {
      let text = "";
      const length = Math.floor(random() * 400);
      for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)] ?? "";
      const maxChars = 300 + Math.floor(random() * 3000);
      const targetChars = 200 + Math.floor(random() * (maxChars - 200));
      expectValid(text, chunkDocument(text, { targetChars, maxChars }).chunks, maxChars);
    }
  });
});
