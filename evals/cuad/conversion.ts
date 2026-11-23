// M2 step 6: how close is toMarkdown's text (as Lexguard stores it, sanitized) to CUAD's own
// text for the same contract, and do the lawyer-labelled clauses survive conversion and
// chunking? CUAD's text is a reference, not the truth: the CUAD authors extracted it from the
// same PDFs with their own tool, so disagreements are sampled and read, not all counted as
// conversion errors.
//
// Comparisons work on words (letters and digits, lowercased) so that Markdown syntax,
// punctuation and whitespace differences do not count.
import { bucketOf, isKept, type Piece } from "./chunking";

export interface Token {
  word: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
export const NGRAM = 8;

export function tokens(text: string): Token[] {
  return [...text.matchAll(WORD)].map((m) => ({
    word: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Word overlap as multisets: precision = share of output words also in the reference. */
export function wordAgreement(reference: readonly Token[], output: readonly Token[]) {
  const counts = new Map<string, number>();
  for (const t of reference) counts.set(t.word, (counts.get(t.word) ?? 0) + 1);
  let common = 0;
  for (const t of output) {
    const left = counts.get(t.word) ?? 0;
    if (left > 0) {
      common++;
      counts.set(t.word, left - 1);
    }
  }
  return {
    precision: output.length === 0 ? 0 : common / output.length,
    recall: reference.length === 0 ? 0 : common / reference.length,
  };
}

function gramOf(words: readonly Token[], at: number): string {
  return words
    .slice(at, at + NGRAM)
    .map((t) => t.word)
    .join(" ");
}

function ngrams(words: readonly Token[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + NGRAM <= words.length; i++) set.add(gramOf(words, i));
  return set;
}

/** Order-aware agreement: share of the reference's 8-word sequences found in the output. */
export function ngramRecall(reference: readonly Token[], outputGrams: ReadonlySet<string>) {
  const grams = ngrams(reference);
  if (grams.size === 0) return 1;
  let found = 0;
  for (const g of grams) if (outputGrams.has(g)) found++;
  return found / grams.size;
}

/**
 * Finds a word sequence in the output. Returns the character span of its first exact
 * occurrence, or null. The output's words are joined with single spaces so a plain string
 * search finds contiguous word sequences.
 */
export class WordIndex {
  private readonly joined: string;
  private readonly offsets: number[] = []; // position of each word in `joined`
  private readonly gramAt = new Map<string, number[]>(); // 8-gram -> word positions
  readonly grams: Set<string>;

  constructor(readonly words: readonly Token[]) {
    let at = 1;
    for (const w of words) {
      this.offsets.push(at);
      at += w.word.length + 1;
    }
    this.joined = ` ${words.map((w) => w.word).join(" ")} `;
    for (let i = 0; i + NGRAM <= words.length; i++) {
      const gram = gramOf(words, i);
      const list = this.gramAt.get(gram);
      if (list === undefined) this.gramAt.set(gram, [i]);
      else list.push(i);
    }
    this.grams = new Set(this.gramAt.keys());
  }

  /**
   * The clause with something inserted (a page header, a footnote mark): its first and last
   * 8-word sequences appear in order, at most `slack` extra words apart. Returns the span from
   * the start of the first to the end of the last, or null.
   */
  anchored(sequence: readonly Token[], slack: number): { start: number; end: number } | null {
    if (sequence.length < NGRAM) return null;
    const firsts = this.gramAt.get(gramOf(sequence, 0)) ?? [];
    const lasts = this.gramAt.get(gramOf(sequence, sequence.length - NGRAM)) ?? [];
    const width = sequence.length - NGRAM; // distance between the two anchors without insertions
    for (const first of firsts) {
      for (const last of lasts) {
        const distance = last - first;
        if (distance >= width && distance <= width + slack) {
          const start = this.words[first]?.start;
          const end = this.words[last + NGRAM - 1]?.end;
          if (start !== undefined && end !== undefined) return { start, end };
        }
      }
    }
    return null;
  }

  find(sequence: readonly Token[]): { start: number; end: number } | null {
    if (sequence.length === 0) return null;
    const at = this.joined.indexOf(` ${sequence.map((w) => w.word).join(" ")} `);
    if (at < 0) return null;
    const first = this.wordAt(at + 1);
    const last = this.words[first + sequence.length - 1];
    const start = this.words[first]?.start;
    if (start === undefined || last === undefined) return null;
    return { start, end: last.end };
  }

  private wordAt(position: number): number {
    let low = 0;
    let high = this.offsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.offsets[mid] ?? Infinity) <= position) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

export type ClauseOutcome = "exact" | "fuzzy" | "missing";

/**
 * Whether a labelled clause survived conversion:
 *   - "exact": its words appear contiguously;
 *   - "fuzzy": present with something inserted (its first and last 8-word sequences appear
 *     in order, at most 20 + 10% extra words apart), or a few words garbled (at least 90% of
 *     its 8-word sequences appear; no location then);
 *   - "missing": otherwise.
 */
export function locateClause(
  clause: readonly Token[],
  output: WordIndex,
): { outcome: ClauseOutcome; span: { start: number; end: number } | null } {
  const span = output.find(clause);
  if (span !== null) return { outcome: "exact", span };
  const anchored = output.anchored(clause, 20 + Math.ceil(clause.length / 10));
  if (anchored !== null) return { outcome: "fuzzy", span: anchored };
  if (clause.length >= NGRAM && ngramRecall(clause, output.grams) >= 0.9) {
    return { outcome: "fuzzy", span: null };
  }
  return { outcome: "missing", span: null };
}

/** Clause integrity on converted text: located clauses kept inside one stored chunk. */
export function keptWhole(chunks: readonly Piece[], span: { start: number; end: number }) {
  const longest = chunks.reduce((max, c) => Math.max(max, c.end - c.start), 0);
  return isKept(chunks, longest, span.start, span.end);
}

export { bucketOf };

/** Lines that repeat 3+ times: usually page headers, footers and page numbers. */
export function repeatedLines(text: string, minCount = 3) {
  const counts = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || /^[-|:\s]+$/.test(line)) continue; // blank, table rules
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const repeated = [...counts].filter(([, n]) => n >= minCount).sort((a, b) => b[1] - a[1]);
  return {
    lines: repeated.reduce((sum, [, n]) => sum + n, 0),
    chars: repeated.reduce((sum, [line, n]) => sum + line.length * n, 0),
    top: repeated.slice(0, 5).map(([line, n]) => ({ line: line.slice(0, 80), count: n })),
  };
}
