// Turns free text (a user's question, an agent's query) into a safe SQLite FTS5 MATCH
// expression.
//
// Why not pass the text straight to MATCH:
//   1. Safety. FTS5 has its own query language: AND, OR, NOT, NEAR(...), "phrases",
//      column filters (`text:`), prefixes (`term*`), `^` and parentheses. Raw text can be a
//      syntax error (a stray quote fails the whole query) or change what is searched.
//      This is injection into the search language, not SQL: the query string is still a bound
//      parameter.
//   2. Recall. Bare words mean AND in FTS5, so a ten-word question only matches chunks that
//      contain all ten words, which is usually none.
//
// So: split the text into words (letters and digits only, nothing FTS5 could read as an
// operator), quote each one, and join them with OR. bm25() then ranks chunks by how many of
// the rarer words they contain. FTS5 applies its own tokenizer (lowercasing, diacritics) to
// each quoted word, the same way it did when indexing.

/**
 * Letter or digit runs, with combining marks (so "é" typed as "e" + U+0301 stays one word
 * instead of becoming "e"): the only characters a word may contain, so it can never be FTS5
 * syntax. A word cannot start with a mark.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/** Bounds the work one query can cause. Longer queries keep their first distinct words. */
export const MAX_QUERY_TERMS = 32;

/** One word longer than this is not a word anyone types; it is dropped. */
const MAX_TERM_CHARS = 64;

/**
 * The FTS5 MATCH expression for `text`, or null when it has no searchable word (the caller then
 * skips the keyword search instead of sending an empty or invalid query).
 */
export function ftsQuery(text: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const [word] of text.matchAll(WORD)) {
    const term = word.toLowerCase();
    if (term.length > MAX_TERM_CHARS || seen.has(term)) continue;
    seen.add(term);
    terms.push(`"${term}"`);
    if (terms.length === MAX_QUERY_TERMS) break;
  }
  return terms.length === 0 ? null : terms.join(" OR ");
}

/** FTS5 column names and filter values we generate ourselves: plain identifiers only. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FILTER_VALUE = /^[A-Za-z0-9]{1,256}$/;

/**
 * Any ID as one FTS5 token: "x" + the hex of its UTF-8 bytes. Tenant IDs contain dashes and
 * document IDs are UUIDs, and FTS5 splits on dashes, so neither could be matched as a single
 * value. Hex is a single token of letters and digits, and two different IDs always give two
 * different tokens (decoding the hex gives the ID back). Lowercase hex, so case folding by
 * the tokenizer cannot merge two values.
 */
export function ftsScopeToken(id: string): string {
  if (id.length === 0 || id.length > 100) throw new Error("scope IDs must be 1-100 chars");
  // UTF-8 bytes via encodeURIComponent (standard JavaScript, unlike TextEncoder, so the
  // package needs no runtime types): "%C3%A9" stays as bytes, any other character is ASCII.
  // It throws on a lone surrogate, which is not a valid ID anyway.
  const encoded = encodeURIComponent(id);
  let hex = "x";
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") {
      hex += encoded.slice(i + 1, i + 3).toLowerCase();
      i += 2;
    } else {
      hex += encoded.charCodeAt(i).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/**
 * A MATCH expression that searches `text` in one column and keeps only rows whose filter
 * columns hold exactly the given single-token values, e.g.
 *   doc : "d12" AND text : ("governing" OR "law")
 *
 * Why filter inside MATCH instead of `WHERE doc = ?`: FTS5 would otherwise find and score
 * every match in the whole table (a tenant's every document) before filtering. Measured on
 * 17,000 CUAD chunks: 28 ms per query filtering afterwards, 5.6 ms inside MATCH.
 *
 * The caller MUST rank with zero weight on the filter columns, e.g. `bm25(fts, 1.0, 0.0)`:
 * bm25 scores every phrase of the query, and the filter value, rare in the table and scored
 * by chunk length, otherwise pushes short chunks to the top (measured: 10 of 300 rankings
 * unchanged without the weights, 300 of 300 with them).
 *
 * Filter values must be one FTS5 token (letters and digits), so IDs are stored in FTS in that
 * form; anything else throws rather than silently matching something broader.
 */
export function scopedFtsQuery(
  column: string,
  text: string,
  filters: Readonly<Record<string, string>>,
): string | null {
  if (!IDENTIFIER.test(column)) throw new Error(`invalid FTS5 column name: ${column}`);
  const scope = ftsScopeMatch(filters);
  const words = ftsQuery(text);
  return words === null ? null : `${scope} AND ${column} : (${words})`;
}

/**
 * Only the scope, e.g. `tenant : "x61" AND doc : "x62"`: selects every row of one document,
 * for deleting them (a virtual table takes no part in ON DELETE CASCADE).
 */
export function ftsScopeMatch(filters: Readonly<Record<string, string>>): string {
  const entries = Object.entries(filters);
  if (entries.length === 0) throw new Error("a scoped query needs at least one filter");
  for (const [name, value] of entries) {
    if (!IDENTIFIER.test(name)) throw new Error(`invalid FTS5 column name: ${name}`);
    if (!FILTER_VALUE.test(value)) throw new Error("FTS5 filter values must be letters/digits");
  }
  return entries.map(([name, value]) => `${name} : "${value}"`).join(" AND ");
}
