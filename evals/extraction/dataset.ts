// Extraction eval dataset (M4 step 2), built only from CUAD's own labels (D10).
//
// The unit is one chunk, because one extractor call reads one chunk. For each chunk the
// answer key is the set of clause types whose lawyer-labelled spans overlap it, e.g.
//   chunk 12 = { "Governing Law", "Anti-Assignment" }
// Chunks with no label are kept: they are where false alarms show up.
import { createHash } from "node:crypto";
import type { CuadContract } from "../cuad/load";
import { textCorpus, type LocatedSpan } from "../retrieval/dataset";
import { CHUNK_OPTIONS } from "../retrieval/sources";

export interface ExtractionChunk {
  doc: number;
  idx: number;
  start: number;
  end: number;
  /** Clause types with a labelled span overlapping this chunk (the answer key). */
  expected: ReadonlySet<string>;
  /** Those spans, in document offsets, to check whether a quote lands on the right text. */
  spans: readonly LocatedSpan[];
}

export interface ExtractionDoc {
  title: string;
  text: string;
  chunks: ExtractionChunk[];
}

/** CUAD's text, chunked as in production (D15), with an answer key per chunk. */
export function extractionCorpus(contracts: readonly CuadContract[]): ExtractionDoc[] {
  const { docs } = textCorpus(contracts, CHUNK_OPTIONS);
  return docs.map((doc, d) => {
    const contract = contracts[d];
    if (contract === undefined) throw new Error("corpus and contracts out of step");
    // Same rule as the other CUAD evals: a span whose text does not match its offset is skipped.
    const spans: LocatedSpan[] = contract.spans
      .filter((s) => s.text.length > 0 && contract.text.startsWith(s.text, s.start))
      .map((s) => ({ clauseType: s.clauseType, start: s.start, end: s.start + s.text.length }));
    return {
      title: doc.title,
      text: doc.text,
      chunks: doc.chunks.map(({ start, end }, idx) => {
        const mine = spans.filter((s) => s.start < end && s.end > start);
        return {
          doc: d,
          idx,
          start,
          end,
          expected: new Set(mine.map((s) => s.clauseType)),
          spans: mine,
        };
      }),
    };
  });
}

/**
 * A reproducible pseudo-random sample, not hand-picked: the `count` titles with the lowest
 * SHA-256(title), the same rule as the PDF subset (evals/cuad/README.md).
 */
export function pinnedSubset<T extends { title: string }>(docs: readonly T[], count: number): T[] {
  const hash = (title: string) => createHash("sha256").update(title, "utf8").digest("hex");
  return [...docs]
    .map((doc) => ({ doc, key: hash(doc.title) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, count)
    .map(({ doc }) => doc);
}
