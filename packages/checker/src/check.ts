import { locateQuote, type Model } from "@lexguard/extraction";
import { parseModelOutput, type ParseFailureReason } from "@lexguard/guardrails";
import { z } from "zod";
import { buildCheckPrompt, CHECK_PROMPT_VERSION } from "./prompt";

// One checker call (M5 step 5, D49): rule + contract passages -> model -> closed form ->
// code finds every quote in a passage -> a verdict is accepted only with evidence.
//
// The checker is a quarantined reader like the extractor (T1): it reads untrusted contract
// text, has no tools, and can only fill this form. Its words are never stored as the
// contract's: an accepted quote is the PASSAGE's text at the found position (T3).

export const VERDICTS = ["agrees", "conflicts", "silent"] as const;
export type Verdict = (typeof VERDICTS)[number];

const MAX_QUOTES = 4;
/**
 * A quote of one or two words proves nothing: "A" or "(a) Compu" occurs in many passages.
 * Found in the oracle run (D49): ContractNLI marks such sentence fragments as evidence.
 */
export const MIN_QUOTE_WORDS = 3;
const MAX_QUOTE_CHARS = 1_500;
const MAX_OUTPUT_CHARS = 20_000;

/** Quotes that are not short strings are dropped (not repaired), like extractor details. */
const quoteList = z
  .unknown()
  .default([])
  .transform((value) =>
    (Array.isArray(value) ? value : [])
      .filter(
        (q): q is string => typeof q === "string" && q.length > 0 && q.length <= MAX_QUOTE_CHARS,
      )
      .slice(0, MAX_QUOTES),
  );

export const CheckForm = z.object({
  verdict: z.enum(VERDICTS),
  quotes: quoteList,
  ruleQuote: z.string().max(MAX_QUOTE_CHARS).optional().catch(undefined),
  reason: z.string().trim().max(500).catch(""),
});

export interface Evidence {
  /** Index into the passages given to the checker. */
  passage: number;
  start: number;
  end: number;
  /** The passage's own text at [start, end), never the model's wording. */
  text: string;
}

export type CheckResult =
  | {
      ok: true;
      promptVersion: string;
      /** The verdict after the evidence check. */
      verdict: Verdict;
      /** What the model said before the check. */
      claimed: Verdict;
      /** agrees/conflicts with no quote found in any passage: downgraded to silent. */
      downgraded: boolean;
      evidence: Evidence[];
      /** The rule's own text the model pointed at, or null (missing or not in the rule). */
      ruleQuote: { start: number; end: number; text: string } | null;
      reason: string;
      quotesNotFound: number;
      /** Quotes under MIN_QUOTE_WORDS words, ignored. */
      quotesTooShort: number;
      /** Quotes that began with our own [n] passage label, removed before matching. */
      labelsStripped: number;
    }
  | { ok: false; promptVersion: string; reason: ParseFailureReason; message: string };

export interface CheckOptions {
  /** Fresh random letters/digits for the document wrapper (see buildCheckPrompt). */
  nonce: string;
}

/**
 * The passage a quote comes from. The same words can be in several passages (repeated
 * boilerplate, or a short list item inside a longer sentence: 0.4% of ContractNLI's expert
 * quotes, D49), so the best match wins: a passage that IS the quote, then one containing it
 * verbatim, then one matching it with different whitespace; the earliest on a tie.
 */
export function findQuote(
  passages: readonly string[],
  quote: string,
  hint?: number,
): { passage: number; found: { start: number; end: number } } | undefined {
  // The passage the model named comes first, if the words are really there.
  const named = hint === undefined ? undefined : passages[hint];
  const there = named === undefined ? null : locateQuote(named, quote);
  if (hint !== undefined && there !== null) return { passage: hint, found: there };
  let best: { passage: number; found: { start: number; end: number }; rank: number } | undefined;
  passages.forEach((text, passage) => {
    const found = locateQuote(text, quote);
    if (found === null) return;
    const rank = text === quote ? 0 : found.exact ? 1 : 2;
    if (best === undefined || rank < best.rank) best = { passage, found, rank };
  });
  return best === undefined ? undefined : { passage: best.passage, found: best.found };
}

export async function checkRule(
  rule: { id: string; text: string },
  passages: readonly string[],
  model: Model,
  options: CheckOptions,
): Promise<CheckResult> {
  const raw = await model(buildCheckPrompt(rule, passages, options.nonce));
  const parsed = parseModelOutput(CheckForm, raw, { maxChars: MAX_OUTPUT_CHARS });
  if (!parsed.ok) {
    return {
      ok: false,
      promptVersion: CHECK_PROMPT_VERSION,
      reason: parsed.reason,
      message: parsed.message,
    };
  }
  const form = parsed.data;

  const evidence: Evidence[] = [];
  let quotesNotFound = 0;
  let quotesTooShort = 0;
  let labelsStripped = 0;
  if (form.verdict !== "silent") {
    for (const raw of form.quotes) {
      // Models often copy our own passage label: "[2] As used herein..." (55 of 58 unfound
      // quotes in the first ContractNLI run, D49). The label is ours, not the contract's: strip
      // it and use it as a hint. The words after it must still be found in a passage.
      const label = /^\[(\d{1,2})\]\s+/u.exec(raw);
      const quote = label === null ? raw : raw.slice(label[0].length);
      const hint = label === null ? undefined : Number(label[1]) - 1;
      if (label !== null) labelsStripped++;
      if (quote.split(/\s+/u).filter((w) => w.length > 0).length < MIN_QUOTE_WORDS) {
        quotesTooShort++;
        continue;
      }
      const hit = findQuote(passages, quote, hint);
      if (hit === undefined) {
        quotesNotFound++;
        continue;
      }
      const { start, end } = hit.found;
      if (evidence.some((e) => e.passage === hit.passage && e.start === start && e.end === end))
        continue;
      evidence.push({
        passage: hit.passage,
        start,
        end,
        text: (passages[hit.passage] ?? "").slice(start, end),
      });
    }
  }

  const located = form.ruleQuote === undefined ? null : locateQuote(rule.text, form.ruleQuote);
  const downgraded = form.verdict !== "silent" && evidence.length === 0;
  return {
    ok: true,
    promptVersion: CHECK_PROMPT_VERSION,
    verdict: downgraded ? "silent" : form.verdict,
    claimed: form.verdict,
    downgraded,
    evidence, // empty whenever downgraded: that is what downgrades
    ruleQuote:
      located === null
        ? null
        : {
            start: located.start,
            end: located.end,
            text: rule.text.slice(located.start, located.end),
          },
    reason: form.reason,
    quotesNotFound,
    quotesTooShort,
    labelsStripped,
  };
}
