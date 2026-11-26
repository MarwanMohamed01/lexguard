// The review job (M5 step 8, D52): a Workflow that checks a ready, indexed document against
// the rules in its review scope and stores one verified-or-rejected claim per rule.
//
//   load -> rules 1-4, rules 5-8, ... (REVIEW_PARALLEL groups at a time) -> finish
//
//   load    check the ticket, the document is ready and indexed; read the scope; delete the
//           claims of a previous review.
//   group   for each rule: hybrid search for its top chunks (M3) -> the top sentences of those
//           chunks (passages) -> reserve Neurons (atomic, daily, shared with extraction) ->
//           checker (quarantined, D49) -> claim in document offsets -> verifier against the
//           loaded chunks and the rulebook (D50) -> store. Several rules per step: the Free
//           plan allows 3,000 Workflow steps a day (D43). Returns only small counts (D33).
//   finish  mark the document reviewed with the version.
//
// Fencing (D20) as extraction: every read and write checks documents.review_job in the same
// statement. Budget (T15): a rule that cannot reserve its Neurons stops the job, which keeps
// what it has and marks the document failed with 'daily_budget'.
import {
  buildCheckPrompt,
  checkRule,
  CHECK_PROMPT_VERSION,
  selectPassages,
  type CheckResult,
} from "@lexguard/checker";
import type { Section } from "@lexguard/chunker";
import { gdpr, getRule, ndaPlaybook, ruleText, type Rulebook } from "@lexguard/rulebook";
import { chunkedText, verifyClaim, type Claim } from "@lexguard/verifier";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import {
  actualNeurons,
  DAILY_EXTRACT_NEURONS,
  EXTRACT_MODEL,
  STEP,
  workersAiCompletion,
  type Completion,
  type StepRunner,
} from "./extraction";
import { estimateNeurons } from "./extraction";
import { hybridTopChunks, type SearchServices } from "./search";
import { vectorIndex, workersAiEmbedder } from "./indexing";

export const REVIEW_MODEL = EXTRACT_MODEL;
/** Model, checker prompt and verifier rules: a change to any of them is a new version. */
export const REVIEW_VERSION = `${REVIEW_MODEL}/${CHECK_PROMPT_VERSION}/verify-1`;
/** Rules per Workflow step (3,000 steps a day on Free, D43). */
export const RULES_PER_STEP = 4;
export const REVIEW_PARALLEL = 2;
export const MAX_REVIEW_RULES = 40;
/** Chunks the search hands over per rule, and sentences of them the checker reads (D49). */
export const CHUNKS_PER_RULE = 5;
export const PASSAGES_PER_RULE = 10;

export const RULEBOOKS: ReadonlyMap<string, Rulebook> = new Map([
  ["gdpr", gdpr],
  ["nda", ndaPlaybook],
]);

export const ScopeSchema = z
  .array(z.object({ ruleId: z.string(), policy: z.enum(["require", "forbid"]) }))
  .min(1)
  .max(MAX_REVIEW_RULES);
export type Scope = z.infer<typeof ScopeSchema>;

export interface ReviewParams {
  tenantId: string;
  documentId: string;
  /** The ticket in documents.review_job; also the instance ID. */
  jobId: string;
}

export interface ReviewServices {
  complete(prompt: { system: string; user: string }): Promise<Completion>;
  nonce(): string;
  today(): string;
  /** Embeddings and Vectorize for hybrid search; without them, keyword search only. */
  search?: SearchServices | undefined;
}

const OWNS = `EXISTS (SELECT 1 FROM documents
  WHERE tenant_id = ? AND id = ? AND review_job = ? AND review_status = 'reviewing')`;

const superseded = () => new NonRetryableError("a newer review job owns this document");

export type ReviewOutcome =
  | { skipped: true }
  | { superseded: true }
  | { failed: "daily_budget" }
  | { rules: number; verified: number; rejected: number; failedAnswers: number; neurons: number };

async function markReviewFailed(db: D1Database, owner: readonly string[], code: string) {
  const result = await db
    .prepare(
      `UPDATE documents SET review_status = 'failed', review_error = ?, review_job = NULL
       WHERE tenant_id = ? AND id = ? AND review_job = ? AND review_status = 'reviewing'`,
    )
    .bind(code, ...owner)
    .run();
  return result.meta.changes === 1;
}

/**
 * Sections rebuilt from the chunks' headings (the chunker's sections are not stored): a
 * section starts at the first chunk under a new heading and ends where the next heading of
 * the same or a higher level starts. Enough to resolve "Section 5.3" to its heading and start.
 */
export function sectionsFromChunks(
  rows: readonly { start: number; heading: string | null; path: string[] }[],
  length: number,
): Section[] {
  const opened: Section[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    if (row.heading === null || row.heading === previous) {
      previous = row.heading;
      continue;
    }
    previous = row.heading;
    opened.push({
      start: row.start,
      end: length,
      depth: row.path.length,
      label: row.heading,
      path: row.path,
    });
  }
  for (const [i, s] of opened.entries()) {
    const next = opened.slice(i + 1).find((n) => n.depth <= s.depth);
    if (next !== undefined) s.end = next.start;
  }
  return opened;
}

type RuleResult = { budget: true } | { budget: false; outcome: string; neurons: number };

export async function runReview(
  db: D1Database,
  services: ReviewServices,
  params: ReviewParams,
  step: StepRunner,
): Promise<ReviewOutcome> {
  const { tenantId, documentId, jobId } = params;
  const owner = [tenantId, documentId, jobId] as const;

  try {
    const loaded = await step.do("load", STEP, async () => {
      const doc = await db
        .prepare(
          `SELECT review_scope AS scope, chars, indexed_chunks AS chunks FROM documents
           WHERE tenant_id = ? AND id = ? AND review_job = ? AND review_status = 'reviewing'
             AND status = 'ready' AND index_status = 'indexed'`,
        )
        .bind(...owner)
        .first<{ scope: string | null; chars: number; chunks: number }>();
      if (doc === null || doc.scope === null) return null;
      const scope = ScopeSchema.parse(JSON.parse(doc.scope));
      await db
        .prepare(`DELETE FROM review_claims WHERE tenant_id = ? AND document_id = ? AND ${OWNS}`)
        .bind(tenantId, documentId, ...owner)
        .run();
      return { rules: scope.map((r) => r.ruleId), chars: doc.chars, chunks: doc.chunks };
    });
    if (loaded === null) return { skipped: true };

    const checkOne = async (ruleId: string, sections: Section[]): Promise<RuleResult> => {
      const book = RULEBOOKS.get(ruleId.slice(0, ruleId.indexOf(":")));
      const rule = book === undefined ? undefined : getRule(book, ruleId);
      if (book === undefined || rule === undefined)
        throw new NonRetryableError(`unknown rule ${ruleId}`);
      const rulePrompt = { id: ruleId, text: ruleText(book, rule) };
      const query = `${rule.title} ${rulePrompt.text}`;

      const { top } = await hybridTopChunks(
        db,
        services.search,
        tenantId,
        documentId,
        loaded.chunks,
        query,
        CHUNKS_PER_RULE,
      );
      const { results: rows } = await db
        .prepare(
          `SELECT idx, start_offset AS start, text FROM chunks
           WHERE tenant_id = ? AND document_id = ? AND idx IN (SELECT value FROM json_each(?))
             AND ${OWNS}`,
        )
        .bind(tenantId, documentId, JSON.stringify(top), ...owner)
        .all<{ idx: number; start: number; text: string }>();
      if (rows.length === 0 && top.length > 0) throw superseded();
      const passages = selectPassages(rows, query, PASSAGES_PER_RULE);

      let result: CheckResult | null = null;
      let neurons = 0;
      if (passages.length > 0) {
        const nonce = services.nonce();
        const estimate = estimateNeurons(
          buildCheckPrompt(
            rulePrompt,
            passages.map((p) => p.text),
            nonce,
          ),
        );
        const day = services.today();
        const [, reserved] = await db.batch([
          db.prepare("INSERT OR IGNORE INTO neuron_budget (day, neurons) VALUES (?, 0)").bind(day),
          db
            .prepare(
              "UPDATE neuron_budget SET neurons = neurons + ? WHERE day = ? AND neurons + ? <= ?",
            )
            .bind(estimate, day, estimate, DAILY_EXTRACT_NEURONS),
        ]);
        if (reserved?.meta.changes !== 1) return { budget: true };
        const call: { completion: Completion | null } = { completion: null };
        result = await checkRule(
          rulePrompt,
          passages.map((p) => p.text),
          async (prompt) => {
            call.completion = await services.complete(prompt);
            return call.completion.text;
          },
          { nonce },
        );
        neurons = call.completion === null ? estimate : actualNeurons(call.completion, estimate);
        await db
          .prepare("UPDATE neuron_budget SET neurons = max(0, neurons + ?) WHERE day = ?")
          .bind(neurons - estimate, day)
          .run();
      }

      // No passage at all: nothing addresses the rule, a silent claim without a model call.
      const checked: Extract<CheckResult, { ok: true }> | null =
        result === null
          ? {
              ok: true,
              promptVersion: CHECK_PROMPT_VERSION,
              verdict: "silent",
              claimed: "silent",
              downgraded: false,
              evidence: [],
              ruleQuote: null,
              reason: "",
              quotesNotFound: 0,
              quotesTooShort: 0,
              labelsStripped: 0,
            }
          : result.ok
            ? result
            : null;

      let outcome: string;
      let claim: Claim | null = null;
      let refs: unknown[] = [];
      let problems: string[] = [];
      let evidence: { chunk: number; start: number; end: number }[] = [];
      if (checked === null) {
        outcome = result !== null && !result.ok ? result.reason : "not_json";
      } else {
        claim = {
          ruleId,
          verdict: checked.verdict,
          evidence: checked.evidence.map((e) => {
            const p = passages[e.passage];
            const start = (p?.start ?? 0) + e.start;
            return { start, end: start + (e.end - e.start), text: e.text };
          }),
          ruleQuote: checked.ruleQuote,
          reason: checked.reason,
        };
        const verified = verifyClaim(claim, {
          text: chunkedText(loaded.chars, rows),
          rulebooks: RULEBOOKS,
          sections,
        });
        outcome = verified.ok ? "verified" : "rejected";
        if (verified.ok) refs = verified.claim.references;
        else problems = verified.problems;
        evidence = claim.evidence.map((e) => ({
          chunk:
            rows.find((r) => r.start <= e.start && e.end <= r.start + r.text.length)?.idx ?? -1,
          start: e.start,
          end: e.end,
        }));
      }

      await db
        .prepare(
          `INSERT OR REPLACE INTO review_claims (tenant_id, document_id, rule_id, outcome, verdict,
             claimed, evidence, rule_quote, reason, refs, problems, passages, neurons)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${OWNS}`,
        )
        .bind(
          tenantId,
          documentId,
          ruleId,
          outcome,
          claim?.verdict ?? null,
          checked?.claimed ?? null,
          JSON.stringify(evidence),
          claim?.ruleQuote == null
            ? null
            : JSON.stringify({ start: claim.ruleQuote.start, end: claim.ruleQuote.end }),
          claim?.reason ?? null,
          JSON.stringify(refs),
          JSON.stringify(problems),
          passages.length,
          neurons,
          ...owner,
        )
        .run();
      return { budget: false, outcome, neurons };
    };

    const groupStep = (rules: string[], index: number) =>
      step.do(
        `rules ${String(index * RULES_PER_STEP + 1)}-${String(index * RULES_PER_STEP + rules.length)}`,
        STEP,
        async () => {
          // Headings of every chunk (no text), to resolve section references.
          const { results: heads } = await db
            .prepare(
              `SELECT start_offset AS start, heading, section_path AS path FROM chunks
             WHERE tenant_id = ? AND document_id = ? AND ${OWNS} ORDER BY idx`,
            )
            .bind(tenantId, documentId, ...owner)
            .all<{ start: number; heading: string | null; path: string }>();
          const sections = sectionsFromChunks(
            heads.map((h) => ({
              ...h,
              path: z.array(z.string()).catch([]).parse(JSON.parse(h.path)),
            })),
            loaded.chars,
          );
          const counts = { budget: false, verified: 0, rejected: 0, failed: 0, neurons: 0 };
          for (const ruleId of rules) {
            const r = await checkOne(ruleId, sections);
            if (r.budget) {
              counts.budget = true;
              break;
            }
            counts.neurons += r.neurons;
            if (r.outcome === "verified") counts.verified++;
            else if (r.outcome === "rejected") counts.rejected++;
            else counts.failed++;
          }
          return counts;
        },
      );

    const groups: string[][] = [];
    for (let i = 0; i < loaded.rules.length; i += RULES_PER_STEP)
      groups.push(loaded.rules.slice(i, i + RULES_PER_STEP));
    const totals = { verified: 0, rejected: 0, failedAnswers: 0, neurons: 0 };
    let outOfBudget = false;
    for (let g = 0; g < groups.length && !outOfBudget; g += REVIEW_PARALLEL) {
      const batch = groups.slice(g, g + REVIEW_PARALLEL);
      const results = await Promise.all(batch.map((rules, k) => groupStep(rules, g + k)));
      for (const r of results) {
        if (r.budget) outOfBudget = true;
        totals.verified += r.verified;
        totals.rejected += r.rejected;
        totals.failedAnswers += r.failed;
        totals.neurons += r.neurons;
      }
    }
    if (outOfBudget) {
      const marked = await step.do("mark budget", STEP, () =>
        markReviewFailed(db, owner, "daily_budget"),
      );
      return marked ? { failed: "daily_budget" } : { superseded: true };
    }

    await step.do("finish", STEP, async () => {
      const result = await db
        .prepare(
          `UPDATE documents SET review_status = 'reviewed', review_job = NULL,
             review_version = ?, review_error = NULL
           WHERE tenant_id = ? AND id = ? AND review_job = ? AND review_status = 'reviewing'`,
        )
        .bind(REVIEW_VERSION, ...owner)
        .run();
      if (result.meta.changes !== 1) throw superseded();
      return true;
    });
    return { rules: loaded.rules.length, ...totals };
  } catch (error) {
    const failed = await step.do("mark failed", STEP, () =>
      markReviewFailed(db, owner, "review_failed"),
    );
    if (!failed) return { superseded: true };
    throw error;
  }
}

export class ReviewDocument extends WorkflowEntrypoint<Env, ReviewParams> {
  override async run(event: Readonly<WorkflowEvent<ReviewParams>>, step: WorkflowStep) {
    const services: ReviewServices = {
      complete: workersAiCompletion(this.env.AI),
      nonce: () => crypto.randomUUID().replaceAll("-", ""),
      today: () => new Date().toISOString().slice(0, 10),
      search: { embed: workersAiEmbedder(this.env.AI), vectors: vectorIndex(this.env) },
    };
    return runReview(this.env.DB, services, event.payload, step);
  }
}
