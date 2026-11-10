import type { Span } from "./schema";

export interface TraceSummary {
  spanCount: number;
  errorCount: number;
  durationMs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  // Model calls whose cost is unknown (model missing from the price table).
  unpricedModelCalls: number;
}

// Totals for one trace: used by tests now, the trace viewer and cost reports later.
export function summarize(spans: readonly Span[]): TraceSummary {
  const summary: TraceSummary = {
    spanCount: spans.length,
    errorCount: 0,
    durationMs: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedModelCalls: 0,
  };
  if (spans.length === 0) return summary;

  let firstStart = Infinity;
  let lastEnd = -Infinity;
  for (const span of spans) {
    firstStart = Math.min(firstStart, span.startMs);
    lastEnd = Math.max(lastEnd, span.endMs);
    if (span.status === "error") summary.errorCount++;
    if (span.kind !== "model_call") continue;

    summary.modelCalls++;
    summary.inputTokens += numberOr0(span.attributes.inputTokens);
    summary.outputTokens += numberOr0(span.attributes.outputTokens);
    const cost = span.attributes.costUsd;
    if (typeof cost === "number") summary.costUsd += cost;
    else summary.unpricedModelCalls++;
  }
  summary.durationMs = lastEnd - firstStart;
  return summary;
}

function numberOr0(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
