import type { HeadingCandidate } from "./detect";
import { isPlausibleNext, type ClauseNumber } from "./sequence";
import type { Section } from "./types";

// How many following numbered candidates must continue from a rejected candidate before we
// believe it anyway (see selectHeadings).
const CONFIRM = 2;

/**
 * Keeps the candidates that are real headings.
 *
 * Normal case: a numbered candidate is accepted when it is a plausible next step from the
 * last accepted heading (sequence.ts). That rejects cross-references and numbers in text.
 *
 * Resync: if a real heading was missed (garbled by PDF extraction) or a table of contents
 * already used up 1, 2, 3..., every later heading would look out of sequence. So a rejected
 * candidate is still accepted when the next CONFIRM numbered candidates each follow from it
 * step by step (e.g. 7.3 -> 7.4 -> 7.5). Cross-references almost never form such a chain.
 *
 * Reset candidates (EXHIBIT A, plain Markdown headings) are always accepted and restart
 * numbering, since exhibits number their own clauses from 1.
 */
export function selectHeadings(candidates: readonly HeadingCandidate[]): HeadingCandidate[] {
  const accepted: HeadingCandidate[] = [];
  let previous: ClauseNumber | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    if (accepted.at(-1)?.start === candidate.start) continue; // same spot found twice
    if (candidate.kind === "reset") {
      accepted.push(candidate);
      previous = null;
      continue;
    }
    if (isPlausibleNext(previous, candidate.number) || chainFollows(candidates, i)) {
      accepted.push(candidate);
      previous = candidate.number;
    }
  }
  return accepted;
}

function chainFollows(candidates: readonly HeadingCandidate[], from: number): boolean {
  const first = candidates[from];
  if (first?.kind !== "numbered") return false;
  let previous: ClauseNumber = first.number;
  let found = 0;
  for (let j = from + 1; j < candidates.length && found < CONFIRM; j++) {
    const next = candidates[j];
    if (next === undefined || next.kind === "reset") return false;
    if (!isPlausibleNext(previous, next.number)) return false;
    previous = next.number;
    found += 1;
  }
  return found === CONFIRM;
}

function labelOf(heading: HeadingCandidate): string {
  if (heading.kind === "reset") return heading.label;
  return heading.title === null ? heading.marker : `${heading.marker} ${heading.title}`;
}

const depthOf = (heading: HeadingCandidate): number =>
  heading.kind === "reset" ? heading.depth : heading.number.length;

/**
 * Turns accepted headings into sections that cover the whole text without gaps: each runs
 * from its heading to the next one. Text before the first heading is a preamble section
 * with an empty path. The path is the stack of enclosing headings, found by depth.
 */
export function buildSections(
  textLength: number,
  headings: readonly HeadingCandidate[],
): Section[] {
  const sections: Section[] = [];
  const firstStart = headings[0]?.start ?? textLength;
  if (firstStart > 0) {
    sections.push({ start: 0, end: firstStart, depth: 0, label: null, path: [] });
  }

  const stack: { depth: number; label: string }[] = [];
  headings.forEach((heading, i) => {
    const depth = depthOf(heading);
    const label = labelOf(heading);
    while ((stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
    stack.push({ depth, label });
    sections.push({
      start: heading.start,
      end: headings[i + 1]?.start ?? textLength,
      depth,
      label,
      path: stack.map((entry) => entry.label),
    });
  });
  return sections;
}
