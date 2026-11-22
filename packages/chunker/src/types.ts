import { z } from "zod";

/**
 * One piece of the document. Offsets are JavaScript string indices (UTF-16 code units), so
 * `text === fullText.slice(start, end)` always holds. Consumers in other languages (Python
 * counts code points) must convert if the text contains characters outside the BMP.
 */
export interface Chunk {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Labels of the enclosing headings, outermost first, e.g. ["7 Training", "7.1"]. */
  sectionPath: string[];
  /** Label of the heading this chunk starts in, or null before the first heading. */
  heading: string | null;
}

/** A heading the chunker accepted, with the span of the section it opens. */
export interface Section {
  start: number;
  end: number;
  depth: number;
  label: string | null;
  path: string[];
}

/** A defined term ("Month" means ...), recorded for cross-reference resolution (M4). */
export interface Definition {
  term: string;
  start: number;
}

export interface ChunkResult {
  chunks: Chunk[];
  sections: Section[];
  definitions: Definition[];
}

// Character limits. The final values depend on the embedding model's input limit (M3);
// these defaults match the per-chunk redaction budget measured in M1 (D11).
export const ChunkOptionsSchema = z
  .object({
    targetChars: z.number().int().min(200).max(50_000).default(2_000),
    maxChars: z.number().int().min(200).max(100_000).default(4_000),
  })
  .refine((o) => o.maxChars >= o.targetChars, { message: "maxChars must be >= targetChars" });

export type ChunkOptions = z.input<typeof ChunkOptionsSchema>;
