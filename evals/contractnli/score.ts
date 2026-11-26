// Scoring for the ContractNLI eval (M5 step 2, D44). One case = one (document, hypothesis)
// pair. Two questions, as in the dataset's paper:
//   label:    did we say Entailment / Contradiction / NotMentioned like the expert?
//   evidence: on pairs the expert says the contract addresses (Entailment or Contradiction),
//             did we point at the expert's spans?
// Plus a retrieval question for the pipeline: if the checker only sees the top k spans of a
// search, how often are the expert's spans among them?
import { toMetrics, type Metrics } from "../shared/metrics";
import { CHOICES, type Choice, type NliAnswer } from "./load";

export interface NliPrediction {
  choice: Choice;
  evidence: readonly number[];
}

export interface NliCase {
  gold: NliAnswer;
  predicted: NliPrediction;
}

export interface LabelScore {
  cases: number;
  accuracy: number;
  perClass: Record<Choice, Metrics>;
  /** Mean F1 of the three classes: a rare class counts as much as a common one. */
  macroF1: number;
  /** confusion[gold][predicted] = count. */
  confusion: Record<Choice, Record<Choice, number>>;
}

export function scoreLabels(cases: readonly NliCase[]): LabelScore {
  const confusion = Object.fromEntries(
    CHOICES.map((g) => [g, Object.fromEntries(CHOICES.map((p) => [p, 0]))]),
  ) as Record<Choice, Record<Choice, number>>;
  for (const { gold, predicted } of cases) confusion[gold.choice][predicted.choice]++;
  const perClass = Object.fromEntries(
    CHOICES.map((c) => {
      const tp = confusion[c][c];
      const fp = CHOICES.reduce((n, g) => n + (g === c ? 0 : confusion[g][c]), 0);
      const fn = CHOICES.reduce((n, p) => n + (p === c ? 0 : confusion[c][p]), 0);
      return [c, toMetrics({ tp, fp, fn })];
    }),
  ) as Record<Choice, Metrics>;
  const correct = CHOICES.reduce((n, c) => n + confusion[c][c], 0);
  return {
    cases: cases.length,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    perClass,
    macroF1: CHOICES.reduce((sum, c) => sum + perClass[c].f1, 0) / CHOICES.length,
    confusion,
  };
}

export interface EvidenceScore extends Metrics {
  /** Pairs scored: those whose expert label is Entailment or Contradiction. */
  pairs: number;
  /** Share of those pairs where at least one predicted span is an expert span. */
  hit: number;
}

/** Micro precision / recall / F1 over (pair, span), on pairs the contract addresses. */
export function scoreEvidence(cases: readonly NliCase[]): EvidenceScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let pairs = 0;
  let hits = 0;
  for (const { gold, predicted } of cases) {
    if (gold.choice === "NotMentioned") continue;
    pairs++;
    const expected = new Set(gold.evidence);
    const found = new Set(predicted.evidence);
    let mine = 0;
    for (const span of found) {
      if (expected.has(span)) mine++;
      else fp++;
    }
    tp += mine;
    fn += expected.size - mine;
    if (mine > 0) hits++;
  }
  return { ...toMetrics({ tp, fp, fn }), pairs, hit: pairs === 0 ? 0 : hits / pairs };
}

export interface CoverageAtK {
  k: number;
  /** Share of addressed pairs with at least one expert span in the top k. */
  any: number;
  /** Share of addressed pairs with every expert span in the top k. */
  all: number;
  /** Share of all expert spans (over addressed pairs) that are in the top k. */
  spans: number;
}

/**
 * How much evidence a checker would see if it read only the top k spans of a ranking.
 * `ranked[i]` is the ranking for `gold[i]`.
 */
export function coverageAtK(
  gold: readonly NliAnswer[],
  ranked: readonly (readonly number[])[],
  ks: readonly number[],
): CoverageAtK[] {
  return ks.map((k) => {
    let pairs = 0;
    let any = 0;
    let all = 0;
    let total = 0;
    let seen = 0;
    gold.forEach((answer, i) => {
      if (answer.choice === "NotMentioned") return;
      pairs++;
      const top = new Set((ranked[i] ?? []).slice(0, k));
      const inTop = answer.evidence.filter((s) => top.has(s)).length;
      total += answer.evidence.length;
      seen += inTop;
      if (inTop > 0) any++;
      if (inTop === answer.evidence.length) all++;
    });
    const share = (n: number, d: number) => (d === 0 ? 0 : n / d);
    return { k, any: share(any, pairs), all: share(all, pairs), spans: share(seen, total) };
  });
}
