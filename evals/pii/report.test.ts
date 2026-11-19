import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATASET_VERSION, piiCases } from "./dataset";
import { buildReport, compare, toMetrics } from "./metrics";

describe("metrics", () => {
  it("counts exact (type, value) matches", () => {
    const expected = [
      { type: "EMAIL" as const, value: "a@b.co" },
      { type: "PHONE" as const, value: "+44 20 7946 0958" },
    ];
    const predicted = [
      { type: "EMAIL" as const, value: "a@b.co" },
      { type: "CARD" as const, value: "4111 1111 1111 1111" },
    ];
    expect(compare(expected, predicted)).toEqual({ tp: 1, fp: 1, fn: 1 });
  });

  it("uses the empty-case conventions", () => {
    expect(toMetrics({ tp: 0, fp: 0, fn: 0 })).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(toMetrics({ tp: 0, fp: 2, fn: 0 })).toMatchObject({ precision: 0, recall: 1, f1: 0 });
  });
});

// Regression gate: fails CI if redaction quality drops below the measured baseline.
// History (pii-v1): 0.926 / 0.926 at first run; 1.000 / 0.963 after the phone pattern fix
// (validated on Gretel, not tuned to this set). Thresholds are the latest baseline rounded down.
// Raise these when the redactor improves; never lower them to make a change pass.
const MIN_PRECISION = 0.96;
const MIN_RECALL = 0.96;

describe(`PII redaction eval (${DATASET_VERSION})`, () => {
  const report = buildReport(piiCases, DATASET_VERSION);

  // Deterministic output (no timestamps), so the committed file only changes when results do.
  writeFileSync(
    new URL("../results/pii.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  it(`precision ≥ ${String(MIN_PRECISION)}`, () => {
    expect(report.supported.precision).toBeGreaterThanOrEqual(MIN_PRECISION);
  });

  it(`recall ≥ ${String(MIN_RECALL)}`, () => {
    expect(report.supported.recall).toBeGreaterThanOrEqual(MIN_RECALL);
  });
});
