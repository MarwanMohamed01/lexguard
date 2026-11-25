// Scoring for the extraction eval (M4 step 2).
//
// 1. Every extracted clause must quote the chunk verbatim (T3). A quote that is not found is
//    rejected before scoring, never repaired. Quotes that differ only in whitespace are
//    counted separately, as a diagnostic, but still rejected.
// 2. The surviving clause types of a chunk are compared with the answer key per type:
//    right = tp, false alarm = fp, missed = fn (shared/metrics.ts).
// 3. "Grounded": an accepted clause whose quote overlaps a lawyer span of the same type, so
//    the right type with the wrong sentence is visible.
import { toMetrics, type Counts, type Metrics } from "../shared/metrics";
import type { ExtractionChunk } from "./dataset";

export interface ExtractedClause {
  clauseType: string;
  quote: string;
}

export type QuoteVerdict = "exact" | "whitespace" | "missing";

const collapse = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Every start offset of `quote` in `text` (overlapping occurrences included). */
export function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  if (quote.length === 0) return found;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
}

export function checkQuote(chunkText: string, quote: string): QuoteVerdict {
  if (quote.trim().length === 0) return "missing";
  if (chunkText.includes(quote)) return "exact";
  return chunkText.length > 0 && collapse(chunkText).includes(collapse(quote))
    ? "whitespace"
    : "missing";
}

export interface ChunkResult {
  predicted: Set<string>;
  accepted: number;
  grounded: number;
  rejected: { missing: number; whitespace: number; unknownType: number };
}

export function scoreChunk(
  chunk: ExtractionChunk,
  chunkText: string,
  clauses: readonly ExtractedClause[],
  knownTypes: ReadonlySet<string>,
): ChunkResult {
  const result: ChunkResult = {
    predicted: new Set(),
    accepted: 0,
    grounded: 0,
    rejected: { missing: 0, whitespace: 0, unknownType: 0 },
  };
  for (const clause of clauses) {
    if (!knownTypes.has(clause.clauseType)) {
      result.rejected.unknownType++;
      continue;
    }
    const verdict = checkQuote(chunkText, clause.quote);
    if (verdict !== "exact") {
      result.rejected[verdict]++;
      continue;
    }
    result.accepted++;
    result.predicted.add(clause.clauseType);
    const onSpan = occurrences(chunkText, clause.quote).some((at) => {
      const start = chunk.start + at;
      const end = start + clause.quote.length;
      return chunk.spans.some(
        (s) => s.clauseType === clause.clauseType && s.start < end && s.end > start,
      );
    });
    if (onSpan) result.grounded++;
  }
  return result;
}

/** Per-type counts over many chunks; micro sums all types, macro averages their F1. */
export class TypeTally {
  readonly byType = new Map<string, Counts>();

  constructor(readonly types: readonly string[]) {
    for (const t of types) this.byType.set(t, { tp: 0, fp: 0, fn: 0 });
  }

  add(expected: ReadonlySet<string>, predicted: ReadonlySet<string>): void {
    for (const [type, c] of this.byType) {
      const e = expected.has(type);
      const p = predicted.has(type);
      if (e && p) c.tp++;
      else if (p) c.fp++;
      else if (e) c.fn++;
    }
  }

  report(): { micro: Metrics; macroF1: number; byType: Record<string, Metrics> } {
    const total: Counts = { tp: 0, fp: 0, fn: 0 };
    const byType: Record<string, Metrics> = {};
    let f1Sum = 0;
    let scored = 0;
    for (const [type, c] of this.byType) {
      total.tp += c.tp;
      total.fp += c.fp;
      total.fn += c.fn;
      byType[type] = toMetrics(c);
      // A type never labelled and never predicted in this sample says nothing: left out.
      if (c.tp + c.fp + c.fn > 0) {
        f1Sum += byType[type].f1;
        scored++;
      }
    }
    return { micro: toMetrics(total), macroF1: scored === 0 ? 0 : f1Sum / scored, byType };
  }
}
