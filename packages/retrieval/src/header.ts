// Contextual header (PROJECT.md 3.1 step 3, D15): a chunk is embedded together with where it
// sits, so "The term is twelve months" inside "9 Term and Termination" of a "Supply Agreement"
// is not just a sentence about months. The header is only ever part of the text sent to the
// embedding model. It is never stored in the chunk's text, so offsets and quotes stay exact.
//
// The title comes from the uploader (a file name) and the section labels from the document,
// so both are untrusted text: they are flattened to one line each and capped, and nothing here
// is ever interpreted. The header is data for an embedding model, which takes no instructions.

export interface ChunkContext {
  /** Document title, e.g. the uploaded file name. */
  title: string;
  /** Enclosing headings, outermost first (chunker `sectionPath`). */
  sectionPath: readonly string[];
  /** Heading the chunk starts in; used when `sectionPath` is empty (flat contracts). */
  heading: string | null;
}

const MAX_TITLE_CHARS = 200;
const MAX_SECTION_CHARS = 300;

/**
 * One clean line: whitespace and underscores (file names) become single spaces; other control
 * and format characters (NUL, bidi overrides, zero-width) are removed, as are lone surrogates;
 * then capped at `max` code points, so a cut never splits a character in two. The upload
 * already sanitizes the title; this package does not rely on its callers for that.
 */
function oneLine(text: string, max: number): string {
  const clean = text
    .replace(/[\s_]+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]|\p{Cs}/gu, "")
    .trim();
  return Array.from(clean).slice(0, max).join("").trim();
}

export function contextualHeader(context: ChunkContext): string {
  const lines: string[] = [];
  const title = oneLine(context.title, MAX_TITLE_CHARS);
  if (title.length > 0) lines.push(`Document: ${title}`);
  const path =
    context.sectionPath.length > 0
      ? context.sectionPath.map((label) => oneLine(label, MAX_SECTION_CHARS)).join(" > ")
      : oneLine(context.heading ?? "", MAX_SECTION_CHARS);
  if (path.length > 0) lines.push(`Section: ${oneLine(path, MAX_SECTION_CHARS)}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}

/** The exact text sent to the embedding model for one chunk. */
export function embeddingInput(context: ChunkContext, chunkText: string): string {
  return contextualHeader(context) + chunkText;
}
