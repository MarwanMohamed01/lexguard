// Retrieval eval dataset, built only from CUAD's own labels (no hand-written queries or
// answers, D10).
//
// A case is one (contract, clause type) pair that lawyers labelled at least once:
//   query    = CUAD's question for that clause type, reduced to its category and description,
//              e.g. "Governing Law: Which state/country's law governs the interpretation of
//              the contract?" (the "Highlight the parts (if any) ... reviewed by a lawyer"
//              wrapper is the same for all 41 types and carries no information);
//   relevant = the chunks of that contract that overlap a labelled span of that type.
// The search runs inside one contract, as Lexguard's agents will search one document.
import { chunkDocument, type ChunkOptions } from "@lexguard/chunker";
import { embeddingInput } from "@lexguard/retrieval";
import { locateClause, tokens, WordIndex } from "../cuad/conversion";
import type { CuadContract } from "../cuad/load";

export interface Piece {
  start: number;
  end: number;
  heading: string | null;
  sectionPath: string[];
}

export interface Doc {
  title: string;
  text: string;
  chunks: Piece[];
}

export interface Case {
  doc: number;
  clauseType: string;
  /** Indices of the chunks that overlap at least one labelled span of this type. */
  relevant: number[];
}

export interface Corpus {
  name: string;
  docs: Doc[];
  cases: Case[];
}

/** What is embedded for a chunk: its text alone, or with the contextual header (D15). */
export type Variant = "plain" | "header";
export const VARIANTS: readonly Variant[] = ["plain", "header"];

export function chunkInput(doc: Doc, chunk: Piece, variant: Variant): string {
  const text = doc.text.slice(chunk.start, chunk.end);
  return variant === "plain"
    ? text
    : embeddingInput(
        { title: doc.title, sectionPath: chunk.sectionPath, heading: chunk.heading },
        text,
      );
}

export const corpusInputs = (corpus: Corpus, variant: Variant): string[] =>
  corpus.docs.flatMap((doc) => doc.chunks.map((chunk) => chunkInput(doc, chunk, variant)));

const QUESTION = /related to "([^"]+)".*Details: (.+)$/su;

/** "Governing Law" + its description, from CUAD's full question. */
export function queryFromQuestion(question: string): string {
  const match = QUESTION.exec(question);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`unexpected CUAD question format: ${question.slice(0, 80)}`);
  }
  return `${match[1]}: ${match[2].trim()}`;
}

/** Chunks (sorted, contiguous or not) overlapping any of the spans. */
export function overlapping(
  chunks: readonly { start: number; end: number }[],
  spans: readonly { start: number; end: number }[],
): number[] {
  const hits = new Set<number>();
  for (const span of spans) {
    chunks.forEach((chunk, index) => {
      if (span.start < chunk.end && span.end > chunk.start) hits.add(index);
    });
  }
  return [...hits].sort((a, b) => a - b);
}

export interface LocatedSpan {
  clauseType: string;
  start: number;
  end: number;
}

/** Groups a document's spans by clause type into cases (types with no span get no case). */
export function casesFor(doc: number, chunks: readonly Piece[], spans: readonly LocatedSpan[]) {
  const byType = new Map<string, LocatedSpan[]>();
  for (const span of spans) {
    const list = byType.get(span.clauseType) ?? [];
    list.push(span);
    byType.set(span.clauseType, list);
  }
  const cases: Case[] = [];
  for (const [clauseType, list] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const relevant = overlapping(chunks, list);
    if (relevant.length > 0) cases.push({ doc, clauseType, relevant });
  }
  return cases;
}

/** CUAD's own text, chunked by our chunker. Spans whose text does not match are skipped. */
export function textCorpus(contracts: readonly CuadContract[], options: ChunkOptions): Corpus {
  const docs: Doc[] = [];
  const cases: Case[] = [];
  contracts.forEach((contract, index) => {
    const { chunks } = chunkDocument(contract.text, options);
    docs.push({
      title: contract.title,
      text: contract.text,
      chunks: chunks.map(({ start, end, heading, sectionPath }) => ({
        start,
        end,
        heading,
        sectionPath,
      })),
    });
    const spans = contract.spans
      .filter((s) => s.text.length > 0 && contract.text.startsWith(s.text, s.start))
      .map((s) => ({ clauseType: s.clauseType, start: s.start, end: s.start + s.text.length }));
    cases.push(...casesFor(index, docs[index]?.chunks ?? [], spans));
  });
  return { name: "CUAD text", docs, cases };
}

/** One PDF as the real Worker stored it (evals/cuad/convert-run.mjs output). */
export interface ConvertedDoc {
  title: string;
  markdown: string | null;
  chunks: Piece[];
}

/**
 * The real converted PDFs with their stored chunks. CUAD's labels point into CUAD's text, so
 * each labelled clause is first located in the converted text (same matcher as the M2
 * conversion eval, D21); clauses it cannot place are counted, not guessed.
 */
export function convertedCorpus(
  converted: readonly ConvertedDoc[],
  contracts: readonly CuadContract[],
): Corpus & { unlocated: number } {
  const byTitle = new Map(contracts.map((c) => [c.title, c]));
  const docs: Doc[] = [];
  const cases: Case[] = [];
  let unlocated = 0;
  for (const doc of [...converted].sort((a, b) => (a.title < b.title ? -1 : 1))) {
    const reference = byTitle.get(doc.title);
    if (reference === undefined || doc.markdown === null) continue;
    const index = new WordIndex(tokens(doc.markdown));
    const spans: LocatedSpan[] = [];
    for (const span of reference.spans) {
      const { span: found } = locateClause(tokens(span.text), index);
      if (found === null) unlocated++;
      else spans.push({ clauseType: span.clauseType, ...found });
    }
    docs.push({ title: doc.title, text: doc.markdown, chunks: doc.chunks });
    cases.push(...casesFor(docs.length - 1, doc.chunks, spans));
  }
  return { name: "converted PDFs", docs, cases, unlocated };
}
