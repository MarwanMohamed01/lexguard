// The checker eval on ContractNLI (M5 step 5, D49). One case = one (NDA, rule) pair:
//   rule      = the NDA playbook rule (packages/rulebook, ContractNLI's hypothesis),
//   passages  = the NDA's top-k spans from M3's keyword search for that rule, in the NDA's
//               own order (production reads the top passages too, never the whole contract),
//   answer    = the expert's label and evidence spans.
// The checker's verdict maps onto ContractNLI's labels, and its accepted quotes onto spans.
import type { CheckResult, Verdict } from "@lexguard/checker";
import { createHash } from "node:crypto";
import type { Choice, NliAnswer, NliDoc } from "./load";
import type { NliPrediction } from "./score";

export const TOP_K = 10;

export interface CheckCase {
  doc: NliDoc;
  /** ContractNLI's hypothesis key, e.g. "nda-11"; the rule ID is "nda:11". */
  key: string;
  ruleId: string;
  /** Span indices given to the checker, in document order. */
  spans: number[];
  gold: NliAnswer;
}

const VERDICT_TO_CHOICE: Record<Verdict, Choice> = {
  agrees: "Entailment",
  conflicts: "Contradiction",
  silent: "NotMentioned",
};

export const ruleIdOf = (key: string) => `nda:${key.slice("nda-".length)}`;

/** Every (document, hypothesis) pair with the top-k keyword spans for that hypothesis. */
export function checkerCases(
  docs: readonly NliDoc[],
  keys: readonly string[],
  rankings: ReadonlyMap<string, number[][]>,
  k = TOP_K,
): CheckCase[] {
  return docs.flatMap((doc, d) =>
    keys.map((key) => ({
      doc,
      key,
      ruleId: ruleIdOf(key),
      spans: [...(rankings.get(key)?.[d] ?? []).slice(0, k)].sort((a, b) => a - b),
      gold: doc.answers.get(key) ?? { choice: "NotMentioned" as const, evidence: [] },
    })),
  );
}

export const passagesOf = (c: CheckCase): string[] =>
  c.spans.map((i) => {
    const [start, end] = c.doc.spans[i] ?? [0, 0];
    return c.doc.text.slice(start, end);
  });

/** The eval's nonce: derived from the input, so a cached answer matches its exact prompt. */
export const caseNonce = (ruleText: string, passages: readonly string[]) =>
  createHash("sha256")
    .update(`${ruleText}\u0000${passages.join("\u0000")}`, "utf8")
    .digest("hex")
    .slice(0, 24);

/** A failed answer counts as "silent": no claim was made. */
export function toPrediction(c: CheckCase, result: CheckResult): NliPrediction {
  if (!result.ok) return { choice: "NotMentioned", evidence: [] };
  return {
    choice: VERDICT_TO_CHOICE[result.verdict],
    evidence: [...new Set(result.evidence.map((e) => c.spans[e.passage] ?? -1))].filter(
      (i) => i >= 0,
    ),
  };
}

/**
 * The best a checker could answer when it reads only these passages: the expert's label,
 * quoting the expert's evidence spans. When none of them is among the passages, its quote is
 * a span the checker never saw, so the real checker code downgrades it to silent. Scoring
 * this "oracle" gives the ceiling the retrieval step allows, without any model.
 */
export function oracleAnswer(c: CheckCase): string {
  const verdict: Verdict =
    c.gold.choice === "Entailment"
      ? "agrees"
      : c.gold.choice === "Contradiction"
        ? "conflicts"
        : "silent";
  const quotes = c.gold.evidence.map((i) => {
    const [start, end] = c.doc.spans[i] ?? [0, 0];
    return c.doc.text.slice(start, end);
  });
  return JSON.stringify({
    verdict,
    quotes: quotes.slice(0, 4), // empty when silent: the expert gives no evidence then
    reason: "oracle",
  });
}
