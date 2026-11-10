// Prices are passed in, not hard-coded: they change, and free tiers are priced at 0.
export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Returns null (not 0) for a model missing from the table, so unknown cost is never
// silently reported as free.
export function estimateCostUsd(usage: ModelUsage, prices: PriceTable): number | null {
  for (const tokens of [usage.inputTokens, usage.outputTokens]) {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new RangeError(`token counts must be non-negative integers, got ${String(tokens)}`);
    }
  }
  const price = prices[usage.model];
  if (price === undefined) return null;
  return (
    (usage.inputTokens * price.inputPerMTokUsd + usage.outputTokens * price.outputPerMTokUsd) /
    1_000_000
  );
}
