import { describe, expect, it } from "vitest";
import { extractPages, pageAt } from "../src/pages";

// Shape of toMarkdown's PDF output, as seen on the CUAD PDFs (M2 step 6).
const wrapped = (pages: string[], metadata = true) =>
  [
    "# document.pdf\n",
    metadata ? "## Metadata\n- PDFFormatVersion=1.4\n- Producer=Some Tool 5.11\n\n\n\n" : "",
    "## Contents\n",
    ...pages.map((p, i) => `### Page ${String(i + 1)}\n${p}\n\n\n\n`),
  ].join("");

describe("extractPages", () => {
  it("removes wrapper and page markers, joining pages with one line break", () => {
    const { text, pageStarts } = extractPages(
      wrapped(["1. Term\nThis Agreement shall have the right to", "obtain specific performance."]),
    );

    expect(text).toBe(
      "1. Term\nThis Agreement shall have the right to\nobtain specific performance.",
    );
    expect(pageStarts).toEqual([0, text.indexOf("obtain")]);
    expect(text).not.toMatch(/Page|Metadata|document\.pdf|Producer/);
  });

  it("works without the metadata section", () => {
    const { text, pageStarts } = extractPages(wrapped(["A.", "B."], false));

    expect(text).toBe("A.\nB.");
    expect(pageStarts).toEqual([0, 3]);
  });

  it("keeps blank pages in the page map", () => {
    const { text, pageStarts } = extractPages(wrapped(["A.", "", "C."]));

    expect(text).toBe("A.\n\nC.");
    expect(pageStarts).toEqual([0, 3, 4]);
    expect(pageAt(pageStarts ?? [], text.indexOf("C"))).toBe(3);
  });

  it("maps any offset to its page", () => {
    const { text, pageStarts } = extractPages(wrapped(["first page", "second page", "third"]));
    const starts = pageStarts ?? [];

    expect(pageAt(starts, 0)).toBe(1);
    expect(pageAt(starts, text.indexOf("second"))).toBe(2);
    expect(pageAt(starts, text.indexOf("second") - 1)).toBe(1); // the joining line break
    expect(pageAt(starts, text.length - 1)).toBe(3);
  });

  it("leaves a 'Page' heading written inside the contract alone", () => {
    // Page 2's text itself contains "### Page 7": not the next marker, so it stays.
    const { text, pageStarts } = extractPages(wrapped(["A.", "See\n### Page 7\nof the manual."]));

    expect(text).toBe("A.\nSee\n### Page 7\nof the manual.");
    expect(pageStarts).toEqual([0, 3]);
  });

  it("stops at the first marker out of sequence and keeps the rest as text", () => {
    const markdown = "## Contents\n### Page 1\nA.\n### Page 3\nC.\n";
    const { text, pageStarts } = extractPages(markdown);

    expect(text).toBe("A.\n### Page 3\nC.");
    expect(pageStarts).toEqual([0]);
  });

  it("returns text unchanged, without a page map, when the format is not recognised", () => {
    for (const markdown of [
      "1. Term\nThis Agreement...",
      "# document.docx\n\nSome heading\n",
      "## Contents\n### Page 2\nB.",
      "Intro\n## Contents\n### Page 1\nA.",
    ]) {
      expect(extractPages(markdown)).toEqual({ text: markdown, pageStarts: null });
    }
  });
});
