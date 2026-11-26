import { describe, expect, it } from "vitest";
import { parseOjRegulation } from "../src/parse-oj";

// Small hand-written pieces in the Official Journal's XHTML shape (unit-test inputs, not a
// dataset). The real file is checked in rulebook.test.ts.
const point = (label: string, body: string) =>
  `<table><col width="4%"/><tbody><tr><td valign="top"><p class="oj-normal">${label}</p></td>` +
  `<td valign="top">${body}</td></tr></tbody></table>`;
const p = (text: string) => `<p class="oj-normal">${text}</p>`;
const article = (n: number, title: string, body: string) =>
  `<div class="eli-subdivision" id="art_${String(n)}"><p class="oj-ti-art">Article ${String(n)}</p>` +
  `<div class="eli-title"><p class="oj-sti-art">${title}</p></div>${body}</div>`;
const para = (art: number, n: number, body: string) =>
  `<div id="${String(art).padStart(3, "0")}.${String(n).padStart(3, "0")}">${body}</div>`;

const doc = (body: string) =>
  `<?xml version="1.0"?><!DOCTYPE html><html><body><!-- note -->` +
  `<div class="eli-subdivision" id="rct_1">${p("(1) A recital, not a rule.")}</div>${body}` +
  `<p class="oj-final">This Regulation shall be binding in its entirety.</p></body></html>`;

describe("parseOjRegulation", () => {
  const xhtml = doc(
    article(
      28,
      "Processor",
      para(28, 1, p("1.   Where processing is carried out on behalf of a controller.")) +
        para(
          28,
          3,
          p("3.   That contract shall stipulate that the processor:") +
            point(
              "(a)",
              p('processes data only on <span class="oj-italic">documented</span> instructions;'),
            ) +
            point("(b)", p("ensures confidentiality;") + point("(i)", p("nested item;"))) +
            p("With regard to point (h), the processor shall inform the controller."),
        ),
    ) +
      article(
        4,
        "Definitions",
        p("For the purposes of this Regulation:") +
          point("(1)", p("&#8216;personal data&#8217; means any information &amp; more")),
      ) +
      article(
        53,
        "Members",
        para(
          53,
          1,
          p("1.   Members are appointed by:") +
            point("—", p("their parliament;")) +
            point("—", p("their government;")),
        ),
      ),
  );
  const { text, rules } = parseOjRegulation(xhtml, "gdpr");
  const byId = new Map(rules.map((r) => [r.id, text.slice(r.start, r.end)]));

  it("gives every paragraph and point a citable ID", () => {
    expect(rules.map((r) => r.id)).toEqual([
      "gdpr:28(1)",
      "gdpr:28(3)",
      "gdpr:28(3)(a)",
      "gdpr:28(3)(b)",
      "gdpr:28(3)(b)(i)",
      "gdpr:28(3)/2",
      "gdpr:4",
      "gdpr:4(1)",
      "gdpr:53(1)",
      "gdpr:53(1)-1",
      "gdpr:53(1)-2",
    ]);
  });

  it("keeps the text of each rule, without the paragraph number", () => {
    expect(byId.get("gdpr:28(3)")).toBe("That contract shall stipulate that the processor:");
    expect(byId.get("gdpr:28(3)(a)")).toBe("processes data only on documented instructions;");
    expect(byId.get("gdpr:28(3)/2")).toBe(
      "With regard to point (h), the processor shall inform the controller.",
    );
    expect(byId.get("gdpr:53(1)-2")).toBe("their government;");
  });

  it("decodes entities and records article and title", () => {
    expect(byId.get("gdpr:4(1)")).toBe("‘personal data’ means any information & more");
    expect(rules.find((r) => r.id === "gdpr:28(3)(a)")).toMatchObject({
      article: "28",
      title: "Processor",
    });
  });

  it("skips recitals, footer text and footnote markers", () => {
    expect(text).not.toContain("recital");
    expect(text).not.toContain("binding in its entirety");
    const withNote = doc(
      article(
        5,
        "X",
        p(
          'Directive 95/46/EC<a href="#n1">(<span class="oj-super oj-note-tag">1</span>)</a> applies.',
        ),
      ),
    );
    expect(parseOjRegulation(withNote, "gdpr").text).toBe("Directive 95/46/EC() applies.");
  });

  it("puts one rule per line, offsets exact", () => {
    expect(text.split("\n")).toHaveLength(rules.length);
    for (const r of rules) expect(text.slice(r.start, r.end)).not.toContain("\n");
  });

  it("strips only a leading number that matches the paragraph", () => {
    const x = doc(article(9, "X", para(9, 2, p("12. months after entry into force."))));
    expect(parseOjRegulation(x, "gdpr").text).toBe("12. months after entry into force.");
    // Only the paragraph's first block carries its number; later blocks and points keep theirs.
    const y = doc(
      article(
        9,
        "X",
        para(9, 3, p("3. Intro.") + point("(a)", p("3. Point text.")) + p("3. Second block.")),
      ),
    );
    expect(parseOjRegulation(y, "gdpr").text).toBe("Intro.\n3. Point text.\n3. Second block.");
  });

  it("returns to article level after a paragraph ends", () => {
    const x = doc(article(7, "X", para(7, 1, p("1. First.")) + p("Closing words.")));
    expect(parseOjRegulation(x, "gdpr").rules.map((r) => r.id)).toEqual(["gdpr:7(1)", "gdpr:7"]);
  });

  it("collapses no-break spaces and drops empty blocks", () => {
    const x = doc(
      article(8, "X", p("a&nbsp;&#160;" + String.fromCharCode(160) + "b") + p(" &nbsp; ")),
    );
    const { text: t, rules: r } = parseOjRegulation(x, "gdpr");
    expect(t).toBe("a b");
    // The entity alone must still separate words.
    expect(parseOjRegulation(doc(article(8, "X", p("data&nbsp;subject"))), "gdpr").text).toBe(
      "data subject",
    );
    expect(r).toHaveLength(1);
  });

  it("refuses structures it does not understand instead of skipping text", () => {
    expect(() => parseOjRegulation(doc(article(1, "X", point("(?)", p("x")))), "gdpr")).toThrow(
      /odd point label/,
    );
    expect(() => parseOjRegulation(doc(article(1, "X", para(2, 1, p("x")))), "gdpr")).toThrow(
      /paragraph 002.001 inside article 1/,
    );
    expect(() => parseOjRegulation(doc(article(1, "X", "<div>")), "gdpr")).toThrow();
    expect(() => parseOjRegulation(doc(article(1, "X", p("x") + "</span>")), "gdpr")).toThrow(
      /unbalanced/,
    );
    expect(() => parseOjRegulation("<html><body>", "gdpr")).toThrow(/unclosed/);
    expect(() => parseOjRegulation(doc(article(1, "X", article(2, "Y", p("x")))), "gdpr")).toThrow(
      /inside article/,
    );
  });
});
