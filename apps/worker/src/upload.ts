// POST /v1/documents: file -> checks -> fingerprint -> toMarkdown -> sanitize -> D1.
//
// CPU budget (D16): this request does only light work. Hashing is the main CPU cost (about
// 2 ms per MB), which is why uploads are capped at 10 MB. Waiting for toMarkdown is I/O and
// costs no CPU. Chunking happens later, in the chunking job (src/chunking.ts).
import { sanitizeText } from "@lexguard/guardrails/sanitize";
import { sha256Hex } from "./auth";
import type { ChunkParams } from "./chunking";
import {
  claimForIndexing,
  claimForRetry,
  findBySha256,
  getDocument,
  markConverted,
  markFailed,
  markIndexNotStarted,
  reserveDocument,
  type ConvertedText,
  type DocumentSummary,
} from "./documents";
import { extractPages } from "./pages";
import { detectFileKind, MIME_TYPES } from "./filetype";
import type { IndexParams } from "./indexing";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** D1 stores at most 2 MB per string or row (D14); the Markdown must fit in one row. */
export const MAX_MARKDOWN_BYTES = 2_000_000;
/** A 'converting' document untouched this long belongs to a request that died. */
export const STALE_CONVERSION_MS = 10 * 60 * 1000;
/**
 * A 'chunking' document untouched this long lost its job (a real job takes seconds, a few
 * minutes with retries). Safe to restart because a restart revokes the old job's ticket.
 */
export const STALE_CHUNKING_MS = 60 * 60 * 1000;

/**
 * Asked of toMarkdown for every upload. No PDF metadata (not contract text; can leak the
 * author or software). No image conversion: it would spend Workers AI neurons, and a model's
 * description of an image would enter the stored text as if the contract said it, which an
 * attacker could exploit with a planted image.
 */
export const CONVERSION_OPTIONS = {
  conversionOptions: {
    pdf: { metadata: false, images: { convert: false } },
    docx: { images: { convert: false } },
  },
} satisfies ConversionRequestOptions;

/** The conversion step, passed in so tests can replace toMarkdown (it always calls Cloudflare). */
export type Converter = (file: MarkdownDocument) => Promise<ConversionResponse>;

/** Starts the chunking job; passed in so upload tests do not run it. */
export type StartChunking = (params: ChunkParams) => Promise<void>;

/** Starts the indexing job (src/indexing.ts) for a re-uploaded, not yet indexed document. */
export type StartIndexing = (params: IndexParams) => Promise<void>;

export interface UploadDeps {
  convert: Converter;
  startChunking: StartChunking;
  /** Optional so tests of other paths need not pass it; production always does (index.ts). */
  startIndexing?: StartIndexing;
  now?: () => Date;
  /** Overrides DAILY_UPLOADS_PER_TENANT (app.ts), for tests. */
  uploadsPerDay?: number;
}

type UploadError =
  | "length_required"
  | "file_too_large"
  | "empty_file"
  | "length_mismatch"
  | "invalid_filename"
  | "unsupported_file_type"
  | "conversion_failed"
  | "no_text"
  | "text_too_large"
  | "chunking_not_started"
  | "conflict_retry";

const fail = (status: number, error: UploadError, document?: DocumentSummary) =>
  Response.json(document === undefined ? { error } : { error, document }, { status });

/**
 * The display name from the X-Filename header (percent-encoded so any language fits in an
 * HTTP header). Kept only for display: the stored type comes from the bytes, never the name.
 */
export function parseFilename(header: string | null): string | null {
  if (header === null) return null;
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    return null;
  }
  name = sanitizeText(name.split(/[\\/]/).pop() ?? "").text.trim();
  return name.length > 0 && name.length <= 255 ? name : null;
}

export async function handleUpload(
  request: Request,
  env: Env,
  tenantId: string,
  deps: UploadDeps,
): Promise<Response> {
  const now = deps.now ?? (() => new Date());

  // 1. Size first, from the header, before reading a single byte of the body.
  const declared = request.headers.get("Content-Length");
  if (declared === null || !/^\d+$/.test(declared)) return fail(411, "length_required");
  if (Number(declared) > MAX_UPLOAD_BYTES) return fail(413, "file_too_large");

  const filename = parseFilename(request.headers.get("X-Filename"));
  if (filename === null) return fail(400, "invalid_filename");

  const length = Number(declared);
  if (length === 0) return fail(400, "empty_file");
  // The header can lie (the runtime does not enforce it), so the body must be exactly the
  // declared length, itself at most 10 MB: never more than that in memory.
  const bytes = await readExactly(request, length);
  if (bytes === null) return fail(400, "length_mismatch");

  // 2. What the file really is, from its bytes.
  const kind = detectFileKind(bytes);
  if (kind === null) return fail(415, "unsupported_file_type");

  // 3. Fingerprint, then reserve the document (or find this tenant's copy of the same file).
  const sha256 = await sha256Hex(bytes);
  let id: string = crypto.randomUUID();
  const created = await reserveDocument(
    env.DB,
    tenantId,
    { id, sha256, filename, mimeType: MIME_TYPES[kind], sizeBytes: bytes.length },
    now().toISOString(),
  );
  if (!created) {
    const existing = await findBySha256(env.DB, tenantId, sha256);
    if (existing === null) return fail(409, "conflict_retry"); // deleted in between
    const ago = (ms: number) => new Date(now().getTime() - ms).toISOString();
    const retry = await claimForRetry(env.DB, tenantId, existing.id, now().toISOString(), {
      converting: ago(STALE_CONVERSION_MS),
      chunking: ago(STALE_CHUNKING_MS),
    });
    if (!retry) {
      // Ready but never indexed (uploaded before M3) or its index failed: re-uploading the
      // file starts indexing, under a new ticket claimed atomically (D32).
      const indexed = await indexIfMissing(env.DB, tenantId, existing, deps.startIndexing);
      // Otherwise already done, or in progress right now: nothing to redo.
      return Response.json({ document: indexed }, { status: 200 });
    }
    id = existing.id;
  }

  // 4. Convert, sanitize, store. Any failure is recorded on the document so the next upload
  //    of the same file retries it instead of being blocked by the duplicate check.
  const converted = await convertAndSanitize(deps.convert, kind, bytes);
  let error: UploadError | null = "error" in converted ? converted.error : null;
  if (!("error" in converted)) {
    // 5. Hand over to a chunking job (src/chunking.ts) with a fresh ticket: only the job
    //    holding it may write this document's chunks. If it cannot start, fail the document
    //    rather than leave it in 'chunking' with nobody working on it.
    const jobId = crypto.randomUUID();
    await markConverted(env.DB, tenantId, id, converted, jobId, now().toISOString());
    try {
      await deps.startChunking({ tenantId, documentId: id, jobId });
    } catch (cause) {
      logError("chunking job not started", cause);
      error = "chunking_not_started";
    }
  }
  if (error !== null) await markFailed(env.DB, tenantId, id, error, now().toISOString());

  const document = await getDocument(env.DB, tenantId, id);
  if (document === null) return fail(409, "conflict_retry");
  return error === null
    ? Response.json({ document }, { status: 201 })
    : fail(error === "chunking_not_started" ? 503 : 422, error, document);
}

/**
 * Starts the indexing job for a ready document whose index is missing or failed, if this
 * call wins the claim. Returns the document as it is afterwards.
 */
async function indexIfMissing(
  db: D1Database,
  tenantId: string,
  existing: DocumentSummary,
  startIndexing: StartIndexing | undefined,
): Promise<DocumentSummary> {
  if (startIndexing === undefined || existing.status !== "ready") return existing;
  if (existing.indexStatus !== null && existing.indexStatus !== "failed") return existing;
  const jobId = crypto.randomUUID();
  if (!(await claimForIndexing(db, tenantId, existing.id, jobId))) return existing;
  try {
    // The ticket doubles as the instance ID, as for the chunking job.
    await startIndexing({ tenantId, documentId: existing.id, jobId });
  } catch (cause) {
    logError("indexing job not started", cause);
    await markIndexNotStarted(db, tenantId, existing.id, jobId);
  }
  return (await getDocument(db, tenantId, existing.id)) ?? existing;
}

/**
 * Logs an upstream failure for Workers Logs (threat T13). Only the message of an Error or a
 * string, cut at 200 characters: never document text, keys or a raw object that might echo
 * its input.
 */
function logError(event: string, detail: unknown): void {
  const message =
    detail instanceof Error
      ? detail.message
      : typeof detail === "string"
        ? detail
        : "(non-error value)";
  console.error(event, message.slice(0, 200));
}

/**
 * The request body if it is exactly `length` bytes, else null. Uses the runtime's native
 * FixedLengthStream, which errors as soon as the body runs past `length` (so no more than
 * `length` bytes are ever buffered) or ends short of it. Measured (D24): the JavaScript loop
 * this replaces cost 5 ms of CPU on a 1.56 MB upload; native reading costs about 0.
 */
export async function readExactly(request: Request, length: number): Promise<Uint8Array | null> {
  if (request.body === null) return null;
  const { readable, writable } = new FixedLengthStream(length);
  try {
    const [bytes] = await Promise.all([
      new Response(readable).arrayBuffer(),
      request.body.pipeTo(writable),
    ]);
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

async function convertAndSanitize(
  convert: Converter,
  kind: "pdf" | "docx",
  bytes: Uint8Array,
): Promise<ConvertedText | { error: UploadError }> {
  let result: ConversionResponse;
  try {
    // Name and MIME type tell toMarkdown the format; both come from the detected kind, never
    // from the client. toMarkdown rejects a Blob without a type (found in step 6).
    const blob = new Blob([bytes], { type: MIME_TYPES[kind] });
    result = await convert({ name: `document.${kind}`, blob });
  } catch (error) {
    logError("toMarkdown threw", error);
    return { error: "conversion_failed" };
  }
  if (result.format === "error") {
    logError("toMarkdown error", result.error);
    return { error: "conversion_failed" };
  }

  // Sanitized once, here, then the converter's page markers become a page map (pages.ts):
  // every chunk offset and citation points into this stored text.
  const { text: clean, removed } = sanitizeText(result.data);
  const { text, pageStarts } = extractPages(clean);
  // After removing the wrapper, so a scan with no text layer (wrapper only) counts as empty.
  if (text.trim().length === 0) return { error: "no_text" };
  if (new TextEncoder().encode(text).length > MAX_MARKDOWN_BYTES)
    return { error: "text_too_large" };
  const hiddenCharsRemoved = Object.values(removed).reduce((sum, count) => sum + count, 0);
  return { markdown: text, hiddenCharsRemoved, pageStarts };
}
