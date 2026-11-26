import { describe, expect, it } from "vitest";
import {
  gdpr,
  getRule,
  ndaPlaybook,
  parseRulebook,
  ruleText,
  rulesOfArticle,
  type Rulebook,
} from "../src/index";

/** The value, or a test failure if it is missing (instead of a non-null assertion). */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

const tiny = (): Rulebook => ({
  source: {
    id: "t",
    title: "Tiny",
    url: "https://example.com/t",
    sourceSha256: "0".repeat(64),
    licence: "test",
    attribution: "test",
  },
  text: "First rule.\nSecond rule.",
  rules: [
    { id: "t:1", article: "1", title: "A", start: 0, end: 11 },
    { id: "t:2", article: "2", title: "B", start: 12, end: 24 },
  ],
});

describe("parseRulebook", () => {
  it("accepts a well-formed rulebook", () => {
    expect(parseRulebook(tiny()).rules).toHaveLength(2);
  });

  it("refuses duplicate IDs, foreign prefixes and bad offsets", () => {
    const edit = (f: (b: Rulebook) => void) => {
      const b = tiny();
      f(b);
      return () => parseRulebook(b);
    };
    expect(edit((b) => (must(b.rules[1]).id = "t:1"))).toThrow(/duplicate/);
    expect(edit((b) => (must(b.rules[1]).id = "x:2"))).toThrow(/prefix/);
    expect(edit((b) => (must(b.rules[1]).start = 5))).toThrow(/offsets/); // overlaps rule 1
    expect(edit((b) => (must(b.rules[1]).end = 99))).toThrow(/offsets/);
    expect(edit((b) => (must(b.rules[1]).end = 12))).toThrow(/offsets/); // empty
    expect(edit((b) => (must(b.rules[0]).end = 13))).toThrow(/offsets/); // runs into rule 2
    expect(edit((b) => (must(b.rules[0]).start = -1))).toThrow(/offsets/);
    expect(edit((b) => (b.text = "First rule.\n            "))).toThrow(/empty/);
    expect(edit((b) => (b.source.sourceSha256 = "abc"))).toThrow();
  });
});

describe("the GDPR rulebook (built from the Official Journal, D45)", () => {
  it("has all 99 articles and every rule on its own line", () => {
    expect(new Set(gdpr.rules.map((r) => r.article)).size).toBe(99);
    expect(gdpr.rules).toHaveLength(786);
    expect(gdpr.text.split("\n")).toHaveLength(gdpr.rules.length);
  });

  it("finds Article 28's processor terms by ID", () => {
    const a = getRule(gdpr, "gdpr:28(3)(a)");
    expect(a).toMatchObject({ article: "28", title: "Processor" });
    expect(ruleText(gdpr, must(a))).toMatch(
      /^processes the personal data only on documented instructions/,
    );
    expect(rulesOfArticle(gdpr, "28").map((r) => r.id)).toContain("gdpr:28(3)(h)");
    expect(ruleText(gdpr, must(getRule(gdpr, "gdpr:4(1)")))).toMatch(/^‘personal data’ means/);
    expect(getRule(gdpr, "gdpr:28(99)")).toBeUndefined();
  });

  it("names its source, licence and changes", () => {
    expect(gdpr.source.url).toMatch(/^https:\/\/publications\.europa\.eu\//);
    expect(gdpr.source.attribution).toMatch(/Changes:/);
  });
});

describe("the NDA playbook (ContractNLI's hypotheses, D45)", () => {
  it("has the 17 rules with ContractNLI's keys", () => {
    expect(ndaPlaybook.rules).toHaveLength(17);
    expect(ndaPlaybook.rules.map((r) => r.id)).toContain("nda:11");
    expect(ruleText(ndaPlaybook, must(getRule(ndaPlaybook, "nda:11")))).toMatch(/reverse engineer/);
    expect(getRule(ndaPlaybook, "nda:11")?.title).toBe("No reverse engineering");
  });
});
