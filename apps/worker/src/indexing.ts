// The indexing job (M3 step 5, D29): a Workflow that makes a ready document searchable.
//
//   load -> embed 1..N -> keywords -> searchable 1..K -> finish
//
//   load      check the ticket; reserve Vectorize space for this document's vectors in one
//             atomic UPDATE (the space guard, D25); delete vectors left over from a previous
//             index with more chunks, and the document's old keyword rows.
//   embed i   one per request-sized batch (longest chunks first, capped by padded size, D26):
//             read the chunks, embed them with bge-m3, upsert the vectors. The vectors never
//             leave the step (a step result is capped at 1 MiB); a retry embeds again.
//   keywords  copy the chunks into chunks_fts with one INSERT ... SELECT inside D1, so the
//             text does not pass through this Worker (D28).
//   searchable i / wait i
//             until the last written vector answers a query (Vectorize is asynchronous:
//             53 s in the first real run, D31), at most 30 checks 10 s apart.
//   finish    mark the document indexed with the model version and vector count.
//
// Fencing (as chunking, D20): the job works only while documents.index_job is its own ticket.
// Every D1 read and write checks it in the same statement. Vectorize cannot check a D1
// ticket, so a replaced job could still upsert a vector between its check and its write;
// such a vector only carries an older embedding of the same chunk ID, and every hit is read
// back from D1 under the caller's tenant (step 6), so it can never expose another document.
//
// Vectors: ID "<document id>:<chunk idx>" (at most 41 bytes; the limit is 64), namespace =
// tenant ID (a query in one namespace never sees another, and the namespace is applied before
// the vector search), metadata { doc, idx } so a search can stay inside one document.
//
// The steps live in runIndexing(), which takes the step runner and the services as
// parameters: the Workflow passes the real ones, tests pass a direct runner and fakes, since
// neither Workers AI nor Vectorize can run in local tests.
import {
  EMBED_BATCH,
  EMBED_MAX_PADDED_CHARS,
  embeddingBatches,
  ftsScopeMatch,
  ftsScopeToken,
} from "@lexguard/retrieval";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DIMENSIONS = 1024;
/**
 * Model + embedding input + revision, stored with every indexed document. "plain": the chunk
 * text alone, no contextual header (on the 30 converted PDFs the header did not help, D26;
 * the full-corpus eval decides). Changing the input means a new version and a re-index.
 */
export const INDEX_VERSION = "bge-m3/plain/1";
/** 5M free stored dimensions / 1,024 = 4,882 vectors for the whole account, with a margin (D25). */
export const MAX_INDEXED_VECTORS = 4_800;
/** Vector IDs per deleteByIds call (the docs give no limit; upsert allows 1,000). */
const DELETE_BATCH = 500;

export interface IndexParams {
  tenantId: string;
  documentId: string;
  /** The ticket stored in documents.index_job when this job was started; also the instance ID. */
  jobId: string;
}

export interface IndexServices {
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
  vectors: Pick<Vectorize, "upsert" | "deleteByIds" | "queryById">;
}

/**
 * Vectorize applies writes asynchronously: in the first real run, vectors became searchable
 * 53 seconds after the upserts (D31), and a search meanwhile silently found nothing on the
 * vector side. So before marking a document indexed, the job checks that its last written
 * vector answers a query (inside the tenant's namespace and this document), sleeping between
 * checks: a Workflow sleep costs no CPU and survives restarts. 30 x 10 s = 5 minutes at most.
 */
export const SEARCHABLE_CHECKS = 30;
export const SEARCHABLE_WAIT = "10 seconds";

/**
 * `wrangler types` declares a Vectorize binding as `VectorizeIndex`, which its own comment
 * calls the beta API (synchronous mutations returning ids and counts). Indexes created today
 * are the current, asynchronous API (`Vectorize`: mutations return a mutationId and apply a
 * few seconds later), so the binding is typed as that here, in one place.
 */
export const vectorIndex = (env: Env): Vectorize => env.VECTORS as unknown as Vectorize;

/** The part of WorkflowStep this job uses, so tests can pass a direct runner. */
export interface StepRunner {
  do<T>(name: string, config: typeof STEP, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: typeof SEARCHABLE_WAIT): Promise<void>;
}

export const STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
  // Step results hold no contract text, but keep them out of the dashboard all the same.
  sensitive: "output",
} as const;

export const vectorId = (documentId: string, idx: number) => `${documentId}:${String(idx)}`;

/** SQL condition: this job still holds the document's index ticket. Binds tenant, id, job. */
const OWNS = `EXISTS (SELECT 1 FROM documents
  WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing')`;

const superseded = () => new NonRetryableError("a newer indexing job owns this document");

/** Workers AI's bge-m3 result, validated: it is data from outside this Worker. */
const EmbeddingResult = z.object({
  data: z.array(z.array(z.number()).length(DIMENSIONS)),
});

export function workersAiEmbedder(ai: Ai): IndexServices["embed"] {
  return async (texts) => {
    const result: unknown = await ai.run(EMBEDDING_MODEL, { text: texts });
    const { data } = EmbeddingResult.parse(result);
    if (data.length !== texts.length) throw new Error("embedding count does not match");
    return data;
  };
}

export type IndexOutcome =
  | { skipped: true }
  | { superseded: true }
  | { failed: "index_full" }
  | { indexed: number; batches: number };

/** Marks the index failed, only if this job still owns it. Returns whether it did. */
async function markIndexFailed(db: D1Database, owner: readonly string[], code: string) {
  const result = await db
    .prepare(
      `UPDATE documents SET index_status = 'failed', index_error = ?, index_job = NULL
       WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing'`,
    )
    .bind(code, ...owner)
    .run();
  return result.meta.changes === 1;
}

export async function runIndexing(
  db: D1Database,
  services: IndexServices,
  params: IndexParams,
  step: StepRunner,
): Promise<IndexOutcome> {
  const { tenantId, documentId, jobId } = params;
  const owner = [tenantId, documentId, jobId] as const;
  const scope = ftsScopeMatch({ tenant: ftsScopeToken(tenantId), doc: ftsScopeToken(documentId) });

  try {
    const loaded = await step.do("load", STEP, async () => {
      const doc = await db
        .prepare(
          `SELECT indexed_chunks AS previous,
             (SELECT COUNT(*) FROM chunks c WHERE c.tenant_id = d.tenant_id AND c.document_id = d.id)
               AS count
           FROM documents d
           WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing'
             AND status = 'ready'`,
        )
        .bind(...owner)
        .first<{ previous: number; count: number }>();
      // Deleted, re-uploaded, or handed to a newer job: nothing to do, and not an error.
      if (doc === null) return null;

      // Space guard (D25), atomic: the reservation succeeds only if all other documents'
      // vectors plus this one's fit. Keeps the larger of old and new count until finish, so
      // the old vector IDs stay accounted for until they are deleted.
      const reserve = Math.max(doc.previous, doc.count);
      const reserved = await db
        .prepare(
          `UPDATE documents SET indexed_chunks = ?
           WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing'
             AND (SELECT COALESCE(SUM(indexed_chunks), 0) FROM documents
                  WHERE NOT (tenant_id = ? AND id = ?)) + ? <= ?`,
        )
        .bind(reserve, ...owner, tenantId, documentId, reserve, MAX_INDEXED_VECTORS)
        .run();
      if (reserved.meta.changes !== 1) {
        // Either the ticket was revoked meanwhile or the space is full: tell them apart.
        // "Full" is returned, not thrown: an error's class does not survive a step boundary.
        const stillOwned = await db
          .prepare(`SELECT 1 AS owned WHERE ${OWNS}`)
          .bind(...owner)
          .first();
        if (stillOwned === null) throw superseded();
        return { full: true as const };
      }

      // Vectors of a previous index beyond the new chunk count (Vectorize deletes by ID only).
      const surplus: string[] = [];
      for (let idx = doc.count; idx < doc.previous; idx++) surplus.push(vectorId(documentId, idx));
      for (let i = 0; i < surplus.length; i += DELETE_BATCH) {
        await services.vectors.deleteByIds(surplus.slice(i, i + DELETE_BATCH));
      }
      await db
        .prepare(`DELETE FROM chunks_fts WHERE chunks_fts MATCH ? AND ${OWNS}`)
        .bind(scope, ...owner)
        .run();

      // Lengths only (SQLite counts code points, close enough to plan batch sizes).
      const { results } = await db
        .prepare(
          `SELECT length(text) AS chars FROM chunks
           WHERE tenant_id = ? AND document_id = ? AND ${OWNS} ORDER BY idx`,
        )
        .bind(tenantId, documentId, ...owner)
        .all<{ chars: number }>();
      if (results.length !== doc.count) throw superseded();
      return {
        full: false as const,
        count: doc.count,
        batches: embeddingBatches(
          results.map((r) => r.chars),
          EMBED_BATCH,
          EMBED_MAX_PADDED_CHARS,
        ),
      };
    });
    if (loaded === null) return { skipped: true };
    if (loaded.full) {
      const marked = await step.do("mark full", STEP, () =>
        markIndexFailed(db, owner, "index_full"),
      );
      return marked ? { failed: "index_full" } : { superseded: true };
    }

    for (const [i, batch] of loaded.batches.entries()) {
      await step.do(`embed ${String(i + 1)}`, STEP, async () => {
        const { results } = await db
          .prepare(
            `SELECT idx, text FROM chunks
             WHERE tenant_id = ? AND document_id = ?
               AND idx IN (SELECT value FROM json_each(?)) AND ${OWNS}
             ORDER BY idx`,
          )
          .bind(tenantId, documentId, JSON.stringify(batch), ...owner)
          .all<{ idx: number; text: string }>();
        if (results.length !== batch.length) throw superseded();

        const vectors = await services.embed(results.map((r) => r.text));
        if (vectors.length !== results.length) throw new Error("embedding count does not match");
        await services.vectors.upsert(
          results.map((row, k) => ({
            id: vectorId(documentId, row.idx),
            values: vectors[k] ?? [],
            namespace: tenantId,
            metadata: { doc: documentId, idx: row.idx },
          })),
        );
        return results.length;
      });
    }

    await step.do("keywords", STEP, async () => {
      // Delete-then-insert in one batch (one transaction), so a retry never duplicates rows.
      // Not checked through meta.changes: FTS5 counts its shadow tables there (D28); the
      // finish step's ticket check catches a job that lost its ticket.
      await db.batch([
        db
          .prepare(`DELETE FROM chunks_fts WHERE chunks_fts MATCH ? AND ${OWNS}`)
          .bind(scope, ...owner),
        db
          .prepare(
            `INSERT INTO chunks_fts (text, tenant, doc, idx)
             SELECT text, ?, ?, idx FROM chunks
             WHERE tenant_id = ? AND document_id = ? AND ${OWNS}`,
          )
          .bind(ftsScopeToken(tenantId), ftsScopeToken(documentId), tenantId, documentId, ...owner),
      ]);
      return true;
    });

    // Wait until the vectors answer queries (Vectorize applies writes in order, so the last
    // batch's vector being searchable means all of them are).
    const lastBatch = loaded.batches.at(-1);
    let searchable = lastBatch === undefined;
    if (lastBatch?.[0] !== undefined) {
      const probe = vectorId(documentId, lastBatch[0]);
      for (let attempt = 1; !searchable && attempt <= SEARCHABLE_CHECKS; attempt++) {
        searchable = await step.do(`searchable ${String(attempt)}`, STEP, async () => {
          try {
            const { matches } = await services.vectors.queryById(probe, {
              topK: 1,
              namespace: tenantId,
              filter: { doc: documentId },
              returnValues: false,
              returnMetadata: "none",
            });
            return matches.length > 0;
          } catch (error) {
            // A vector not yet stored may make queryById fail: just "not yet".
            console.error(`searchable check failed: ${String(error).slice(0, 200)}`);
            return false;
          }
        });
        if (!searchable) await step.sleep(`wait ${String(attempt)}`, SEARCHABLE_WAIT);
      }
    }

    await step.do("finish", STEP, async () => {
      // Not confirmed after 5 minutes: indexed anyway (keyword search works, and the vectors
      // will arrive), but the delay is recorded rather than hidden.
      const result = await db
        .prepare(
          `UPDATE documents SET index_status = 'indexed', index_job = NULL, index_version = ?,
             indexed_chunks = ?, index_error = ?
           WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing'`,
        )
        .bind(INDEX_VERSION, loaded.count, searchable ? null : "vectors_not_confirmed", ...owner)
        .run();
      if (result.meta.changes !== 1) throw superseded();
      return true;
    });

    return { indexed: loaded.count, batches: loaded.batches.length };
  } catch (error) {
    // Failed for good: mark the index failed, but only if this job still owns it.
    const failed = await step.do("mark failed", STEP, () =>
      markIndexFailed(db, owner, "indexing_failed"),
    );
    if (!failed) return { superseded: true };
    throw error;
  }
}

export class IndexDocument extends WorkflowEntrypoint<Env, IndexParams> {
  override async run(event: Readonly<WorkflowEvent<IndexParams>>, step: WorkflowStep) {
    const services: IndexServices = {
      embed: workersAiEmbedder(this.env.AI),
      vectors: vectorIndex(this.env),
    };
    return runIndexing(this.env.DB, services, event.payload, step);
  }
}
