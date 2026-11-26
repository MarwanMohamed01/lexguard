import { chunkDocument } from "@lexguard/chunker";
import { describe, expect, it } from "vitest";
import { findSectionReferences, resolveReference, sectionNumber } from "../src/index";

const refs = (text: string) =>
  findSectionReferences(text).map((r) => ({
    text: text.slice(r.start, r.end),
    number: r.number.join("."),
    point: r.point,
    kind: r.kind,
    external: r.external,
  }));

describe("findSectionReferences", () => {
  it("finds single references with points and roman numerals", () => {
    expect(refs("as set out in Section 5.3 and under Article IV.")).toEqual([
      { text: "Section 5.3", number: "5.3", point: "", kind: "section", external: false },
      { text: "Article IV", number: "4", point: "", kind: "article", external: false },
    ]);
    expect(refs("pursuant to Clause 9.1(b)(ii) hereof")).toEqual([
      {
        text: "Clause 9.1(b)(ii)",
        number: "9.1",
        point: "(b)(ii)",
        kind: "clause",
        external: false,
      },
    ]);
  });

  it("splits lists into one reference per item, with each item's own offsets", () => {
    expect(
      refs("Sections 3, 4, 7 and 9.1(b) shall survive").map((r) => [r.text, r.number]),
    ).toEqual([
      ["Sections 3", "3"],
      ["4", "4"],
      ["7", "7"],
      ["9.1(b)", "9.1"],
    ]);
    expect(refs("Paragraphs 2 or 3").map((r) => r.number)).toEqual(["2", "3"]);
  });

  it("marks references to other documents as external, the whole list", () => {
    expect(refs("Section 11.5 of the Supply Agreement applies")[0]?.external).toBe(true);
    expect(refs("Sections 2 and 3 of the Purchase Agreement").map((r) => r.external)).toEqual([
      true,
      true,
    ]);
    expect(refs("Section 4 of Exhibit B")[0]?.external).toBe(true);
    // "this Agreement" and "the Agreement" mean the contract itself.
    expect(refs("Section 4 of this Agreement")[0]?.external).toBe(false);
    expect(refs("Section 4 of the Agreement")[0]?.external).toBe(false);
  });

  it("ignores things that are not section numbers", () => {
    expect(refs("Sections of the Code")).toEqual([]);
    expect(refs("Section 12345")).toEqual([]); // more digits than a clause number
    expect(refs("section 5.3 applies")).toEqual([]); // a reference starts with a capital
    expect(refs("Section 10.6.1.2.3.4 here")).toEqual([]); // deeper than any heading
    expect(refs("Section Liability")).toEqual([]); // not Roman numeral L
    expect(refs("Section 5A")).toEqual([]);
  });
});

describe("sectionNumber", () => {
  it.each([
    ["1.1 Grant and Acceptance", "1.1"],
    ["ARTICLE IV Payment", "4"],
    ["Section 5.3. Term", "5.3"],
    ["7.", "7"],
    ["12) Notices", "12"],
  ])("reads %s as %s", (label, number) => {
    expect(sectionNumber(label)?.join(".")).toBe(number);
  });

  it.each([["EXHIBIT 10.6"], ["DEFINITIONS"], [""]])("finds no number in %j", (label) => {
    expect(sectionNumber(label)).toBeNull();
  });
  it("finds no number without a label", () => {
    expect(sectionNumber(null)).toBeNull();
  });
});

describe("resolveReference", () => {
  const text = [
    "1. Definitions",
    "Terms have the meanings below.",
    "2. Confidentiality",
    "2.1 The Recipient shall keep the Information secret, subject to Section 2.2.",
    "2.2 The obligations in Section 2.1 do not apply to public information.",
    "3. Term",
    "This Agreement ends after two years. Section 9 of the Supply Agreement is unaffected.",
  ].join("\n");
  const { sections } = chunkDocument(text);

  it("resolves an internal reference to the chunker's section with that number", () => {
    const [ref] = findSectionReferences("subject to Section 2.2.");
    if (ref === undefined) throw new Error("no reference");
    const section = resolveReference(ref, sections);
    expect(section?.label).toMatch(/^2\.2\b/);
    expect(text.slice(section?.start, section?.end)).toContain(
      "do not apply to public information",
    );
  });

  it("does not resolve an external reference or a number with no section", () => {
    const external = findSectionReferences("Section 9 of the Supply Agreement")[0];
    const missing = findSectionReferences("Section 8.4")[0];
    if (external === undefined || missing === undefined) throw new Error("no reference");
    expect(resolveReference(external, sections)).toBeNull();
    // Even when this contract has a section with the same number: 2.2 here is not the
    // Supply Agreement's 2.2.
    const sameNumber = findSectionReferences("Section 2.2 of the Supply Agreement")[0];
    if (sameNumber === undefined) throw new Error("no reference");
    expect(resolveReference(sameNumber, sections)).toBeNull();
    expect(resolveReference(missing, sections)).toBeNull();
    // 2 is not 2.1: numbers must match exactly.
    const two = findSectionReferences("Section 2")[0];
    if (two === undefined) throw new Error("no reference");
    expect(resolveReference(two, sections)?.label).toBe("2 Confidentiality");
  });
});
