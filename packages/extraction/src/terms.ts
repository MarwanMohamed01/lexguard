// Which defined terms does a clause use? (M4 step 7, D40)
//
// Defined terms are capitalised words or phrases ("Effective Date", "Supplier"), so matching is
// case-sensitive and on whole words only: "Supplier" matches "the Supplier shall" but not
// "Suppliers" or "supplier". All of a document's terms go into ONE pattern, longest first, so
// "Effective Date" wins over a shorter term "Date" at the same place, and a clause is scanned
// once instead of once per term (hundreds of terms x up to 1,000 clauses would not fit the
// Worker's CPU budget otherwise).

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Terms shorter than this are too ambiguous to match ("A", "I"). */
const MIN_TERM_LENGTH = 2;

/**
 * Returns a function that lists the distinct terms used in a text, in order of first use.
 * Terms are taken as given (already validated data from the definitions table).
 */
export function termMatcher(terms: readonly string[]): (text: string) => string[] {
  const usable = [...new Set(terms.map((t) => t.trim()))]
    .filter((t) => t.length >= MIN_TERM_LENGTH)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (usable.length === 0) return () => [];
  // Not preceded or followed by a letter or digit: whole words, any script.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${usable.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  return (text) => [...new Set([...text.matchAll(pattern)].map((m) => m[0]))];
}
