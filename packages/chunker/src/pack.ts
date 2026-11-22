import type { Chunk, Section } from "./types";

interface Limits {
  targetChars: number;
  maxChars: number;
}

interface Span {
  start: number;
  end: number;
  members: Section[];
}

/**
 * Packs sections into chunks:
 *   - neighbouring sections are merged while the chunk stays within targetChars, so short
 *     clauses and definitions do not become dozens of tiny chunks. A new top-level section
 *     (article) starts a new chunk unless the current one is tiny, so chunks keep a
 *     meaningful section path;
 *   - a section longer than maxChars is split at the best available boundary;
 *   - everything else is one chunk.
 * Chunks are contiguous: together they cover the text exactly, no gaps, no overlap.
 */
export function packSections(
  text: string,
  sections: readonly Section[],
  softBoundaries: readonly number[],
  limits: Limits,
): Chunk[] {
  const spans: Span[] = [];
  let current: Span | null = null;

  for (const section of sections) {
    const length = section.end - section.start;
    if (length > limits.maxChars) {
      if (current !== null) spans.push(current);
      current = null;
      for (const [start, end] of splitSection(text, section, softBoundaries, limits)) {
        spans.push({ start, end, members: [section] });
      }
    } else if (
      current !== null &&
      section.end - current.start <= limits.targetChars &&
      (sameTopLevel(current, section) || current.end - current.start < limits.targetChars / 4)
    ) {
      current.end = section.end;
      current.members.push(section);
    } else {
      if (current !== null) spans.push(current);
      current = { start: section.start, end: section.end, members: [section] };
    }
  }
  if (current !== null) spans.push(current);

  return spans.map((span, index) => ({
    index,
    start: span.start,
    end: span.end,
    text: text.slice(span.start, span.end),
    sectionPath: commonPath(span.members),
    heading: span.members[0]?.label ?? null,
  }));
}

const sameTopLevel = (span: Span, section: Section): boolean =>
  span.members[0]?.path[0] === section.path[0];

/** The headings shared by every section in the chunk: 7.1.9 + 7.1.10 -> ["7 ...", "7.1"]. */
function commonPath(members: readonly Section[]): string[] {
  const [first, ...rest] = members;
  if (first === undefined) return [];
  let length = first.path.length;
  for (const member of rest) {
    let i = 0;
    while (i < length && member.path[i] === first.path[i]) i++;
    length = i;
  }
  return first.path.slice(0, length);
}

function splitSection(
  text: string,
  section: Section,
  softBoundaries: readonly number[],
  limits: Limits,
): [number, number][] {
  const pieces: [number, number][] = [];
  let position = section.start;
  while (section.end - position > limits.maxChars) {
    const cut = chooseCut(text, position, softBoundaries, limits);
    pieces.push([position, cut]);
    position = cut;
  }
  pieces.push([position, section.end]);
  return pieces;
}

// Boundary kinds, best first. Each pattern's match END is where the next piece starts.
const PARAGRAPH = /\r?\n[ \t]*\r?\n\s*/g;
const LINE = /\n/g;
const SENTENCE = /[.;:!?]["”')]?\s+/g;
const WHITESPACE = /\s+/g;

/**
 * Where to end a piece that starts at `from`: somewhere in the window
 * (from + targetChars/2, from + maxChars]. Prefers, in order: a list item or definition,
 * a paragraph break, a line break, a sentence end, any whitespace; within the best kind
 * found, the boundary closest to from + targetChars. Hard cut only as a last resort.
 * Only called when more than maxChars remain, so the window never reaches the section end.
 */
function chooseCut(
  text: string,
  from: number,
  softBoundaries: readonly number[],
  limits: Limits,
): number {
  const low = from + Math.floor(limits.targetChars / 2);
  const high = from + limits.maxChars;
  const ideal = from + limits.targetChars;
  const window = text.slice(low, high);
  const ends = (pattern: RegExp): number[] =>
    [...window.matchAll(pattern)].map((m) => low + m.index + m[0].length).filter((p) => p > low);

  const kinds: (() => number[])[] = [
    () => softBoundaries.filter((p) => p > low && p <= high),
    () => ends(PARAGRAPH),
    () => ends(LINE),
    () => ends(SENTENCE),
    () => ends(WHITESPACE),
  ];
  for (const kind of kinds) {
    const options = kind();
    if (options.length > 0) {
      return options.reduce((best, p) => (Math.abs(p - ideal) < Math.abs(best - ideal) ? p : best));
    }
  }
  // Hard cut, but never between the two halves of a surrogate pair (e.g. an emoji).
  const code = text.charCodeAt(high);
  return code >= 0xdc00 && code <= 0xdfff ? high - 1 : high;
}
