import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cuadAvailable, loadCuad, type CuadContract } from "./load";
import { measureRedaction } from "./redaction";

describe("measureRedaction", () => {
  const contract: CuadContract = {
    title: "T",
    text: "Notices to legal@acme.com. Governing law: Delaware.",
    spans: [
      { clauseType: "Notice", text: "Notices to legal@acme.com.", start: 0 },
      { clauseType: "Governing Law", text: "Governing law: Delaware.", start: 27 },
    ],
  };

  it("counts redactions and the labelled spans they alter", () => {
    const report = measureRedaction([contract]);
    expect(report.redactions).toMatchObject({ total: 1, EMAIL: 1 });
    expect(report.clauseSpans).toMatchObject({
      labelled: 2,
      altered: 1,
      byClauseType: { Notice: 1 },
    });
    expect(report.examples.EMAIL[0]).toContain("[[legal@acme.com]]");
  });
});

// Real-contract measurement. Requires `npm run fetch:cuad -w @lexguard/evals`; not run in CI
// (40 MB download). No thresholds: CUAD has no PII labels, so this describes, it does not score.
describe.skipIf(!cuadAvailable())("CUAD over-redaction", () => {
  it("writes results/cuad-redaction.json", { timeout: 300_000 }, () => {
    const contracts = loadCuad();
    // Zero configuration, and the region most CUAD contracts come from (US SEC filings).
    const internationalOnly = measureRedaction(contracts);
    const withUs = measureRedaction(contracts, { phoneRegions: ["US"] });
    writeFileSync(
      new URL("../results/cuad-redaction.json", import.meta.url),
      `${JSON.stringify({ internationalOnly, withUs }, null, 2)}\n`,
    );
    expect(withUs.contracts).toBe(510);
  });
});
