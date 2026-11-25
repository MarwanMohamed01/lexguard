import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chunkDocument } from "@lexguard/chunker";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bucketOf,
  keptWhole,
  locateClause,
  ngramRecall,
  repeatedLines,
  tokens,
  WordIndex,
  wordAgreement,
  type ClauseOutcome,
} from "./conversion";
import { cuadAvailable, loadCuad } from "./load";

// Same limits as the Worker (CHUNK_OPTIONS) and the step 4 eval.
const OPTIONS = { targetChars: 2_000, maxChars: 4_000 };
const CONVERTED = new URL("../data/cuad/converted/", import.meta.url);

describe("conversion measurements", () => {
  it("compares words, ignoring case, punctuation and Markdown syntax", () => {
    const reference = tokens("The Supplier shall deliver.");
    const output = tokens("## THE supplier **shall** deliver");

    expect(wordAgreement(reference, output)).toEqual({ precision: 1, recall: 1 });
  });

  it("counts repeated words only as often as the reference has them", () => {
    const result = wordAgreement(tokens("a b"), tokens("a a a b"));

    expect(result).toEqual({ precision: 0.5, recall: 1 });
  });

  it("measures order with 8-word sequences", () => {
    const reference = tokens("one two three four five six seven eight nine");
    const same = new WordIndex(tokens("x one two three four five six seven eight nine y"));
    const shuffled = new WordIndex(tokens("nine eight seven six five four three two one"));

    expect(ngramRecall(reference, same.grams)).toBe(1);
    expect(ngramRecall(reference, shuffled.grams)).toBe(0);
  });

  it("locates a clause exactly, with its character span in the output", () => {
    const output = "# 7. Term\n\nThis Agreement **shall** continue for two years.";
    const result = locateClause(
      tokens("shall continue for two years"),
      new WordIndex(tokens(output)),
    );

    expect(result.outcome).toBe("exact");
    expect(output.slice(result.span?.start, result.span?.end)).toBe(
      "shall** continue for two years",
    );
  });

  it("finds a clause fuzzily when a page footer interrupts it, and misses absent ones", () => {
    const clause = tokens(
      "The Licensee shall pay all fees within thirty days of receipt of each invoice issued by the Licensor under this Agreement without set off",
    );
    const text =
      "Intro. The Licensee shall pay all fees within thirty days of receipt of each invoice issued by\nPage 4 of 20\nthe Licensor under this Agreement without set off. Next clause.";
    const output = new WordIndex(tokens(text));
    const found = locateClause(clause, output);

    expect(found.outcome).toBe("fuzzy");
    // Located from "The" to "off", footer included: that whole span must sit in one chunk.
    expect(text.slice(found.span?.start, found.span?.end)).toMatch(
      /^The Licensee.*Page 4.*set off$/s,
    );
    expect(locateClause(tokens("governed by the laws of Delaware"), output).outcome).toBe(
      "missing",
    );
  });

  it("does not stitch together two distant fragments as one clause", () => {
    const clause = tokens(
      "The Licensee shall pay all fees within thirty days of receipt of each invoice issued by the Licensor under this Agreement without set off",
    );
    const filler = " unrelated words".repeat(200);
    const output = new WordIndex(
      tokens(
        `The Licensee shall pay all fees within thirty days ${filler} issued by the Licensor under this Agreement without set off`,
      ),
    );

    expect(locateClause(clause, output).outcome).toBe("missing");
  });

  it("finds repeated lines (page headers and footers)", () => {
    const text = "Confidential\nA\nConfidential\nB\nConfidential\n---\n---\n---\nC";

    expect(repeatedLines(text)).toEqual({
      lines: 3,
      chars: 36,
      top: [{ line: "Confidential", count: 3 }],
    });
  });
});

interface Converted {
  title: string;
  pdfSha256: string;
  pdfBytes: number;
  httpStatus: number;
  error: string | null;
  status: string | null;
  uploadMs: number;
  readyMs: number;
  markdown: string | null;
  hiddenCharsRemoved: number | null;
  pageStarts?: number[] | null;
  chunks: { start: number; end: number; heading: string | null; sectionPath: string[] }[];
}

const available = () =>
  cuadAvailable() &&
  existsSync(CONVERTED) &&
  readdirSync(CONVERTED).some((f) => f.endsWith(".json"));

describe.skipIf(!available())("CUAD PDFs through the real Worker (toMarkdown)", () => {
  let converted: Converted[] = [];
  let report: ReturnType<typeof buildReport>;

  beforeAll(() => {
    converted = readdirSync(CONVERTED)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(new URL(f, CONVERTED), "utf8")) as Converted);
    report = buildReport(converted);
    writeFileSync(
      new URL("../results/cuad-conversion.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    // Matching 1,174 clauses in 30 documents; slower when other CUAD evals run in parallel.
  }, 120_000);

  it("converts and chunks every PDF", () => {
    expect(report.documents).toBe(30);
    expect(report.ready).toBe(30);
  });

  it("stores exactly the chunks the chunker produces on the stored text", () => {
    expect(report.workflowMismatches).toEqual([]);
  });

  it("turns every PDF's page markers into a page map", () => {
    expect(report.withPageMap).toBe(30);
    expect(report.pageMarkersLeftInText).toBe(0);
  });

  // Gates just under the measured values (D21), so a regression fails.
  it("keeps the labelled clauses through conversion", () => {
    expect(report.clauseRecall).toBeGreaterThanOrEqual(0.975); // measured 0.9796
  });

  it("keeps clauses whole in chunks of the converted text", () => {
    expect(report.integrityOnConverted.rate).toBeGreaterThanOrEqual(0.98); // measured 0.9863
  });
});

function buildReport(converted: readonly Converted[]) {
  const cuad = new Map(loadCuad().map((c) => [c.title, c]));
  const clauses: Record<ClauseOutcome, number> = { exact: 0, fuzzy: 0, missing: 0 };
  const integrity = { kept: 0, total: 0 };
  const baseline = { kept: 0, total: 0 };
  const missingExamples: { contract: string; clauseType: string; text: string }[] = [];
  const brokenExamples: { contract: string; clauseType: string; aroundCut: string }[] = [];
  const workflowMismatches: string[] = [];
  const perDocument = [];

  for (const doc of [...converted].sort((a, b) => a.pdfBytes - b.pdfBytes)) {
    const reference = cuad.get(doc.title);
    if (reference === undefined) throw new Error(`not in CUAD: ${doc.title}`);
    const markdown = doc.markdown ?? "";

    // Measured with the current chunker on the stored text. The Workflow must have stored
    // exactly that: after a chunker change, rerun convert-run.mjs or this check fails.
    const pieces = chunkDocument(markdown, OPTIONS).chunks;
    const expected = pieces.map((c) => [c.start, c.end]);
    const stored = doc.chunks.map((c) => [c.start, c.end]);
    if (JSON.stringify(expected) !== JSON.stringify(stored)) workflowMismatches.push(doc.title);

    const refWords = tokens(reference.text);
    const outWords = tokens(markdown);
    const index = new WordIndex(outWords);
    const words = wordAgreement(refWords, outWords);

    // Clauses: found in the converted text? kept whole by the chunks?
    const local: Record<ClauseOutcome, number> = { exact: 0, fuzzy: 0, missing: 0 };
    for (const span of reference.spans) {
      if (reference.text.slice(span.start, span.start + span.text.length) !== span.text) continue;
      const { outcome, span: found } = locateClause(tokens(span.text), index);
      clauses[outcome]++;
      local[outcome]++;
      if (outcome === "missing" && missingExamples.length < 400) {
        missingExamples.push({
          contract: doc.title,
          clauseType: span.clauseType,
          text: span.text.slice(0, 200),
        });
      }
      if (found !== null && bucketOf(found.end - found.start, OPTIONS.maxChars) !== "tooLong") {
        integrity.total++;
        if (keptWhole(pieces, found)) integrity.kept++;
        else if (brokenExamples.length < 400) {
          const cut =
            pieces.find((p) => p.start > found.start && p.start < found.end)?.start ?? found.start;
          brokenExamples.push({
            contract: doc.title,
            clauseType: span.clauseType,
            aroundCut: `${markdown.slice(Math.max(found.start, cut - 120), cut)}⟦|⟧${markdown.slice(cut, Math.min(found.end, cut + 120))}`,
          });
        }
      }
    }

    // Baseline: the same clauses, chunked on CUAD's own text (step 4's setting).
    const cuadPieces = chunkDocument(reference.text, OPTIONS).chunks;
    for (const span of reference.spans) {
      const end = span.start + span.text.length;
      if (reference.text.slice(span.start, end) !== span.text) continue;
      if (bucketOf(span.text.length, OPTIONS.maxChars) === "tooLong") continue;
      baseline.total++;
      if (keptWhole(cuadPieces, { start: span.start, end })) baseline.kept++;
    }

    perDocument.push({
      title: doc.title,
      pdfBytes: doc.pdfBytes,
      status: doc.status,
      error: doc.error,
      uploadMs: doc.uploadMs,
      readyMs: doc.readyMs,
      cuadChars: reference.text.length,
      markdownChars: markdown.length,
      hiddenCharsRemoved: doc.hiddenCharsRemoved,
      pages: doc.pageStarts?.length ?? null,
      wordPrecision: round(words.precision),
      wordRecall: round(words.recall),
      ngramRecall: round(ngramRecall(refWords, index.grams)),
      clauses: local,
      chunks: pieces.length,
      chunksOnCuadText: cuadPieces.length,
      sections: chunkDocument(markdown, OPTIONS).sections.length,
      sectionsOnCuadText: chunkDocument(reference.text, OPTIONS).sections.length,
      repeatedLines: repeatedLines(markdown),
      start: markdown.slice(0, 300),
    });
  }

  const totalClauses = clauses.exact + clauses.fuzzy + clauses.missing;
  return {
    documents: converted.length,
    ready: converted.filter((d) => d.status === "ready").length,
    withPageMap: converted.filter((d) => Array.isArray(d.pageStarts)).length,
    pages: converted.reduce((sum, d) => sum + (d.pageStarts?.length ?? 0), 0),
    pageMarkersLeftInText: converted.filter((d) => /^#{1,6} Page d+$/m.test(d.markdown ?? ""))
      .length,
    options: OPTIONS,
    clauses,
    clauseRecall: round((clauses.exact + clauses.fuzzy) / totalClauses),
    clauseExactRate: round(clauses.exact / totalClauses),
    integrityOnConverted: { ...integrity, rate: round(integrity.kept / integrity.total) },
    integrityOnCuadText: { ...baseline, rate: round(baseline.kept / baseline.total) },
    workflowMismatches,
    perDocument,
    missingExamples: spread(missingExamples, 15),
    brokenExamples: spread(brokenExamples, 15),
  };
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/** Up to n examples evenly spread across the list (not just the first contract's). */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)] as T);
}
