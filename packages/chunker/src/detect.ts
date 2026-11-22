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
    // After "# ", the section starts at the "#" so the marks stay with their heading.
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const hashed = /^[ \t]*#{1,6}[ \t]+$/.test(text.slice(lineStart, match.index));
    candidates.push({
      kind: "numbered",
      start: hashed ? lineStart : match.index,
      number,
      marker: keyword === undefined ? raw : `${keyword} ${raw}`,
      title: titleAfter(text, match.index + match[0].length),
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

export function findDefinitions(text: string): { term: string; start: number }[] {
  return [...text.matchAll(DEFINITION)].map((m) => ({ term: m[1] ?? "", start: m.index }));
}
