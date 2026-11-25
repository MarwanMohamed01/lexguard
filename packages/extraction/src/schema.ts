import { z } from "zod";
import { CLAUSE_TYPE_NAMES } from "./types";

// The form an extractor must fill in (M4 step 3). The extractor is a quarantined reader (T1):
// it reads untrusted contract text, so everything it returns is treated as untrusted too and
// kept narrow. Types and risk flags are closed lists; free text is short and capped; the quote
// is checked against the chunk by code before anything uses it (T3).

export const MAX_QUOTE_CHARS = 2_000;
export const MAX_CLAUSES = 20;

/** Coarse warning signs a reader can see in one clause; scoring against a rulebook is M5. */
export const RISK_FLAGS = [
  "one_sided", // obliges or benefits only one party
  "no_limit", // no cap on amount, duration or scope
  "auto_renewal", // renews unless someone acts
  "short_notice", // a notice or cure period of 30 days or less
  "survives_termination", // keeps applying after the contract ends
] as const;

const shortText = (max: number) => z.string().trim().min(1).max(max);

/**
 * A list of details where each item must pass `item`. Items that do not are DROPPED, not
 * repaired, and the list is cut to `max`; anything that is not a list becomes []. Type and
 * quote are the clause; details are extras. Found in step 4: llama3.2 left `action` out of
 * obligations, and rejecting the whole clause for it threw away 3 of its 39 entries (30 more
 * had an empty quote, rightly rejected). Dropping is as safe as rejecting: nothing outside the
 * form ever gets through.
 */
const details = <T extends z.ZodType>(item: T, max: number) =>
  z
    .unknown()
    .default([])
    .transform((value): z.output<T>[] =>
      (Array.isArray(value) ? value : []).flatMap((v: unknown) => {
        const parsed = item.safeParse(v);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .transform((list) => list.slice(0, max));

export const ExtractedClause = z.object({
  clauseType: z.enum(CLAUSE_TYPE_NAMES),
  // Not trimmed: the quote must match the chunk character for character.
  quote: z.string().min(1).max(MAX_QUOTE_CHARS),
  parties: details(shortText(200), 6),
  obligations: details(z.object({ party: shortText(200), action: shortText(300) }), 5),
  dates: details(shortText(100), 5),
  riskFlags: details(z.enum(RISK_FLAGS), RISK_FLAGS.length).transform((flags) => [
    ...new Set(flags),
  ]),
});
export type ExtractedClause = z.infer<typeof ExtractedClause>;

/**
 * The envelope only. Clauses are validated one by one afterwards, so one bad clause (an
 * unknown type, a missing quote) costs that clause, not the whole chunk, and is counted.
 */
export const ExtractionEnvelope = z.object({
  clauses: z.array(z.unknown()).max(MAX_CLAUSES),
});
