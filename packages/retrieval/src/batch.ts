// Groups texts into embedding requests. Measured on Workers AI's bge-m3 (D26): a batch is
// padded to its longest text, and both the 60,000-token request limit and the bill count the
// padded size (one 842-token text alone: 842 tokens; with four 6-token texts: 4,210). So texts
// are sorted by length, and a request is capped by count x longest, not by the sum.

/**
 * Texts per request (and per Workflow step). The step's CPU is mostly JSON: the response of
 * 50 bge-m3 vectors is ~1 MB, JSON.parse alone 5.9 ms in Node, plus serializing them again for
 * the Vectorize upsert, against a 10 ms CPU budget per step on Free (D33). 32 keeps a step
 * at ~0.66 MB. No Neuron cost: batches are sorted by length, so smaller groups add no padding.
 */
export const EMBED_BATCH = 32;
/**
 * Padded characters per request: ~31k tokens at the measured 3.19 characters per token, so
 * even text twice as dense in tokens stays under the 60,000-token limit.
 */
export const EMBED_MAX_PADDED_CHARS = 100_000;

/**
 * Indices of texts (given by their lengths) grouped into requests, longest first. Every index
 * appears exactly once. Ties keep their original order, so the plan is deterministic, which
 * a Workflow needs: steps replayed after a restart must get the same batches.
 */
export function embeddingBatches(
  lengths: readonly number[],
  maxCount: number = EMBED_BATCH,
  maxPaddedChars: number = EMBED_MAX_PADDED_CHARS,
): number[][] {
  if (!(maxCount >= 1) || !(maxPaddedChars >= 1)) throw new Error("invalid batch limits");
  const order = lengths
    .map((length, index) => ({ length, index }))
    .sort((a, b) => b.length - a.length || a.index - b.index);
  const out: number[][] = [];
  let current: number[] = [];
  let longest = 0;
  for (const { length, index } of order) {
    if (!(length >= 0) || length > maxPaddedChars) {
      throw new Error(`text ${String(index)} of ${String(length)} chars exceeds one request`);
    }
    const widest = Math.max(longest, length);
    if (current.length === maxCount || (current.length + 1) * widest > maxPaddedChars) {
      out.push(current);
      current = [];
      longest = 0;
    }
    current.push(index);
    longest = Math.max(longest, length);
  }
  if (current.length > 0) out.push(current);
  return out;
}
