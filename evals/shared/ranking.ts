// Ranking metrics for retrieval evals. A ranking is a list of item indices, best first; the
// relevant set comes from labels. All metrics are in [0, 1], higher is better.

export interface RankScores {
  /** At least one relevant item in the top 1 / top 5. */
  hit1: number;
  hit5: number;
  /** Share of the relevant items found in the top 5 / top 10. */
  recall5: number;
  recall10: number;
  /** 1 / rank of the first relevant item, 0 if none in the top 10. */
  mrr10: number;
  /** Binary-relevance nDCG over the top 10. */
  ndcg10: number;
}

export function scoreRanking(ranking: readonly number[], relevant: readonly number[]): RankScores {
  const wanted = new Set(relevant);
  if (wanted.size === 0) throw new Error("a case needs at least one relevant item");
  const isRelevant = ranking.map((item) => wanted.has(item));
  const foundIn = (k: number) => isRelevant.slice(0, k).filter(Boolean).length;
  const first = isRelevant.findIndex(Boolean);

  let dcg = 0;
  for (let i = 0; i < Math.min(10, isRelevant.length); i++) {
    if (isRelevant[i] === true) dcg += 1 / Math.log2(i + 2);
  }
  let ideal = 0;
  for (let i = 0; i < Math.min(10, wanted.size); i++) ideal += 1 / Math.log2(i + 2);

  return {
    hit1: foundIn(1) > 0 ? 1 : 0,
    hit5: foundIn(5) > 0 ? 1 : 0,
    recall5: foundIn(5) / wanted.size,
    recall10: foundIn(10) / wanted.size,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0,
    ndcg10: dcg / ideal,
  };
}

export const METRICS = ["hit1", "hit5", "recall5", "recall10", "mrr10", "ndcg10"] as const;

/** Mean of each metric, rounded to 4 decimals. */
export function meanScores(scores: readonly RankScores[]): RankScores & { cases: number } {
  const mean = (key: keyof RankScores) =>
    scores.length === 0
      ? 0
      : Math.round((scores.reduce((sum, s) => sum + s[key], 0) / scores.length) * 10_000) / 10_000;
  return {
    cases: scores.length,
    hit1: mean("hit1"),
    hit5: mean("hit5"),
    recall5: mean("recall5"),
    recall10: mean("recall10"),
    mrr10: mean("mrr10"),
    ndcg10: mean("ndcg10"),
  };
}
