import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { cuadAvailable, loadCuad, type CuadContract } from "../cuad/load";
import { loadQueries } from "../retrieval/sources";
import { allTypes, keywordTop1, prior, typeFrequency, type Predictions } from "./baselines";
import {
  extractionCorpus,
  pinnedSubset,
  type ExtractionChunk,
  type ExtractionDoc,
} from "./dataset";
import { checkQuote, occurrences, scoreChunk, TypeTally } from "./score";
import { CLAUSE_TYPES } from "@lexguard/extraction";

const TYPES = new Set(["Governing Law", "Anti-Assignment", "Insurance"]);

function chunkOf(text: string, spans: ExtractionChunk["spans"], start = 0): ExtractionChunk {
  return {
    doc: 0,
    idx: 0,
    start,
    end: start + text.length,
    expected: new Set(spans.map((s) => s.clauseType)),
    spans,
  };
}

describe("quote check (T3)", () => {
  const chunk = "12. Governing Law. This Agreement is governed by\nthe laws of New York.";

  it("accepts only a verbatim quote", () => {
    expect(checkQuote(chunk, "governed by\nthe laws of New York")).toBe("exact");
    expect(checkQuote(chunk, "governed by the laws of Delaware")).toBe("missing");
  });

  it("rejects a blank quote, which would match anywhere", () => {
    expect(checkQuote(chunk, "")).toBe("missing");
    expect(checkQuote(chunk, "   ")).toBe("missing");
  });

  it("tells whitespace-only differences apart, for diagnosis", () => {
    expect(checkQuote(chunk, "governed by the laws of New York")).toBe("whitespace");
    expect(checkQuote(chunk, "governed  by\tthe laws")).toBe("whitespace");
  });

  it("finds every occurrence, overlapping ones too", () => {
    expect(occurrences("aaaa", "aa")).toEqual([0, 1, 2]);
    expect(occurrences("abc", "")).toEqual([]);
  });
});

describe("scoring one chunk", () => {
  // Chunk 12 of a contract, starting at document offset 1,000. Lawyers labelled Governing
  // Law and Anti-Assignment in it (offsets in the document).
  const text =
    "This Agreement is governed by the laws of New York. " +
    "Neither party may assign this Agreement without consent. " +
    "Supplier shall maintain insurance.";
  const at = (s: string) => 1_000 + text.indexOf(s);
  const law = "governed by the laws of New York";
  const assign = "Neither party may assign this Agreement";
  const chunk = chunkOf(
    text,
    [
      { clauseType: "Governing Law", start: at(law), end: at(law) + law.length },
      { clauseType: "Anti-Assignment", start: at(assign), end: at(assign) + assign.length },
    ],
    1_000,
  );

  it("keeps verbatim quotes, rejects invented ones and unknown types", () => {
    const r = scoreChunk(
      chunk,
      text,
      [
        { clauseType: "Governing Law", quote: law },
        { clauseType: "Insurance", quote: "Supplier shall maintain insurance." },
        { clauseType: "Anti-Assignment", quote: "Either party may assign freely" },
        { clauseType: "Made Up Type", quote: law },
      ],
      TYPES,
    );
    expect([...r.predicted].sort()).toEqual(["Governing Law", "Insurance"]);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toEqual({ missing: 1, whitespace: 0, unknownType: 1 });
  });

  it("counts a quote as grounded only on a lawyer span of the same type", () => {
    const right = scoreChunk(chunk, text, [{ clauseType: "Governing Law", quote: law }], TYPES);
    expect(right.grounded).toBe(1);
    // Right type, wrong sentence: accepted, but not grounded.
    const wrongPlace = scoreChunk(
      chunk,
      text,
      [{ clauseType: "Governing Law", quote: "Supplier shall maintain insurance." }],
      TYPES,
    );
    expect(wrongPlace.accepted).toBe(1);
    expect(wrongPlace.grounded).toBe(0);
    // A real span, but of another type.
    const otherType = scoreChunk(chunk, text, [{ clauseType: "Insurance", quote: law }], TYPES);
    expect(otherType.grounded).toBe(0);
  });

  it("uses document offsets: the same words outside the span are not grounded", () => {
    const shifted = chunkOf(
      text,
      [{ clauseType: "Governing Law", start: 0, end: law.length }],
      1_000,
    );
    expect(
      scoreChunk(shifted, text, [{ clauseType: "Governing Law", quote: law }], TYPES).grounded,
    ).toBe(0);
  });
});

describe("per-type tally", () => {
  it("counts right, false alarm and missed per type (the example from the explanation)", () => {
    const tally = new TypeTally([...TYPES]);
    tally.add(
      new Set(["Governing Law", "Anti-Assignment"]),
      new Set(["Governing Law", "Insurance"]),
    );
    const { micro, byType } = tally.report();
    expect(micro).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
    expect(byType["Insurance"]).toMatchObject({ tp: 0, fp: 1, fn: 0, precision: 0 });
    expect(byType["Anti-Assignment"]).toMatchObject({ tp: 0, fp: 0, fn: 1, recall: 0 });
  });

  it("predicting every type gives recall 1 and low precision", () => {
    const tally = new TypeTally([...TYPES]);
    for (let i = 0; i < 9; i++) tally.add(new Set(), TYPES);
    tally.add(new Set(["Insurance"]), TYPES);
    const { micro } = tally.report();
    expect(micro.recall).toBe(1);
    expect(micro.precision).toBeCloseTo(1 / 30);
  });

  it("leaves types with no labels and no predictions out of the macro average", () => {
    // Insurance missed (F1 0). The two untouched types would score F1 1 by the empty-case
    // convention and lift the average to 2/3 if they were counted.
    const tally = new TypeTally([...TYPES]);
    tally.add(new Set(["Insurance"]), new Set());
    expect(tally.report().macroF1).toBe(0);
  });
});

describe("dataset", () => {
  const section = (n: number, body: string) =>
    `${String(n)}. Section ${String(n)}\n\n${body} ${"Lorem ipsum dolor sit amet. ".repeat(60)}\n\n`;
  const text =
    section(1, "Alpha terms.") + section(2, "Governed by Ohio law.") + section(3, "Gamma.");
  const quote = "Governed by Ohio law.";
  const contract: CuadContract = {
    title: "Tiny",
    text,
    spans: [
      { clauseType: "Governing Law", text: quote, start: text.indexOf(quote) },
      { clauseType: "Insurance", text: "wrong text", start: 0 }, // offset mismatch: skipped
    ],
  };

  it("labels exactly the chunk holding the span and keeps unlabelled chunks", () => {
    const [doc] = extractionCorpus([contract]);
    expect(doc?.chunks.length).toBeGreaterThan(1);
    const labelled = doc?.chunks.filter((c) => c.expected.size > 0) ?? [];
    expect(labelled).toHaveLength(1);
    const only = labelled[0];
    expect([...(only?.expected ?? [])]).toEqual(["Governing Law"]);
    expect(text.slice(only?.start, only?.end)).toContain(quote);
    expect(doc?.chunks.some((c) => c.expected.size === 0)).toBe(true);
  });

  it("does not label a chunk that a span only touches at its edge (end is exclusive)", () => {
    const [plain] = extractionCorpus([{ title: "Edge", text, spans: [] }]);
    const boundary = plain?.chunks[1]?.start ?? 0;
    expect(boundary).toBeGreaterThan(10);
    const before = text.slice(boundary - 10, boundary);
    const [doc] = extractionCorpus([
      {
        title: "Edge",
        text,
        spans: [{ clauseType: "Insurance", text: before, start: boundary - 10 }],
      },
    ]);
    expect([...(doc?.chunks[0]?.expected ?? [])]).toEqual(["Insurance"]);
    expect(doc?.chunks[1]?.expected.size).toBe(0);
  });

  it("picks the subset by hash, independent of input order", () => {
    const docs = ["a", "b", "c", "d", "e"].map((title) => ({ title }));
    const one = pinnedSubset(docs, 2).map((d) => d.title);
    const two = pinnedSubset([...docs].reverse(), 2).map((d) => d.title);
    expect(one).toEqual(two);
    expect(one).toHaveLength(2);
  });
});

describe("baselines", () => {
  const doc: ExtractionDoc = {
    title: "T",
    text: "The laws of Ohio govern this contract. Supplier keeps insurance cover.",
    chunks: [
      { doc: 0, idx: 0, start: 0, end: 38, expected: new Set(["Governing Law"]), spans: [] },
      { doc: 0, idx: 1, start: 38, end: 70, expected: new Set(), spans: [] },
    ],
  };

  it("keyword top-1 puts each type on the chunk that shares its words", () => {
    const p = keywordTop1([doc], new Map([["Governing Law", "Which law governs the contract?"]]));
    expect([...(p[0]?.[0] ?? [])]).toEqual(["Governing Law"]);
    expect(p[0]?.[1]?.size).toBe(0);
  });

  it("prior guesses are reproducible and follow type frequency", () => {
    const freq = typeFrequency([doc]);
    expect(freq.get("Governing Law")).toBe(0.5);
    const a = prior([doc], freq, 7).map((d) => d.map((s) => [...s]));
    expect(prior([doc], freq, 7).map((d) => d.map((s) => [...s]))).toEqual(a);
  });

  it("prior never guesses a type with frequency 0 and always one with frequency 1", () => {
    const p = prior(
      [doc],
      new Map([
        ["Always", 1],
        ["Never", 0],
      ]),
      3,
    );
    expect(p[0]?.map((s) => [...s])).toEqual([["Always"], ["Always"]]);
  });

  it("all-types predicts everything everywhere", () => {
    expect(allTypes([doc], [...TYPES])[0]?.[1]?.size).toBe(3);
  });
});

function evaluate(docs: readonly ExtractionDoc[], predictions: Predictions, types: string[]) {
  const tally = new TypeTally(types);
  docs.forEach((doc, d) => {
    doc.chunks.forEach((chunk, i) => {
      tally.add(chunk.expected, predictions[d]?.[i] ?? new Set());
    });
  });
  return tally.report();
}

describe.skipIf(!cuadAvailable())("CUAD extraction baselines", () => {
  type Report = ReturnType<typeof evaluate>;
  const results: Record<string, Record<string, Report>> = {};

  beforeAll(() => {
    const queries = loadQueries();
    const types = [...queries.keys()].sort();
    const full = extractionCorpus(loadCuad());
    const sets: Record<string, ExtractionDoc[]> = {
      all: full,
      subset10: pinnedSubset(full, 10),
      subset20: pinnedSubset(full, 20),
    };
    // Frequencies come from the full corpus, so the prior baseline knows the real base rates.
    const frequency = typeFrequency(full);
    for (const [name, docs] of Object.entries(sets)) {
      results[name] = {
        allTypes: evaluate(docs, allTypes(docs, types), types),
        prior: evaluate(docs, prior(docs, frequency), types),
        keywordTop1: evaluate(docs, keywordTop1(docs, queries), types),
      };
    }
    const size = (docs: ExtractionDoc[]) => ({
      contracts: docs.length,
      chunks: docs.reduce((n, d) => n + d.chunks.length, 0),
      labelledChunks: docs.reduce((n, d) => n + d.chunks.filter((c) => c.expected.size).length, 0),
      characters: docs.reduce((n, d) => n + d.text.length, 0),
    });
    writeFileSync(
      new URL("../results/cuad-extraction-baselines.json", import.meta.url),
      `${JSON.stringify(
        {
          sizes: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, size(v)])),
          subsets: Object.fromEntries(
            Object.entries(sets).map(([k, v]) => [k, v.map((d) => d.title)]),
          ),
          results,
        },
        null,
        2,
      )}\n`,
    );
  }, 600_000);

  it("the extractor's clause types and descriptions are CUAD's, verbatim", () => {
    const fromCuad = [...loadQueries()].sort(([a], [b]) => (a < b ? -1 : 1));
    expect(CLAUSE_TYPES.map(([name, description]) => `${name}: ${description}`)).toEqual(
      fromCuad.map(([, query]) => query),
    );
  });

  it("all-types reaches recall 1 with low precision", () => {
    expect(results["all"]?.["allTypes"]?.micro.recall).toBe(1);
    expect(results["all"]?.["allTypes"]?.micro.precision).toBeLessThan(0.05);
  });

  it("keyword search beats guessing by frequency", () => {
    const keyword = results["all"]?.["keywordTop1"]?.micro.f1 ?? 0;
    const guess = results["all"]?.["prior"]?.micro.f1 ?? 1;
    expect(keyword).toBeGreaterThan(guess);
  });
});
