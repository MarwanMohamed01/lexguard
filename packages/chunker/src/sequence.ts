/**
 * A clause number split into its parts: "7.1.2" -> [7, 1, 2], "ARTICLE IV" -> [4].
 */
export type ClauseNumber = readonly number[];

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/** "IV" -> 4. Returns null for anything that is not a well-formed numeral up to 399. */
export function romanToNumber(roman: string): number | null {
  if (!/^C{0,3}(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(roman) || roman === "") return null;
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const value = ROMAN[roman.charAt(i)] ?? 0;
    const nextValue = ROMAN[roman.charAt(i + 1)] ?? 0;
    total += value < nextValue ? -value : value;
  }
  return total;
}

/** "7.1.2" -> [7, 1, 2]; "2.01" -> [2, 1]; "IV" -> [4]. Null if it is neither. */
export function parseClauseNumber(raw: string): ClauseNumber | null {
  if (/^\d{1,3}(\.\d{1,3})*$/.test(raw)) return raw.split(".").map(Number);
  const roman = romanToNumber(raw);
  return roman === null ? null : [roman];
}

/**
 * Is `next` a believable next heading, given the last heading we accepted?
 *
 * Real headings move through a document one step at a time. Three moves are allowed:
 *   deeper:      7.1 -> 7.1.1  (append 1)
 *   next:        7.1 -> 7.2    (last part + 1)
 *   up and next: 7.1.2 -> 7.2, 7.1.2 -> 8  (drop parts, then + 1)
 * Anything else (skips, going backwards, "thirty (30) days") is rejected. With no previous
 * heading, only 1 is accepted.
 */
export function isPlausibleNext(previous: ClauseNumber | null, next: ClauseNumber): boolean {
  if (previous === null) return next.length === 1 && next[0] === 1;

  // Deeper: previous followed by a 1.
  if (next.length === previous.length + 1 && next.at(-1) === 1) {
    return previous.every((part, i) => next[i] === part);
  }

  // Next or up-and-next: same parts up to the last one of `next`, which is one more.
  if (next.length > previous.length) return false;
  const last = next.length - 1;
  for (let i = 0; i < last; i++) {
    if (next[i] !== previous[i]) return false;
  }
  return next[last] === (previous[last] ?? 0) + 1;
}

/** Negative if a comes before b in document order (7.1 < 7.1.1 < 7.2 < 8). */
export function compareClauseNumbers(a: ClauseNumber, b: ClauseNumber): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}
