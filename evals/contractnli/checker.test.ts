import { checkRule } from "@lexguard/checker";
import { getRule, ndaPlaybook, ruleText } from "@lexguard/rulebook";
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { keywordRankings, perHypothesisLabels } from "./baselines";
import {
  caseNonce,
  checkerCases,
  oracleAnswer,
  passagesOf,
  ruleIdOf,
  toPrediction,
  TOP_K,
  type CheckCase,
} from "./checker";
import { contractNliAvailable, loadContractNli, type NliDoc, type NliSplit } from "./load";
import { coverageAtK, scoreEvidence, scoreLabels, type NliCase } from "./score";

const SENTENCES = [
  "Alpha clause applies here.",
  "Beta clause applies here.",
  "Gamma clause applies here.",
];
const spansOf = (parts: readonly string[]) => {
  let at = 0;
  return parts.map((p) => {
    const span = [at, at + p.length] as const;
    at += p.length + 1;
    return span;
  });
};
const doc: NliDoc = {
  id: 1,
  title: "contractnli-1",
  text: SENTENCES.join(" "),
  spans: spansOf(SENTENCES),
  answers: new Map([["nda-11", { choice: "Entailment", evidence: [1] }]]),
};

const ruleOf = (id: string) => {
  const rule = getRule(ndaPlaybook, id);
  if (rule === undefined) throw new Error(`no rule ${id}`);
  return { id, text: ruleText(ndaPlaybook, rule) };
};

async function run(c: CheckCase, answer: string) {
  const rule = ruleOf(c.ruleId);
  const passages = passagesOf(c);
  return checkRule(rule, passages, () => Promise.resolve(answer), {
    nonce: caseNonce(rule.text, passages),
  });
}

describe("checker cases and their scoring", () => {
  const rankings = new Map([["nda-11", [[2, 1, 0]]]]);

  it("gives the checker the top-k spans in document order, and maps keys to rule IDs", () => {
    const [c] = checkerCases([doc], ["nda-11"], rankings, 2);
    expect(c?.spans).toEqual([1, 2]); // top 2 by rank were 2 and 1
    expect(c?.ruleId).toBe("nda:11");
    expect(ruleIdOf("nda-20")).toBe("nda:20");
    expect(c && passagesOf(c)).toEqual(["Beta clause applies here.", "Gamma clause applies here."]);
  });

  it("maps a checked verdict to ContractNLI's label and its quotes to span indices", async () => {
    const [c] = checkerCases([doc], ["nda-11"], rankings, 2);
    if (c === undefined) throw new Error("no case");
    const agrees = await run(
      c,
      JSON.stringify({ verdict: "agrees", quotes: ["Gamma clause applies"] }),
    );
    expect(toPrediction(c, agrees)).toEqual({ choice: "Entailment", evidence: [2] });
    const conflicts = await run(
      c,
      JSON.stringify({ verdict: "conflicts", quotes: ["Beta clause applies"] }),
    );
    expect(toPrediction(c, conflicts)).toEqual({ choice: "Contradiction", evidence: [1] });
    // An invented quote is downgraded by the checker: scored as NotMentioned.
    const invented = await run(
      c,
      JSON.stringify({ verdict: "agrees", quotes: ["Delta clause applies"] }),
    );
    expect(toPrediction(c, invented)).toEqual({ choice: "NotMentioned", evidence: [] });
    // A broken answer makes no claim.
    expect(toPrediction(c, await run(c, "not json"))).toEqual({
      choice: "NotMentioned",
      evidence: [],
    });
  });

  it("the oracle answers the expert's label and evidence, and is downgraded when it cannot see it", async () => {
    const [seen] = checkerCases([doc], ["nda-11"], rankings, 2); // span 1 is among the passages
    const [blind] = checkerCases([doc], ["nda-11"], new Map([["nda-11", [[0, 2]]]]), 2);
    if (seen === undefined || blind === undefined) throw new Error("no case");
    expect(toPrediction(seen, await run(seen, oracleAnswer(seen)))).toEqual({
      choice: "Entailment",
      evidence: [1],
    });
    expect(toPrediction(blind, await run(blind, oracleAnswer(blind)))).toEqual({
      choice: "NotMentioned",
      evidence: [],
    });
  });

  it("derives the eval nonce from the input, so the cache matches the exact prompt", () => {
    expect(caseNonce("r", ["a", "b"])).toBe(caseNonce("r", ["a", "b"]));
    expect(caseNonce("r", ["a", "b"])).not.toBe(caseNonce("r", ["ab"]));
    expect(caseNonce("r", ["a"])).toMatch(/^[0-9a-f]{24}$/);
  });
});

const round = (x: number) => Math.round(x * 10_000) / 10_000;

describe.skipIf(!contractNliAvailable())(
  "the checker's ceiling with keyword top-k passages (oracle)",
  () => {
    let train: NliSplit;
    let test: NliSplit;
    beforeAll(() => {
      train = loadContractNli("train");
      test = loadContractNli("test");
    });

    it("uses the playbook's rule text, identical to ContractNLI's hypotheses", () => {
      for (const [key, hypothesis] of test.hypotheses) {
        expect(ruleOf(ruleIdOf(key)).text).toBe(hypothesis.replace(/\s+/g, " ").trim());
      }
    });

    it("scores the oracle through the real checker code on every test pair", async () => {
      const keys = [...test.hypotheses.keys()];
      const rankings = keywordRankings(test.docs, test.hypotheses, 50);
      const report: Record<string, unknown> = { split: "test" };
      for (const k of [5, TOP_K, 20]) {
        const cases = checkerCases(test.docs, keys, rankings, k);
        const scored: NliCase[] = [];
        for (const c of cases)
          scored.push({ gold: c.gold, predicted: toPrediction(c, await run(c, oracleAnswer(c))) });
        report[`top${String(k)}`] = {
          labels: scoreLabels(scored),
          evidence: scoreEvidence(scored),
        };
        if (k === TOP_K) {
          expect(cases).toHaveLength(2_091);
          // The oracle quotes only expert evidence, so its evidence precision is about 1. Not
          // exactly: the same 3+ words can also stand inside another passage (repeated
          // boilerplate), and text alone cannot tell the two apart (D49).
          expect(scoreEvidence(scored).precision).toBeGreaterThan(0.99);
          // Its label can be right only where it saw some expert evidence (or none was needed),
          // so accuracy is at most that share; fragments under 3 words cost a little more.
          const coverage = coverageAtK(
            cases.map((c) => c.gold),
            cases.map((c) => [...c.spans]),
            [k],
          )[0];
          const addressed = cases.filter((c) => c.gold.choice !== "NotMentioned").length;
          const bound =
            (cases.length - addressed + (coverage?.any ?? 0) * addressed) / cases.length;
          const accuracy = scoreLabels(scored).accuracy;
          expect(accuracy).toBeLessThanOrEqual(bound + 1e-9);
          expect(accuracy).toBeGreaterThan(bound - 0.02);
        }
      }
      const perHyp = perHypothesisLabels(train);
      report.barPerHypothesisMacroF1 = scoreLabels(
        checkerCases(test.docs, keys, rankings).map((c) => ({
          gold: c.gold,
          predicted: { choice: perHyp.get(c.key) ?? "Entailment", evidence: [] },
        })),
      ).macroF1;
      writeFileSync(
        new URL("../results/contractnli-checker-oracle.json", import.meta.url),
        JSON.stringify(
          report,
          (_, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? round(v) : v),
          2,
        ) + "\n",
      );
    }, 120_000);
  },
);
