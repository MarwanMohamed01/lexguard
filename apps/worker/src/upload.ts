// POST /v1/documents: file -> checks -> fingerprint -> toMarkdown -> sanitize -> D1.
//
// CPU budget (D16): this request does only light work. Hashing is the main CPU cost (about
// 2 ms per MB), which is why uploads are capped at 10 MB. Waiting for toMarkdown is I/O and
// costs no CPU. Chunking happens later, in the chunking job (src/chunking.ts).
import { sanitizeText } from "@lexguard/guardrails/sanitize";
import { sha256Hex } from "./auth";
import type { ChunkParams } from "./chunking";
import {
  claimForRetry,
  findBySha256,
  getDocument,
  markConverted,
  markFailed,
  reserveDocument,
  type ConvertedText,
  type DocumentSummary,
} from "./documents";
import { extractPages } from "./pages";
import { detectFileKind, MIME_TYPES } from "./filetype";

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

export interface UploadDeps {
  convert: Converter;
  startChunking: StartChunking;
  now?: () => Date;
}

type UploadError =
  | "length_required"
  | "file_too_large"
  | "empty_file"
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

  // The header can lie (the runtime does not enforce it), so the body is read as a stream
  // and reading stops as soon as it passes the cap: never more than 10 MB in memory.
  const bytes = await readCapped(request, MAX_UPLOAD_BYTES);
  if (bytes === null) return fail(413, "file_too_large");
  if (bytes.length === 0) return fail(400, "empty_file");

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
    // Already done, or in progress right now (converting or chunking): nothing to redo.
    if (!retry) return Response.json({ document: existing }, { status: 200 });
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
      console.error("chunking job not started", cause instanceof Error ? cause.message : cause);
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

/** The request body, or null as soon as it grows past `max` bytes. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  // A request body is always bytes; the runtime types its stream items loosely (any).
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
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
    console.error("toMarkdown threw", error instanceof Error ? error.message : error);
    return { error: "conversion_failed" };
  }
  if (result.format === "error") {
    console.error("toMarkdown error", result.error);
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
