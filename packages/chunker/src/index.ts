import { buildSections, selectHeadings } from "./headings";
import { packSections } from "./pack";
import { ChunkOptionsSchema, type ChunkOptions, type ChunkResult } from "./types";
import { detectWindow, mergeDetections, type Detections } from "./windows";

/**
 * Splits a document into structure-aware chunks with exact offsets.
 *
 *   1. detect   find everything that looks like a heading, list item or definition
 *   2. select   keep the headings whose numbering is plausible (with resync)
 *   3. sections turn headings into a section tree covering the whole text
 *   4. pack     merge small sections, split oversized ones, within the size limits
 *
 * Guarantees: chunks are contiguous and cover the text exactly; for every chunk,
 * chunk.text === text.slice(chunk.start, chunk.end) and its length is <= maxChars.
 *
 * Long documents run step 1 in windows (windows.ts), possibly in separate invocations, then
 * steps 2-4 once with planChunks. Same result, by construction and by test.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): ChunkResult {
  return planChunks(text, [detectWindow(text, { from: 0, to: text.length })], options);
}

/** Steps 2-4: from the detections of all windows (in order) to chunks. */
export function planChunks(
  text: string,
  detections: readonly Detections[],
  options: ChunkOptions = {},
): ChunkResult {
  const limits = ChunkOptionsSchema.parse(options);
  if (text.length === 0) return { chunks: [], sections: [], definitions: [] };

  const found = mergeDetections(detections);
  const headings = selectHeadings(found.headings);
  const sections = buildSections(text.length, headings);
  const chunks = packSections(text, sections, found.softBoundaries, limits);
  return { chunks, sections, definitions: found.definitions };
}

export { isPlausibleNext, parseClauseNumber, type ClauseNumber } from "./sequence";
export type { Chunk, ChunkOptions, ChunkResult, Definition, Section } from "./types";
export { detectWindow, planWindows, type Detections, type TextWindow } from "./windows";
