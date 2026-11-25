// The extraction job (M4 step 5, D37): a Workflow that reads every chunk of a ready document
// with the quarantined extractor (@lexguard/extraction) and stores the accepted clauses.
//
//   load -> chunk 0..N-1 (EXTRACT_PARALLEL at a time) -> finish
//
//   load      check the ticket and the size cap; delete the clauses of a previous run.
//   chunk i   reserve the Neurons this call can cost (atomic, daily, account-wide); read the
//             chunk under the ticket; extract (prompt -> model -> form -> verbatim quote
//             check); correct the reservation with the real usage; store the accepted clauses
//             and a per-chunk record. Returns only small counts (D33: big step results cost
//             CPU as JSON).
//   finish    mark the document extracted with the model + prompt version.
//
// Fencing (D20, as indexing): every read and write checks documents.extract_job in the same
// statement, so a replaced job can no longer change anything.
// Budget (T15): if a chunk cannot reserve its Neurons, the job stops, keeps what it has, and
// marks the document failed with 'daily_budget'. Running it again re-extracts everything.
import { buildPrompt, extractClauses, PROMPT_VERSION, type Prompt } from "@lexguard/extraction";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";

/**
 * Provisional until the step 4 eval decides (D34: the cheapest capable candidate). A change
 * means a new EXTRACT_VERSION, and documents can be extracted again.
 */
export const EXTRACT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Neurons per million tokens, input / output (Workers AI pricing, checked 2026-11-25, D34). */
export const MODEL_PRICE = { input: 9_091, output: 27_273 };
export const EXTRACT_VERSION = `${EXTRACT_MODEL}/${PROMPT_VERSION}`;
/** Output cap per call; also the reservation's worst case. */
export const MAX_OUTPUT_TOKENS = 2_048;
/** Of the free 10,000 Neurons a day, the rest stays for uploads' embeddings and searches. */
export const DAILY_EXTRACT_NEURONS = 6_000;
/** About 400 pages; also keeps an instance far below the 1,024-step limit. */
export const MAX_EXTRACT_CHUNKS = 400;
/** Chunk steps running at once (Workers AI allows 300 text requests a minute). */
export const EXTRACT_PARALLEL = 4;

export interface ExtractParams {
  tenantId: string;
  documentId: string;
  /** The ticket in documents.extract_job; also the instance ID. */
  jobId: string;
}

export interface Completion {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ExtractServices {
  complete(prompt: Prompt): Promise<Completion>;
  /** Fresh random lowercase letters/digits for the document wrapper (D36). */
  nonce(): string;
  /** "YYYY-MM-DD" in UTC, for the daily budget. */
  today(): string;
}

/** The part of WorkflowStep this job uses, so tests can pass a direct runner. */
export interface StepRunner {
  do<T>(name: string, config: typeof STEP, callback: () => Promise<T>): Promise<T>;
}

export const STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
  sensitive: "output",
} as const;

const OWNS = `EXISTS (SELECT 1 FROM documents
  WHERE tenant_id = ? AND id = ? AND extract_job = ? AND extract_status = 'extracting')`;

const superseded = () => new NonRetryableError("a newer extraction job owns this document");

/** Upper bound for one call, before it is made: ~3 characters per token (D26 measured 3.2). */
export function estimateNeurons(prompt: Prompt): number {
  const inputTokens = (prompt.system.length + prompt.user.length) / 3;
  return (inputTokens * MODEL_PRICE.input + MAX_OUTPUT_TOKENS * MODEL_PRICE.output) / 1_000_000;
}

export function actualNeurons(c: Completion, estimate: number): number {
  if (c.inputTokens === null || c.outputTokens === null) return estimate;
  return (c.inputTokens * MODEL_PRICE.input + c.outputTokens * MODEL_PRICE.output) / 1_000_000;
}

/** Workers AI chat result, validated: data from outside this Worker. */
const ChatResult = z.object({
  response: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
});

export function workersAiCompletion(ai: Ai): ExtractServices["complete"] {
  // The model ID is not in the binding's generated model list, so `run` is called untyped.
  const run = ai.run.bind(ai) as unknown as (model: string, input: unknown) => Promise<unknown>;
  return async (prompt) => {
    const raw = await run(EXTRACT_MODEL, {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const result = ChatResult.parse(raw);
    // In JSON mode some models return the object already parsed.
    const text =
      typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? "");
    return {
      text,
      inputTokens: result.usage?.prompt_tokens ?? null,
      outputTokens: result.usage?.completion_tokens ?? null,
    };
  };
}

export type ExtractOutcome =
  | { skipped: true }
  | { superseded: true }
  | { failed: "too_many_chunks" | "daily_budget" }
  | { extracted: number; chunks: number; neurons: number };

async function markExtractFailed(db: D1Database, owner: readonly string[], code: string) {
  const result = await db
    .prepare(
      `UPDATE documents SET extract_status = 'failed', extract_error = ?, extract_job = NULL
       WHERE tenant_id = ? AND id = ? AND extract_job = ? AND extract_status = 'extracting'`,
    )
    .bind(code, ...owner)
    .run();
  return result.meta.changes === 1;
}

type ChunkResult =
  { budget: true } | { budget: false; accepted: number; neurons: number; outcome: string };

export async function runExtraction(
  db: D1Database,
  services: ExtractServices,
  params: ExtractParams,
  step: StepRunner,
): Promise<ExtractOutcome> {
  const { tenantId, documentId, jobId } = params;
  const owner = [tenantId, documentId, jobId] as const;

  try {
    const loaded = await step.do("load", STEP, async () => {
      const doc = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM chunks c
                   WHERE c.tenant_id = d.tenant_id AND c.document_id = d.id) AS count
           FROM documents d
           WHERE tenant_id = ? AND id = ? AND extract_job = ? AND extract_status = 'extracting'
             AND status = 'ready'`,
        )
        .bind(...owner)
        .first<{ count: number }>();
      if (doc === null) return null;
      if (doc.count > MAX_EXTRACT_CHUNKS) return { tooMany: true as const };
      await db.batch([
        db
          .prepare(`DELETE FROM clauses WHERE tenant_id = ? AND document_id = ? AND ${OWNS}`)
          .bind(tenantId, documentId, ...owner),
        db
          .prepare(
            `DELETE FROM extraction_chunks WHERE tenant_id = ? AND document_id = ? AND ${OWNS}`,
          )
          .bind(tenantId, documentId, ...owner),
      ]);
      return { tooMany: false as const, count: doc.count };
    });
    if (loaded === null) return { skipped: true };
    if (loaded.tooMany) {
      const marked = await step.do("mark too large", STEP, () =>
        markExtractFailed(db, owner, "too_many_chunks"),
      );
      return marked ? { failed: "too_many_chunks" } : { superseded: true };
    }

    const chunkStep = (idx: number) =>
      step.do(`chunk ${String(idx)}`, STEP, async (): Promise<ChunkResult> => {
        const row = await db
          .prepare(
            `SELECT start_offset AS start, text FROM chunks
             WHERE tenant_id = ? AND document_id = ? AND idx = ? AND ${OWNS}`,
          )
          .bind(tenantId, documentId, idx, ...owner)
          .first<{ start: number; text: string }>();
        if (row === null) throw superseded();

        // Reserve the worst case before calling the model (a retry reserves again: that only
        // errs on the safe side). One conditional UPDATE: two jobs cannot both pass.
        const nonce = services.nonce();
        const estimate = estimateNeurons(buildPrompt(row.text, nonce));
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

        // Set inside the model callback (an object, so the type checker sees the change).
        const call: { completion: Completion | null } = { completion: null };
        const result = await extractClauses(
          row.text,
          async (prompt) => {
            call.completion = await services.complete(prompt);
            return call.completion.text;
          },
          { nonce },
        );
        const neurons =
          call.completion === null ? estimate : actualNeurons(call.completion, estimate);
        const outcome = result.ok ? "ok" : result.reason;
        const clauses = result.ok ? result.clauses : [];
        const rejected = result.ok ? result.rejected : {};

        // Correct the reservation, then replace this chunk's rows: all or nothing, under the
        // ticket. Offsets are stored in document coordinates.
        await db.batch([
          db
            .prepare("UPDATE neuron_budget SET neurons = max(0, neurons + ?) WHERE day = ?")
            .bind(neurons - estimate, day),
          db
            .prepare(
              `DELETE FROM clauses WHERE tenant_id = ? AND document_id = ? AND chunk_idx = ?
                 AND ${OWNS}`,
            )
            .bind(tenantId, documentId, idx, ...owner),
          ...clauses.map((c, n) =>
            db
              .prepare(
                `INSERT INTO clauses (tenant_id, document_id, chunk_idx, n, clause_type,
                   start_offset, end_offset, details)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${OWNS}`,
              )
              .bind(
                tenantId,
                documentId,
                idx,
                n,
                c.clauseType,
                row.start + c.start,
                row.start + c.end,
                JSON.stringify({
                  parties: c.parties,
                  obligations: c.obligations,
                  dates: c.dates,
                  riskFlags: c.riskFlags,
                }),
                ...owner,
              ),
          ),
          db
            .prepare(
              `INSERT OR REPLACE INTO extraction_chunks (tenant_id, document_id, chunk_idx,
                 outcome, accepted, rejected, neurons)
               SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${OWNS}`,
            )
            .bind(
              tenantId,
              documentId,
              idx,
              outcome,
              clauses.length,
              JSON.stringify(rejected),
              neurons,
              ...owner,
            ),
        ]);
        return { budget: false, accepted: clauses.length, neurons, outcome };
      });

    let extracted = 0;
    let neurons = 0;
    let outOfBudget = false;
    for (let first = 0; first < loaded.count && !outOfBudget; first += EXTRACT_PARALLEL) {
      const group = Array.from(
        { length: Math.min(EXTRACT_PARALLEL, loaded.count - first) },
        (_, k) => first + k,
      );
      // Steps of one group run in parallel (Workflows run concurrent step.do calls).
      const results = await Promise.all(group.map(chunkStep));
      for (const r of results) {
        if (r.budget) outOfBudget = true;
        else {
          extracted += r.accepted;
          neurons += r.neurons;
        }
      }
    }
    if (outOfBudget) {
      const marked = await step.do("mark budget", STEP, () =>
        markExtractFailed(db, owner, "daily_budget"),
      );
      return marked ? { failed: "daily_budget" } : { superseded: true };
    }

    await step.do("finish", STEP, async () => {
      const result = await db
        .prepare(
          `UPDATE documents SET extract_status = 'extracted', extract_job = NULL,
             extract_version = ?, extract_error = NULL
           WHERE tenant_id = ? AND id = ? AND extract_job = ? AND extract_status = 'extracting'`,
        )
        .bind(EXTRACT_VERSION, ...owner)
        .run();
      if (result.meta.changes !== 1) throw superseded();
      return true;
    });
    return { extracted, chunks: loaded.count, neurons };
  } catch (error) {
    const failed = await step.do("mark failed", STEP, () =>
      markExtractFailed(db, owner, "extraction_failed"),
    );
    if (!failed) return { superseded: true };
    throw error;
  }
}

export class ExtractDocument extends WorkflowEntrypoint<Env, ExtractParams> {
  override async run(event: Readonly<WorkflowEvent<ExtractParams>>, step: WorkflowStep) {
    const services: ExtractServices = {
      complete: workersAiCompletion(this.env.AI),
      nonce: () => crypto.randomUUID().replaceAll("-", ""),
      today: () => new Date().toISOString().slice(0, 10),
    };
    return runExtraction(this.env.DB, services, event.payload, step);
  }
}
