// Paired comparison of two methods on the same cases (M3 close, D42).
//
// Comparing two averages hides how often each method wins. Here every case is scored by both
// methods, and the difference per case is what is studied:
//   diff = candidate - baseline        (e.g. hybrid MRR - keyword MRR on the same question)
// The 95% interval comes from a CLUSTER bootstrap: questions about the same contract are not
// independent (one badly converted contract hurts all its questions), so whole contracts are
// resampled, not single questions. Resampling questions would give a narrower, over-confident
// interval. Seeded, so the numbers are reproducible.

export interface PairedResult {
  cases: number;
  groups: number;
  baseline: number;
  candidate: number;
  /** Mean of candidate - baseline. */
  meanDiff: number;
  better: number;
  worse: number;
  same: number;
  /** 95% cluster-bootstrap interval of meanDiff. Above 0: the candidate is really better. */
  ci95: [number, number];
}

/** Small seeded generator (mulberry32): same seed, same resamples. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

export function pairedComparison(
  baseline: readonly number[],
  candidate: readonly number[],
  groups: readonly (string | number)[],
  { resamples = 2_000, seed = 1 } = {},
): PairedResult {
  const n = baseline.length;
  if (n === 0) throw new Error("no cases to compare");
  if (candidate.length !== n || groups.length !== n) throw new Error("lists differ in length");

  // Per group: sum of differences and number of cases.
  const byGroup = new Map<string | number, { sum: number; count: number }>();
  let better = 0;
  let worse = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = (candidate[i] ?? 0) - (baseline[i] ?? 0);
    total += d;
    if (d > 0) better++;
    else if (d < 0) worse++;
    const g = byGroup.get(groups[i] ?? "") ?? { sum: 0, count: 0 };
    g.sum += d;
    g.count++;
    byGroup.set(groups[i] ?? "", g);
  }

  const clusters = [...byGroup.values()];
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < clusters.length; k++) {
      const c = clusters[Math.floor(random() * clusters.length)];
      if (c === undefined) continue;
      sum += c.sum;
      count += c.count;
    }
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) => means[Math.min(means.length - 1, Math.floor(q * means.length))] ?? 0;
  const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / n;

  return {
    cases: n,
    groups: clusters.length,
    baseline: round(mean(baseline)),
    candidate: round(mean(candidate)),
    meanDiff: round(total / n),
    better,
    worse,
    same: n - better - worse,
    ci95: [round(at(0.025)), round(at(0.975))],
  };
}
