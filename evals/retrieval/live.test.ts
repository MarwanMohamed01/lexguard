// Scores M3 step 7's real run (live-run.mjs): the real Worker, bge-m3 and Vectorize, on the
// 30 converted CUAD PDFs. Cases come from the run's own stored text and chunks (labels located
// as in the offline eval, dataset.ts), so the numbers are comparable with D26's exact-search
// results on the same documents. Skipped until a run exists (local only, like conversion).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { cuadAvailable, loadCuad } from "../cuad/load";
import { meanScores, scoreRanking, type RankScores } from "../shared/ranking";
import { convertedCorpus, type ConvertedDoc } from "./dataset";
import { loadQueries } from "./sources";

const RUN = new URL("../data/retrieval/live-run.json", import.meta.url);

interface LiveSearch {
  clauseType: string;
  mode: "keyword" | "vector" | "hybrid";
  status: number;
  ms: number;
  degraded: string[] | null;
  ranking: number[];
}

interface LiveDoc extends ConvertedDoc {
  id: string | null;
  indexStatus: string | null;
  indexedMs: number;
  searchableMs: number | null;
  searches: LiveSearch[];
}

interface LiveRun {
  queries: Record<string, string>;
  documents: LiveDoc[];
  isolation: {
    otherTenantStatus: number;
    ownVectorResults: number;
    ownSearchableMs?: number;
  } | null;
  vectorCount: { before: number | null; expected: number; actual: number | null } | null;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
};

function scoreRun(run: LiveRun) {
  const indexed = run.documents.filter((d) => d.indexStatus === "indexed");
  const corpus = convertedCorpus(indexed, loadCuad());
  const byTitle = new Map(indexed.map((d) => [d.title, d]));

  const scores: Record<string, RankScores[]> = { keyword: [], vector: [], hybrid: [] };
  let missing = 0;
  for (const c of corpus.cases) {
    const doc = byTitle.get(corpus.docs[c.doc]?.title ?? "");
    for (const mode of ["keyword", "vector", "hybrid"] as const) {
      const search = doc?.searches.find((s) => s.clauseType === c.clauseType && s.mode === mode);
      if (search === undefined) {
        missing++;
        continue;
      }
      scores[mode]?.push(scoreRanking(search.ranking, c.relevant));
    }
  }
  const all = indexed.flatMap((d) => d.searches);
  const report = {
    documents: run.documents.length,
    indexed: indexed.length,
    cases: corpus.cases.length,
    unlocatedSpans: corpus.unlocated,
    missingSearches: missing,
    modes: Object.fromEntries(Object.entries(scores).map(([mode, s]) => [mode, meanScores(s)])),
    latencyMs: Object.fromEntries(
      (["keyword", "vector", "hybrid"] as const).map((mode) => {
        const ms = all.filter((s) => s.mode === mode).map((s) => s.ms);
        return [mode, { p50: percentile(ms, 50), p95: percentile(ms, 95) }];
      }),
    ),
    searchableAfterIndexedMs: {
      p50: percentile(
        indexed.flatMap((d) => (d.searchableMs === null ? [] : [d.searchableMs])),
        50,
      ),
      max: Math.max(0, ...indexed.map((d) => d.searchableMs ?? Infinity)),
    },
    indexedMs: {
      p50: percentile(
        indexed.map((d) => d.indexedMs),
        50,
      ),
      max: Math.max(...indexed.map((d) => d.indexedMs)),
    },
    searches: all.length,
    // Errors other than the vector side being unavailable (503): must be none.
    errors: all.filter((s) => s.status !== 200 && s.status !== 503).length,
    // Transient vector-side failures (D31); the endpoint now retries once (search.ts).
    vectorUnavailable: all.filter((s) => s.status === 503).length,
    degraded: all.filter((s) => (s.degraded ?? []).length > 0).length,
    isolation: run.isolation,
    vectorCount: run.vectorCount,
  };
  return report;
}

// The run file exists only on the machine that made the run (evals/data/ is git-ignored).
// Vitest runs a describe body even when the suite is skipped, to collect its test names, so
// the file is read in beforeAll, which a skipped suite never runs (CI failed on this, D38).
describe.skipIf(!cuadAvailable() || !existsSync(RUN))("M3 step 7: real retrieval run", () => {
  let run: LiveRun;
  let report: ReturnType<typeof scoreRun>;

  beforeAll(() => {
    run = JSON.parse(readFileSync(RUN, "utf8")) as LiveRun;
    report = scoreRun(run);
    writeFileSync(
      new URL("../results/cuad-retrieval-live.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }, 600_000);

  it("used exactly the eval's queries", () => {
    expect(run.queries).toEqual(Object.fromEntries(loadQueries()));
  });

  it("indexed every document and answered every search", () => {
    expect(report.indexed).toBe(report.documents);
    expect(report.missingSearches).toBe(0);
    expect(report.errors).toBe(0);
    // At most 1 in 1,000: the 30-PDF run of 2026-11-25 had 1 of 3,690, before the retry.
    expect(report.vectorUnavailable).toBeLessThanOrEqual(Math.floor(report.searches / 1_000));
    expect(report.degraded).toBe(0);
  });

  it("kept tenants apart on the real index", () => {
    // Another tenant asking for this tenant's copy: 404, exactly like a missing document.
    expect(run.isolation?.otherTenantStatus).toBe(404);
    // The owner's vector search works on the same text, from its own namespace.
    expect(run.isolation?.ownVectorResults).toBeGreaterThan(0);
  });

  it("D1's vector count matches Vectorize's own", () => {
    expect(run.vectorCount?.actual).toBe(run.vectorCount?.expected);
  });

  it("every mode beats a random order by a wide margin", () => {
    // Random order on these documents: MRR@10 0.125 (D26).
    for (const mode of ["keyword", "vector", "hybrid"]) {
      expect(report.modes[mode]?.mrr10 ?? 0).toBeGreaterThan(0.3);
    }
  });
});
