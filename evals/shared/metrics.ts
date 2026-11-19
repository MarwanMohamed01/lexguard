// Precision / recall / F1 from raw counts, shared by every eval.

export interface Counts {
  tp: number; // found and correct
  fp: number; // found but wrong (false alarm)
  fn: number; // missed
}

export interface Metrics extends Counts {
  precision: number;
  recall: number;
  f1: number;
}

// Conventions for empty cases: nothing predicted → precision 1; nothing expected → recall 1.
export function toMetrics({ tp, fp, fn }: Counts): Metrics {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}
