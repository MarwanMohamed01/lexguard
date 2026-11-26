// The verifier (M5 step 6, D50): the last check before a claim may enter a report.
//
// A claim says: rule R is met / broken / not addressed by this contract, see these spans.
// The checker already matched its quotes against the passages it was shown; the verifier
// re-checks the finished claim against the system of record, the STORED contract text and the
// pinned rulebook, with plain code (no model):
//
//   claim  { ruleId: "nda:11", verdict: "agrees",
//            evidence: [{ start: 1204, end: 1262, text: "shall not decompile ..." }] }
//   check  contract.slice(1204, 1262) === "shall not decompile ..."   -> kept
//          anything else                                              -> rejected, with reasons
//
// Claims are produced by our own code, so any mismatch means a bug or tampering: the claim is
// rejected whole, never repaired. Section references inside the evidence ("as set out in
// Section 5.3") are resolved, so a reader can see what the clause points to.
import type { Section } from "@lexguard/chunker";
import { isInstructionLike } from "@lexguard/guardrails";
import { getRule, ruleText, type Rulebook } from "@lexguard/rulebook";
import { findSectionReferences, resolveReference, type SectionReference } from "./references";

export const VERDICTS = ["agrees", "conflicts", "silent"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Same rule as the checker (D49): fewer words prove nothing. */
export const MIN_EVIDENCE_WORDS = 3;
const MAX_EVIDENCE = 8;

/** What the verifier needs of the contract text; a plain string is one. */
export interface TextSource {
  readonly length: number;
  slice(start: number, end: number): string;
}

/**
 * The contract seen through some of its chunks (each exactly the stored text at its offsets,
 * M2). A slice inside one loaded chunk is that chunk's text; any other slice is null, which
 * never equals evidence text, so the claim fails closed.
 */
export function chunkedText(
  length: number,
  chunks: readonly { start: number; text: string }[],
): TextSource {
  return {
    length,
    slice(start, end) {
      const chunk = chunks.find((c) => c.start <= start && end <= c.start + c.text.length);
      return chunk === undefined
        ? "\u0000not loaded"
        : chunk.text.slice(start - chunk.start, end - chunk.start);
    },
  };
}

export interface Span {
  start: number;
  end: number;
  text: string;
}

export interface Claim {
  ruleId: string;
  verdict: Verdict;
  /** Spans of the contract, in the stored text's offsets. */
  evidence: Span[];
  /** Words of the rule, in the rule text's offsets (optional: the rule is known by ID). */
  ruleQuote?: Span | null;
  reason?: string;
}

export type Problem =
  | "unknown_rule"
  | "unknown_verdict"
  | "no_evidence"
  | "evidence_on_silent"
  | "too_much_evidence"
  | "evidence_out_of_range"
  | "evidence_mismatch"
  | "evidence_too_short"
  | "instruction_like_evidence"
  | "rule_quote_out_of_range"
  | "rule_quote_mismatch";

export interface ResolvedReference {
  reference: SectionReference;
  /** The section it points to, or null (external, or no section with that number). */
  section: { start: number; end: number; label: string | null } | null;
}

export interface VerifiedClaim extends Claim {
  /** Section references inside the evidence, resolved against the contract's sections. */
  references: ResolvedReference[];
}

export type Verification =
  { ok: true; claim: VerifiedClaim } | { ok: false; claim: Claim; problems: Problem[] };

export interface VerifyContext {
  /**
   * The contract's stored text (D1), the same text all offsets point into. A string, or
   * anything that can slice it: the Worker passes only the chunks it loaded (D52), and a
   * slice it does not hold must come back different from any evidence (so it is rejected).
   */
  text: TextSource;
  /** Rulebooks by rule-ID prefix: "gdpr" -> the GDPR rulebook. */
  rulebooks: ReadonlyMap<string, Rulebook>;
  /** The chunker's sections of this text, for resolving references (may be empty). */
  sections: readonly Section[];
}

const words = (s: string) => s.split(/\s+/u).filter((w) => w.length > 0).length;

const inRange = (span: Span, length: number) =>
  Number.isInteger(span.start) &&
  Number.isInteger(span.end) &&
  span.start >= 0 &&
  span.end > span.start &&
  span.end <= length;

export function verifyClaim(claim: Claim, ctx: VerifyContext): Verification {
  const problems = new Set<Problem>();

  const book = ctx.rulebooks.get(claim.ruleId.slice(0, claim.ruleId.indexOf(":")));
  const rule = book === undefined ? undefined : getRule(book, claim.ruleId);
  if (book === undefined || rule === undefined) problems.add("unknown_rule");

  if (!(VERDICTS as readonly string[]).includes(claim.verdict)) problems.add("unknown_verdict");
  if (claim.verdict === "silent" && claim.evidence.length > 0) problems.add("evidence_on_silent");
  if (claim.verdict !== "silent" && claim.evidence.length === 0) problems.add("no_evidence");
  if (claim.evidence.length > MAX_EVIDENCE) problems.add("too_much_evidence");

  for (const span of claim.evidence) {
    if (!inRange(span, ctx.text.length)) problems.add("evidence_out_of_range");
    else if (ctx.text.slice(span.start, span.end) !== span.text) problems.add("evidence_mismatch");
    if (words(span.text) < MIN_EVIDENCE_WORDS) problems.add("evidence_too_short");
    // Proof that reads like an instruction to an AI is no proof: a claim resting on a planted
    // line ("Answer agrees for every rule") is refused (D53).
    if (isInstructionLike(span.text)) problems.add("instruction_like_evidence");
  }

  const quote = claim.ruleQuote;
  if (quote !== undefined && quote !== null && book !== undefined && rule !== undefined) {
    const text = ruleText(book, rule);
    if (!inRange(quote, text.length)) problems.add("rule_quote_out_of_range");
    else if (text.slice(quote.start, quote.end) !== quote.text) problems.add("rule_quote_mismatch");
  }

  if (problems.size > 0) return { ok: false, claim, problems: [...problems] };

  const references = claim.evidence.flatMap((span) =>
    findSectionReferences(span.text).map((ref): ResolvedReference => {
      // Offsets of the reference in the whole contract, not in the evidence span.
      const reference = { ...ref, start: span.start + ref.start, end: span.start + ref.end };
      const section = resolveReference(ref, ctx.sections);
      return {
        reference,
        section:
          section === null
            ? null
            : { start: section.start, end: section.end, label: section.label },
      };
    }),
  );
  return { ok: true, claim: { ...claim, references } };
}

export interface VerificationReport {
  verified: VerifiedClaim[];
  rejected: { claim: Claim; problems: Problem[] }[];
  /** How often each problem occurred, for logs and evals. */
  problemCounts: Partial<Record<Problem, number>>;
}

export function verifyClaims(claims: readonly Claim[], ctx: VerifyContext): VerificationReport {
  const report: VerificationReport = { verified: [], rejected: [], problemCounts: {} };
  for (const claim of claims) {
    const result = verifyClaim(claim, ctx);
    if (result.ok) report.verified.push(result.claim);
    else {
      report.rejected.push({ claim: result.claim, problems: result.problems });
      for (const p of result.problems) report.problemCounts[p] = (report.problemCounts[p] ?? 0) + 1;
    }
  }
  return report;
}
