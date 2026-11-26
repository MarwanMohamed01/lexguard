import { describe, expect, it } from "vitest";
import { pairedComparison, seededRandom } from "./paired";

describe("pairedComparison", () => {
  it("finds no difference between identical methods", () => {
    const r = pairedComparison([0, 0.5, 1], [0, 0.5, 1], ["a", "b", "c"]);
    expect(r).toMatchObject({ meanDiff: 0, better: 0, worse: 0, same: 3, ci95: [0, 0] });
  });

  it("counts wins and losses per case and averages the difference", () => {
    const r = pairedComparison([0, 1, 0.5, 0.5], [1, 0, 1, 0.5], [1, 2, 3, 4]);
    expect(r).toMatchObject({ cases: 4, groups: 4, better: 2, worse: 1, same: 1 });
    expect(r.meanDiff).toBeCloseTo(0.125);
    expect(r.baseline).toBeCloseTo(0.5);
    expect(r.candidate).toBeCloseTo(0.625);
  });

  it("an improvement on every case gives an interval above zero", () => {
    const base = Array.from({ length: 40 }, (_, i) => (i % 5) / 10);
    const cand = base.map((x) => x + 0.2);
    const r = pairedComparison(
      base,
      cand,
      base.map((_, i) => i % 8),
    );
    expect(r.ci95[0]).toBeGreaterThan(0);
    expect(r.ci95[0]).toBeCloseTo(0.2);
    expect(r.ci95[1]).toBeCloseTo(0.2);
  });

  it("is reproducible with a seed", () => {
    const base = [0, 1, 0, 1, 0.5, 0.2];
    const cand = [1, 1, 0, 0, 1, 0.3];
    const groups = [1, 1, 2, 2, 3, 3];
    expect(pairedComparison(base, cand, groups)).toEqual(pairedComparison(base, cand, groups));
  });

  it("is wider when the gain sits in one contract than when it is spread out", () => {
    // 100 questions, gain 1.0 on 10 of them: all in contract 0, or one per contract.
    const base = Array.from({ length: 100 }, () => 0);
    const cand = base.map((_, i) => (i < 10 ? 1 : 0));
    const clustered = pairedComparison(
      base,
      cand,
      base.map((_, i) => Math.floor(i / 10)),
    );
    const spread = pairedComparison(
      base,
      cand,
      base.map((_, i) => (i < 10 ? i : 10 + (i % 10))),
    );
    const width = (r: typeof clustered) => r.ci95[1] - r.ci95[0];
    expect(clustered.meanDiff).toBe(spread.meanDiff);
    expect(width(clustered)).toBeGreaterThan(width(spread));
    expect(clustered.ci95[0]).toBe(0); // one lucky contract is not proof
  });

  it("refuses empty or mismatched input", () => {
    expect(() => pairedComparison([], [], [])).toThrow();
    expect(() => pairedComparison([1], [1, 2], [1])).toThrow();
    expect(() => pairedComparison([1], [1], [])).toThrow();
  });

  it("averages a resample over ITS cases (contracts have different sizes)", () => {
    // Contract A: 1 question, gain 1. Contract B: 3 questions, no gain. A resample of A twice
    // has mean gain 1 (2 / 2 questions), and happens a quarter of the time.
    const r = pairedComparison([0, 0, 0, 0], [1, 0, 0, 0], ["A", "B", "B", "B"]);
    expect(r.meanDiff).toBe(0.25);
    expect(r.ci95).toEqual([0, 1]);
  });

  it("gives a 95% interval, not a narrower one", () => {
    // 20 contracts, gain 1 on half: about 0.5 +- 2 x 0.11 (binomial).
    const base = Array.from({ length: 20 }, () => 0);
    const cand = base.map((_, i) => (i % 2 === 0 ? 1 : 0));
    const r = pairedComparison(
      base,
      cand,
      base.map((_, i) => i),
    );
    expect(r.ci95[0]).toBeGreaterThan(0.2);
    expect(r.ci95[0]).toBeLessThan(0.35);
    expect(r.ci95[1]).toBeGreaterThan(0.65);
    expect(r.ci95[1]).toBeLessThan(0.8);
  });

  it("is the published mulberry32 generator", () => {
    expect(seededRandom(1)()).toBe(0.6270739405881613);
  });

  it("draws numbers in [0, 1)", () => {
    const r = seededRandom(7);
    for (let i = 0; i < 1_000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
