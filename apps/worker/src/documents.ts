// All D1 access to the documents table. Every function takes the tenant first and every
// query filters on it, through the (tenant_id, ...) primary key or unique index, so a
// lookup reads one row instead of scanning (D1 bills rows scanned, D17).

export type DocumentStatus = "converting" | "chunking" | "ready" | "failed";

/** What a tenant may see about a document: everything except the full text. */
export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  chars: number | null;
  hiddenCharsRemoved: number | null;
  /** Number of PDF pages, when the page map is known. */
  pages: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  /** Search index (D29): null until chunking hands the document over. */
  indexStatus: IndexStatus | null;
  indexVersion: string | null;
  indexError: string | null;
  /** Clause extraction (D37): null until someone asks for it. */
  extractStatus: ExtractStatus | null;
  extractVersion: string | null;
  extractError: string | null;
}

export type IndexStatus = "indexing" | "indexed" | "failed";
export type ExtractStatus = "extracting" | "extracted" | "failed";

const SUMMARY_COLUMNS = `id, filename, mime_type AS mimeType, size_bytes AS sizeBytes, sha256, status,
  chars, hidden_chars_removed AS hiddenCharsRemoved, error, created_at AS createdAt,
  updated_at AS updatedAt, json_array_length(page_starts) AS pages,
  index_status AS indexStatus, index_version AS indexVersion, index_error AS indexError,
  extract_status AS extractStatus, extract_version AS extractVersion, extract_error AS extractError`;

export interface NewDocument {
  id: string;
  sha256: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Inserts a document in 'converting' state, unless this tenant already has the same file.
 * Returns true when this call created it. Two uploads of the same file racing each other
 * cannot both win: the UNIQUE (tenant_id, sha256) constraint lets exactly one insert through.
 */
export async function reserveDocument(
  db: D1Database,
  tenantId: string,
  doc: NewDocument,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'converting', ?)
       ON CONFLICT (tenant_id, sha256) DO NOTHING`,
    )
    .bind(tenantId, doc.id, doc.sha256, doc.filename, doc.mimeType, doc.sizeBytes, now)
    .run();
  return result.meta.changes === 1;
}

export function findBySha256(
  db: D1Database,
  tenantId: string,
  sha256: string,
): Promise<DocumentSummary | null> {
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM documents WHERE tenant_id = ? AND sha256 = ?`)
    .bind(tenantId, sha256)
    .first<DocumentSummary>();
}

export function getDocument(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<DocumentSummary | null> {
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM documents WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id)
    .first<DocumentSummary>();
}

/** Before these times, a document still 'converting' or 'chunking' is considered stuck. */
export interface StaleBefore {
  converting: string;
  chunking: string;
}

/**
 * Takes over a document for another conversion attempt. Allowed when the last attempt failed,
 * or when the document has not moved since before the stale time of its state: a
 * 'converting' request died, or a chunking job died without managing to mark it failed.
 * Clearing chunk_job revokes the old job's ticket at once, so even if it is only slow, none
 * of its later writes land (chunking.ts checks the ticket on every write). Returns true when
 * this call won; a single UPDATE makes the check-and-claim atomic.
 */
export async function claimForRetry(
  db: D1Database,
  tenantId: string,
  id: string,
  now: string,
  staleBefore: StaleBefore,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE documents SET status = 'converting', error = NULL, chunk_job = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ?
         AND (status = 'failed'
              OR (status = 'converting' AND COALESCE(updated_at, created_at) < ?)
              OR (status = 'chunking' AND COALESCE(updated_at, created_at) < ?))`,
    )
    .bind(now, tenantId, id, staleBefore.converting, staleBefore.chunking)
    .run();
  return result.meta.changes === 1;
}

export interface ConvertedText {
  markdown: string;
  hiddenCharsRemoved: number;
  /** Offset of each PDF page in `markdown` (src/pages.ts), or null when unknown. */
  pageStarts: number[] | null;
}

/**
 * Stores the sanitized text and hands the document to a chunking job, identified by
 * `chunkJob`: from now on only that job may write the document's chunks.
 */
export async function markConverted(
  db: D1Database,
  tenantId: string,
  id: string,
  text: ConvertedText,
  chunkJob: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE documents SET status = 'chunking', markdown = ?, chars = ?, hidden_chars_removed = ?,
         page_starts = ?,
         error = NULL, chunk_job = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(
      text.markdown,
      text.markdown.length,
      text.hiddenCharsRemoved,
      text.pageStarts === null ? null : JSON.stringify(text.pageStarts),
      chunkJob,
      now,
      tenantId,
      id,
    )
    .run();
}

/**
 * Marks a document failed. With `chunkJob`, only if that job still owns it (a replaced job
 * must not fail a document another job is working on). Returns whether it changed anything.
 */
export async function markFailed(
  db: D1Database,
  tenantId: string,
  id: string,
  error: string,
  now: string,
  chunkJob?: string,
): Promise<boolean> {
  const fenced = chunkJob === undefined ? "" : " AND chunk_job = ?";
  const params: (string | number)[] = [error, now, tenantId, id];
  if (chunkJob !== undefined) params.push(chunkJob);
  const result = await db
    .prepare(
      `UPDATE documents SET status = 'failed', error = ?, chunk_job = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ?${fenced}`,
    )
    .bind(...params)
    .run();
  return result.meta.changes === 1;
}

/**
 * Hands a ready document whose search index is missing (documents from before M3) or failed
 * to a new indexing job, identified by `indexJob` (fencing ticket, D29). A single UPDATE, so
 * two re-uploads racing each other cannot both start a job. Returns true when this call won.
 */
export async function claimForIndexing(
  db: D1Database,
  tenantId: string,
  id: string,
  indexJob: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE documents SET index_status = 'indexing', index_job = ?, index_error = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'ready'
         AND (index_status IS NULL OR index_status = 'failed')`,
    )
    .bind(indexJob, tenantId, id)
    .run();
  return result.meta.changes === 1;
}

/** Marks the index failed, only if `indexJob` still owns it. */
export async function markIndexNotStarted(
  db: D1Database,
  tenantId: string,
  id: string,
  indexJob: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE documents SET index_status = 'failed', index_error = 'indexing_not_started',
         index_job = NULL
       WHERE tenant_id = ? AND id = ? AND index_job = ? AND index_status = 'indexing'`,
    )
    .bind(tenantId, id, indexJob)
    .run();
}

/**
 * Hands a ready document to a new extraction job (ticket `extractJob`, fencing as D29).
 * Allowed when never extracted, failed, or extracted with another model/prompt version; never
 * while a job is running. One UPDATE, so two requests cannot both start a job.
 */
export async function claimForExtraction(
  db: D1Database,
  tenantId: string,
  id: string,
  extractJob: string,
  version: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE documents SET extract_status = 'extracting', extract_job = ?, extract_error = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'ready'
         AND (extract_status IS NULL OR extract_status = 'failed'
              OR (extract_status = 'extracted' AND extract_version IS NOT ?))`,
    )
    .bind(extractJob, tenantId, id, version)
    .run();
  return result.meta.changes === 1;
}

/** Marks extraction failed, only if `extractJob` still owns it. */
export async function markExtractNotStarted(
  db: D1Database,
  tenantId: string,
  id: string,
  extractJob: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE documents SET extract_status = 'failed', extract_error = 'extraction_not_started',
         extract_job = NULL
       WHERE tenant_id = ? AND id = ? AND extract_job = ? AND extract_status = 'extracting'`,
    )
    .bind(tenantId, id, extractJob)
    .run();
}

/**
 * Documents this tenant created since `since` (ISO time). Reads the tenant's rows through
 * the primary key prefix (no extra index, which would cost a write per row, D17).
 */
export async function countCreatedSince(
  db: D1Database,
  tenantId: string,
  since: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND created_at >= ?")
    .bind(tenantId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
