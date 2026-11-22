// The chunking job (M2 step 5d): a Workflow that turns a converted document's text into
// chunks and definitions in D1, then marks it 'ready'.
//
// Why a Workflow (D17): each step is its own invocation with its own 10 ms CPU budget on
// the Free plan, results are saved, and a failed step is retried alone. Detection (~90% of
// chunking CPU) runs in windows of WINDOW_CHARS, one step each; planning and storing follow.
//
// Steps for one document (a 1M-char document takes about 15 of the 1,024 allowed):
//   load -> detect 1..N -> plan -> store chunks 1..M -> store definitions 1..K -> finish
//
// Every step re-reads the text from D1 and cuts it in JavaScript: SQLite's substr() counts
// code points, JavaScript counts UTF-16 units, so SQL slicing would shift offsets after any
// emoji or rare symbol.
import { planChunks, planWindows, detectWindow, type Detections } from "@lexguard/chunker";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { markFailed } from "./documents";

export interface ChunkParams {
  tenantId: string;
  documentId: string;
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
    const { tenantId, documentId } = event.payload;
    const db = this.env.DB;
    const text = () => loadMarkdown(db, tenantId, documentId);

    try {
      const loaded = await step.do("load", STEP, async () => {
        const doc = await db
          .prepare("SELECT status, markdown FROM documents WHERE tenant_id = ? AND id = ?")
          .bind(tenantId, documentId)
          .first<{ status: string; markdown: string | null }>();
        // Deleted, re-uploaded or already done: nothing to do, and not an error.
        if (doc?.status !== "chunking" || doc.markdown === null) return null;
        // A re-run (retry after failure) starts clean.
        await db.batch([
          db
            .prepare("DELETE FROM chunks WHERE tenant_id = ? AND document_id = ?")
            .bind(tenantId, documentId),
          db
            .prepare("DELETE FROM definitions WHERE tenant_id = ? AND document_id = ?")
            .bind(tenantId, documentId),
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
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
              ),
          );
          await db.batch(batch);
          return batch.length;
        });
      }

      for (let from = 0; from < plan.definitions.length; from += STORE_BATCH) {
        await step.do(`store definitions ${String(from / STORE_BATCH + 1)}`, STEP, async () => {
          const batch = plan.definitions.slice(from, from + STORE_BATCH).map((definition, i) =>
            db
              .prepare(
                `INSERT OR REPLACE INTO definitions (tenant_id, document_id, idx, term, start_offset)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .bind(tenantId, documentId, from + i, definition.term, definition.start),
          );
          await db.batch(batch);
          return batch.length;
        });
      }

      await step.do("finish", STEP, async () => {
        await db
          .prepare(
            `UPDATE documents SET status = 'ready', updated_at = ?
             WHERE tenant_id = ? AND id = ? AND status = 'chunking'`,
          )
          .bind(new Date().toISOString(), tenantId, documentId)
          .run();
        return true;
      });

      return { chunks: plan.chunks.length, definitions: plan.definitions.length };
    } catch (error) {
      // A step failed after all its retries: record it on the document, so the tenant sees
      // 'failed' (not 'chunking' forever) and a re-upload of the file retries it.
      await step.do("mark failed", STEP, async () => {
        await markFailed(db, tenantId, documentId, "chunking_failed", new Date().toISOString());
        return true;
      });
      throw error;
    }
  }
}

async function loadMarkdown(db: D1Database, tenantId: string, id: string): Promise<string> {
  const row = await db
    .prepare("SELECT markdown FROM documents WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id)
    .first<{ markdown: string | null }>();
  if (row?.markdown == null) throw new Error("document text is gone");
  return row.markdown;
}
