import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateGretel } from "./evaluate";
import { gretelAvailable, loadGretelTest, type GretelRow } from "./load";

const REVISION = "e06eb1499ca8d54470f085021cd8e54f9efac7fd";

describe("evaluateGretel scoring rules", () => {
  const row = (text: string, entities: GretelRow["entities"]): GretelRow => ({
    uid: "u",
    domain: "legal-documents",
    documentType: "NDA",
    text,
    entities,
  });

  it("counts an exact catch in both strict and overlap", () => {
    const report = evaluateGretel(
      [row("Mail a@b.org now", [{ value: "a@b.org", types: ["email"] }])],
      "r",
    );
    expect(report.all.strict).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(report.all.overlap).toMatchObject({ tp: 1, fp: 0, fn: 0 });
  });

  it("counts a partial catch as overlap only", () => {
    const report = evaluateGretel(
      // The label includes the word "Tel", so our redaction can only cover part of it.
      [
        row("Call Tel +44 20 7946 0958", [
          { value: "Tel +44 20 7946 0958", types: ["phone_number"] },
        ]),
      ],
      "r",
    );
    expect(report.all.strict).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(report.all.overlap).toMatchObject({ tp: 1, fp: 0, fn: 0 });
  });

  it("does not count redacting an unsupported PII type as a false alarm", () => {
    const report = evaluateGretel(
      [
        row("Patient ID +44 20 7946 0958", [
          { value: "+44 20 7946 0958", types: ["medical_record_number"] },
        ]),
      ],
      "r",
    );
    expect(report.all.strict.fp).toBe(0);
    expect(report.all.redactedOtherPii).toBe(1);
    expect(report.coverage).toMatchObject({ labelledEntities: 1, supportedEntities: 0 });
  });
});

// Regression gate on public data (CI downloads the pinned dataset before `npm run check`).
// Baseline 2026-11-19, libphonenumber VALID + regions US/GB/AU: precision 0.966, recall 0.750,
// rounded down. Raise these when redaction improves; never lower them to make a change pass.
const MIN_PRECISION = 0.96;
const MIN_RECALL = 0.74;

// Skipped only when the data has not been downloaded (npm run fetch:gretel -w @lexguard/evals).
describe.skipIf(!gretelAvailable())("Gretel PII eval", () => {
  let withRegions: ReturnType<typeof evaluateGretel>;

  beforeAll(async () => {
    const rows = await loadGretelTest();
    // Zero configuration: only international "+..." numbers are recognised.
    const internationalOnly = evaluateGretel(rows, REVISION);
    // A deployment configures its own regions; these are the national formats that occur in
    // Gretel's documents.
    withRegions = evaluateGretel(rows, REVISION, { phoneRegions: ["US", "GB", "AU"] });
    // Deterministic output (no timestamps), so the committed file only changes when results do.
    writeFileSync(
      new URL("../results/gretel.json", import.meta.url),
      `${JSON.stringify({ internationalOnly, withRegions }, null, 2)}\n`,
    );
  }, 120_000);

  it("scores all 5,000 test documents", () => {
    expect(withRegions.all.rows).toBe(5_000);
  });

  it(`precision ≥ ${String(MIN_PRECISION)}`, () => {
    expect(withRegions.all.strict.precision).toBeGreaterThanOrEqual(MIN_PRECISION);
  });

  it(`recall ≥ ${String(MIN_RECALL)}`, () => {
    expect(withRegions.all.strict.recall).toBeGreaterThanOrEqual(MIN_RECALL);
  });
});
