// The three searches compared by the retrieval eval, all over one contract's chunks:
//   keyword: real SQLite FTS5 + bm25() (node:sqlite), the same engine family as D1;
//   vector:  exact cosine similarity over the chunk embeddings (Vectorize is approximate, so
//            this is its best case; the real index is measured in M3 step 7);
//   hybrid:  reciprocal rank fusion of the two (@lexguard/retrieval).
import { DatabaseSync } from "node:sqlite";
import { reciprocalRankFusion, scopedFtsQuery } from "@lexguard/retrieval";
import type { Doc } from "./dataset";

/** A document's ID as one FTS5 token. */
const docToken = (doc: number) => `d${String(doc)}`;

/** How many results each search returns (Vectorize's topK limit with metadata is 50, D25). */
export const DEPTH = 50;

export type Tokenizer = "unicode61" | "porter unicode61";

/**
 * One FTS5 table holding every chunk of every document, like a tenant's table in D1: bm25's
 * word statistics come from the whole table. The document filter is part of MATCH with zero
 * bm25 weight (see scopedFtsQuery for why and the measurement).
 */
export class KeywordIndex {
  private readonly db = new DatabaseSync(":memory:");
  private readonly query;

  constructor(docs: readonly Doc[], tokenizer: Tokenizer = "unicode61") {
    this.db.exec(
      `CREATE VIRTUAL TABLE fts USING fts5(text, doc, idx UNINDEXED, tokenize = '${tokenizer}')`,
    );
    const insert = this.db.prepare("INSERT INTO fts (text, doc, idx) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    docs.forEach((doc, d) => {
      doc.chunks.forEach((chunk, i) =>
        insert.run(doc.text.slice(chunk.start, chunk.end), docToken(d), i),
      );
    });
    this.db.exec("COMMIT");
    // Weights follow the column order: text 1.0, doc 0.0 (idx is unindexed).
    this.query = this.db.prepare(
      "SELECT idx FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, 1.0, 0.0), idx LIMIT ?",
    );
  }

  search(doc: number, text: string, depth = DEPTH): number[] {
    const match = scopedFtsQuery("text", text, { doc: docToken(doc) });
    if (match === null) return [];
    return this.query.all(match, depth).map((row) => Number(row.idx));
  }

  close(): void {
    this.db.close();
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function normalize(v: Float32Array): Float32Array {
  const length = Math.sqrt(dot(v, v));
  return length === 0 ? v : v.map((x) => x / length);
}

/** Chunk indices by cosine similarity to the query, best first (inputs normalized). */
export function vectorSearch(
  query: Float32Array,
  chunks: readonly Float32Array[],
  depth = DEPTH,
): number[] {
  return chunks
    .map((vector, index) => ({ index, score: dot(query, vector) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, depth)
    .map((r) => r.index);
}

export function hybridSearch(keyword: readonly number[], vector: readonly number[]): number[] {
  return reciprocalRankFusion([keyword.map(String), vector.map(String)])
    .slice(0, DEPTH)
    .map((f) => Number(f.id));
}

/** Context for the numbers: a seeded random order of the document's chunks. */
export function randomRanking(chunkCount: number, seed: number): number[] {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  const order = Array.from({ length: chunkCount }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j] ?? i, order[i] ?? j];
  }
  return order.slice(0, DEPTH);
}
