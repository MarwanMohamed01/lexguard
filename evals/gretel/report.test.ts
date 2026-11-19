import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
        row("Patient ID 020 7946 0958", [
          { value: "020 7946 0958", types: ["medical_record_number"] },
        ]),
      ],
      "r",
    );
    expect(report.all.strict.fp).toBe(0);
    expect(report.all.redactedOtherPii).toBe(1);
    expect(report.coverage).toMatchObject({ labelledEntities: 1, supportedEntities: 0 });
  });
});

// Public-data eval. The dataset is downloaded locally (npm run fetch:gretel -w @lexguard/evals)
// and is not present in CI, so this suite is skipped there. Results are committed.
describe.skipIf(!gretelAvailable())("Gretel PII eval", () => {
  it("writes results/gretel.json", async () => {
    const report = evaluateGretel(await loadGretelTest(), REVISION);
    writeFileSync(
      new URL("../results/gretel.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(report.all.rows).toBe(5_000);
  });
});
