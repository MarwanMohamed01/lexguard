// Which contract passages the checker reads for one rule (M5 step 8, D52).
//
// In production the document is too large to scan in a Worker step (10 ms CPU), so:
//   1. the database's search (keyword + vector, M3) picks the rule's top chunks;
//   2. here, those chunks are split into sentences and ranked against the rule (BM25);
//   3. the top k sentences go to the checker, in document order.
// The ContractNLI eval measured k = 10 sentence-sized passages (D44/D49), so the checker sees
// passages of the same shape here.
import { terms } from "@lexguard/rulebook";

export interface Passage {
  /** Offsets in the whole document (chunk start + offset in the chunk). */
  start: number;
  end: number;
  text: string;
}

/** A sentence longer than this is cut at a space: the checker's input stays bounded. */
export const MAX_PASSAGE_CHARS = 1_000;

/**
 * Sentences of `text` with exact offsets, whitespace trimmed. A sentence ends at a line break,
 * or at ". " / "; " / ": " / "? " / "! " before a capital, digit, quote or bracket (the
 * chunker's rule for definitions, D40), so "Acme Inc. and" and "Section 5.3 of" stay whole.
 */
export function splitSentences(text: string, offset = 0): Passage[] {
  const out: Passage[] = [];
  // Not after a number's full stop: "1. Definitions" and "Section 5.3. Term" are headings.
  const BOUNDARY = /\n+|(?<=[.;:?!])(?<!\d\.)\s+(?=[A-Z0-9"“'([])/gu;
  let from = 0;
  const push = (start: number, end: number) => {
    while (start < end && /\s/u.test(text[start] ?? "")) start++;
    while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
    while (end - start > MAX_PASSAGE_CHARS) {
      const cut = text.lastIndexOf(" ", start + MAX_PASSAGE_CHARS);
      const at = cut > start ? cut : start + MAX_PASSAGE_CHARS;
      out.push({ start: offset + start, end: offset + at, text: text.slice(start, at) });
      start = at;
      while (start < end && /\s/u.test(text[start] ?? "")) start++;
    }
    if (end > start)
      out.push({ start: offset + start, end: offset + end, text: text.slice(start, end) });
  };
  for (const m of text.matchAll(BOUNDARY)) {
    push(from, m.index);
    from = m.index + m[0].length;
  }
  push(from, text.length);
  return out;
}

const K1 = 1.2;
const B = 0.75;

/**
 * The `k` sentences of these chunks that best match `query` (BM25 over the candidate
 * sentences), in document order. Sentences sharing no word with the query are never chosen;
 * if none matches, the first sentences are returned so the checker can still say "silent".
 */
export function selectPassages(
  chunks: readonly { start: number; text: string }[],
  query: string,
  k = 10,
): Passage[] {
  const sentences = chunks.flatMap((c) => splitSentences(c.text, c.start));
  const docs = sentences.map((s) => {
    const words = terms(s.text);
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { s, tf, length: words.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const q = [...new Set(terms(query))];
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const w of q) {
      const f = d.tf.get(w);
      if (f === undefined) continue;
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / Math.max(avg, 1)));
    }
    return { i, score };
  });
  const matching = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const picked = (matching.length > 0 ? matching.slice(0, k) : scored.slice(0, k)).map((x) => x.i);
  return picked.sort((a, b) => a - b).flatMap((i) => (docs[i] === undefined ? [] : [docs[i].s]));
}
