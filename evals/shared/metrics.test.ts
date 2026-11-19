import { describe, expect, it } from "vitest";
import { toMetrics } from "./metrics";

describe("toMetrics", () => {
  it("computes precision, recall and F1", () => {
    expect(toMetrics({ tp: 3, fp: 1, fn: 1 })).toMatchObject({
      precision: 0.75,
      recall: 0.75,
      f1: 0.75,
    });
  });

  it("uses the empty-case conventions", () => {
    expect(toMetrics({ tp: 0, fp: 0, fn: 0 })).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(toMetrics({ tp: 0, fp: 2, fn: 0 })).toMatchObject({ precision: 0, recall: 1, f1: 0 });
  });
});
