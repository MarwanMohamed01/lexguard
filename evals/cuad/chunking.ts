import { chunkDocument, type ChunkOptions } from "@lexguard/chunker";
import type { CuadContract } from "./load";

// Clause-integrity eval: what share of CUAD's lawyer-labelled clauses ends up whole inside
// one chunk? In M4 each extractor reads one chunk, so a clause cut across two chunks is never
// seen whole: this share is a ceiling on extraction recall for that clause.

export interface Piece {
  start: number;
  end: number;
}

export type Splitter = (text: string) => Piece[];

// ---------------------------------------------------------------------------------------------
// Splitters

export const structureAware =
  (options: ChunkOptions = {}): Splitter =>
  (text) =>
    chunkDocument(text, options).chunks.map(({ start, end }) => ({ start, end }));

/** Naive baseline: cut every `size` characters; with overlap, each piece repeats the tail. */
export function fixedSize(size: number, overlap = 0): Splitter {
  const step = size - overlap;
  if (step <= 0) throw new Error("overlap must be smaller than size");
  return (text) => {
    const pieces: Piece[] = [];
    for (let start = 0; start < text.length; start += step) {
      pieces.push({ start, end: Math.min(start + size, text.length) });
      if (start + size >= text.length) break;
    }
    return pieces;
  };
}

// LangChain's RecursiveCharacterTextSplitter defaults (separator kept at the start of the next
// piece). The realistic baseline: what most RAG systems use.
const RECURSIVE_SEPARATORS = ["\n\n", "\n", " ", ""] as const;

/**
 * Realistic baseline: split at the first separator that occurs (blank line, then line break,
 * then space, then anywhere), pack the parts greedily up to `size`, and recurse with the next
 * separator into parts that are still too long. Pieces are contiguous.
 */
export function recursive(size: number): Splitter {
  return (text) => (text.length === 0 ? [] : splitRange(text, 0, text.length, 0, size));
}

function splitRange(text: string, start: number, end: number, sepIndex: number, size: number) {
  if (end - start <= size) return [{ start, end }];

  let index = sepIndex;
  const occurs = (sep: string): boolean => {
    const at = text.indexOf(sep, start + 1);
    return at !== -1 && at < end;
  };
  while (index < RECURSIVE_SEPARATORS.length - 1 && !occurs(RECURSIVE_SEPARATORS[index] ?? "")) {
    index++;
  }
  const sep = RECURSIVE_SEPARATORS[index] ?? "";

  const pieces: Piece[] = [];
  if (sep === "") {
    for (let s = start; s < end; s += size) pieces.push({ start: s, end: Math.min(s + size, end) });
    return pieces;
  }

  const bounds = [start];
  for (
    let at = text.indexOf(sep, start + 1);
    at !== -1 && at < end;
    at = text.indexOf(sep, at + 1)
  ) {
    if (at > (bounds.at(-1) ?? start)) bounds.push(at);
  }
  bounds.push(end);

  let current: Piece | null = null;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const part = { start: bounds[k] ?? start, end: bounds[k + 1] ?? end };
    if (part.end - part.start > size) {
      if (current !== null) pieces.push(current);
      current = null;
      pieces.push(...splitRange(text, part.start, part.end, index + 1, size));
    } else if (current !== null && part.end - current.start <= size) {
      current.end = part.end;
    } else {
      if (current !== null) pieces.push(current);
      current = part;
    }
  }
  if (current !== null) pieces.push(current);
  return pieces;
}

// ---------------------------------------------------------------------------------------------
// Measurement

export const LENGTH_BUCKETS = ["short", "medium", "long", "tooLong"] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

/** short < 200 chars, medium < 1,000, long up to maxSpan, tooLong above (cannot fit a chunk). */
export function bucketOf(length: number, maxSpan: number): LengthBucket {
  if (length > maxSpan) return "tooLong";
  if (length < 200) return "short";
  return length < 1_000 ? "medium" : "long";
}

export interface Tally {
  kept: number;
  total: number;
  rate: number;
}

const tally = (kept: number, total: number): Tally => ({
  kept,
  total,
  rate: total === 0 ? 1 : Math.round((kept / total) * 10_000) / 10_000,
});

export interface SplitterReport {
  name: string;
  chunks: number;
  meanChars: number;
  medianChars: number;
  /** Headline: clauses up to maxSpan characters (longer ones cannot fit any chunk). */
  integrity: Tally;
  byLength: Record<LengthBucket, Tally>;
  byClauseType: Record<string, Tally>;
}

export interface LabelledSpan {
  contract: number;
  clauseType: string;
  start: number;
  end: number;
}

/**
 * CUAD spans, checked against the text: a span whose text does not match its offset is
 * dropped (and counted) rather than trusted.
 */
export function labelledSpans(contracts: readonly CuadContract[]): {
  spans: LabelledSpan[];
  invalid: number;
} {
  const spans: LabelledSpan[] = [];
  let invalid = 0;
  contracts.forEach((contract, index) => {
    for (const span of contract.spans) {
      const end = span.start + span.text.length;
      if (span.text.length === 0 || contract.text.slice(span.start, end) !== span.text) {
        invalid++;
        continue;
      }
      spans.push({ contract: index, clauseType: span.clauseType, start: span.start, end });
    }
  });
  return { spans, invalid };
}

/** Is [start, end) inside one of the pieces? Pieces sorted by start; may overlap. */
export function isKept(pieces: readonly Piece[], longest: number, start: number, end: number) {
  let low = 0;
  let high = pieces.length - 1;
  let last = -1; // last piece with piece.start <= start
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((pieces[mid]?.start ?? Infinity) <= start) {
      last = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  for (let k = last; k >= 0; k--) {
    const piece = pieces[k];
    if (piece === undefined || piece.start + longest < end) break;
    if (piece.end >= end) return true;
  }
  return false;
}

export function measureIntegrity(
  name: string,
  contracts: readonly CuadContract[],
  spans: readonly LabelledSpan[],
  splitter: Splitter,
  maxSpan: number,
): SplitterReport {
  const piecesPerContract = contracts.map((c) => splitter(c.text));
  const lengths = piecesPerContract.flat().map((p) => p.end - p.start);
  const longestPerContract = piecesPerContract.map((ps) =>
    ps.reduce((m, p) => Math.max(m, p.end - p.start), 0),
  );

  const counts = new Map<string, [number, number]>();
  const add = (key: string, kept: boolean): void => {
    const [k, t] = counts.get(key) ?? [0, 0];
    counts.set(key, [k + (kept ? 1 : 0), t + 1]);
  };
  for (const span of spans) {
    const pieces = piecesPerContract[span.contract] ?? [];
    const kept = isKept(pieces, longestPerContract[span.contract] ?? 0, span.start, span.end);
    const bucket = bucketOf(span.end - span.start, maxSpan);
    add(`length:${bucket}`, kept);
    if (bucket === "tooLong") continue;
    add("all", kept);
    add(`type:${span.clauseType}`, kept);
  }
  const get = (key: string): Tally => {
    const [k, t] = counts.get(key) ?? [0, 0];
    return tally(k, t);
  };

  const sorted = [...lengths].sort((a, b) => a - b);
  const types = [...counts.keys()].filter((k) => k.startsWith("type:")).sort();
  return {
    name,
    chunks: lengths.length,
    meanChars: Math.round(lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)),
    medianChars: sorted[sorted.length >> 1] ?? 0,
    integrity: get("all"),
    byLength: Object.fromEntries(LENGTH_BUCKETS.map((b) => [b, get(`length:${b}`)])) as Record<
      LengthBucket,
      Tally
    >,
    byClauseType: Object.fromEntries(types.map((k) => [k.slice(5), get(k)])),
  };
}

/**
 * Finds the size parameter at which a baseline produces (as near as possible) `target`
 * chunks over all contracts, so every splitter is compared at the same chunk count: same
 * average chunk length, same storage and embedding cost. Chunk count falls as size grows.
 */
export function calibrate(
  contracts: readonly CuadContract[],
  make: (size: number) => Splitter,
  target: number,
): number {
  const count = (size: number): number =>
    contracts.reduce((n, c) => n + make(size)(c.text).length, 0);
  let low = 100;
  let high = 20_000;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (count(mid) > target) low = mid;
    else high = mid;
  }
  return Math.abs(count(low) - target) < Math.abs(count(high) - target) ? low : high;
}

// ---------------------------------------------------------------------------------------------
// Diagnostics for our chunker: guarantees, and why clauses break.

export interface BrokenExample {
  contract: string;
  clauseType: string;
  spanChars: number;
  /** Text around the first cut inside the clause, cut marked with ⟦|⟧. */
  aroundCut: string;
}

export interface StructureDiagnostics {
  offsetViolations: number;
  oversizedChunks: number;
  chunksWithSectionPath: number;
  contractsWithoutHeadings: number;
  /** Broken clauses by the kind of the first cut inside them. */
  brokenBy: { heading: number; sizeSplit: number };
  examples: { heading: BrokenExample[]; sizeSplit: BrokenExample[] };
}

export function diagnoseStructureAware(
  contracts: readonly CuadContract[],
  spans: readonly LabelledSpan[],
  options: { targetChars: number; maxChars: number },
  examplesPerKind = 12,
): StructureDiagnostics {
  const results = contracts.map((c) => chunkDocument(c.text, options));
  const diagnostics: StructureDiagnostics = {
    offsetViolations: 0,
    oversizedChunks: 0,
    chunksWithSectionPath: 0,
    contractsWithoutHeadings: 0,
    brokenBy: { heading: 0, sizeSplit: 0 },
    examples: { heading: [], sizeSplit: [] },
  };

  results.forEach((result, i) => {
    const text = contracts[i]?.text ?? "";
    let position = 0;
    for (const chunk of result.chunks) {
      if (chunk.start !== position || chunk.text !== text.slice(chunk.start, chunk.end)) {
        diagnostics.offsetViolations++;
      }
      if (chunk.text.length > options.maxChars) diagnostics.oversizedChunks++;
      if (chunk.sectionPath.length > 0) diagnostics.chunksWithSectionPath++;
      position = chunk.end;
    }
    if (position !== text.length) diagnostics.offsetViolations++;
    if (!result.sections.some((s) => s.label !== null)) diagnostics.contractsWithoutHeadings++;
  });

  const broken: Record<"heading" | "sizeSplit", { span: LabelledSpan; cut: number }[]> = {
    heading: [],
    sizeSplit: [],
  };
  for (const span of spans) {
    if (span.end - span.start > options.maxChars) continue;
    const result = results[span.contract];
    if (result === undefined) continue;
    const cut = result.chunks.find((c) => c.start > span.start && c.start < span.end)?.start;
    if (cut === undefined) continue;
    const kind = result.sections.some((s) => s.start === cut && s.label !== null)
      ? "heading"
      : "sizeSplit";
    broken[kind].push({ span, cut });
  }

  for (const kind of ["heading", "sizeSplit"] as const) {
    const all = broken[kind];
    diagnostics.brokenBy[kind] = all.length;
    // Evenly spaced over all broken clauses, not just the first contracts.
    const step = Math.max(1, Math.floor(all.length / examplesPerKind));
    for (
      let k = 0;
      k < all.length && diagnostics.examples[kind].length < examplesPerKind;
      k += step
    ) {
      const entry = all[k];
      const contract = entry === undefined ? undefined : contracts[entry.span.contract];
      if (entry === undefined || contract === undefined) continue;
      const { span, cut } = entry;
      diagnostics.examples[kind].push({
        contract: contract.title,
        clauseType: span.clauseType,
        spanChars: span.end - span.start,
        aroundCut: `${contract.text.slice(Math.max(span.start, cut - 120), cut)}⟦|⟧${contract.text.slice(cut, Math.min(span.end, cut + 120))}`,
      });
    }
  }
  return diagnostics;
}
