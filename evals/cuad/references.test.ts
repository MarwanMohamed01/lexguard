// Section cross-references on all 510 CUAD contracts (M5 step 6, D50). CUAD has no labels for
// references, so this measures properties, not correctness against labels (D10): how many are
// found, how many point to another document, how many resolve to a section of the contract,
// and that every resolution is to a section with exactly that number.
import { chunkDocument } from "@lexguard/chunker";
import { findSectionReferences, resolveReference, sectionNumber } from "@lexguard/verifier";
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CHUNK_OPTIONS } from "../retrieval/sources";
import { cuadAvailable, loadCuad, type CuadContract } from "./load";

describe.skipIf(!cuadAvailable())("section references on CUAD", () => {
  let contracts: CuadContract[];
  beforeAll(() => {
    contracts = loadCuad();
  });

  it("finds and resolves references, and every resolution has the right number", () => {
    const totals = {
      contracts: contracts.length,
      withReferences: 0,
      references: 0,
      external: 0,
      internal: 0,
      resolved: 0,
    };
    const byKind: Record<string, { internal: number; resolved: number }> = {};
    for (const contract of contracts) {
      const { sections } = chunkDocument(contract.text, CHUNK_OPTIONS);
      const refs = findSectionReferences(contract.text);
      if (refs.length > 0) totals.withReferences++;
      for (const ref of refs) {
        totals.references++;
        // Offsets point at the reference itself.
        expect(contract.text.slice(ref.start, ref.end)).toMatch(/\d|[IVXLC]/u);
        if (ref.external) {
          totals.external++;
          continue;
        }
        totals.internal++;
        const kind = (byKind[ref.kind] ??= { internal: 0, resolved: 0 });
        kind.internal++;
        const section = resolveReference(ref, sections);
        if (section === null) continue;
        totals.resolved++;
        kind.resolved++;
        expect(sectionNumber(section.label)).toEqual(ref.number);
        expect(section.start).toBeLessThan(section.end);
      }
    }
    const share = (n: number, d: number) => Math.round((n / Math.max(d, 1)) * 10_000) / 10_000;
    const report = {
      ...totals,
      externalShare: share(totals.external, totals.references),
      internalResolvedShare: share(totals.resolved, totals.internal),
      byKind: Object.fromEntries(
        Object.entries(byKind).map(([k, v]) => [
          k,
          { ...v, resolvedShare: share(v.resolved, v.internal) },
        ]),
      ),
    };
    writeFileSync(
      new URL("../results/cuad-references.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report));
    expect(totals.references).toBeGreaterThan(10_000);
    // CI gate (measured 0.8818 on 2026-11-26, D50): a drop means references stopped resolving.
    expect(report.internalResolvedShare).toBeGreaterThanOrEqual(0.87);
  }, 300_000);
});
