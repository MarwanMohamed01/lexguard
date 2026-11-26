import { describe, expect, it } from "vitest";
import { gdpr, ndaPlaybook, searchRules, terms, type Rulebook } from "../src/index";

const book: Rulebook = {
  source: {
    id: "t",
    title: "Tiny",
    url: "https://example.com/t",
    sourceSha256: "0".repeat(64),
    licence: "test",
    attribution: "test",
  },
  text: [
    "The processor shall not engage another processor without written authorisation.",
    "Personal data shall be processed lawfully, fairly and in a transparent manner.",
    "The controller shall keep records of processing activities.",
    "Processors and sub-processors shall notify breaches.",
  ].join("\n"),
  rules: [],
};
let at = 0;
for (const [i, line] of book.text.split("\n").entries()) {
  book.rules.push({
    id: `t:${String(i + 1)}`,
    article: String(i + 1),
    title: "",
    start: at,
    end: at + line.length,
  });
  at += line.length + 1;
}

describe("terms", () => {
  it("lower-cases, drops stop words and strips simple plurals", () => {
    expect(terms("The Processors shall NOT engage the Sub-processors")).toEqual([
      "processor",
      "engage",
      "sub",
      "processor",
    ]);
    expect(terms("activities addresses class")).toEqual(["activity", "address", "class"]);
    expect(terms("Datenschutz-Grundverordnung 2016/679")).toEqual([
      "datenschutz",
      "grundverordnung",
      "2016",
      "679",
    ]);
  });
});

describe("searchRules", () => {
  it("ranks the rule that matches more, and rarer, query words first", () => {
    const hits = searchRules(book, "engage processor written authorisation");
    expect(hits[0]?.id).toBe("t:1");
    expect(hits.map((h) => h.id)).toContain("t:4"); // "processors" matches "processor"
    expect(hits.map((h) => h.id)).not.toContain("t:2"); // shares no query word
  });

  it("returns nothing for a query of only stop words or unknown words", () => {
    expect(searchRules(book, "the and of shall")).toEqual([]);
    expect(searchRules(book, "zebra")).toEqual([]);
  });

  it("respects the limit and keeps rulebook order on ties", () => {
    expect(searchRules(book, "processor", 1)).toHaveLength(1);
    expect(searchRules(book, "processor", 0)).toEqual([]);
    const tie: Rulebook = {
      ...book,
      text: "alpha\nalpha",
      rules: [
        { id: "t:1", article: "1", title: "", start: 0, end: 5 },
        { id: "t:2", article: "2", title: "", start: 6, end: 11 },
      ],
    };
    expect(searchRules(tie, "alpha").map((h) => h.id)).toEqual(["t:1", "t:2"]);
  });

  const lines = (...texts: string[]): Rulebook => {
    const rules: Rulebook["rules"] = [];
    let start = 0;
    texts.forEach((t, i) => {
      rules.push({
        id: `t:${String(i + 1)}`,
        article: String(i + 1),
        title: "",
        start,
        end: start + t.length,
      });
      start += t.length + 1;
    });
    return { ...book, text: texts.join("\n"), rules };
  };

  it("weighs a rare word above a common one (idf)", () => {
    // "processor" is in three rules, "authorisation" in one: the rare word decides.
    const b = lines("processor processor", "authorisation", "processor", "processor");
    expect(searchRules(b, "processor authorisation")[0]?.id).toBe("t:2");
  });

  it("prefers the shorter of two rules that match equally (length normalisation)", () => {
    const b = lines(
      "breach notification within a period set out in detail elsewhere",
      "breach report",
    );
    expect(searchRules(b, "breach").map((h) => h.id)).toEqual(["t:2", "t:1"]);
  });

  it("counts a repeated query word once", () => {
    const b = lines("processor", "processor processor authorisation", "authorisation");
    expect(searchRules(b, "processor processor authorisation")).toEqual(
      searchRules(b, "processor authorisation"),
    );
  });

  it("searches article titles too", () => {
    // Article 4's text starts "For the purposes of this Regulation:"; its title is Definitions.
    expect(searchRules(gdpr, "definitions", 1)[0]?.id).toBe("gdpr:4");
  });

  it("finds GDPR Article 28's sub-processor rule and the NDA reverse-engineering rule", () => {
    const top = searchRules(gdpr, "processor engage another processor written authorisation", 3);
    expect(top.map((h) => h.id)).toContain("gdpr:28(2)");
    expect(searchRules(ndaPlaybook, "reverse engineering", 1)[0]?.id).toBe("nda:11");
  });
});
