// Keyword search over a rulebook's rules (M5 step 4, D46): BM25, the same scoring family as
// FTS5's bm25() in D1, written out because a rulebook is small (786 GDPR rules) and must be
// searchable inside a Worker with no database.
//
//   searchRules(gdpr, "engage another processor written authorisation")
//     -> [{ id: "gdpr:28(2)", score: 14.1 }, { id: "gdpr:28(4)", score: 9.8 }, ...]
//
// It serves outside MCP clients looking for a rule. Lexguard's own pipeline picks rules by ID
// (code maps a clause type to rule IDs), so search quality never decides a verdict; that is
// why it has unit tests but no quality eval (D46).
import type { Rule, Rulebook } from "./rulebook";

// Very common words carry no signal and would only add noise to the scores.
const STOP = new Set(
  (
    "a an and any are as at be by for from has have in into is it its may not of on or other " +
    "shall such than that the their them there these this those to under was where which " +
    "who will with"
  ).split(" "),
);

/** Minimal English suffix stripping so "processors" finds "processor" (not a full stemmer). */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Lower-case words (letters and digits, any script), stop words removed, stemmed. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

export interface SearchHit {
  id: string;
  score: number;
}

interface Index {
  docs: { rule: Rule; tf: Map<string, number>; length: number }[];
  df: Map<string, number>;
  avgLength: number;
}

// Built once per rulebook (rulebooks never change at run time).
const indexes = new WeakMap<Rulebook, Index>();

function indexOf(book: Rulebook): Index {
  const cached = indexes.get(book);
  if (cached !== undefined) return cached;
  const df = new Map<string, number>();
  const docs = book.rules.map((rule) => {
    const words = terms(`${rule.title} ${book.text.slice(rule.start, rule.end)}`);
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    return { rule, tf, length: words.length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const index = { docs, df, avgLength };
  indexes.set(book, index);
  return index;
}

// Standard BM25 constants (also FTS5's defaults).
const K1 = 1.2;
const B = 0.75;

/**
 * The best-matching rules, highest score first; ties keep rulebook order. Only rules sharing
 * at least one query term are returned.
 */
export function searchRules(book: Rulebook, query: string, limit = 5): SearchHit[] {
  const { docs, df, avgLength } = indexOf(book);
  const queryTerms = [...new Set(terms(query))];
  const n = docs.length;
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of queryTerms) {
      const f = doc.tf.get(term);
      if (f === undefined) continue;
      const d = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avgLength));
    }
    if (score > 0) hits.push({ id: doc.rule.id, score });
  }
  // Array.prototype.sort is stable (ES2019), so equal scores keep rulebook order.
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}
