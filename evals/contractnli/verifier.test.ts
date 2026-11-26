// The verifier on real checker claims (M5 step 6, D50). Claims come from the checker's real
// code run on ContractNLI: the oracle on every test pair (no model, runs in CI), and the
// cached Groq answers when they exist locally. Two properties must hold:
//   1. every claim the checker accepts verifies against the stored contract text;
//   2. every tampered copy of a verified claim is rejected (moved offsets, edited text, a
//      rule that does not exist, the proof removed, a rule quote that is not the rule's).
import { checkRule, buildCheckPrompt, type CheckResult } from "@lexguard/checker";
import { chunkDocument } from "@lexguard/chunker";
import { getRule, ndaPlaybook, ruleText } from "@lexguard/rulebook";
import { verifyClaim, type Claim } from "@lexguard/verifier";
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pinnedSubset } from "../extraction/dataset";
import { AnswerCache } from "../extraction/models";
import { keywordRankings } from "./baselines";
import { caseNonce, checkerCases, oracleAnswer, passagesOf, type CheckCase } from "./checker";
import { contractNliAvailable, loadContractNli, type NliSplit } from "./load";

const rulebooks = new Map([["nda", ndaPlaybook]]);

const ruleOf = (id: string) => {
  const rule = getRule(ndaPlaybook, id);
  if (rule === undefined) throw new Error(`no rule ${id}`);
  return { id, text: ruleText(ndaPlaybook, rule) };
};

/** A checker result as a document-level claim: passage offsets become contract offsets. */
function toClaim(c: CheckCase, result: Extract<CheckResult, { ok: true }>): Claim {
  return {
    ruleId: c.ruleId,
    verdict: result.verdict,
    evidence: result.evidence.map((e) => {
      const [spanStart] = c.doc.spans[c.spans[e.passage] ?? -1] ?? [0];
      return { start: spanStart + e.start, end: spanStart + e.end, text: e.text };
    }),
    ruleQuote: result.ruleQuote,
    reason: result.reason,
  };
}

/** Tampered copies of a verified claim, each of which must be rejected. */
function tampered(claim: Claim): [string, Claim][] {
  const out: [string, Claim][] = [];
  const first = claim.evidence[0];
  if (first !== undefined) {
    const rest = claim.evidence.slice(1);
    out.push([
      "offsets moved",
      { ...claim, evidence: [{ ...first, start: first.start + 1, end: first.end + 1 }, ...rest] },
    ]);
    out.push([
      "text edited",
      { ...claim, evidence: [{ ...first, text: `${first.text.slice(0, -1)}#` }, ...rest] },
    ]);
    out.push(["proof removed", { ...claim, evidence: [] }]);
  }
  out.push(["unknown rule", { ...claim, ruleId: "nda:99" }]);
  if (claim.ruleQuote)
    out.push([
      "rule quote edited",
      { ...claim, ruleQuote: { ...claim.ruleQuote, text: `${claim.ruleQuote.text}#` } },
    ]);
  return out;
}

interface Tally {
  claims: number;
  verified: number;
  nonSilent: number;
  tampered: number;
  tamperRejected: number;
  withReferences: number;
  references: number;
  resolvedReferences: number;
}

async function tallyClaims(cases: CheckCase[], answerOf: (c: CheckCase) => string | undefined) {
  const tally: Tally = {
    claims: 0,
    verified: 0,
    nonSilent: 0,
    tampered: 0,
    tamperRejected: 0,
    withReferences: 0,
    references: 0,
    resolvedReferences: 0,
  };
  const sectionsOf = new Map<number, ReturnType<typeof chunkDocument>["sections"]>();
  const failures: string[] = [];
  for (const c of cases) {
    const answer = answerOf(c);
    if (answer === undefined) continue;
    const rule = ruleOf(c.ruleId);
    const passages = passagesOf(c);
    const result = await checkRule(rule, passages, () => Promise.resolve(answer), {
      nonce: caseNonce(rule.text, passages),
    });
    if (!result.ok) continue;
    const sections = sectionsOf.get(c.doc.id) ?? chunkDocument(c.doc.text).sections;
    sectionsOf.set(c.doc.id, sections);
    const ctx = { text: c.doc.text, rulebooks, sections };
    const claim = toClaim(c, result);
    tally.claims++;
    if (claim.verdict !== "silent") tally.nonSilent++;
    const verified = verifyClaim(claim, ctx);
    if (!verified.ok) {
      failures.push(`${String(c.doc.id)} ${c.ruleId}: ${verified.problems.join(",")}`);
      continue;
    }
    tally.verified++;
    if (verified.claim.references.length > 0) tally.withReferences++;
    tally.references += verified.claim.references.length;
    tally.resolvedReferences += verified.claim.references.filter((r) => r.section !== null).length;
    for (const [, bad] of tampered(claim)) {
      tally.tampered++;
      if (!verifyClaim(bad, ctx).ok) tally.tamperRejected++;
    }
  }
  return { tally, failures };
}

describe.skipIf(!contractNliAvailable())("the verifier on real checker claims", () => {
  let test: NliSplit;
  const report: Record<string, unknown> = {};
  beforeAll(() => {
    test = loadContractNli("test");
  });

  it("verifies every oracle claim on all test pairs and rejects every tampered copy", async () => {
    const cases = checkerCases(
      test.docs,
      [...test.hypotheses.keys()],
      keywordRankings(test.docs, test.hypotheses, 50),
    );
    const { tally, failures } = await tallyClaims(cases, oracleAnswer);
    report.oracle = tally;
    expect(failures).toEqual([]);
    expect(tally.claims).toBe(2_091);
    expect(tally.verified).toBe(tally.claims);
    expect(tally.tamperRejected).toBe(tally.tampered);
    expect(tally.tampered).toBeGreaterThan(2_000);
  }, 300_000);

  it("verifies the cached Groq claims too (when the cache exists locally)", async () => {
    const cache = new AnswerCache(
      "groq-openai/gpt-oss-20b-json-low-t0",
      "check/1",
      new URL("../data/contractnli/answers/", import.meta.url),
    );
    const docs = pinnedSubset(test.docs, 20);
    const cases = checkerCases(
      docs,
      [...test.hypotheses.keys()],
      keywordRankings(docs, test.hypotheses, 50),
    );
    const { tally, failures } = await tallyClaims(cases, (c) => {
      const rule = ruleOf(c.ruleId);
      const passages = passagesOf(c);
      return cache.get(buildCheckPrompt(rule, passages, caseNonce(rule.text, passages)).user)?.text;
    });
    report.groq = tally;
    expect(failures).toEqual([]);
    expect(tally.verified).toBe(tally.claims);
    expect(tally.tamperRejected).toBe(tally.tampered);
    writeFileSync(
      new URL("../results/contractnli-verifier.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }, 300_000);
});
