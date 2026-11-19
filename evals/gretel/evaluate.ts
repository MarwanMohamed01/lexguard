import {
  findPii,
  luhnValid,
  type PhoneRegion,
  type PiiMatch,
  type PiiOptions,
  type PiiType,
} from "@lexguard/guardrails";
import { toMetrics, type Counts, type Metrics } from "../shared/metrics";
import type { GretelRow } from "./load";

// Gretel types that correspond to what our redactor claims to detect. Gretel has no IBANs,
// so IBAN detection is only measured on the hand-made set.
export const TYPE_MAP: Readonly<Record<string, PiiType>> = {
  email: "EMAIL",
  phone_number: "PHONE",
  credit_card_number: "CARD",
};

export const CONTRACT_DOC = /agreement|contract|lease|nda|terms|mandate/i;

interface Span {
  start: number;
  end: number;
}

interface LabelledEntity {
  type: string; // Gretel type
  ours: PiiType | undefined;
  value: string;
  spans: Span[];
}

export interface Bucket {
  rows: number;
  strict: Metrics;
  overlap: Metrics;
  byType: Record<PiiType, { strict: Metrics; overlap: Metrics }>;
  // Redactions that hit a labelled entity of a type we do not claim (e.g. an ID number
  // detected as a phone). Good for privacy, so not counted as false alarms.
  redactedOtherPii: number;
}

export interface GretelReport {
  dataset: string;
  revision: string;
  phoneRegions: readonly PhoneRegion[];
  coverage: { labelledEntities: number; supportedEntities: number; share: number };
  all: Bucket;
  contracts: Bucket;
  cardsLuhnValid: { labelled: number; strictRecall: number; overlapRecall: number };
  unsupportedTypes: Record<string, number>;
  examples: { missed: string[]; falseAlarms: string[] };
}

const empty = (): Counts => ({ tp: 0, fp: 0, fn: 0 });

function spansOf(text: string, value: string): Span[] {
  const spans: Span[] = [];
  if (value.length === 0) return spans;
  for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + value.length)) {
    spans.push({ start: i, end: i + value.length });
  }
  return spans;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

function labelled(row: GretelRow): LabelledEntity[] {
  const seen = new Set<string>();
  const out: LabelledEntity[] = [];
  for (const entity of row.entities) {
    for (const type of entity.types) {
      const key = `${type}\u0000${entity.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        type,
        ours: TYPE_MAP[type],
        value: entity.value,
        spans: spansOf(row.text, entity.value),
      });
    }
  }
  return out;
}

class Accumulator {
  rows = 0;
  strict = empty();
  overlap = empty();
  byType = Object.fromEntries(
    Object.values(TYPE_MAP).map((t) => [t, { strict: empty(), overlap: empty() }]),
  ) as Record<PiiType, { strict: Counts; overlap: Counts }>;
  redactedOtherPii = 0;

  add(entities: LabelledEntity[], predictions: PiiMatch[], examples?: GretelReport["examples"]) {
    this.rows++;
    const supported = entities.filter((e) => e.ours !== undefined);

    for (const entity of supported) {
      const type = entity.ours as PiiType;
      const exact = predictions.some((p) => p.type === type && p.value === entity.value);
      const touched = predictions.some((p) => entity.spans.some((s) => overlaps(s, p)));
      bump(this.strict, this.byType[type].strict, exact ? "tp" : "fn");
      bump(this.overlap, this.byType[type].overlap, touched ? "tp" : "fn");
      if (!touched && examples && examples.missed.length < 15) {
        examples.missed.push(`${type}: ${entity.value}`);
      }
    }

    for (const p of predictions) {
      const exactHit = supported.some((e) => e.ours === p.type && e.value === p.value);
      const hitsSupported = supported.some((e) => e.spans.some((s) => overlaps(s, p)));
      const hitsOther = entities.some(
        (e) => e.ours === undefined && e.spans.some((s) => overlaps(s, p)),
      );
      if (!exactHit && !hitsSupported && !hitsOther) {
        this.strict.fp++;
        this.overlap.fp++;
        this.byType[p.type].strict.fp++;
        this.byType[p.type].overlap.fp++;
        if (examples && examples.falseAlarms.length < 15)
          examples.falseAlarms.push(`${p.type}: ${p.value}`);
      } else if (!exactHit && !hitsSupported) {
        this.redactedOtherPii++;
      } else if (!exactHit) {
        // Overlapped the right entity but not exactly: a strict false alarm only.
        this.strict.fp++;
        this.byType[p.type].strict.fp++;
      }
    }
  }

  result(): Bucket {
    return {
      rows: this.rows,
      strict: toMetrics(this.strict),
      overlap: toMetrics(this.overlap),
      byType: Object.fromEntries(
        Object.entries(this.byType).map(([t, c]) => [
          t,
          { strict: toMetrics(c.strict), overlap: toMetrics(c.overlap) },
        ]),
      ) as Bucket["byType"],
      redactedOtherPii: this.redactedOtherPii,
    };
  }
}

function bump(total: Counts, perType: Counts, field: "tp" | "fn") {
  total[field]++;
  perType[field]++;
}

export function evaluateGretel(
  rows: readonly GretelRow[],
  revision: string,
  options: PiiOptions = {},
  // Swappable so alternative detectors can be compared on exactly the same scoring.
  detect: (text: string) => PiiMatch[] = (text) => findPii(text, options),
): GretelReport {
  const all = new Accumulator();
  const contracts = new Accumulator();
  const examples: GretelReport["examples"] = { missed: [], falseAlarms: [] };
  const unsupportedTypes: Record<string, number> = {};
  const cards = { labelled: 0, strict: 0, overlap: 0 };
  let labelledEntities = 0;
  let supportedEntities = 0;

  for (const row of rows) {
    const entities = labelled(row);
    const predictions = detect(row.text);
    all.add(entities, predictions, examples);
    if (CONTRACT_DOC.test(row.documentType)) contracts.add(entities, predictions);

    for (const e of entities) {
      labelledEntities++;
      if (e.ours === undefined) unsupportedTypes[e.type] = (unsupportedTypes[e.type] ?? 0) + 1;
      else supportedEntities++;
      if (e.ours === "CARD" && luhnValid(e.value.replace(/\D/g, ""))) {
        cards.labelled++;
        if (predictions.some((p) => p.type === "CARD" && p.value === e.value)) cards.strict++;
        if (predictions.some((p) => e.spans.some((s) => overlaps(s, p)))) cards.overlap++;
      }
    }
  }

  return {
    dataset: "gretelai/gretel-pii-masking-en-v1 (test split)",
    revision,
    phoneRegions: options.phoneRegions ?? [],
    coverage: {
      labelledEntities,
      supportedEntities,
      share: labelledEntities === 0 ? 0 : supportedEntities / labelledEntities,
    },
    all: all.result(),
    contracts: contracts.result(),
    cardsLuhnValid: {
      labelled: cards.labelled,
      strictRecall: cards.labelled === 0 ? 1 : cards.strict / cards.labelled,
      overlapRecall: cards.labelled === 0 ? 1 : cards.overlap / cards.labelled,
    },
    unsupportedTypes: Object.fromEntries(
      Object.entries(unsupportedTypes).sort((a, b) => b[1] - a[1]),
    ),
    examples,
  };
}
