import { findPii, PII_TYPES, type PiiOptions, type PiiType } from "@lexguard/guardrails";
import type { CuadContract } from "./load";

// CUAD has no PII labels, so this cannot report precision. It reports what the redactor would
// change in real contracts: how much, of which kind, and how many lawyer-labelled clause spans
// (the text agents must analyse) would be altered.

export interface RedactionReport {
  phoneRegions: readonly string[];
  contracts: number;
  characters: number;
  redactions: Record<PiiType, number> & { total: number };
  redactedCharacters: number;
  redactedShare: number;
  perContract: { withAny: number; median: number; max: number; maxTitle: string };
  clauseSpans: {
    labelled: number;
    altered: number;
    alteredShare: number;
    byClauseType: Record<string, number>;
  };
  examples: Record<PiiType, string[]>;
}

const EXAMPLES_PER_TYPE = 10;
const CONTEXT = 30;

export function measureRedaction(
  contracts: readonly CuadContract[],
  options: PiiOptions = {},
): RedactionReport {
  const redactions = { total: 0, EMAIL: 0, IBAN: 0, CARD: 0, PHONE: 0 };
  const examples = Object.fromEntries(PII_TYPES.map((t) => [t, [] as string[]])) as Record<
    PiiType,
    string[]
  >;
  const byClauseType: Record<string, number> = {};
  const perContract: { title: string; count: number }[] = [];
  let characters = 0;
  let redactedCharacters = 0;
  let labelled = 0;
  let altered = 0;

  for (const contract of contracts) {
    const found = findPii(contract.text, options);
    characters += contract.text.length;
    perContract.push({ title: contract.title, count: found.length });

    for (const match of found) {
      redactions.total++;
      redactions[match.type]++;
      redactedCharacters += match.end - match.start;
      if (examples[match.type].length < EXAMPLES_PER_TYPE) {
        const before = contract.text.slice(Math.max(0, match.start - CONTEXT), match.start);
        const after = contract.text.slice(match.end, match.end + CONTEXT);
        examples[match.type].push(oneLine(`…${before}[[${match.value}]]${after}…`));
      }
    }

    for (const span of contract.spans) {
      labelled++;
      const end = span.start + span.text.length;
      if (found.some((m) => m.start < end && span.start < m.end)) {
        altered++;
        byClauseType[span.clauseType] = (byClauseType[span.clauseType] ?? 0) + 1;
      }
    }
  }

  const counts = perContract.map((c) => c.count).sort((a, b) => a - b);
  const top = perContract.reduce(
    (best, c) => (c.count > best.count ? c : best),
    perContract[0] ?? { title: "", count: 0 },
  );

  return {
    phoneRegions: options.phoneRegions ?? [],
    contracts: contracts.length,
    characters,
    redactions,
    redactedCharacters,
    redactedShare: characters === 0 ? 0 : redactedCharacters / characters,
    perContract: {
      withAny: counts.filter((c) => c > 0).length,
      median: counts[Math.floor(counts.length / 2)] ?? 0,
      max: top.count,
      maxTitle: top.title,
    },
    clauseSpans: {
      labelled,
      altered,
      alteredShare: labelled === 0 ? 0 : altered / labelled,
      byClauseType: Object.fromEntries(Object.entries(byClauseType).sort((a, b) => b[1] - a[1])),
    },
    examples,
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}
