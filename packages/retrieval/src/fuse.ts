// Reciprocal rank fusion (Cormack, Clarke & Buettcher, SIGIR 2009): merges ranked lists using
// only each item's position, never its score. That matters here because the two scores are
// not comparable: bm25() is unbounded and lower is better, cosine similarity is in [-1, 1] and
// higher is better. score(item) = sum over lists of 1 / (k + rank), rank starting at 1.
// k = 60 is the value from the paper; it damps the difference between the very top ranks.

export const RRF_K = 60;

export interface Fused {
  id: string;
  score: number;
}

/**
 * Fuses ranked lists of IDs (best first). An ID missing from a list simply gets nothing from
 * it. Ties are broken by the best single rank, then by ID, so the order is deterministic.
 * Duplicates inside one list count once, at their best rank.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly string[])[],
  k: number = RRF_K,
): Fused[] {
  if (!(k >= 0) || !Number.isFinite(k)) throw new Error("k must be a finite number >= 0");
  const scores = new Map<string, number>();
  const bestRank = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
      bestRank.set(id, Math.min(bestRank.get(id) ?? Infinity, rank));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (bestRank.get(a.id) ?? 0) - (bestRank.get(b.id) ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
