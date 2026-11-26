import { describe, expect, it } from "vitest";
import { MAX_PASSAGE_CHARS, selectPassages, splitSentences } from "../src/index";

describe("splitSentences", () => {
  it("splits at sentence ends and line breaks, keeping exact offsets", () => {
    const text = 'First one. Second one; Third: (a) item\n\nNext line?  "Quoted" too!';
    const parts = splitSentences(text, 100);
    expect(parts.map((p) => p.text)).toEqual([
      "First one.",
      "Second one;",
      "Third:",
      "(a) item",
      "Next line?",
      '"Quoted" too!',
    ]);
    for (const p of parts) expect(text.slice(p.start - 100, p.end - 100)).toBe(p.text);
  });

  it("does not split after a heading number", () => {
    expect(
      splitSentences("1. Definitions. Terms follow. Section 5.3. Term applies.").map((p) => p.text),
    ).toEqual(["1. Definitions.", "Terms follow.", "Section 5.3. Term applies."]);
  });

  it("does not split inside abbreviations and section numbers", () => {
    expect(
      splitSentences("Acme Inc. and Beta Ltd. agree, see Section 5.3 of the terms.").map(
        (p) => p.text,
      ),
    ).toEqual(["Acme Inc. and Beta Ltd. agree, see Section 5.3 of the terms."]);
  });

  it("cuts an overlong sentence at spaces, never losing text", () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${String(i)}`).join(" ");
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
      expect(long.slice(p.start, p.end)).toBe(p.text);
    }
    expect(parts.map((p) => p.text).join(" ")).toBe(long);
  });

  it("returns nothing for blank text", () => {
    expect(splitSentences("  \n\n ")).toEqual([]);
  });
});

describe("selectPassages", () => {
  const chunks = [
    {
      start: 0,
      text: "1. Definitions. Confidential Information means all data. Governing law is Texas.",
    },
    {
      start: 500,
      text: "2. The Recipient shall not reverse engineer the Materials. Payment is due in 30 days.",
    },
  ];

  it("picks the sentences that match the rule, in document order, with document offsets", () => {
    const picked = selectPassages(
      chunks,
      "Receiving Party shall not reverse engineer any objects",
      2,
    );
    expect(picked.map((p) => p.text)).toContain(
      "2. The Recipient shall not reverse engineer the Materials.",
    );
    const best = picked.find((p) => p.text.includes("reverse engineer"));
    expect(best?.start).toBe(500);
    expect(picked.map((p) => p.start)).toEqual(
      [...picked.map((p) => p.start)].sort((a, b) => a - b),
    );
  });

  it("returns at most k, and the first sentences when nothing matches", () => {
    expect(selectPassages(chunks, "reverse engineer", 1)).toHaveLength(1);
    expect(selectPassages(chunks, "zebra crossing", 2).map((p) => p.text)).toEqual([
      "1. Definitions.",
      "Confidential Information means all data.",
    ]);
    expect(selectPassages([], "anything")).toEqual([]);
  });
});
