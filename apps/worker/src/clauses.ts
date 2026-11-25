// Extraction endpoints (M4 step 5, D37).
//
//   POST /v1/documents/:id/extract   start the extraction job (202), or report that it runs or
//                                     is done with this version (200)
//   GET  /v1/documents/:id/clauses   the stored clauses, each with its exact quote and page
//
// Extraction is started on request, not after every upload: it spends the shared daily
// Neurons (T15), so only a tenant who asks pays for it.
import {
  CLAUSE_TYPE_NAMES,
  mergeClauses,
  termMatcher,
  type ClausePiece,
  type MergedClause,
} from "@lexguard/extraction";
import { definitionSpan } from "@lexguard/chunker";
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

  // merged=true: document-level clauses (M4 step 6, D39), computed on read from every stored
  // piece; otherwise the stored per-chunk clauses as they are.
  const merged = url.searchParams.get("merged") === "true";
  const { results: rows } = await db
    .prepare(
      `SELECT chunk_idx AS chunk, clause_type AS type, start_offset AS start,
         end_offset AS end, details
       FROM clauses WHERE tenant_id = ? AND document_id = ? AND (? IS NULL OR clause_type = ?)
       ORDER BY start_offset, chunk_idx, n LIMIT ?`,
    )
    .bind(tenantId, id, type, type, merged ? MAX_PIECES : MAX_CLAUSES_RETURNED + 1)
    .all<{ chunk: number; type: string; start: number; end: number; details: string }>();

  // Quotes come from the stored chunks (offsets are UTF-16 units: sliced in JavaScript, not
  // with SQLite's substr, which counts characters), read once per chunk.
  const chunkIds = [...new Set(rows.map((r) => r.chunk))];
  const { results: chunks } = await db
    .prepare(
      `SELECT idx, start_offset AS start, text FROM chunks
       WHERE tenant_id = ? AND document_id = ? AND idx IN (SELECT value FROM json_each(?))
       ORDER BY start_offset`,
    )
    .bind(tenantId, id, JSON.stringify(chunkIds))
    .all<{ idx: number; start: number; text: string }>();
  const textOf = documentText(chunks);
  const pageStarts = doc.pageStarts === null ? null : (JSON.parse(doc.pageStarts) as number[]);
  const pieces: ClausePiece[] = rows.map((row) => ({
    type: row.type,
    start: row.start,
    end: row.end,
    chunk: row.chunk,
    ...(JSON.parse(row.details) as Pick<
      ClausePiece,
      "parties" | "obligations" | "dates" | "riskFlags"
    >),
  }));

  if (!merged) {
    const clauses: ClauseResult[] = [];
    for (const p of pieces.slice(0, MAX_CLAUSES_RETURNED)) {
      const quote = textOf(p.start, p.end);
      // A chunk re-made since extraction no longer matches: skip rather than show wrong text.
      if (quote === null) continue;
      clauses.push({
        type: p.type,
        quote,
        start: p.start,
        end: p.end,
        page: pageOf(pageStarts, p.start),
        chunk: p.chunk,
        parties: [...p.parties],
        obligations: [...p.obligations],
        dates: [...p.dates],
        riskFlags: [...p.riskFlags],
      });
    }
    const definitions = await definitionsFor(db, tenantId, id, clauses, pageStarts);
    return Response.json({
      extractVersion: doc.version,
      clauses: clauses.map((c, i) => ({ ...c, definitions: definitions[i] ?? [] })),
      truncated: pieces.length > MAX_CLAUSES_RETURNED,
      note: UNTRUSTED_NOTE,
    });
  }

  const whitespaceGap = (from: number, to: number) => {
    const gap = textOf(from, to);
    return gap !== null && /^\s*$/u.test(gap);
  };
  const all = mergeClauses(pieces, whitespaceGap);
  const clauses: MergedResult[] = [];
  for (const m of all.slice(0, MAX_CLAUSES_RETURNED)) {
    const quote = textOf(m.start, m.end);
    if (quote === null) continue;
    clauses.push({ ...m, quote, page: pageOf(pageStarts, m.start) });
  }
  const definitions = await definitionsFor(db, tenantId, id, clauses, pageStarts);
  return Response.json({
    extractVersion: doc.version,
    merged: true,
    clauses: clauses.map((c, i) => ({ ...c, definitions: definitions[i] ?? [] })),
    truncated: all.length > MAX_CLAUSES_RETURNED,
    note: UNTRUSTED_NOTE,
  });
}

/** Every stored piece of a document: 400 chunks x 20 clauses at most (D37). */
const MAX_PIECES = 8_000;

export type MergedResult = MergedClause & { quote: string; page: number | null };

/**
 * Text of the document between two offsets, from chunk rows sorted by start. Null when the
 * loaded chunks do not cover the whole range without a gap (then no quote is shown).
 */
export function documentText(
  chunks: readonly { start: number; text: string }[],
): (from: number, to: number) => string | null {
  return (from, to) => {
    if (!(to >= from)) return null;
    let out = "";
    let at = from;
    for (const c of chunks) {
      if (at === to) break;
      const end = c.start + c.text.length;
      if (end <= at) continue; // entirely before the range
      if (c.start > at) return null; // a gap the loaded chunks do not cover
      const stop = Math.min(to, end);
      out += c.text.slice(at - c.start, stop - c.start);
      at = stop;
    }
    return at === to ? out : null;
  };
}

/** Definitions attached to one clause at most (the most-used terms come first in the text). */
export const MAX_DEFINITIONS_PER_CLAUSE = 10;

export interface AttachedDefinition {
  term: string;
  quote: string;
  start: number;
  end: number;
  page: number | null;
}

/**
 * Cross-references (M4 step 7, D40): for each clause, the defined terms its quote uses, each
 * with its definition quoted from the document (definitionSpan, cut at the chunk holding the
 * definition) and its page. The first definition of a term in the document is used; a clause
 * that contains the definition itself does not get it repeated.
 */
export async function definitionsFor(
  db: D1Database,
  tenantId: string,
  id: string,
  clauses: readonly { quote: string; start: number; end: number }[],
  pageStarts: readonly number[] | null,
): Promise<AttachedDefinition[][]> {
  if (clauses.length === 0) return [];
  const { results: rows } = await db
    .prepare(
      `SELECT term, start_offset AS start FROM definitions
       WHERE tenant_id = ? AND document_id = ? ORDER BY start_offset`,
    )
    .bind(tenantId, id)
    .all<{ term: string; start: number }>();
  const first = new Map<string, number>();
  for (const r of rows) if (!first.has(r.term)) first.set(r.term, r.start);
  const find = termMatcher([...first.keys()]);
  const used = clauses.map((c) => find(c.quote).slice(0, MAX_DEFINITIONS_PER_CLAUSE));

  // The chunks holding the definitions that are needed, read once each.
  const starts = [...new Set(used.flat().map((t) => first.get(t) ?? -1))].filter((s) => s >= 0);
  if (starts.length === 0) return clauses.map(() => []);
  const { results: chunks } = await db
    .prepare(
      `SELECT start_offset AS start, end_offset AS end, text FROM chunks
       WHERE tenant_id = ? AND document_id = ?
         AND EXISTS (SELECT 1 FROM json_each(?) j
                     WHERE j.value >= chunks.start_offset AND j.value < chunks.end_offset)`,
    )
    .bind(tenantId, id, JSON.stringify(starts))
    .all<{ start: number; end: number; text: string }>();

  const spans = new Map<number, AttachedDefinition | null>();
  const spanAt = (term: string, at: number): AttachedDefinition | null => {
    const chunk = chunks.find((c) => c.start <= at && at < c.end);
    if (chunk === undefined) return null;
    const span = definitionSpan(chunk.text, at - chunk.start);
    if (span === null) return null;
    return {
      term,
      quote: chunk.text.slice(span.start, span.end),
      start: chunk.start + span.start,
      end: chunk.start + span.end,
      page: pageOf(pageStarts, chunk.start + span.start),
    };
  };

  return clauses.map((clause, i) =>
    (used[i] ?? []).flatMap((term) => {
      const at = first.get(term);
      if (at === undefined || (at >= clause.start && at < clause.end)) return [];
      if (!spans.has(at)) spans.set(at, spanAt(term, at));
      const d = spans.get(at);
      return d === null || d === undefined ? [] : [{ ...d, term }];
    }),
  );
}
