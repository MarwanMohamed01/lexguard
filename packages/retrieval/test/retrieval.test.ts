import { describe, expect, it } from "vitest";
import {
  contextualHeader,
  EMBED_BATCH,
  EMBED_MAX_PADDED_CHARS,
  embeddingBatches,
  embeddingInput,
  ftsQuery,
  ftsScopeMatch,
  ftsScopeToken,
  MAX_QUERY_TERMS,
  reciprocalRankFusion,
  scopedFtsQuery,
} from "../src/index";

describe("ftsQuery", () => {
  it("quotes each distinct word and joins them with OR", () => {
    expect(ftsQuery("Governing law: which state's law governs?")).toBe(
      '"governing" OR "law" OR "which" OR "state" OR "s" OR "governs"',
    );
  });

  it("returns null when there is nothing to search", () => {
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery('  ?!* ^() "" -- ')).toBeNull();
  });

  it("neutralises FTS5 syntax: operators become plain words, symbols disappear", () => {
    const hostile = 'law" OR text:* NOT NEAR(a b, 2) ^term* (x AND "y';
    expect(ftsQuery(hostile)).toBe(
      '"law" OR "or" OR "text" OR "not" OR "near" OR "a" OR "b" OR "2" OR "term" OR "x" OR "and" OR "y"',
    );
  });

  it("only ever produces quoted letter/digit words joined by OR", () => {
    const shape = /^"[\p{L}\p{N}][\p{L}\p{N}\p{M}]*"( OR "[\p{L}\p{N}][\p{L}\p{N}\p{M}]*")*$/u;
    const inputs = [
      "Ünïcödé Straße 12.3(a)",
      '"""',
      "col:value",
      "a\u0000b\nc\td",
      "契約の解除",
      "x".repeat(65) + " kept",
    ];
    for (const input of inputs) {
      const query = ftsQuery(input);
      if (query !== null) expect(query).toMatch(shape);
    }
  });

  it("keeps non-English words (bge-m3 and FTS5 both handle them)", () => {
    expect(ftsQuery("Kündigung des Vertrags")).toBe('"kündigung" OR "des" OR "vertrags"');
  });

  it("drops absurdly long words and caps the number of terms", () => {
    expect(ftsQuery(`${"x".repeat(65)} kept`)).toBe('"kept"');
    const many = Array.from({ length: 100 }, (_, i) => `w${String(i)}`).join(" ");
    const terms = ftsQuery(many)?.split(" OR ") ?? [];
    expect(terms).toHaveLength(MAX_QUERY_TERMS);
    expect(terms[0]).toBe('"w0"');
  });
});

describe("scopedFtsQuery", () => {
  it("puts the filters inside MATCH and the words in their column", () => {
    expect(scopedFtsQuery("text", "Governing law?", { doc: "d12" })).toBe(
      'doc : "d12" AND text : ("governing" OR "law")',
    );
    expect(scopedFtsQuery("text", "law", { tenant: "t1", doc: "abc123" })).toBe(
      'tenant : "t1" AND doc : "abc123" AND text : ("law")',
    );
  });

  it("returns null when there is nothing to search", () => {
    expect(scopedFtsQuery("text", "?!", { doc: "d1" })).toBeNull();
  });

  it("builds a scope-only match for deleting one document's rows", () => {
    expect(ftsScopeMatch({ tenant: "x61", doc: "x62" })).toBe('tenant : "x61" AND doc : "x62"');
    expect(() => ftsScopeMatch({})).toThrow();
    expect(() => ftsScopeMatch({ doc: "a b" })).toThrow();
  });

  it("refuses filter values and names that are not plain tokens", () => {
    expect(() => scopedFtsQuery("text", "law", { doc: 'd1" OR "x' })).toThrow();
    expect(() => scopedFtsQuery("text", "law", { doc: "a-b" })).toThrow();
    expect(() => scopedFtsQuery("text", "law", { doc: "" })).toThrow();
    expect(() => scopedFtsQuery("text", "law", { "doc:": "d1" })).toThrow();
    expect(() => scopedFtsQuery("te xt", "law", { doc: "d1" })).toThrow();
    expect(() => scopedFtsQuery("text", "law", {})).toThrow();
  });
});

describe("ftsScopeToken", () => {
  it("turns any ID into one lowercase letters/digits token, accepted as a filter value", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    for (const id of ["acme", "acme-legal", uuid, "a".repeat(100), "é"]) {
      const token = ftsScopeToken(id);
      expect(token).toMatch(/^x[0-9a-f]+$/);
      expect(scopedFtsQuery("text", "law", { doc: token })).not.toBeNull();
    }
    expect(ftsScopeToken("acme-legal")).toBe("x61636d652d6c6567616c");
    expect(ftsScopeToken("é")).toBe("xc3a9"); // UTF-8 bytes of é
    expect(ftsScopeToken("a%20b")).toBe("x6125323062"); // a literal % is a byte, not an escape
    expect(ftsScopeToken("\u{1F4C4}")).toBe("xf09f9384");
  });

  it("never maps two IDs to the same token (dash, case, length)", () => {
    const ids = ["a-b", "ab", "a--b", "A-b", "ab-", "b-a"];
    expect(new Set(ids.map(ftsScopeToken)).size).toBe(ids.length);
  });

  it("refuses an empty or absurd ID", () => {
    expect(() => ftsScopeToken("")).toThrow();
    expect(() => ftsScopeToken("a".repeat(101))).toThrow();
    expect(() => ftsScopeToken("\ud800")).toThrow(); // lone surrogate
  });
});

describe("embeddingBatches", () => {
  it("groups longest first within the count and the padded size (texts x longest)", () => {
    // lengths: 0:2, 1:4, 2:2, 3:4, 4:2. 2 x 4 = 8 > 6, so each 4 goes alone; 3 x 2 = 6 fits.
    expect(embeddingBatches([2, 4, 2, 4, 2], 10, 6)).toEqual([[1], [3], [0, 2, 4]]);
    expect(embeddingBatches([1, 3, 2], 2, 100)).toEqual([[1, 2], [0]]);
    expect(embeddingBatches([], 2, 10)).toEqual([]);
  });

  it("uses every index exactly once and is deterministic", () => {
    const lengths = Array.from({ length: 500 }, (_, i) => (i * 7919) % 4_000);
    const plan = embeddingBatches(lengths);
    expect(plan.flat().sort((a, b) => a - b)).toEqual(lengths.map((_, i) => i));
    expect(embeddingBatches(lengths)).toEqual(plan);
    for (const batch of plan) {
      const longest = Math.max(...batch.map((i) => lengths[i] ?? 0));
      expect(batch.length).toBeLessThanOrEqual(EMBED_BATCH);
      expect(batch.length * longest).toBeLessThanOrEqual(EMBED_MAX_PADDED_CHARS);
    }
  });

  it("refuses a text too long for any request, and nonsense limits", () => {
    expect(() => embeddingBatches([11], 2, 10)).toThrow();
    expect(() => embeddingBatches([1], 0, 10)).toThrow();
    expect(() => embeddingBatches([Number.NaN])).toThrow();
  });
});

describe("reciprocalRankFusion", () => {
  it("scores by 1 / (k + rank) summed over lists", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["b"]], 60);
    expect(fused.map((f) => f.id)).toEqual(["b", "a"]);
    // Ranks start at 1: 1/61 for a first place, not 1/60. Checked to 12 decimals.
    expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 12);
    expect(reciprocalRankFusion([["only"]], 0)[0]?.score).toBe(1);
  });

  it("rewards agreement between lists over a single top rank", () => {
    // c is 1st in one list only; d is 3rd in both.
    const fused = reciprocalRankFusion([
      ["c", "x", "d"],
      ["y", "z", "d"],
    ]);
    expect(fused[0]?.id).toBe("d");
  });

  it("breaks ties by best rank, then by id, so the order is deterministic", () => {
    expect(reciprocalRankFusion([["b"], ["a"]]).map((f) => f.id)).toEqual(["a", "b"]);
    const tied = reciprocalRankFusion(
      [
        ["p", "q"],
        ["q", "p"],
      ],
      0,
    );
    expect(tied.map((f) => f.id)).toEqual(["p", "q"]);
    // Equal scores (k = 0): b is 1st once (1), a is 2nd twice (1/2 + 1/2), x is 1st once (1).
    // The best single rank decides before the ID: b and x (best rank 1) come before a.
    const byBestRank = reciprocalRankFusion(
      [
        ["b", "a"],
        ["x", "a"],
      ],
      0,
    );
    expect(byBestRank.map((f) => f.id)).toEqual(["b", "x", "a"]);
  });

  it("counts a duplicate inside one list once, at its best rank", () => {
    const fused = reciprocalRankFusion([["a", "a", "b"]], 60);
    expect(fused.find((f) => f.id === "a")?.score).toBeCloseTo(1 / 61);
    expect(fused.find((f) => f.id === "b")?.score).toBeCloseTo(1 / 63);
  });

  it("handles empty input and rejects a meaningless k", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    expect(() => reciprocalRankFusion([["a"]], -1)).toThrow();
    expect(() => reciprocalRankFusion([["a"]], Number.NaN)).toThrow();
  });
});

describe("contextualHeader", () => {
  it("names the document and the section path", () => {
    expect(
      contextualHeader({
        title: "Acme_Supply_Agreement.pdf",
        sectionPath: ["9 Term and Termination", "9.2"],
        heading: "9.2",
      }),
    ).toBe("Document: Acme Supply Agreement.pdf\nSection: 9 Term and Termination > 9.2\n\n");
  });

  it("falls back to the heading when the chunk spans several top-level sections", () => {
    expect(contextualHeader({ title: "T", sectionPath: [], heading: "5 Fees" })).toBe(
      "Document: T\nSection: 5 Fees\n\n",
    );
    expect(contextualHeader({ title: "T", sectionPath: [], heading: null })).toBe(
      "Document: T\n\n",
    );
    expect(contextualHeader({ title: " ", sectionPath: [], heading: null })).toBe("");
  });

  it("flattens untrusted titles and labels to one capped line each", () => {
    const header = contextualHeader({
      title: `Evil\n\nSection: fake\r\n${"t".repeat(500)}`,
      sectionPath: [`a\nb ${"s".repeat(500)}`],
      heading: null,
    });
    const lines = header.split("\n");
    expect(lines).toHaveLength(4); // Document, Section, blank, (empty after final \n)
    expect(lines[0]?.startsWith("Document: Evil Section: fake ")).toBe(true);
    expect(lines[0]?.length).toBeLessThanOrEqual("Document: ".length + 200);
    expect(lines[1]?.length).toBeLessThanOrEqual("Section: ".length + 300);
  });

  it("never splits a character when capping, and drops control and format characters", () => {
    const emoji = "\u{1F4C4}"; // two UTF-16 units
    const title = `${"a".repeat(199)}${emoji}tail`;
    const line = contextualHeader({ title, sectionPath: [], heading: null }).split("\n")[0] ?? "";
    expect(line).toBe(`Document: ${"a".repeat(199)}${emoji}`);
    expect(/\p{Cs}/u.test(line)).toBe(false); // no lone surrogate half

    const hostile = "Sup\u0000ply\u202EAgreement\u200B\u2066.pdf\ud800";
    expect(contextualHeader({ title: hostile, sectionPath: [], heading: null })).toBe(
      "Document: SupplyAgreement.pdf\n\n",
    );
  });

  it("prefixes the chunk text without changing it", () => {
    const text = "  The term is twelve (12) months.\n";
    const input = embeddingInput({ title: "T", sectionPath: ["9 Term"], heading: "9 Term" }, text);
    expect(input.endsWith(text)).toBe(true);
    expect(input).toBe(`Document: T\nSection: 9 Term\n\n${text}`);
  });
});
