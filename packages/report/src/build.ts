// The report (M5 step 7, D51): verified claims -> one finding per rule in scope.
//
// Only verified claims (packages/verifier) are used. A rule with no verified claim is
// "missing", never guessed. A rule's policy says what a good contract does with it:
//   require  the contract should state it   (GDPR 28(3)(a), "shall not reverse engineer")
//   forbid   the contract should not state it (e.g. "may retain information after termination")
//
//   require + agrees    -> meets            forbid + agrees    -> breaks (high)
//   require + conflicts -> breaks (high)    forbid + conflicts -> meets
//   require + silent    -> missing (medium) forbid + silent    -> meets
//
// Suggested wording (the redline) comes from the RULEBOOK, never from a model: pinned,
// trusted text, marked as a template to adapt. No contract text reaches a writer (T1).
import { getRule, ruleText, type Rulebook } from "@lexguard/rulebook";
import type { Claim, Problem, TextSource, Verdict, VerifiedClaim } from "@lexguard/verifier";

export const REPORT_VERSION = "report/1";

export type Policy = "require" | "forbid";
export type Status = "meets" | "breaks" | "missing";
export type Risk = "none" | "medium" | "high";

export interface ReportInput {
  document: { id: string; title: string };
  /** The stored contract text that every offset points into (a string, or the chunks the
   * caller loaded: only its length and the slices of references are read). */
  text: TextSource;
  /** Offsets where each PDF page starts (D21), to cite pages; empty for plain text. */
  pageStarts?: readonly number[];
  rulebooks: ReadonlyMap<string, Rulebook>;
  /** The rules this review covers, in report order. */
  scope: readonly { ruleId: string; policy?: Policy }[];
  verified: readonly VerifiedClaim[];
  rejected: readonly { claim: Claim; problems: readonly Problem[] }[];
  /** Which code and model produced the claims (PROJECT.md: versioning). */
  versions: Record<string, string>;
  /** ISO time, injected so reports are reproducible in tests. */
  generatedAt: string;
}

export interface CitedSpan {
  start: number;
  end: number;
  /** 1-based page, or null when the document has no page map. */
  page: number | null;
  text: string;
}

export type Redline =
  | { kind: "insert"; at: number; text: string }
  | { kind: "replace"; start: number; end: number; original: string; text: string }
  | { kind: "delete"; start: number; end: number; original: string };

export interface Finding {
  ruleId: string;
  citation: string;
  ruleTitle: string;
  ruleText: string;
  policy: Policy;
  /** The verdict the finding rests on; null when no claim about this rule was verified. */
  verdict: Verdict | null;
  status: Status;
  risk: Risk;
  evidence: CitedSpan[];
  references: {
    text: string;
    start: number;
    end: number;
    external: boolean;
    section: string | null;
  }[];
  /** The checker's one-sentence reason: written by a model that read the contract, so it is
   * shown as an unverified note, never as a finding. */
  modelNote: string | null;
  redline: (Redline & { source: "rulebook"; note: string }) | null;
}

export interface Report {
  version: typeof REPORT_VERSION;
  document: { id: string; title: string };
  generatedAt: string;
  versions: Record<string, string>;
  rulebooks: { id: string; title: string; sourceSha256: string }[];
  summary: Record<Status, number> & { rules: number };
  findings: Finding[];
  /** Claims the verifier refused, with why: they are not findings, but are reported. */
  rejectedClaims: { count: number; problems: Partial<Record<Problem, number>> };
}

/** 1-based page containing `offset` (binary search, same as the Worker's pageAt, D21). */
export function pageAt(pageStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = pageStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((pageStarts[mid] ?? Infinity) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** "gdpr:28(3)(a)" -> "GDPR Art. 28(3)(a)"; "nda:11" -> "NDA playbook rule 11". */
export function citationOf(ruleId: string): string {
  const [source = "", rest = ""] = ruleId.split(":");
  if (source === "gdpr") return `GDPR Art. ${rest}`;
  if (source === "nda") return `NDA playbook rule ${rest}`;
  return `${source.toUpperCase()} ${rest}`;
}

const STATUS: Record<Policy, Record<Verdict, Status>> = {
  require: { agrees: "meets", conflicts: "breaks", silent: "missing" },
  forbid: { agrees: "breaks", conflicts: "meets", silent: "meets" },
};
const RISK: Record<Status, Risk> = { meets: "none", breaks: "high", missing: "medium" };

/** Of several claims about one rule, the one that matters most: a break, then a meet. */
function decisive(claims: readonly VerifiedClaim[], policy: Policy): VerifiedClaim | null {
  const rank = (c: VerifiedClaim) =>
    ({ breaks: 0, meets: 1, missing: 2 })[STATUS[policy][c.verdict]];
  return [...claims].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

function redlineFor(
  status: Status,
  policy: Policy,
  evidence: readonly CitedSpan[],
  wording: string,
  textLength: number,
): Finding["redline"] {
  const first = evidence[0];
  const note =
    "Template from the rulebook's own wording: adapt it to this contract's defined terms and " +
    "have it reviewed. Not generated from the contract.";
  if (status === "meets") return null;
  if (policy === "forbid" && first !== undefined) {
    return {
      kind: "delete",
      start: first.start,
      end: first.end,
      original: first.text,
      source: "rulebook",
      note,
    };
  }
  if (status === "breaks" && first !== undefined) {
    return {
      kind: "replace",
      start: first.start,
      end: first.end,
      original: first.text,
      text: wording,
      source: "rulebook",
      note,
    };
  }
  return { kind: "insert", at: textLength, text: wording, source: "rulebook", note };
}

export function buildReport(input: ReportInput): Report {
  const cite = (s: { start: number; end: number; text: string }): CitedSpan => ({
    start: s.start,
    end: s.end,
    page:
      input.pageStarts !== undefined && input.pageStarts.length > 0
        ? pageAt(input.pageStarts, s.start)
        : null,
    text: s.text,
  });

  const findings = input.scope.map(({ ruleId, policy = "require" }): Finding => {
    const book = input.rulebooks.get(ruleId.slice(0, ruleId.indexOf(":")));
    const rule = book === undefined ? undefined : getRule(book, ruleId);
    if (book === undefined || rule === undefined)
      throw new Error(`rule ${ruleId} is not in any rulebook`);
    const wording = ruleText(book, rule);
    const claim = decisive(
      input.verified.filter((c) => c.ruleId === ruleId),
      policy,
    );
    const verdict = claim?.verdict ?? null;
    const status = verdict === null ? STATUS[policy].silent : STATUS[policy][verdict];
    const evidence = (claim?.evidence ?? []).map(cite);
    return {
      ruleId,
      citation: citationOf(ruleId),
      ruleTitle: rule.title,
      ruleText: wording,
      policy,
      verdict,
      status,
      risk: RISK[status],
      evidence,
      references: (claim?.references ?? []).map((r) => ({
        text: input.text.slice(r.reference.start, r.reference.end),
        start: r.reference.start,
        end: r.reference.end,
        external: r.reference.external,
        section: r.section?.label ?? null,
      })),
      modelNote: claim?.reason !== undefined && claim.reason !== "" ? claim.reason : null,
      redline: redlineFor(status, policy, evidence, wording, input.text.length),
    };
  });

  const problems: Partial<Record<Problem, number>> = {};
  for (const r of input.rejected) for (const p of r.problems) problems[p] = (problems[p] ?? 0) + 1;
  const count = (s: Status) => findings.filter((f) => f.status === s).length;

  return {
    version: REPORT_VERSION,
    document: input.document,
    generatedAt: input.generatedAt,
    versions: input.versions,
    rulebooks: [...input.rulebooks.values()].map((b) => ({
      id: b.source.id,
      title: b.source.title,
      sourceSha256: b.source.sourceSha256,
    })),
    summary: {
      rules: findings.length,
      meets: count("meets"),
      breaks: count("breaks"),
      missing: count("missing"),
    },
    findings,
    rejectedClaims: { count: input.rejected.length, problems },
  };
}
