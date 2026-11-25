// Baselines the extractor must beat (M4 step 2). Each returns the predicted clause types per
// chunk, indexed [doc][chunk].
//
//   allTypes: every chunk gets all 41 types. Recall 1, precision = how common labels are.
//   prior:    each type predicted at random with its own frequency in the data (seeded), i.e.
//             guessing with knowledge of how common each type is, but without reading.
//   keyword:  M3's keyword search (FTS5 porter, bm25) with CUAD's question for the type; the
//             top chunk of each contract gets that type. Reading by word overlap, no model.
import { KeywordIndex } from "../retrieval/search";
import type { ExtractionDoc } from "./dataset";

export type Predictions = Set<string>[][];

export function allTypes(docs: readonly ExtractionDoc[], types: readonly string[]): Predictions {
  return docs.map((doc) => doc.chunks.map(() => new Set(types)));
}

/** Share of chunks whose answer key contains each type. */
export function typeFrequency(docs: readonly ExtractionDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  let chunks = 0;
  for (const chunk of docs.flatMap((d) => d.chunks)) {
    chunks++;
    for (const t of chunk.expected) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return new Map([...counts].map(([t, n]) => [t, n / Math.max(chunks, 1)]));
}

/** xorshift32, the same generator as the retrieval eval's random order. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function prior(
  docs: readonly ExtractionDoc[],
  frequency: ReadonlyMap<string, number>,
  seed = 1,
): Predictions {
  const next = seeded(seed);
  const entries = [...frequency].sort(([a], [b]) => (a < b ? -1 : 1));
  return docs.map((doc) =>
    doc.chunks.map(() => new Set(entries.filter(([, p]) => next() < p).map(([t]) => t))),
  );
}

export function keywordTop1(
  docs: readonly ExtractionDoc[],
  queries: ReadonlyMap<string, string>,
): Predictions {
  const index = new KeywordIndex(
    docs.map((doc) => ({
      title: doc.title,
      text: doc.text,
      chunks: doc.chunks.map(({ start, end }) => ({ start, end, heading: null, sectionPath: [] })),
    })),
    "porter unicode61",
  );
  try {
    return docs.map((doc, d) => {
      const predicted = doc.chunks.map(() => new Set<string>());
      for (const [type, query] of queries) {
        const top = index.search(d, query, 1)[0];
        if (top !== undefined) predicted[top]?.add(type);
      }
      return predicted;
    });
  } finally {
    index.close();
  }
}
