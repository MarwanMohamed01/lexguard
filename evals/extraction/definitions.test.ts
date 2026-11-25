// Cross-reference resolution on CUAD (M4 step 7, D40): the definition finder and the
// definition text it cites, on all 510 real contracts, checked against properties that must
// hold for every definition (no hand-made labels, D10):
//   - the cited text is the contract's own text and contains the term;
//   - it is at most MAX_DEFINITION_CHARS long;
//   - almost every found definition gets a text at all.
// And the reason for the step: the share of lawyer-labelled clauses that use a defined term
// whose definition can be attached.
import { writeFileSync } from "node:fs";
import { definitionSpan, findDefinitions, MAX_DEFINITION_CHARS } from "@lexguard/chunker";
import { termMatcher } from "@lexguard/extraction";
import { beforeAll, describe, expect, it } from "vitest";
import { cuadAvailable, loadCuad } from "../cuad/load";

interface Report {
  contracts: number;
  definitions: number;
  inline: number;
  withSpan: number;
  spanMissesTerm: number;
  spanTooLong: number;
  medianSpanChars: number;
  clauses: number;
  clausesUsingDefinedTerm: number;
  meansOnlyClausesUsingDefinedTerm: number;
}

describe.skipIf(!cuadAvailable())("CUAD cross-references", () => {
  let report: Report;

  beforeAll(() => {
    const contracts = loadCuad();
    const lengths: number[] = [];
    const r: Report = {
      contracts: contracts.length,
      definitions: 0,
      inline: 0,
      withSpan: 0,
      spanMissesTerm: 0,
      spanTooLong: 0,
      medianSpanChars: 0,
      clauses: 0,
      clausesUsingDefinedTerm: 0,
      meansOnlyClausesUsingDefinedTerm: 0,
    };
    for (const c of contracts) {
      const defs = findDefinitions(c.text);
      for (const d of defs) {
        r.definitions++;
        if (c.text[d.start] === "(") r.inline++;
        const span = definitionSpan(c.text, d.start);
        if (span === null) continue;
        r.withSpan++;
        const cited = c.text.slice(span.start, span.end);
        lengths.push(cited.length);
        if (!cited.includes(d.term)) r.spanMissesTerm++;
        if (cited.length > MAX_DEFINITION_CHARS) r.spanTooLong++;
      }
      const all = termMatcher(defs.map((d) => d.term));
      const meansOnly = termMatcher(defs.filter((d) => c.text[d.start] !== "(").map((d) => d.term));
      for (const s of c.spans) {
        // Parties and Document Name are where terms are defined, not used.
        if (s.clauseType === "Parties" || s.clauseType === "Document Name") continue;
        r.clauses++;
        if (all(s.text).length > 0) r.clausesUsingDefinedTerm++;
        if (meansOnly(s.text).length > 0) r.meansOnlyClausesUsingDefinedTerm++;
      }
    }
    lengths.sort((a, b) => a - b);
    r.medianSpanChars = lengths[Math.floor(lengths.length / 2)] ?? 0;
    report = r;
    writeFileSync(
      new URL("../results/cuad-definitions.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }, 600_000);

  it("finds definitions of both kinds in real contracts", () => {
    expect(report.definitions).toBeGreaterThan(10_000);
    expect(report.inline).toBeGreaterThan(3_000);
  });

  it("cites a text for almost every definition, always containing the term, never too long", () => {
    expect(report.withSpan / report.definitions).toBeGreaterThan(0.98);
    expect(report.spanMissesTerm).toBe(0);
    expect(report.spanTooLong).toBe(0);
  });

  it("inline definitions roughly double the clauses whose terms can be explained", () => {
    expect(report.clausesUsingDefinedTerm / report.clauses).toBeGreaterThan(0.65);
    expect(report.clausesUsingDefinedTerm).toBeGreaterThan(
      1.5 * report.meansOnlyClausesUsingDefinedTerm,
    );
  });
});
