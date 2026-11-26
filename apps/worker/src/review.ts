// Review endpoints (M5 step 8, D52).
//
//   POST /v1/documents/:id/review   { "rules": [{ "id": "gdpr:28(3)(a)", "policy"?: "require" |
//                                     "forbid" }, ...] }  start a review of these rules (202)
//   GET  /v1/documents/:id/report   the report, JSON (default) or ?format=markdown
//
// The request carries the scope and the policy per rule because what is good depends on the
// side the reviewer represents (D51): a discloser forbids "only technical information".
// Reviews are started on request: they spend the shared daily Neurons (T15).
import { buildReport, renderMarkdown } from "@lexguard/report";
import { getRule, ruleText } from "@lexguard/rulebook";
import {
  chunkedText,
  type Claim,
  type Problem,
  type ResolvedReference,
  type VerifiedClaim,
} from "@lexguard/verifier";
import { z } from "zod";
import { getDocument } from "./documents";
import {
  MAX_REVIEW_RULES,
  RULEBOOKS,
  REVIEW_VERSION,
  type ReviewParams,
  type Scope,
} from "./reviewing";
import { MAX_BODY_BYTES } from "./search";
import { readExactly } from "./upload";

export type StartReview = (params: ReviewParams) => Promise<void>;

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

const ReviewRequest = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: z.string().min(3).max(40),
        policy: z.enum(["require", "forbid"]).default("require"),
      }),
    )
    .min(1)
    .max(MAX_REVIEW_RULES),
});

const ruleExists = (id: string) => {
  const book = RULEBOOKS.get(id.slice(0, id.indexOf(":")));
  return book !== undefined && getRule(book, id) !== undefined;
};

export async function handleReview(
  request: Request,
  db: D1Database,
  tenantId: string,
  id: string,
  start: StartReview | undefined,
): Promise<Response> {
  // Bounded read, as for search (D30).
  const declared = request.headers.get("Content-Length");
  if (declared === null || !/^\d+$/.test(declared)) {
    return Response.json({ error: "length_required" }, { status: 411 });
  }
  const length = Number(declared);
  if (length > MAX_BODY_BYTES) return Response.json({ error: "body_too_large" }, { status: 413 });
  const bytes = await readExactly(request, length);
  if (bytes === null) return Response.json({ error: "length_mismatch" }, { status: 400 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = ReviewRequest.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const ids = parsed.data.rules.map((r) => r.id);
  const unknown = ids.filter((r) => !ruleExists(r));
  // Rule IDs are not echoed back verbatim beyond the known pattern: only valid-looking ones.
  if (unknown.length > 0) {
    return Response.json(
      {
        error: "unknown_rules",
        rules: unknown.filter((r) => /^[a-z]+:[0-9()a-z/-]{1,30}$/.test(r)),
      },
      { status: 400 },
    );
  }
  if (new Set(ids).size !== ids.length)
    return Response.json({ error: "duplicate_rules" }, { status: 400 });
  const scope: Scope = parsed.data.rules.map((r) => ({ ruleId: r.id, policy: r.policy }));

  const document = await getDocument(db, tenantId, id);
  if (document === null) return notFound();
  if (document.status !== "ready" || document.indexStatus !== "indexed") {
    return Response.json(
      { error: "not_indexed", status: document.status, indexStatus: document.indexStatus },
      { status: 409 },
    );
  }
  if (start === undefined) return Response.json({ error: "unavailable" }, { status: 503 });

  const jobId = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE documents SET review_status = 'reviewing', review_job = ?, review_scope = ?,
         review_error = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'ready' AND index_status = 'indexed'
         AND (review_status IS NULL OR review_status != 'reviewing')`,
    )
    .bind(jobId, JSON.stringify(scope), tenantId, id)
    .run();
  if (claimed.meta.changes !== 1) {
    return Response.json(
      { error: "review_running", review: await reviewState(db, tenantId, id) },
      { status: 409 },
    );
  }
  try {
    await start({ tenantId, documentId: id, jobId });
  } catch (error) {
    console.error(`review start failed: ${String(error).slice(0, 200)}`);
    await db
      .prepare(
        `UPDATE documents SET review_status = 'failed', review_error = 'review_not_started',
           review_job = NULL
         WHERE tenant_id = ? AND id = ? AND review_job = ? AND review_status = 'reviewing'`,
      )
      .bind(tenantId, id, jobId)
      .run();
    return Response.json({ error: "review_not_started" }, { status: 503 });
  }
  return Response.json({ review: await reviewState(db, tenantId, id) }, { status: 202 });
}

async function reviewState(db: D1Database, tenantId: string, id: string) {
  return db
    .prepare(
      `SELECT review_status AS status, review_version AS version, review_error AS error
       FROM documents WHERE tenant_id = ? AND id = ?`,
    )
    .bind(tenantId, id)
    .first<{ status: string | null; version: string | null; error: string | null }>();
}

const Offsets = z.object({ start: z.number().int(), end: z.number().int() });
const EvidenceList = z.array(Offsets.extend({ chunk: z.number().int() }));

interface ClaimRow {
  rule_id: string;
  outcome: string;
  verdict: "agrees" | "conflicts" | "silent" | null;
  evidence: string;
  rule_quote: string | null;
  reason: string | null;
  refs: string;
  problems: string;
  neurons: number;
}

export async function handleReport(
  db: D1Database,
  tenantId: string,
  id: string,
  url: URL,
): Promise<Response> {
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "markdown") {
    return Response.json({ error: "unknown_format" }, { status: 400 });
  }
  const doc = await db
    .prepare(
      `SELECT filename, chars, page_starts AS pageStarts, review_status AS status,
         review_version AS version, review_error AS error, review_scope AS scope
       FROM documents WHERE tenant_id = ? AND id = ?`,
    )
    .bind(tenantId, id)
    .first<{
      filename: string;
      chars: number;
      pageStarts: string | null;
      status: string | null;
      version: string | null;
      error: string | null;
      scope: string | null;
    }>();
  if (doc === null) return notFound();
  if (doc.status !== "reviewed" || doc.scope === null) {
    return Response.json(
      { error: "not_reviewed", reviewStatus: doc.status, reviewError: doc.error },
      { status: 409 },
    );
  }
  const scope = z
    .array(z.object({ ruleId: z.string(), policy: z.enum(["require", "forbid"]) }))
    .parse(JSON.parse(doc.scope));
  const { results: rows } = await db
    .prepare(
      `SELECT rule_id, outcome, verdict, evidence, rule_quote, reason, refs, problems, neurons
       FROM review_claims WHERE tenant_id = ? AND document_id = ?`,
    )
    .bind(tenantId, id)
    .all<ClaimRow>();

  // Evidence text is read from the chunks it points into (stored offsets only, 0008).
  const evidenceOf = new Map(
    rows.map((r) => [r.rule_id, EvidenceList.parse(JSON.parse(r.evidence))]),
  );
  const chunkIds = [...new Set([...evidenceOf.values()].flat().map((e) => e.chunk))];
  const { results: chunks } = await db
    .prepare(
      `SELECT idx, start_offset AS start, text FROM chunks
       WHERE tenant_id = ? AND document_id = ? AND idx IN (SELECT value FROM json_each(?))`,
    )
    .bind(tenantId, id, JSON.stringify(chunkIds))
    .all<{ idx: number; start: number; text: string }>();
  const byIdx = new Map(chunks.map((c) => [c.idx, c]));
  const textAt = (e: { chunk: number; start: number; end: number }) => {
    const c = byIdx.get(e.chunk);
    return c === undefined ? "" : c.text.slice(e.start - c.start, e.end - c.start);
  };

  const verified: VerifiedClaim[] = [];
  const rejected: { claim: Claim; problems: Problem[] }[] = [];
  let failedAnswers = 0;
  let neurons = 0;
  for (const r of rows) {
    neurons += r.neurons;
    if (r.outcome !== "verified" && r.outcome !== "rejected") {
      failedAnswers++;
      continue;
    }
    const book = RULEBOOKS.get(r.rule_id.slice(0, r.rule_id.indexOf(":")));
    const rule = book === undefined ? undefined : getRule(book, r.rule_id);
    const quote = r.rule_quote === null ? null : Offsets.parse(JSON.parse(r.rule_quote));
    const claim: Claim = {
      ruleId: r.rule_id,
      verdict: r.verdict ?? "silent",
      evidence: (evidenceOf.get(r.rule_id) ?? []).map((e) => ({
        start: e.start,
        end: e.end,
        text: textAt(e),
      })),
      ruleQuote:
        quote === null || book === undefined || rule === undefined
          ? null
          : { ...quote, text: ruleText(book, rule).slice(quote.start, quote.end) },
      reason: r.reason ?? "",
    };
    if (r.outcome === "verified") {
      verified.push({ ...claim, references: JSON.parse(r.refs) as ResolvedReference[] });
    } else {
      rejected.push({ claim, problems: JSON.parse(r.problems) as Problem[] });
    }
  }

  const pageStarts = z
    .array(z.number().int())
    .nullable()
    .catch(null)
    .parse(doc.pageStarts === null ? null : JSON.parse(doc.pageStarts));
  const report = buildReport({
    document: { id, title: doc.filename },
    // Only the length and the references' slices are read: the loaded chunks hold them.
    text: chunkedText(doc.chars, chunks),
    ...(pageStarts === null ? {} : { pageStarts }),
    rulebooks: RULEBOOKS,
    scope,
    verified,
    rejected,
    versions: { review: doc.version ?? REVIEW_VERSION },
    generatedAt: new Date().toISOString(),
  });
  if (format === "markdown") {
    return new Response(renderMarkdown(report), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return Response.json({ report, review: { failedAnswers, neurons } });
}
