import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { cuadAvailable } from "../cuad/load";
import { pairedComparison, type PairedResult } from "../shared/paired";
import { meanScores, scoreRanking, type RankScores } from "../shared/ranking";
import {
  casesFor,
  chunkInput,
  overlapping,
  queryFromQuestion,
  type Corpus,
  type Variant,
} from "./dataset";
import { batches, DIMENSIONS, EmbeddingCache, estimateNeurons, NeuronLedger } from "./embeddings";
import {
  dot,
  hybridSearch,
  KeywordIndex,
  normalize,
  randomRanking,
  vectorSearch,
  type Tokenizer,
} from "./search";
import { loadCorpora, loadQueries } from "./sources";

describe("ranking metrics", () => {
  it("scores a ranking against the relevant set", () => {
    const s = scoreRanking([7, 3, 9, 1], [3, 1]);
    expect(s.hit1).toBe(0);
    expect(s.hit5).toBe(1);
    expect(s.recall5).toBe(1);
    expect(s.mrr10).toBe(0.5);
    // DCG = 1/log2(3) + 1/log2(5); ideal = 1 + 1/log2(3)
    expect(s.ndcg10).toBeCloseTo((1 / Math.log2(3) + 1 / Math.log2(5)) / (1 + 1 / Math.log2(3)));
  });

  it("gives zero when nothing relevant is in the top 10", () => {
    const ranking = Array.from({ length: 12 }, (_, i) => i);
    expect(scoreRanking(ranking, [11])).toMatchObject({
      hit5: 0,
      recall10: 0,
      mrr10: 0,
      ndcg10: 0,
    });
    expect(scoreRanking([], [1]).ndcg10).toBe(0);
  });

  it("refuses a case with no relevant item", () => {
    expect(() => scoreRanking([1], [])).toThrow();
  });

  it("averages per metric", () => {
    const one: RankScores = { hit1: 1, hit5: 1, recall5: 1, recall10: 1, mrr10: 1, ndcg10: 1 };
    const zero: RankScores = { hit1: 0, hit5: 0, recall5: 0, recall10: 0, mrr10: 0, ndcg10: 0 };
    expect(meanScores([one, zero])).toMatchObject({ cases: 2, hit1: 0.5, ndcg10: 0.5 });
  });
});

describe("dataset", () => {
  it("turns a CUAD question into category + description", () => {
    expect(
      queryFromQuestion(
        'Highlight the parts (if any) of this contract related to "Governing Law" that should be reviewed by a lawyer. Details: Which state/country\'s law governs the interpretation of the contract?',
      ),
    ).toBe("Governing Law: Which state/country's law governs the interpretation of the contract?");
    expect(() => queryFromQuestion("What is the governing law?")).toThrow();
  });

  it("marks every chunk a span touches as relevant, and only those", () => {
    const chunks = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ];
    expect(overlapping(chunks, [{ start: 5, end: 15 }])).toEqual([0, 1]);
    expect(overlapping(chunks, [{ start: 10, end: 20 }])).toEqual([1]); // end is exclusive
    expect(overlapping(chunks, [{ start: 30, end: 31 }])).toEqual([]);
  });

  it("makes one case per labelled clause type", () => {
    const chunks = [
      { start: 0, end: 10, heading: null, sectionPath: [] },
      { start: 10, end: 20, heading: null, sectionPath: [] },
    ];
    const cases = casesFor(3, chunks, [
      { clauseType: "Law", start: 12, end: 14 },
      { clauseType: "Term", start: 1, end: 2 },
      { clauseType: "Law", start: 2, end: 3 },
    ]);
    expect(cases).toEqual([
      { doc: 3, clauseType: "Law", relevant: [0, 1] },
      { doc: 3, clauseType: "Term", relevant: [0] },
    ]);
  });

  it("embeds the header only in the header variant, never changing the text", () => {
    const doc = {
      title: "Acme_Agreement",
      text: "1 Term. Twelve months.",
      chunks: [{ start: 0, end: 22, heading: "1 Term", sectionPath: ["1 Term"] }],
    };
    const chunk = doc.chunks[0];
    if (chunk === undefined) throw new Error("fixture");
    expect(chunkInput(doc, chunk, "plain")).toBe(doc.text);
    expect(chunkInput(doc, chunk, "header")).toBe(
      `Document: Acme Agreement\nSection: 1 Term\n\n${doc.text}`,
    );
  });
});

describe("keyword search (real FTS5)", () => {
  const docs = [
    {
      title: "A",
      text: "Governing law. This Agreement is governed by the laws of New York.RIGHTS10.1 Except",
      chunks: [
        { start: 0, end: 14, heading: null, sectionPath: [] },
        { start: 14, end: 67, heading: null, sectionPath: [] },
        { start: 67, end: 84, heading: null, sectionPath: [] },
      ],
    },
    {
      title: "B",
      text: "Governing law: Delaware.",
      chunks: [{ start: 0, end: 24, heading: null, sectionPath: [] }],
    },
  ];

  it("ranks within one document only, and survives hostile query text", () => {
    const index = new KeywordIndex(docs);
    expect(index.search(1, "law")).toEqual([0]);
    expect(index.search(0, 'law" OR text:* NEAR(')).toEqual([0]);
    expect(index.search(0, "?!")).toEqual([]);
    index.close();
  });

  it("needs stemming to match 'law governs' with 'governed by the laws'", () => {
    const plain = new KeywordIndex(docs, "unicode61");
    expect(plain.search(0, "Which law governs?")).toEqual([0]); // only the heading
    plain.close();
    const porter = new KeywordIndex(docs, "porter unicode61");
    expect([...porter.search(0, "Which law governs?")].sort()).toEqual([0, 1]);
    porter.close();
  });

  it("cannot find a word glued to a number by PDF conversion (D21)", () => {
    const index = new KeywordIndex(docs);
    expect(index.search(0, "rights")).toEqual([]); // "RIGHTS10" is one token
    index.close();
  });
});

describe("vector and hybrid search", () => {
  it("ranks by cosine, then fuses with keyword ranks", () => {
    const q = normalize(Float32Array.from([1, 0]));
    const chunks = [
      [0, 1],
      [1, 1],
      [1, 0],
    ].map((v) => normalize(Float32Array.from(v)));
    expect(vectorSearch(q, chunks)).toEqual([2, 1, 0]);
    expect(hybridSearch([0, 1], [2, 1])[0]).toBe(1); // 2nd in both beats 1st in one only
  });

  it("gives a reproducible random baseline", () => {
    expect(randomRanking(10, 7)).toEqual(randomRanking(10, 7));
    expect([...randomRanking(10, 7)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("embedding cache and daily Neuron cap", () => {
  const fakeEmbedder = (neuronsPerCall: number | null) => {
    const calls: string[][] = [];
    return {
      calls,
      embedder: {
        name: "fake",
        batch: 2,
        maxPaddedChars: 1_000,
        embed(texts: readonly string[]) {
          calls.push([...texts]);
          const vectors = texts.map((t) => {
            const v = new Float32Array(DIMENSIONS);
            v[t.length % DIMENSIONS] = 2; // not unit length: the cache must normalize
            return v;
          });
          return Promise.resolve({ vectors, neurons: neuronsPerCall });
        },
      },
    };
  };
  const tempDir = () => pathToFileURL(`${mkdtempSync(join(tmpdir(), "lexguard-embed-"))}/`);

  it("stops before a batch that could pass the cap, and the next run resumes", async () => {
    const dir = tempDir();
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    // Longest first, two per batch; cap with room for exactly the first two batches.
    const cap = estimateNeurons(["eeeee", "dddd"]) + estimateNeurons(["ccc", "bb"]);
    const { embedder, calls } = fakeEmbedder(0);
    const ledger = new NeuronLedger(cap, dir);
    // The fake reports 0 Neurons, so only the estimate stops it: record by hand.
    const spending = {
      ...embedder,
      async embed(batch: readonly string[]) {
        const result = await embedder.embed(batch);
        return { ...result, neurons: estimateNeurons(batch) };
      },
    };
    const left = await new EmbeddingCache("fake", dir).fill(texts, spending, undefined, ledger);
    expect(calls).toEqual([
      ["eeeee", "dddd"],
      ["ccc", "bb"],
    ]);
    expect(left).toBe(1);
    expect(new NeuronLedger(cap, dir).spentToday()).toBeCloseTo(cap); // persisted

    // A new cache object reads what was saved; with a bigger cap only the rest is embedded.
    const resumed = new EmbeddingCache("fake", dir);
    expect(resumed.missing(texts)).toEqual(["a"]);
    expect(await resumed.fill(texts, spending, undefined, new NeuronLedger(cap * 2, dir))).toBe(0);
    expect(calls.at(-1)).toEqual(["a"]);
  });

  it("stores unit-length vectors keyed by the exact text", async () => {
    const dir = tempDir();
    const { embedder } = fakeEmbedder(null);
    await new EmbeddingCache("fake", dir).fill(["x", "x ", "x"], embedder);
    const cache = new EmbeddingCache("fake", dir);
    const v = cache.get("x");
    expect(v).toBeDefined();
    expect(Math.sqrt(dot(v as Float32Array, v as Float32Array))).toBeCloseTo(1);
    expect(cache.get("x ")).toBeDefined(); // a trailing space is a different text
    expect(cache.get("y")).toBeUndefined();
  });

  it("batches longest first, within the count and the padded size (texts x longest)", () => {
    expect(batches(["a", "ccc", "bb"], 2, 100)).toEqual([["ccc", "bb"], ["a"]]);
    // 2 x 4 = 8 > 6, so each 4-char text goes alone; then 3 x 2 = 6 fits.
    expect(batches(["aa", "bbbb", "cc", "dddd", "ee"], 10, 6)).toEqual([
      ["bbbb"],
      ["dddd"],
      ["aa", "cc", "ee"],
    ]);
    expect(batches([], 2, 10)).toEqual([]);
    expect(() => batches(["x".repeat(11)], 2, 10)).toThrow();
  });

  it("estimates Neurons on the padded size", () => {
    expect(estimateNeurons(["x".repeat(300), "y"])).toBeCloseTo(estimateNeurons(["x".repeat(600)]));
  });

  it("refuses a meaningless cap", () => {
    expect(() => new NeuronLedger(Number.NaN, tempDir())).toThrow();
    expect(() => new NeuronLedger(-1, tempDir())).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The eval on CUAD. Keyword search runs wherever CUAD is downloaded (CI included); vector and
// hybrid need the embedding cache (npm run embed:cuad, local only) and are skipped without it.

const EMBEDDERS = ["ollama-bge-m3", "workers-ai-bge-m3"] as const;

interface MethodReport {
  method: string;
  all: ReturnType<typeof meanScores>;
  byClauseType: Record<string, { cases: number; hit5: number; mrr10: number }>;
}

interface CorpusReport {
  corpus: string;
  documents: number;
  chunks: number;
  cases: number;
  unlocatedSpans?: number;
  methods: MethodReport[];
  /** Per-question comparisons of two methods (D42), clustered by contract. */
  comparisons: { question: string; mrr10: PairedResult; hit5: PairedResult }[];
  skipped: string[];
}

// The production methods (D30, D42) and the questions the paired comparison answers.
const KEYWORD = "keyword (FTS5 porter unicode61)";
const HYBRID_PLAIN = "hybrid RRF (workers-ai-bge-m3, plain + FTS5 porter unicode61)";
const HYBRID_HEADER = "hybrid RRF (workers-ai-bge-m3, header + FTS5 porter unicode61)";
const COMPARISONS = [
  { question: "porter stemming vs none", baseline: "keyword (FTS5 unicode61)", candidate: KEYWORD },
  { question: "hybrid vs keyword", baseline: KEYWORD, candidate: HYBRID_PLAIN },
  { question: "header vs plain (hybrid)", baseline: HYBRID_PLAIN, candidate: HYBRID_HEADER },
  {
    question: "header vs plain (vector)",
    baseline: "vector (workers-ai-bge-m3, plain)",
    candidate: "vector (workers-ai-bge-m3, header)",
  },
] as const;

function evaluate(corpus: Corpus, queries: Map<string, string>): CorpusReport {
  const report: CorpusReport = {
    corpus: corpus.name,
    documents: corpus.docs.length,
    chunks: corpus.docs.reduce((n, d) => n + d.chunks.length, 0),
    cases: corpus.cases.length,
    methods: [],
    comparisons: [],
    skipped: [],
  };
  const perCase = new Map<string, RankScores[]>();
  const query = (type: string) => {
    const q = queries.get(type);
    if (q === undefined) throw new Error(`no question for ${type}`);
    return q;
  };
  const measure = (method: string, rank: (c: Corpus["cases"][number]) => number[]) => {
    const scored = corpus.cases.map((c) => ({
      type: c.clauseType,
      s: scoreRanking(rank(c), c.relevant),
    }));
    perCase.set(
      method,
      scored.map((x) => x.s),
    );
    const byType = new Map<string, RankScores[]>();
    for (const { type, s } of scored) byType.set(type, [...(byType.get(type) ?? []), s]);
    const methodReport: MethodReport = {
      method,
      all: meanScores(scored.map((x) => x.s)),
      byClauseType: Object.fromEntries(
        [...byType]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([type, list]) => {
            const m = meanScores(list);
            return [type, { cases: m.cases, hit5: m.hit5, mrr10: m.mrr10 }];
          }),
      ),
    };
    report.methods.push(methodReport);
    return methodReport;
  };

  measure("random", (c) =>
    randomRanking(corpus.docs[c.doc]?.chunks.length ?? 0, c.doc * 41 + c.relevant.length),
  );

  const keyword = new Map<Tokenizer, Map<string, number[]>>();
  for (const tokenizer of ["unicode61", "porter unicode61"] as const) {
    const index = new KeywordIndex(corpus.docs, tokenizer);
    const results = new Map<string, number[]>();
    measure(`keyword (FTS5 ${tokenizer})`, (c) => {
      const ranking = index.search(c.doc, query(c.clauseType));
      results.set(`${String(c.doc)}|${c.clauseType}`, ranking);
      return ranking;
    });
    keyword.set(tokenizer, results);
    index.close();
  }

  for (const embedder of EMBEDDERS) {
    const cache = new EmbeddingCache(embedder);
    for (const variant of ["plain", "header"] as const satisfies readonly Variant[]) {
      const label = `${embedder}, ${variant}`;
      // Every vector must be cached, or this embedder/variant is skipped (never partly scored).
      const vectors: Float32Array[][] = [];
      const queryVectors = new Map<string, Float32Array>();
      let complete = true;
      for (const doc of corpus.docs) {
        const row: Float32Array[] = [];
        for (const chunk of doc.chunks) {
          const v = cache.get(chunkInput(doc, chunk, variant));
          if (v === undefined) complete = false;
          else row.push(v);
        }
        vectors.push(row);
      }
      for (const [type, q] of queries) {
        const v = cache.get(q);
        if (v === undefined) complete = false;
        else queryVectors.set(type, v);
      }
      if (!complete) {
        report.skipped.push(`${label}: embeddings not cached`);
        continue;
      }
      const vectorRanking = (c: Corpus["cases"][number]) => {
        const q = queryVectors.get(c.clauseType);
        if (q === undefined) throw new Error(`no query vector for ${c.clauseType}`);
        return vectorSearch(q, vectors[c.doc] ?? []);
      };
      measure(`vector (${label})`, vectorRanking);
      for (const [tokenizer, results] of keyword) {
        measure(`hybrid RRF (${label} + FTS5 ${tokenizer})`, (c) =>
          hybridSearch(results.get(`${String(c.doc)}|${c.clauseType}`) ?? [], vectorRanking(c)),
        );
      }
    }
  }

  const groups = corpus.cases.map((c) => c.doc);
  for (const { question, baseline, candidate } of COMPARISONS) {
    const a = perCase.get(baseline);
    const b = perCase.get(candidate);
    if (a === undefined || b === undefined) continue;
    report.comparisons.push({
      question,
      mrr10: pairedComparison(
        a.map((s) => s.mrr10),
        b.map((s) => s.mrr10),
        groups,
      ),
      hit5: pairedComparison(
        a.map((s) => s.hit5),
        b.map((s) => s.hit5),
        groups,
      ),
    });
  }
  return report;
}

describe.skipIf(!cuadAvailable())("CUAD retrieval", () => {
  let reports: CorpusReport[];

  beforeAll(() => {
    const queries = loadQueries();
    const { text, converted } = loadCorpora();
    reports = [evaluate(text, queries)];
    if (converted !== null) {
      reports.push({ ...evaluate(converted, queries), unlocatedSpans: converted.unlocated });
    }
    writeFileSync(
      new URL("../results/cuad-retrieval.json", import.meta.url),
      `${JSON.stringify({ queries: Object.fromEntries(queries), reports }, null, 2)}\n`,
    );
  }, 600_000);

  it("has a query for each of CUAD's 41 clause types and cases to score", () => {
    expect(reports[0]?.cases).toBeGreaterThan(5_000);
  });

  it("keyword search beats a random order", () => {
    const methods = reports[0]?.methods ?? [];
    const random = methods.find((m) => m.method === "random")?.all.mrr10 ?? 1;
    const keyword = methods.find((m) => m.method.startsWith("keyword"))?.all.mrr10 ?? 0;
    expect(keyword).toBeGreaterThan(random);
  });

  // Gates (D42). Measured on CUAD text: keyword MRR@10 0.5677, hit@5 0.7204; hybrid 0.5901,
  // 0.7471. The eval is deterministic, so a drop below these floors is a real regression.
  const method = (name: string) => reports[0]?.methods.find((m) => m.method === name);
  const comparison = (question: string) =>
    reports[0]?.comparisons.find((c) => c.question === question);

  it("gate: production keyword search keeps its quality (runs in CI)", () => {
    expect(method(KEYWORD)?.all.mrr10).toBeGreaterThanOrEqual(0.56);
    expect(method(KEYWORD)?.all.hit5).toBeGreaterThanOrEqual(0.71);
    expect(comparison("porter stemming vs none")?.mrr10.ci95[0]).toBeGreaterThan(0);
  });

  // Needs the embedding cache (local only): skipped in CI, like the vector rows above.
  it("gate: hybrid search keeps its quality and stays really better than keyword", (ctx) => {
    const hybrid = method(HYBRID_PLAIN);
    if (hybrid === undefined) ctx.skip();
    expect(hybrid?.all.mrr10).toBeGreaterThanOrEqual(0.58);
    expect(hybrid?.all.hit5).toBeGreaterThanOrEqual(0.74);
    expect(comparison("hybrid vs keyword")?.mrr10.ci95[0]).toBeGreaterThan(0);
    expect(comparison("hybrid vs keyword")?.hit5.ci95[0]).toBeGreaterThan(0);
  });

  it("the contextual header stays off: it does not help (D42)", (ctx) => {
    const header = comparison("header vs plain (hybrid)");
    if (header === undefined) ctx.skip();
    expect(header?.mrr10.ci95[1]).toBeLessThanOrEqual(0);
  });
});
