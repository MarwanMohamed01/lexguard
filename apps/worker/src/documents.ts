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
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
}

const SUMMARY_COLUMNS = `id, filename, mime_type AS mimeType, size_bytes AS sizeBytes, sha256, status,
  chars, hidden_chars_removed AS hiddenCharsRemoved, error, created_at AS createdAt,
  updated_at AS updatedAt`;

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

/**
 * Takes over a document for another conversion attempt: allowed when the last attempt failed,
 * or when it has sat in 'converting' since before `staleBefore` (its request died). Returns
 * true when this call won; a single UPDATE makes the check-and-claim atomic.
 */
export async function claimForRetry(
  db: D1Database,
  tenantId: string,
  id: string,
  now: string,
  staleBefore: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE documents SET status = 'converting', error = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ?
         AND (status = 'failed'
              OR (status = 'converting' AND COALESCE(updated_at, created_at) < ?))`,
    )
    .bind(now, tenantId, id, staleBefore)
    .run();
  return result.meta.changes === 1;
}

export interface ConvertedText {
  markdown: string;
  hiddenCharsRemoved: number;
}

/** Stores the sanitized text and hands the document to the chunking job (step 5d). */
export async function markConverted(
  db: D1Database,
  tenantId: string,
  id: string,
  text: ConvertedText,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE documents SET status = 'chunking', markdown = ?, chars = ?, hidden_chars_removed = ?,
         error = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(text.markdown, text.markdown.length, text.hiddenCharsRemoved, now, tenantId, id)
    .run();
}

export async function markFailed(
  db: D1Database,
  tenantId: string,
  id: string,
  error: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE documents SET status = 'failed', error = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    )
    .bind(error, now, tenantId, id)
    .run();
}
