// The chunking job (M2 step 5d): a Workflow that turns a converted document's text into
// chunks and definitions in D1, then marks it 'ready'.
//
// Why a Workflow (D17): each step is its own invocation with its own 10 ms CPU budget on
// the Free plan, results are saved, and a failed step is retried alone. Detection (~90% of
// chunking CPU) runs in windows of WINDOW_CHARS, one step each; planning and storing follow.
//
// Steps for one document (a 1M-char document takes about 15 of the 1,024 allowed):
//   load -> detect 1..N -> plan -> store chunks 1..M -> store definitions 1..K -> finish
//   -> start indexing (src/indexing.ts, D29)
//
// Fencing (D20): the job only works while the document's chunk_job is its own jobId. Every
// read checks it and every write is conditional on it, inside the same SQL statement, so a
// job that was replaced (the document was re-uploaded after this job looked dead) can no
// longer change anything, even if it wakes up mid-step.
//
// Every step re-reads the text from D1 and cuts it in JavaScript: SQLite's substr() counts
// code points, JavaScript counts UTF-16 units, so SQL slicing would shift offsets after any
// emoji or rare symbol.
import { planChunks, planWindows, detectWindow, type Detections } from "@lexguard/chunker";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { markFailed } from "./documents";
import type { IndexParams } from "./indexing";

export interface ChunkParams {
  tenantId: string;
  documentId: string;
  /** The ticket stored in documents.chunk_job when this job was started; also the instance ID. */
  jobId: string;
}

/** Same limits as the CUAD eval (D15). */
export const CHUNK_OPTIONS = { targetChars: 2_000, maxChars: 4_000 } as const;
/** ~200k chars of detection is about 5 ms warm on Workers (measured in Node, scaled per D16). */
export const WINDOW_CHARS = 200_000;
/** Rows per D1 batch: one batch counts as one query against the 50-per-invocation limit. */
export const STORE_BATCH = 100;

// "sensitive: output" keeps step results (headings, terms: contract text) out of the
// Cloudflare dashboard and logs.
const STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "1 minute",
  sensitive: "output",
} as const;

/** SQL condition: this job still holds the document's ticket. Binds tenant, document, job. */
const OWNS = `EXISTS (SELECT 1 FROM documents
  WHERE tenant_id = ? AND id = ? AND chunk_job = ? AND status = 'chunking')`;

interface PlannedChunk {
  start: number;
  end: number;
  sectionPath: string[];
  heading: string | null;
}

interface PlannedDefinition {
  term: string;
  start: number;
}

export class ChunkDocument extends WorkflowEntrypoint<Env, ChunkParams> {
  override async run(event: Readonly<WorkflowEvent<ChunkParams>>, step: WorkflowStep) {
    const { tenantId, documentId, jobId } = event.payload;
    const db = this.env.DB;
    const owner = [tenantId, documentId, jobId] as const;
    const text = () => loadOwnedMarkdown(db, tenantId, documentId, jobId);

    try {
      const loaded = await step.do("load", STEP, async () => {
        const doc = await db
          .prepare(
            `SELECT markdown FROM documents
             WHERE tenant_id = ? AND id = ? AND chunk_job = ? AND status = 'chunking'`,
          )
          .bind(...owner)
          .first<{ markdown: string | null }>();
        // Deleted, done, or handed to a newer job: nothing to do, and not an error.
        if (doc?.markdown == null) return null;
        // A re-run starts clean. Conditional too: the ticket may be revoked meanwhile.
        await db.batch([
          db
            .prepare(`DELETE FROM chunks WHERE tenant_id = ? AND document_id = ? AND ${OWNS}`)
            .bind(tenantId, documentId, ...owner),
          db
            .prepare(`DELETE FROM definitions WHERE tenant_id = ? AND document_id = ? AND ${OWNS}`)
            .bind(tenantId, documentId, ...owner),
        ]);
        return { windows: planWindows(doc.markdown, WINDOW_CHARS) };
      });
      if (loaded === null) return { skipped: true };

      const detections: Detections[] = [];
      for (const [i, window] of loaded.windows.entries()) {
        const found = await step.do(`detect ${String(i + 1)}`, STEP, async () =>
          detectWindow(await text(), window),
        );
        detections.push(found);
      }

      const plan = await step.do("plan", STEP, async () => {
        const result = planChunks(await text(), detections, CHUNK_OPTIONS);
        // Offsets only: the text is cut again when storing, so results stay small.
        const chunks: PlannedChunk[] = result.chunks.map((c) => ({
          start: c.start,
          end: c.end,
          sectionPath: c.sectionPath,
          heading: c.heading,
        }));
        const definitions: PlannedDefinition[] = result.definitions;
        return { chunks, definitions };
      });

      for (let from = 0; from < plan.chunks.length; from += STORE_BATCH) {
        await step.do(`store chunks ${String(from / STORE_BATCH + 1)}`, STEP, async () => {
          const markdown = await text();
          const batch = plan.chunks.slice(from, from + STORE_BATCH).map((chunk, i) =>
            db
              .prepare(
                `INSERT OR REPLACE INTO chunks
                   (tenant_id, document_id, idx, start_offset, end_offset, text, section_path, heading)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${OWNS}`,
              )
              .bind(
                tenantId,
                documentId,
                from + i,
                chunk.start,
                chunk.end,
                markdown.slice(chunk.start, chunk.end),
                JSON.stringify(chunk.sectionPath),
                chunk.heading,
                ...owner,
              ),
          );
          return written(await db.batch(batch), batch.length);
        });
      }

      for (let from = 0; from < plan.definitions.length; from += STORE_BATCH) {
        await step.do(`store definitions ${String(from / STORE_BATCH + 1)}`, STEP, async () => {
          const batch = plan.definitions.slice(from, from + STORE_BATCH).map((definition, i) =>
            db
              .prepare(
                `INSERT OR REPLACE INTO definitions (tenant_id, document_id, idx, term, start_offset)
                 SELECT ?, ?, ?, ?, ? WHERE ${OWNS}`,
              )
              .bind(tenantId, documentId, from + i, definition.term, definition.start, ...owner),
          );
          return written(await db.batch(batch), batch.length);
        });
      }

      // Ready, and handed to an indexing job in the same UPDATE: the new index ticket is
      // created inside the step, so a replayed step reuses the same one (D29).
      const indexJob = await step.do("finish", STEP, async () => {
        const ticket = crypto.randomUUID();
        const result = await db
          .prepare(
            `UPDATE documents SET status = 'ready', chunk_job = NULL, updated_at = ?,
               index_status = 'indexing', index_job = ?, index_error = NULL
             WHERE tenant_id = ? AND id = ? AND chunk_job = ? AND status = 'chunking'`,
          )
          .bind(new Date().toISOString(), ticket, ...owner)
          .run();
        if (result.meta.changes !== 1) throw superseded();
        return ticket;
      });

      // Never throws: the chunks are stored and the document is ready whatever happens here.
      // If the indexing job cannot be started, only the index is marked failed.
      await this.startIndexing(step, { tenantId, documentId, jobId: indexJob });
      return { chunks: plan.chunks.length, definitions: plan.definitions.length };
    } catch (error) {
      // A step failed for good. Mark the document failed, but only if this job still owns it:
      // a replaced job must not fail a document a newer job is working on.
      const failed = await step.do("mark failed", STEP, () =>
        markFailed(db, tenantId, documentId, "chunking_failed", new Date().toISOString(), jobId),
      );
      if (!failed) return { superseded: true };
      throw error;
    }
  }

  private async startIndexing(step: WorkflowStep, params: IndexParams): Promise<void> {
    try {
      await step.do("start indexing", STEP, async () => {
        try {
          // The index ticket doubles as the instance ID: one instance per ticket.
          await this.env.INDEX_DOCUMENT.create({ id: params.jobId, params });
        } catch (error) {
          // A retried step whose first attempt did create the instance: that is success.
          await this.env.INDEX_DOCUMENT.get(params.jobId).catch(() => {
            throw error;
          });
        }
        return true;
      });
    } catch {
      await step.do("indexing not started", STEP, async () => {
        await this.env.DB.prepare(
          `UPDATE documents SET index_status = 'failed', index_error = 'indexing_not_started',
             index_job = NULL
           WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing'`,
        )
          .bind(params.tenantId, params.documentId, params.jobId)
          .run();
        return true;
      });
    }
  }
}

function superseded(): NonRetryableError {
  return new NonRetryableError("a newer chunking job owns this document");
}

/** Every row written, or the ticket was revoked mid-batch: stop without retrying. */
function written(results: D1Result[], expected: number): number {
  const rows = results.reduce((sum, r) => sum + r.meta.changes, 0);
  if (rows < expected) throw superseded();
  return rows;
}

async function loadOwnedMarkdown(
  db: D1Database,
  tenantId: string,
  id: string,
  jobId: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT markdown FROM documents
       WHERE tenant_id = ? AND id = ? AND chunk_job = ? AND status = 'chunking'`,
    )
    .bind(tenantId, id, jobId)
    .first<{ markdown: string | null }>();
  if (row?.markdown == null) throw superseded();
  return row.markdown;
}
