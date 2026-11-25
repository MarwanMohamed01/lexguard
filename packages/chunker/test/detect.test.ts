import { describe, expect, it } from "vitest";
import {
  definitionSpan,
  MAX_DEFINITION_CHARS,
  findDefinitions,
  findHeadingCandidates,
  findSoftBoundaries,
  type NumberedCandidate,
} from "../src/detect";

const numbered = (text: string): NumberedCandidate[] =>
  findHeadingCandidates(text).filter((c): c is NumberedCandidate => c.kind === "numbered");

describe("findHeadingCandidates", () => {
  it("finds numbers at line starts, with their titles", () => {
    const text = "1. Definitions. Words...\n1.1 Scope\n  2) Term of Agreement: ten years";
    expect(numbered(text).map((c) => [c.marker, c.title, c.start])).toEqual([
      ["1", "Definitions", 0],
      ["1.1", "Scope", 25],
      ["2", "Term of Agreement", 37],
    ]);
  });

  it("finds a sub-clause that starts mid-line after a sentence ends", () => {
    const text = "6.3.4 Training Costs. 6.3.4.1 The Initial Franchise Fee covers it.";
    expect(numbered(text).map((c) => c.marker)).toEqual(["6.3.4", "6.3.4.1"]);
  });

  it("finds a clause glued to an all-caps heading, and trims the title", () => {
    const text = "9. PROPRIETARY MARKS 9.1 Use of Marks. You may use them.";
    expect(numbered(text).map((c) => [c.marker, c.title])).toEqual([
      ["9", "PROPRIETARY MARKS"],
      ["9.1", "Use of Marks"],
    ]);
  });

  it("ignores cross-references in ALL-CAPS paragraphs (found on CUAD)", () => {
    const text =
      "EXCEPT FOR LIABILITY ARISING UNDER SECTION 8 OF THIS AGREEMENT, IN NO EVENT SHALL EITHER " +
      "PARTY BE LIABLE FOR BREACH OF CONFIDENTIALITY (ARTICLE 12) OR INDEMNIFICATION OBLIGATIONS.";
    expect(numbered(text)).toEqual([]);
  });

  it("finds ARTICLE 7 once, not also as a bare 7", () => {
    expect(numbered("ARTICLE 7 FEES\n7.1 Amount.").map((c) => c.marker)).toEqual([
      "ARTICLE 7",
      "7.1",
    ]);
  });

  it("returns no title when the marker is followed by a sentence", () => {
    const text =
      "7.1.2 For the purpose of this Agreement, the term supplier includes any approved vendor of goods";
    expect(numbered(text)[0]?.title).toBeNull();
  });

  it("reads keywords and roman numerals, title on the next line", () => {
    const text = "ARTICLE IV\nTRAINING\nSection 4.01 Initial Training.";
    expect(numbered(text).map((c) => [c.marker, c.number, c.title])).toEqual([
      ["ARTICLE IV", [4], "TRAINING"],
      ["Section 4.01", [4, 1], "Initial Training"],
    ]);
  });

  it("ignores numbers inside sentences and before lowercase words", () => {
    const text = "Pay within thirty (30) days as set out in Section 5.3 hereof.\n2 days later";
    expect(numbered(text)).toEqual([]);
  });

  it("ignores a lone roman-looking word without a keyword", () => {
    expect(numbered("I Agree to the terms.\nC Corporation")).toEqual([]);
  });

  it("treats exhibits and plain Markdown headings as resets", () => {
    const text = "1. Term\nEXHIBIT A\n1. Form\n## Background\n# 2. Scope";
    const all = findHeadingCandidates(text);
    expect(all.map((c) => [c.kind, c.kind === "reset" ? c.label : c.marker, c.start])).toEqual([
      ["numbered", "1", 0],
      ["reset", "EXHIBIT A", 8],
      ["numbered", "1", 18],
      ["reset", "Background", 26],
      ["numbered", "2", 40],
    ]);
  });
});

describe("findSoftBoundaries and findDefinitions", () => {
  it("finds list items and definitions that start a line or sentence", () => {
    const text = 'Terms: (a) one; (b) two.\n"Month" means a month. "Year" means a year.';
    expect(findSoftBoundaries(text)).toEqual([7, 16, 25, 48]);
  });

  it("does not split at a definition inside a sentence", () => {
    const text = 'In this Agreement  "Month" means a calendar month.';
    expect(findSoftBoundaries(text)).toEqual([]);
    expect(findDefinitions(text)).toEqual([{ term: "Month", start: 19 }]);
  });

  it("accepts curly quotes and 'shall mean' / 'has the meaning'", () => {
    const text = '“Affiliate” shall mean any entity. "Term" has the meaning in 2.1.';
    expect(findDefinitions(text).map((d) => d.term)).toEqual(["Affiliate", "Term"]);
  });
});

describe("inline definitions and definition spans (D40)", () => {
  it("finds inline definitions, every term in a parenthesis, and skips references", () => {
    const text =
      'This Agreement is made as of March 1, 2020 (the "Effective Date") by Acme Inc. ("Supplier") ' +
      'and Beta LLC (each, a "Party" and collectively, the "Parties"). Fees (as defined in "Schedule A") apply.';
    expect(findDefinitions(text).map((d) => d.term)).toEqual([
      "Effective Date",
      "Supplier",
      "Party",
      "Parties",
    ]);
    const effective = findDefinitions(text)[0];
    expect(text[effective?.start ?? -1]).toBe("(");
  });

  it("keeps 'X' means definitions and sorts everything by position", () => {
    const text = 'Acme ("Seller").\n"Month" means a calendar month.';
    expect(findDefinitions(text)).toEqual([
      { term: "Seller", start: 5 },
      { term: "Month", start: 17 },
    ]);
  });

  it("an inline definition's text is its sentence up to the closing parenthesis", () => {
    const text =
      'Recitals. This Agreement is made as of March 1, 2020 (the "Effective Date") by the parties.';
    const [d] = findDefinitions(text);
    const span = definitionSpan(text, d?.start ?? 0);
    expect(text.slice(span?.start, span?.end)).toBe(
      'This Agreement is made as of March 1, 2020 (the "Effective Date")',
    );
  });

  it("a 'means' definition runs to the next definition or the end of its paragraph", () => {
    const text =
      '"Month" means a calendar month. "Year" means twelve Months.\n\n2. Term. This lasts one Year.';
    const defs = findDefinitions(text);
    const month = definitionSpan(text, defs[0]?.start ?? 0);
    const year = definitionSpan(text, defs[1]?.start ?? 0);
    expect(text.slice(month?.start, month?.end)).toBe('"Month" means a calendar month.');
    expect(text.slice(year?.start, year?.end)).toBe('"Year" means twelve Months.');
  });

  it("caps a long definition after its last sentence inside the cap", () => {
    const body = "It includes items. ".repeat(100);
    const text = `"Product" means the goods. ${body}`;
    const span = definitionSpan(text, 0);
    expect((span?.end ?? 0) - (span?.start ?? 0)).toBeLessThanOrEqual(MAX_DEFINITION_CHARS);
    expect(text.slice(span?.start, span?.end).endsWith(".")).toBe(true);
  });

  it("returns null where no definition starts", () => {
    expect(definitionSpan("plain text here", 3)).toBeNull();
    expect(definitionSpan('a (b "C" never closed', 2)).toBeNull();
  });
});

describe("definition spans and abbreviations (D40)", () => {
  it("does not end a sentence at 'Inc.' before a parenthesis", () => {
    const text = 'Recitals. This Agreement is made by Acme Inc. ("Supplier") and Beta.';
    const [d] = findDefinitions(text);
    const span = definitionSpan(text, d?.start ?? 0);
    expect(text.slice(span?.start, span?.end)).toBe(
      'This Agreement is made by Acme Inc. ("Supplier")',
    );
  });

  it("starts at a line break, and after '; ' before a capital", () => {
    const text = 'Background\nAcme ("Seller") sells; Beta ("Buyer") buys.';
    const defs = findDefinitions(text);
    expect(text.slice(definitionSpan(text, defs[0]?.start ?? 0)?.start)).toMatch(/^Acme/);
    expect(text.slice(definitionSpan(text, defs[1]?.start ?? 0)?.start)).toMatch(/^Beta/);
  });
});

describe("definitionSpan only at a definition's own start", () => {
  it("returns null at a position where no definition starts, even if one follows", () => {
    const text = 'Plain words. "Month" means a calendar month.';
    expect(definitionSpan(text, 0)).toBeNull();
    expect(definitionSpan(text, text.indexOf('"Month"'))?.start).toBe(text.indexOf('"Month"'));
  });
});
