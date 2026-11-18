import { findPii, PII_TYPES, type PiiType } from "@lexguard/guardrails";
import type { Label, LabelType, PiiCase } from "./dataset";

export interface Counts {
  tp: number; // found and correct
  fp: number; // found but not PII (or wrong type/span)
  fn: number; // PII we missed
}

export interface Metrics extends Counts {
  precision: number;
  recall: number;
  f1: number;
}

// What the redactor would remove from a text, as labels.
export function predict(text: string): Label[] {
  return findPii(text).map(({ type, value }) => ({ type, value }));
}

// Exact matching on (type, value): a partial span or wrong type counts as one miss plus
// one false alarm. Strict on purpose: a half-redacted IBAN still leaks the account.
export function compare(expected: readonly Label[], predicted: readonly Label[]): Counts {
  const remaining = expected.map(key);
  let tp = 0;
  let fp = 0;
  for (const label of predicted) {
    const index = remaining.indexOf(key(label));
    if (index === -1) {
      fp++;
    } else {
      tp++;
      remaining.splice(index, 1);
    }
  }
  return { tp, fp, fn: remaining.length };
}

// Conventions for empty cases: nothing predicted → precision 1; nothing expected → recall 1.
export function toMetrics({ tp, fp, fn }: Counts): Metrics {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

export interface PiiReport {
  datasetVersion: string;
  cases: number;
  // Over the PII types the redactor claims to support (NAME excluded).
  supported: Metrics;
  byType: Record<PiiType, Metrics>;
  // Names are labelled but not supported: reported so the gap stays visible.
  names: { labelled: number; caught: number };
  failures: { id: string; missed: Label[]; falseAlarms: Label[] }[];
}

// Micro-averaged: counts are summed over all cases first, then turned into ratios.
export function buildReport(
  cases: readonly PiiCase[],
  datasetVersion: string,
  detect: (text: string) => Label[] = predict,
): PiiReport {
  const total: Counts = { tp: 0, fp: 0, fn: 0 };
  const perType = Object.fromEntries(PII_TYPES.map((t) => [t, { tp: 0, fp: 0, fn: 0 }])) as Record<
    PiiType,
    Counts
  >;
  const names = { labelled: 0, caught: 0 };
  const failures: PiiReport["failures"] = [];

  for (const testCase of cases) {
    const predicted = detect(testCase.text);
    const expectedSupported = testCase.expected.filter((l) => l.type !== "NAME");
    const expectedNames = testCase.expected.filter((l) => l.type === "NAME");
    names.labelled += expectedNames.length;
    names.caught += compare(expectedNames, predicted).tp;

    add(total, compare(expectedSupported, predicted));
    for (const type of PII_TYPES) {
      add(
        perType[type],
        compare(
          expectedSupported.filter((l) => l.type === type),
          predicted.filter((l) => l.type === type),
        ),
      );
    }

    const missed = expectedSupported.filter((l) => !predicted.some((p) => key(p) === key(l)));
    const falseAlarms = predicted.filter((p) => !expectedSupported.some((l) => key(l) === key(p)));
    if (missed.length > 0 || falseAlarms.length > 0) {
      failures.push({ id: testCase.id, missed, falseAlarms });
    }
  }

  return {
    datasetVersion,
    cases: cases.length,
    supported: toMetrics(total),
    byType: Object.fromEntries(PII_TYPES.map((t) => [t, toMetrics(perType[t])])) as Record<
      PiiType,
      Metrics
    >,
    names,
    failures,
  };
}

function key(label: { type: LabelType; value: string }): string {
  return `${label.type}\u0000${label.value}`;
}

function add(into: Counts, counts: Counts): void {
  into.tp += counts.tp;
  into.fp += counts.fp;
  into.fn += counts.fn;
}
