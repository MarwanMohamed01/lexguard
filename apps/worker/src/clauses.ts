// Extraction endpoints (M4 step 5, D37).
//
//   POST /v1/documents/:id/extract   start the extraction job (202), or report that it runs or
//                                     is done with this version (200)
//   GET  /v1/documents/:id/clauses   the stored clauses, each with its exact quote and page
//
// Extraction is started on request, not after every upload: it spends the shared daily
// Neurons (T15), so only a tenant who asks pays for it.
import { CLAUSE_TYPE_NAMES } from "@lexguard/extraction";
import { claimForExtraction, getDocument, markExtractNotStarted } from "./documents";
import { EXTRACT_VERSION, type ExtractParams } from "./extraction";
import { pageOf, UNTRUSTED_NOTE } from "./search";

export type StartExtraction = (params: ExtractParams) => Promise<void>;

/** Clauses returned per request; the response says when there are more. */
export const MAX_CLAUSES_RETURNED = 1_000;

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

export async function handleExtract(
  db: D1Database,
  tenantId: string,
  id: string,
  start: StartExtraction | undefined,
): Promise<Response> {
  const document = await getDocument(db, tenantId, id);
  if (document === null) return notFound();
  if (document.status !== "ready") {
    return Response.json({ error: "not_ready", document }, { status: 409 });
  }
  if (start === undefined) return Response.json({ error: "unavailable" }, { status: 503 });

  const jobId = crypto.randomUUID();
  if (!(await claimForExtraction(db, tenantId, id, jobId, EXTRACT_VERSION))) {
    // Running already, or done with this version: nothing new to start.
    return Response.json({ document: await getDocument(db, tenantId, id) });
  }
  try {
    await start({ tenantId, documentId: id, jobId });
  } catch (error) {
    console.error(`extraction start failed: ${String(error).slice(0, 200)}`);
    await markExtractNotStarted(db, tenantId, id, jobId);
    return Response.json(
      { error: "extraction_not_started", document: await getDocument(db, tenantId, id) },
      { status: 503 },
    );
  }
  return Response.json({ document: await getDocument(db, tenantId, id) }, { status: 202 });
}

export interface ClauseResult {
  type: string;
  quote: string;
  start: number;
  end: number;
  page: number | null;
  chunk: number;
  parties: string[];
  obligations: { party: string; action: string }[];
  dates: string[];
  riskFlags: string[];
}

const KNOWN_TYPES = new Set<string>(CLAUSE_TYPE_NAMES);

export async function handleClauses(
  db: D1Database,
  tenantId: string,
  id: string,
  url: URL,
): Promise<Response> {
  const type = url.searchParams.get("type");
  if (type !== null && !KNOWN_TYPES.has(type)) {
    return Response.json({ error: "unknown_clause_type" }, { status: 400 });
  }
  const doc = await db
    .prepare(
      `SELECT extract_status AS status, extract_version AS version, extract_error AS error,
         page_starts AS pageStarts
       FROM documents WHERE tenant_id = ? AND id = ?`,
    )
    .bind(tenantId, id)
    .first<{
      status: string | null;
      version: string | null;
      error: string | null;
      pageStarts: string | null;
    }>();
  if (doc === null) return notFound();
  if (doc.status !== "extracted") {
    return Response.json(
      { error: "not_extracted", extractStatus: doc.status, extractError: doc.error },
      { status: 409 },
    );
  }

  const { results: rows } = await db
    .prepare(
      `SELECT chunk_idx AS chunk, clause_type AS type, start_offset AS start,
         end_offset AS end, details
       FROM clauses WHERE tenant_id = ? AND document_id = ? AND (? IS NULL OR clause_type = ?)
       ORDER BY start_offset, chunk_idx, n LIMIT ?`,
    )
    .bind(tenantId, id, type, type, MAX_CLAUSES_RETURNED + 1)
    .all<{ chunk: number; type: string; start: number; end: number; details: string }>();
  const truncated = rows.length > MAX_CLAUSES_RETURNED;
  const kept = rows.slice(0, MAX_CLAUSES_RETURNED);

  // Quotes come from the stored chunks (offsets are UTF-16 units: sliced in JavaScript, not
  // with SQLite's substr, which counts characters), read once per chunk.
  const chunkIds = [...new Set(kept.map((r) => r.chunk))];
  const { results: chunks } = await db
    .prepare(
      `SELECT idx, start_offset AS start, text FROM chunks
       WHERE tenant_id = ? AND document_id = ? AND idx IN (SELECT value FROM json_each(?))`,
    )
    .bind(tenantId, id, JSON.stringify(chunkIds))
    .all<{ idx: number; start: number; text: string }>();
  const byIdx = new Map(chunks.map((c) => [c.idx, c]));
  const pageStarts = doc.pageStarts === null ? null : (JSON.parse(doc.pageStarts) as number[]);

  const clauses: ClauseResult[] = [];
  for (const row of kept) {
    const chunk = byIdx.get(row.chunk);
    // A chunk re-made since extraction no longer matches: skip rather than show wrong text.
    if (chunk === undefined) continue;
    const from = row.start - chunk.start;
    const to = row.end - chunk.start;
    if (from < 0 || to > chunk.text.length) continue;
    const details = JSON.parse(row.details) as Pick<
      ClauseResult,
      "parties" | "obligations" | "dates" | "riskFlags"
    >;
    clauses.push({
      type: row.type,
      quote: chunk.text.slice(from, to),
      start: row.start,
      end: row.end,
      page: pageOf(pageStarts, row.start),
      chunk: row.chunk,
      ...details,
    });
  }
  return Response.json({
    extractVersion: doc.version,
    clauses,
    truncated,
    note: UNTRUSTED_NOTE,
  });
}
