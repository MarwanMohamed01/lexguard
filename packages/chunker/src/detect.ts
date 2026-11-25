import { parseClauseNumber, type ClauseNumber } from "./sequence";

// Finds places in the text that LOOK like structure. Detection is deliberately generous;
// headings.ts then decides which numbered candidates are real (numbering-sequence check).

/** A numbered heading candidate: "7.1.2 Title", "ARTICLE IV", "Section 2.01". */
export interface NumberedCandidate {
  kind: "numbered";
  start: number;
  number: ClauseNumber;
  /** The marker as written, e.g. "ARTICLE IV" or "7.1.2". */
  marker: string;
  /** Short title after the marker, or null when what follows is a sentence. */
  title: string | null;
}

/** A heading that is always accepted and restarts numbering: "EXHIBIT A", "# Background". */
export interface ResetCandidate {
  kind: "reset";
  start: number;
  /** 1 for EXHIBIT/SCHEDULE/ANNEX/APPENDIX, otherwise the Markdown heading level. */
  depth: number;
  label: string;
}

export type HeadingCandidate = NumberedCandidate | ResetCandidate;

// A heading starts at the beginning of a line, or mid-line right after a sentence ends
// ("... Expenses. 6.3.4.1 The Initial ..."), but never in the middle of a sentence.
// A Markdown heading's "#" marks count as a line start ("# 7.1 Title" from toMarkdown).
// After an ALL-CAPS word also counts: PDF extraction often glues a heading line to the next
// clause ("9. PROPRIETARY MARKS 9.1 Use of Marks.").
const AT_BOUNDARY = String.raw`(?<=^[ \t]*(?:#{1,6}[ \t]+)?|[.:;][ \t]+|\b[A-Z]{2,}[ \t]+)`;

const NUMBERED = new RegExp(
  AT_BOUNDARY +
    // Optional keyword, then a dotted number or (only after a keyword) a roman numeral.
    String.raw`(?:(ARTICLE|Article|SECTION|Section|§)[ \t]*)?(\d{1,3}(?:\.\d{1,3})*|[IVXLC]{1,8})` +
    // Optional "." or ")" after the number, then whitespace and something that starts a title
    // or sentence. "2 days" (lowercase) is not a heading.
    String.raw`[.)]?(?=\s+["“(A-Z])`,
  "gm",
);

const RESET_KEYWORD = /^[ \t]*((?:EXHIBIT|SCHEDULE|ANNEX|APPENDIX)\s+[A-Z0-9][\w.-]*)/gm;
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(\S[^\r\n]*)/gm;

// Lettered or roman list items "(a)", "(iv)" at a line start or after ":" / ";".
const LIST_ITEM = /(?<=^[ \t]*|[:;][ \t]+)\((?:[a-z]{1,2}|[ivx]{1,5})\)(?=\s)/gm;

// "Term" means / shall mean / has the meaning. Straight or curly quotes.
const DEFINITION =
  /["“]([A-Z][^"”\r\n]{0,80})["”]\s+(?:shall\s+)?(?:means?|has\s+the\s+meaning|have\s+the\s+meaning)\b/g;

const MAX_TITLE = 80;

/**
 * Title after a marker: up to the first ".", ":" or line end (skipping a line break right
 * after the marker, as in "ARTICLE 7\nTRAINING"). If that runs too long or starts lowercase,
 * the marker is followed by a sentence, not a title.
 */
function titleAfter(text: string, from: number): string | null {
  const rest = text.slice(from, from + MAX_TITLE + 20);
  const match = /^\s*([^.:\r\n]*)/.exec(rest);
  // "9. PROPRIETARY MARKS 9.1 ..." stops at the "." of 9.1: drop the stray " 9".
  const title = (match?.[1] ?? "").replace(/\s+\d{1,3}\s*$/, "").trim();
  if (title === "" || title.length > MAX_TITLE || !/^["“(A-Z]/.test(title)) return null;
  return title;
}

export function findHeadingCandidates(text: string): HeadingCandidate[] {
  const candidates: HeadingCandidate[] = [];

  let markerEnd = -1;
  for (const match of text.matchAll(NUMBERED)) {
    // "ARTICLE 7" also matches as a bare "7" after the all-caps word: keep only the first.
    if (match.index < markerEnd) continue;
    markerEnd = match.index + match[0].length;
    const keyword = match[1];
    const raw = match[2] ?? "";
    // Roman numerals only count after a keyword: a lone "I" or "C" is a word, not a number.
    if (keyword === undefined && !/^\d/.test(raw)) continue;
    const number = parseClauseNumber(raw);
    if (number === null) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const before = text.slice(lineStart, match.index);
    const title = titleAfter(text, match.index + match[0].length);
    // Found only because an ALL-CAPS word precedes it: that rule exists for headings glued to
    // a title line ("MARKS 9.1 Our Representations."), where the clause title switches out of
    // capitals. So demand a bare number with a short title that has lowercase letters.
    // Otherwise it is a number inside an all-caps sentence ("ARISING UNDER SECTION 8 OF THIS
    // AGREEMENT", "(ARTICLE 12) OR ...", "PRECEDING 12 MONTHS"), found on CUAD liability clauses.
    const atLineOrSentence = /^[ \t]*(?:#{1,6}[ \t]+)?$|[.:;][ \t]+$/.test(before);
    if (!atLineOrSentence && (keyword !== undefined || title === null || !/[a-z]/.test(title))) {
      continue;
    }
    // After "# ", the section starts at the "#" so the marks stay with their heading.
    const hashed = /^[ \t]*#{1,6}[ \t]+$/.test(before);
    candidates.push({
      kind: "numbered",
      start: hashed ? lineStart : match.index,
      number,
      marker: keyword === undefined ? raw : `${keyword} ${raw}`,
      title,
    });
  }

  for (const match of text.matchAll(RESET_KEYWORD)) {
    const label = match[1] ?? "";
    candidates.push({
      kind: "reset",
      start: match.index + match[0].indexOf(label),
      depth: 1,
      label,
    });
  }

  for (const match of text.matchAll(MARKDOWN_HEADING)) {
    const hashes = match[1] ?? "#";
    const content = (match[2] ?? "").trim();
    // "# 7.1 Title" is a numbered heading; NUMBERED already finds it after the hashes.
    if (/^(?:(?:ARTICLE|Article|SECTION|Section|§)\s*)?\d/.test(content)) continue;
    candidates.push({ kind: "reset", start: match.index, depth: hashes.length, label: content });
  }

  return candidates.sort((a, b) => a.start - b.start);
}

/** Positions where an oversized section may be split: list items and definitions. */
export function findSoftBoundaries(text: string): number[] {
  const positions = [...text.matchAll(LIST_ITEM)].map((m) => m.index);
  for (const match of text.matchAll(DEFINITION)) {
    // Only where a definition starts a line or sentence, never inside a sentence.
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const before = text.slice(lineStart, match.index);
    if (/^[ \t]*$|[.:;][ \t]+$/.test(before)) positions.push(match.index);
  }
  return [...new Set(positions)].sort((a, b) => a - b);
}

// Inline definitions (M4 step 7, D40): a parenthesis holding a quoted, capitalised term, e.g.
//   (the "Effective Date")   ("Licensee")   (hereinafter "Supplier")
//   (each, a "Party" and collectively, the "Parties")   -> both terms
// Measured on CUAD: 478 of 510 contracts use them (308 use "X" means), and lawyer-labelled
// clauses that use a defined term rise from 35% to 73% when they are counted. A parenthesis
// that only points elsewhere ("as defined in", "see") defines nothing and is skipped.
const PARENTHESIS = /\(([^()\r\n]{1,240})\)/g;
const QUOTED_TERM = /["“]([A-Z][^"”\r\n]{0,60})["”]/g;
const REFERENCE_ONLY = /\b(?:as\s+defined|defined\s+in|see|referred\s+to\s+in)\b/i;

/**
 * Defined terms with where their definition starts: at the opening quote for "X" means, at
 * the opening parenthesis for inline ones. Sorted by position; a term may appear twice.
 */
export function findDefinitions(text: string): { term: string; start: number }[] {
  const found = [...text.matchAll(DEFINITION)].map((m) => ({ term: m[1] ?? "", start: m.index }));
  for (const p of text.matchAll(PARENTHESIS)) {
    const inside = p[1] ?? "";
    if (REFERENCE_ONLY.test(inside)) continue;
    for (const q of inside.matchAll(QUOTED_TERM)) {
      const term = (q[1] ?? "").trim();
      if (term.length > 0) found.push({ term, start: p.index });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** At most this many characters of definition text are cited. */
export const MAX_DEFINITION_CHARS = 1_200;

/**
 * The definition's text in `text`, for a definition found at `start` (see findDefinitions):
 *   "X" means ...  -> from the opening quote to the end of that paragraph (blank line), or to
 *                     the next "Y" means definition, whichever comes first;
 *   (the "X")      -> the sentence the parenthesis belongs to, up to the closing parenthesis.
 * Capped at MAX_DEFINITION_CHARS (cut after the last sentence end inside the cap when there
 * is one). Offsets in `text`; null when nothing definition-like is at `start`. The caller
 * cites text.slice(start, end): always the document's own words (T3).
 */
export function definitionSpan(text: string, start: number): { start: number; end: number } | null {
  if (text[start] === "(") {
    const close = text.indexOf(")", start);
    if (close === -1 || close - start > 242) return null;
    // Back to the sentence start (at most 600 chars): a line break, or ". " / "; " / ": "
    // followed by a capital, digit or quote. "Acme Inc. (" is not a sentence end: found by
    // the worker test, where "(the ...) by Acme Inc. ("Supplier")" was cut after "Inc.".
    const floor = Math.max(0, start - 600);
    let from = start;
    while (from > floor) {
      const prev = text[from - 1] ?? "";
      if (prev === "\n") break;
      if (
        /\s/.test(prev) &&
        /[.;:]/.test(text[from - 2] ?? "") &&
        /[A-Z0-9"“]/.test(text[from] ?? "")
      ) {
        break;
      }
      from--;
    }
    while (from < start && /\s/.test(text[from] ?? "")) from++;
    return { start: from, end: close + 1 };
  }
  DEFINITION.lastIndex = start;
  const m = DEFINITION.exec(text);
  DEFINITION.lastIndex = 0;
  if (m?.index !== start) return null;
  const after = start + m[0].length;
  const limit = Math.min(text.length, start + MAX_DEFINITION_CHARS);
  let end = limit;
  const blank = text.slice(after, limit).search(/\n\s*\n/);
  if (blank !== -1) end = after + blank;
  DEFINITION.lastIndex = after;
  const next = DEFINITION.exec(text);
  DEFINITION.lastIndex = 0;
  if (next !== null && next.index < end) end = next.index;
  if (end === limit && limit < text.length) {
    const lastStop = text.slice(after, end).search(/[.;](?=[^.;]*$)/);
    if (lastStop !== -1) end = after + lastStop + 1;
  }
  while (end > after && /\s/.test(text[end - 1] ?? "")) end--;
  return { start, end };
}
