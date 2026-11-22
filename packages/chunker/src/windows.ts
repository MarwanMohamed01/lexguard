import {
  findDefinitions,
  findHeadingCandidates,
  findSoftBoundaries,
  type HeadingCandidate,
} from "./detect";
import type { Definition } from "./types";

// Detection (the regex passes) is ~90% of chunking CPU, and each match only looks at its own
// line plus a little text after it. So detection can run on windows of the document, in
// separate invocations, and give exactly the same result as one pass over the whole text.
// Choosing headings and packing (cheap) then run once over everything (planChunks).
//
// Why windows are exact:
//   - Every window starts at a line start (just after "\n"). No detection pattern consumes
//     a line break, and every look-behind stays on its own line, so nothing before a window
//     can change what is found inside it.
//   - Matches peek ahead: titles (<= 100 chars), definitions, and "\s+" runs of any length.
//     Each window therefore reads MARGIN extra characters, extended across a whitespace run,
//     and keeps only matches that START inside it. The next window finds the rest.
// The CUAD eval checks windowed == whole on all 510 contracts with tiny windows.

/** Everything detection finds in one window, with offsets into the whole text. */
export interface Detections {
  headings: HeadingCandidate[];
  softBoundaries: number[];
  definitions: Definition[];
}

export interface TextWindow {
  from: number;
  to: number;
}

const MARGIN = 2_000;

/**
 * Splits [0, text.length) into windows of about `windowChars`, each cut just after a line
 * break. A text without a line break past the target stays one window (correctness first).
 */
export function planWindows(text: string, windowChars = 200_000): TextWindow[] {
  if (!Number.isInteger(windowChars) || windowChars < 1) {
    throw new RangeError("windowChars must be a positive integer");
  }
  const windows: TextWindow[] = [];
  let from = 0;
  while (from < text.length) {
    const newline = text.indexOf("\n", from + windowChars - 1);
    const to = newline === -1 ? text.length : newline + 1;
    windows.push({ from, to });
    from = to;
  }
  return windows;
}

export function detectWindow(text: string, window: TextWindow): Detections {
  const { from, to } = window;
  if (from !== 0 && text[from - 1] !== "\n") {
    throw new RangeError("a window must start at the beginning of the text or of a line");
  }
  let end = Math.min(text.length, to + MARGIN);
  while (end < text.length && /\s/.test(text[end - 1] ?? "")) end++;

  const slice = text.slice(from, end);
  const limit = to - from;
  return {
    headings: findHeadingCandidates(slice)
      .filter((c) => c.start < limit)
      .map((c) => ({ ...c, start: c.start + from })),
    softBoundaries: findSoftBoundaries(slice)
      .filter((p) => p < limit)
      .map((p) => p + from),
    definitions: findDefinitions(slice)
      .filter((d) => d.start < limit)
      .map((d) => ({ ...d, start: d.start + from })),
  };
}

/** Joins per-window detections, in window order, into one. */
export function mergeDetections(parts: readonly Detections[]): Detections {
  return {
    headings: parts.flatMap((p) => p.headings),
    softBoundaries: parts.flatMap((p) => p.softBoundaries),
    definitions: parts.flatMap((p) => p.definitions),
  };
}
