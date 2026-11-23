import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { chunkDocument, detectWindow, planChunks, planWindows } from "@lexguard/chunker";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bucketOf,
  calibrate,
  diagnoseStructureAware,
  fixedSize,
  isKept,
  labelledSpans,
  measureIntegrity,
  recursive,
  structureAware,
  type SplitterReport,
  type StructureDiagnostics,
} from "./chunking";
import { cuadAvailable, loadCuad, type CuadContract } from "./load";

const contract = (text: string, spans: CuadContract["spans"] = []): CuadContract => ({
  title: "T",
  text,
  spans,
});

describe("baseline splitters", () => {
  it("fixed-size cuts every N characters, with optional overlap", () => {
    expect(fixedSize(4)("abcdefghij")).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 10 },
    ]);
    expect(fixedSize(4, 2)("abcdefgh")).toEqual([
      { start: 0, end: 4 },
      { start: 2, end: 6 },
      { start: 4, end: 8 },
    ]);
  });

  it("recursive prefers blank lines, then lines, then spaces, and packs up to size", () => {
    const text = "aaaa bbbb\n\ncccc\ndddd eeee";
    const pieces = recursive(10)(text).map((p) => text.slice(p.start, p.end));
    expect(pieces).toEqual(["aaaa bbbb", "\n\ncccc", "\ndddd eeee"]);
    expect(pieces.join("")).toBe(text);
  });

  it("recursive falls back to hard cuts in text without separators", () => {
    expect(recursive(4)("x".repeat(10)).map((p) => p.end - p.start)).toEqual([4, 4, 2]);
    expect(recursive(4)("")).toEqual([]);
  });
});

describe("measurement", () => {
  it("counts a clause as kept only when one piece contains all of it", () => {
    const pieces = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    expect(isKept(pieces, 10, 0, 10)).toBe(true); // exactly the first piece
    expect(isKept(pieces, 10, 10, 20)).toBe(true); // starts on a boundary
    expect(isKept(pieces, 10, 5, 15)).toBe(false); // crosses the boundary
    expect(isKept(pieces, 10, 9, 11)).toBe(false);
  });

  it("finds a clause kept by an earlier, overlapping piece", () => {
    const pieces = [
      { start: 0, end: 10 },
      { start: 5, end: 12 },
    ];
    expect(isKept(pieces, 10, 1, 9)).toBe(true);
    expect(isKept(pieces, 10, 6, 12)).toBe(true);
  });

  it("drops spans whose text does not match their offset", () => {
    const c = contract("Governing law: Delaware.", [
      { clauseType: "Law", text: "Delaware", start: 15 },
      { clauseType: "Law", text: "Texas", start: 15 },
      { clauseType: "Law", text: "", start: 0 },
    ]);
    const { spans, invalid } = labelledSpans([c]);
    expect(spans).toEqual([{ contract: 0, clauseType: "Law", start: 15, end: 23 }]);
    expect(invalid).toBe(2);
  });

  it("buckets by length and keeps too-long clauses out of the headline", () => {
    expect([10, 500, 3_000, 5_000].map((n) => bucketOf(n, 4_000))).toEqual([
      "short",
      "medium",
      "long",
      "tooLong",
    ]);
    const text = "a".repeat(30);
    const c = contract(text, [
      { clauseType: "A", text: "a".repeat(5), start: 0 },
      { clauseType: "B", text: "a".repeat(10), start: 8 },
      { clauseType: "C", text: text, start: 0 },
    ]);
    const { spans } = labelledSpans([c]);
    const report = measureIntegrity("fixed", [c], spans, fixedSize(10), 20);
    expect(report.integrity).toEqual({ kept: 1, total: 2, rate: 0.5 });
    expect(report.byLength.tooLong).toEqual({ kept: 0, total: 1, rate: 0 });
    expect(report.byClauseType).toEqual({
      A: { kept: 1, total: 1, rate: 1 },
      B: { kept: 0, total: 1, rate: 0 },
    });
  });

  it("calibrates a baseline to a target chunk count", () => {
    const contracts = [contract("x".repeat(1_000))];
    expect(calibrate(contracts, (size) => fixedSize(size), 4)).toBe(250);
  });

  it("explains why a clause broke: at a heading or at a size split", () => {
    const filler = "Words here. ".repeat(30);
    const text = `1 Term. ${filler}\n2 Fees. ${filler}`;
    const second = text.indexOf("2 Fees");
    const c = contract(text, [
      {
        clauseType: "Across heading",
        text: text.slice(second - 20, second + 20),
        start: second - 20,
      },
    ]);
    const { spans } = labelledSpans([c]);
    const d = diagnoseStructureAware([c], spans, { targetChars: 200, maxChars: 400 });
    expect(d.offsetViolations).toBe(0);
    expect(d.brokenBy.heading).toBe(1);
    expect(d.examples.heading[0]?.aroundCut).toContain("⟦|⟧2 Fees");
  });
});

// ---------------------------------------------------------------------------------------------
// Real-contract eval and CI gate. CI downloads CUAD (pinned, cached) before `npm run check`.

const OPTIONS = { targetChars: 2_000, maxChars: 4_000 };

// Baseline 2026-11-23: 13,742 of 13,823 clauses kept (0.9941), see evals/cuad/README.md.
// The chunker is deterministic, so the margin only allows about 14 more broken clauses.
// Raise when the chunker improves; never lower to make a change pass.
const MIN_INTEGRITY = 0.993;

describe.skipIf(!cuadAvailable())("CUAD clause integrity", () => {
  let ours: SplitterReport;
  let reports: SplitterReport[];
  let diagnostics: StructureDiagnostics;
  let invalidSpans: number;

  beforeAll(() => {
    const contracts = loadCuad();
    const labelled = labelledSpans(contracts);
    invalidSpans = labelled.invalid;
    const { spans } = labelled;
    const measure = (name: string, splitter: (text: string) => { start: number; end: number }[]) =>
      measureIntegrity(name, contracts, spans, splitter, OPTIONS.maxChars);

    ours = measure("structure-aware (ours)", structureAware(OPTIONS));
    // Equal chunk count: every splitter gets the same average chunk length and the same
    // storage/embedding cost, so nobody wins by using bigger chunks.
    const fixedAtCount = calibrate(contracts, (s) => fixedSize(s), ours.chunks);
    const recursiveAtCount = calibrate(contracts, (s) => recursive(s), ours.chunks);
    reports = [
      ours,
      measure(
        `recursive, size ${String(recursiveAtCount)} (equal chunk count)`,
        recursive(recursiveAtCount),
      ),
      measure(`fixed-size ${String(fixedAtCount)} (equal chunk count)`, fixedSize(fixedAtCount)),
      // For reference: the baselines at our nominal sizes, and the usual 10% overlap.
      measure(`recursive, size ${String(OPTIONS.targetChars)}`, recursive(OPTIONS.targetChars)),
      measure(`recursive, size ${String(OPTIONS.maxChars)}`, recursive(OPTIONS.maxChars)),
      measure(
        `fixed-size ${String(fixedAtCount)}, 10% overlap`,
        fixedSize(fixedAtCount, Math.round(fixedAtCount / 10)),
      ),
    ];
    diagnostics = diagnoseStructureAware(contracts, spans, OPTIONS);

    // Deterministic output (no timings), so the committed file only changes when results do.
    writeFileSync(
      new URL("../results/cuad-chunking.json", import.meta.url),
      `${JSON.stringify({ options: OPTIONS, invalidSpans, reports, diagnostics }, null, 2)}\n`,
    );
  }, 300_000);

  it("keeps every offset exact and every chunk within maxChars", () => {
    expect(diagnostics.offsetViolations).toBe(0);
    expect(diagnostics.oversizedChunks).toBe(0);
  });

  it("keeps at least the baseline share of labelled clauses whole", () => {
    expect(ours.integrity.rate).toBeGreaterThanOrEqual(MIN_INTEGRITY);
  });

  it("beats both baselines at equal chunk count", () => {
    const [, recursiveEqual, fixedEqual] = reports;
    expect(ours.integrity.rate).toBeGreaterThan(recursiveEqual?.integrity.rate ?? 1);
    expect(ours.integrity.rate).toBeGreaterThan(fixedEqual?.integrity.rate ?? 1);
  });
});

// The chunking Workflow (M2 step 5d) detects structure in windows, in separate invocations,
// then plans chunks once. That must give exactly what one pass gives. Tiny windows (20k
// chars) put several window edges in almost every contract: thousands of edges in total.
describe.skipIf(!cuadAvailable())("CUAD windowed chunking", () => {
  it("gives exactly the same chunks, sections and definitions as one pass", () => {
    let edges = 0;
    const mismatches: string[] = [];
    for (const { title, text } of loadCuad()) {
      const windows = planWindows(text, 20_000);
      edges += windows.length - 1;
      const windowed = planChunks(
        text,
        windows.map((w) => detectWindow(text, w)),
        OPTIONS,
      );
      if (!isDeepStrictEqual(windowed, chunkDocument(text, OPTIONS))) mismatches.push(title);
    }
    expect(mismatches).toEqual([]);
    expect(edges).toBeGreaterThan(1_000);
  }, 120_000); // 1,020 chunking passes over 510 contracts
});
