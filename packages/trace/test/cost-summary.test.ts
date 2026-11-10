import { describe, expect, it } from "vitest";
import { estimateCostUsd, summarize } from "../src/index";
import { makeTracer } from "./helpers";

const prices = {
  free: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  large: { inputPerMTokUsd: 1, outputPerMTokUsd: 4 },
};

describe("estimateCostUsd", () => {
  it("prices tokens per million", () => {
    expect(estimateCostUsd({ model: "large", inputTokens: 2_000, outputTokens: 500 }, prices)).toBe(
      0.004,
    );
  });

  it("returns 0 for a free model but null for an unknown one", () => {
    expect(estimateCostUsd({ model: "free", inputTokens: 10, outputTokens: 10 }, prices)).toBe(0);
    expect(estimateCostUsd({ model: "mystery", inputTokens: 10, outputTokens: 10 }, prices)).toBe(
      null,
    );
  });

  it("rejects negative or fractional token counts", () => {
    expect(() =>
      estimateCostUsd({ model: "free", inputTokens: -1, outputTokens: 0 }, prices),
    ).toThrow(RangeError);
    expect(() =>
      estimateCostUsd({ model: "free", inputTokens: 1.5, outputTokens: 0 }, prices),
    ).toThrow(RangeError);
  });
});

describe("summarize", () => {
  it("totals a trace, counting unpriced calls separately", async () => {
    const { tracer, sink, advance } = makeTracer({ prices });
    const run = tracer.start("run", "doc");

    const a = run.child("model_call", "a");
    a.recordModelUsage({ model: "large", inputTokens: 1_000, outputTokens: 1_000 });
    advance(100);
    a.end();

    const b = run.child("model_call", "b");
    b.recordModelUsage({ model: "mystery", inputTokens: 50, outputTokens: 5 });
    b.fail("rate limited");

    advance(20);
    run.end();
    await tracer.flush();

    expect(summarize(sink.spans)).toEqual({
      spanCount: 3,
      errorCount: 1,
      durationMs: 120,
      modelCalls: 2,
      inputTokens: 1_050,
      outputTokens: 1_005,
      costUsd: 0.005,
      unpricedModelCalls: 1,
    });
  });

  it("handles an empty trace", () => {
    expect(summarize([])).toMatchObject({ spanCount: 0, durationMs: 0, costUsd: 0 });
  });
});
