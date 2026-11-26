import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pinnedSubset } from "../extraction/dataset";
import { keywordRankings, majorityLabel, perHypothesisLabels } from "./baselines";
import {
  contractNliAvailable,
  loadContractNli,
  parseContractNli,
  type NliAnswer,
  type NliSplit,
} from "./load";
import { coverageAtK, scoreEvidence, scoreLabels, type NliCase } from "./score";

const E = (...evidence: number[]): NliAnswer => ({ choice: "Entailment", evidence });
const C = (...evidence: number[]): NliAnswer => ({ choice: "Contradiction", evidence });
const N: NliAnswer = { choice: "NotMentioned", evidence: [] };

describe("label scoring", () => {
  it("counts accuracy, per-class F1 and the confusion matrix", () => {
    const cases: NliCase[] = [
      { gold: E(1), predicted: E(1) },
      { gold: E(2), predicted: N },
      { gold: C(3), predicted: C(3) },
      { gold: N, predicted: E(0) },
    ];
    const s = scoreLabels(cases);
    expect(s.accuracy).toBe(0.5);
    expect(s.confusion.Entailment.NotMentioned).toBe(1);
    expect(s.confusion.NotMentioned.Entailment).toBe(1);
    // Entailment: tp 1, fp 1 (the NotMentioned case), fn 1 -> P = R = F1 = 0.5.
    expect(s.perClass.Entailment).toMatchObject({ tp: 1, fp: 1, fn: 1, f1: 0.5 });
    expect(s.perClass.Contradiction.f1).toBe(1);
    expect(s.perClass.NotMentioned.f1).toBe(0);
    expect(s.macroF1).toBeCloseTo(0.5, 10);
  });

  it("gives a majority guess a low macro F1 even when its accuracy looks fine", () => {
    const cases: NliCase[] = [E(1), E(1), E(1), C(1)].map((gold) => ({ gold, predicted: E() }));
    const s = scoreLabels(cases);
    expect(s.accuracy).toBe(0.75);
    // Entailment F1 = 6/7, Contradiction 0, NotMentioned 0 (nothing predicted or expected).
    expect(s.perClass.NotMentioned.f1).toBe(1); // empty class: P = R = 1 by convention
    expect(s.macroF1).toBeCloseTo((6 / 7 + 0 + 1) / 3, 10);
  });
});

describe("evidence scoring", () => {
  it("scores only pairs the contract addresses, span by span", () => {
    const cases: NliCase[] = [
      { gold: E(1, 2), predicted: E(2, 5) }, // tp 1 (2), fp 1 (5), fn 1 (1)
      { gold: C(7), predicted: N }, // fn 1, no hit
      { gold: N, predicted: E(9) }, // not scored: the expert found nothing to point at
    ];
    const s = scoreEvidence(cases);
    expect(s).toMatchObject({ pairs: 2, tp: 1, fp: 1, fn: 2, hit: 0.5 });
  });

  it("does not count a repeated span twice", () => {
    const s = scoreEvidence([
      { gold: E(1), predicted: { choice: "Entailment", evidence: [1, 1] } },
    ]);
    expect(s).toMatchObject({ tp: 1, fp: 0, fn: 0 });
  });
});

describe("coverage at k", () => {
  it("tells whether the expert's spans are in the top k of a ranking", () => {
    const gold = [E(3, 8), C(1), N];
    const ranked = [[3, 4, 8], [5, 6, 1], [0]];
    const [k1, k2, k3] = coverageAtK(gold, ranked, [1, 2, 3]);
    expect(k1).toEqual({ k: 1, any: 0.5, all: 0, spans: 1 / 3 });
    // Exactly k, not k + 1: span 8 (doc 0) and span 1 (doc 1) are third.
    expect(k2).toEqual({ k: 2, any: 0.5, all: 0, spans: 1 / 3 });
    expect(k3).toEqual({ k: 3, any: 1, all: 1, spans: 1 });
  });
});

describe("parsing the downloaded file", () => {
  const file = (annotation: object, spans = [[0, 5]]) => ({
    documents: [
      { id: 1, text: "Hello world", spans, annotation_sets: [{ annotations: annotation }] },
    ],
    labels: {
      "nda-2": { hypothesis: "B" },
      "nda-10": { hypothesis: "C" },
      "nda-1": { hypothesis: "A" },
    },
  });

  it("keeps hypotheses in numeric key order", () => {
    const split = parseContractNli(file({ "nda-1": { choice: "Entailment", spans: [0] } }));
    expect([...split.hypotheses.keys()]).toEqual(["nda-1", "nda-2", "nda-10"]);
    expect(split.docs[0]?.answers.get("nda-1")).toEqual({ choice: "Entailment", evidence: [0] });
  });

  it("refuses data that would make a score meaningless", () => {
    expect(() => parseContractNli(file({}, [[3, 99]]))).toThrow(/out of range/);
    expect(() => parseContractNli(file({}, [[2, 2]]))).toThrow(/out of range/); // empty span
    expect(() => parseContractNli(file({}, [[-1, 3]]))).toThrow(/out of range/);
    // One span, so index 1 is already one past the end.
    expect(() => parseContractNli(file({ "nda-1": { choice: "Entailment", spans: [1] } }))).toThrow(
      /evidence index/,
    );
    expect(() => parseContractNli(file({ "nda-1": { choice: "Entailment", spans: [4] } }))).toThrow(
      /evidence index/,
    );
    expect(() =>
      parseContractNli(file({ "nda-1": { choice: "NotMentioned", spans: [0] } })),
    ).toThrow(/disagree/);
    expect(() => parseContractNli(file({ "nda-1": { choice: "Entailment", spans: [] } }))).toThrow(
      /disagree/,
    );
    expect(() => parseContractNli(file({ "nda-9": { choice: "Entailment", spans: [0] } }))).toThrow(
      /unknown hypothesis/,
    );
    expect(() => parseContractNli(file({ "nda-1": { choice: "Maybe", spans: [] } }))).toThrow();
  });
});

const round = (x: number) => Math.round(x * 10_000) / 10_000;

describe.skipIf(!contractNliAvailable())("ContractNLI baselines (test split)", () => {
  let train: NliSplit;
  let test: NliSplit;
  beforeAll(() => {
    train = loadContractNli("train");
    test = loadContractNli("test");
  });

  it("has the documented size, every pair labelled", () => {
    expect(train.docs.length + loadContractNli("dev").docs.length + test.docs.length).toBe(607);
    expect(test.docs.length).toBe(123);
    expect(test.hypotheses.size).toBe(17);
    for (const doc of test.docs) expect(doc.answers.size).toBe(17);
  });

  it("scores the baselines the checker must beat", () => {
    const keys = [...test.hypotheses.keys()];
    const gold = test.docs.flatMap((doc) => keys.map((k) => doc.answers.get(k) ?? N));
    const majority = majorityLabel(train);
    const perHyp = perHypothesisLabels(train);
    const rankings = keywordRankings(test.docs, test.hypotheses, 50);
    const ranked = test.docs.flatMap((_, d) => keys.map((k) => rankings.get(k)?.[d] ?? []));

    const cases = (label: (key: string) => NliAnswer["choice"], topK: number) =>
      gold.map((g, i): NliCase => {
        const key = keys[i % keys.length] ?? "";
        const choice = label(key);
        const evidence = choice === "NotMentioned" ? [] : (ranked[i] ?? []).slice(0, topK);
        return { gold: g, predicted: { choice, evidence } };
      });

    const majorityCases = cases(() => majority, 2);
    const perHypCases = cases((k) => perHyp.get(k) ?? majority, 2);
    const labels = {
      majority: scoreLabels(majorityCases),
      perHypothesis: scoreLabels(perHypCases),
    };
    // Evidence on its own: keyword top k, scored on addressed pairs whatever the label.
    const keywordEvidence = Object.fromEntries(
      [1, 2, 3].map((k) => [`top${String(k)}`, scoreEvidence(cases(() => "Entailment", k))]),
    );
    const coverage = coverageAtK(gold, ranked, [1, 3, 5, 10, 20]);
    const subset = pinnedSubset(test.docs, 20).map((d) => d.id);

    writeFileSync(
      new URL("../results/contractnli-baselines.json", import.meta.url),
      JSON.stringify(
        {
          split: "test",
          pairs: gold.length,
          addressedPairs: gold.filter((g) => g.choice !== "NotMentioned").length,
          majorityLabel: majority,
          labels,
          keywordEvidence,
          keywordCoverage: coverage,
          pinnedSubsetIds: subset,
        },
        (_, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? round(v) : v),
        2,
      ) + "\n",
    );

    // Sanity, not gates: a rule-only guess must beat the overall majority, and keyword search
    // must find the expert's evidence far more often than chance (~2 of ~72 spans per pair).
    expect(gold.length).toBe(2_091);
    expect(labels.perHypothesis.macroF1).toBeGreaterThan(labels.majority.macroF1);
    expect(coverage.find((c) => c.k === 10)?.any ?? 0).toBeGreaterThan(0.5);
    expect(subset).toHaveLength(20);
  }, 60_000); // ~4 s alone; slower when every eval runs at once
});
