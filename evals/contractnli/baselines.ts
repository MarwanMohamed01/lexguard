// Baselines the M5 checker must beat on ContractNLI (M5 step 2, D44). None reads with a model.
//
//   majority:       every pair gets the most common label in the TRAIN split.
//   perHypothesis:  each hypothesis gets its own most common train label, e.g. "No reverse
//                   engineering" is mostly NotMentioned, "Limited use" mostly Entailment.
//                   Knows the rule, never reads the contract.
//   keyword:        evidence = the top spans of M3's keyword search (FTS5 porter, bm25) with
//                   the hypothesis as the query; the same search production uses.
import { KeywordIndex } from "../retrieval/search";
import type { Choice, NliDoc, NliSplit } from "./load";
import { CHOICES } from "./load";

/** Most common label in a split; ties broken by CHOICES order, so the result is stable. */
function mostCommon(choices: readonly Choice[]): Choice {
  const counts = new Map<Choice, number>();
  for (const c of choices) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: Choice = CHOICES[0] ?? "Entailment";
  for (const c of CHOICES) if ((counts.get(c) ?? 0) > (counts.get(best) ?? 0)) best = c;
  return best;
}

export function majorityLabel(train: NliSplit): Choice {
  return mostCommon(train.docs.flatMap((d) => [...d.answers.values()].map((a) => a.choice)));
}

export function perHypothesisLabels(train: NliSplit): Map<string, Choice> {
  return new Map(
    [...train.hypotheses.keys()].map((key) => [
      key,
      mostCommon(train.docs.flatMap((d) => d.answers.get(key)?.choice ?? [])),
    ]),
  );
}

/**
 * Keyword rankings of each document's spans for each hypothesis: result.get(key)[d] is the
 * ranking (span indices, best first) for docs[d].
 */
export function keywordRankings(
  docs: readonly NliDoc[],
  hypotheses: ReadonlyMap<string, string>,
  depth: number,
): Map<string, number[][]> {
  const index = new KeywordIndex(
    docs.map((doc) => ({
      title: doc.title,
      text: doc.text,
      chunks: doc.spans.map(([start, end]) => ({ start, end, heading: null, sectionPath: [] })),
    })),
    "porter unicode61",
  );
  try {
    return new Map(
      [...hypotheses].map(([key, text]) => [key, docs.map((_, d) => index.search(d, text, depth))]),
    );
  } finally {
    index.close();
  }
}
