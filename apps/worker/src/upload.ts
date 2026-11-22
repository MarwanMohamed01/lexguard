// POST /v1/documents: file -> checks -> fingerprint -> toMarkdown -> sanitize -> D1.
//
// CPU budget (D16): this request does only light work. Hashing is the main CPU cost (about
// 2 ms per MB), which is why uploads are capped at 10 MB. Waiting for toMarkdown is I/O and
// costs no CPU. Chunking happens later, in the chunking job (step 5d).
import { sanitizeText } from "@lexguard/guardrails/sanitize";
import { sha256Hex } from "./auth";
import {
  claimForRetry,
  findBySha256,
  getDocument,
  markConverted,
  markFailed,
  reserveDocument,
  type DocumentSummary,
} from "./documents";
import { detectFileKind, MIME_TYPES } from "./filetype";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** D1 stores at most 2 MB per string or row (D14); the Markdown must fit in one row. */
export const MAX_MARKDOWN_BYTES = 2_000_000;
/** A 'converting' document untouched this long belongs to a request that died. */
export const STALE_CONVERSION_MS = 10 * 60 * 1000;

/** The conversion step, passed in so tests can replace toMarkdown (it always calls Cloudflare). */
export type Converter = (file: MarkdownDocument) => Promise<ConversionResponse>;

export interface UploadDeps {
  convert: Converter;
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

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return fail(400, "empty_file");
  if (bytes.length > MAX_UPLOAD_BYTES) return fail(413, "file_too_large");

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
    const staleBefore = new Date(now().getTime() - STALE_CONVERSION_MS).toISOString();
    const retry = await claimForRetry(
      env.DB,
      tenantId,
      existing.id,
      now().toISOString(),
      staleBefore,
    );
    // Already converted, or being converted right now by another request: nothing to redo.
    if (!retry) return Response.json({ document: existing }, { status: 200 });
    id = existing.id;
  }

  // 4. Convert, sanitize, store. Any failure is recorded on the document so the next upload
  //    of the same file retries it instead of being blocked by the duplicate check.
  const outcome = await convertAndSanitize(deps.convert, kind, bytes);
  if ("error" in outcome) {
    await markFailed(env.DB, tenantId, id, outcome.error, now().toISOString());
  } else {
    await markConverted(env.DB, tenantId, id, outcome, now().toISOString());
  }
  const document = await getDocument(env.DB, tenantId, id);
  if (document === null) return fail(409, "conflict_retry");
  return "error" in outcome
    ? fail(422, outcome.error, document)
    : Response.json({ document }, { status: 201 });
}

async function convertAndSanitize(
  convert: Converter,
  kind: "pdf" | "docx",
  bytes: Uint8Array,
): Promise<{ markdown: string; hiddenCharsRemoved: number } | { error: UploadError }> {
  let result: ConversionResponse;
  try {
    // The name tells toMarkdown the format; built from the detected kind, not the upload name.
    result = await convert({ name: `document.${kind}`, blob: new Blob([bytes]) });
  } catch (error) {
    console.error("toMarkdown threw", error instanceof Error ? error.message : error);
    return { error: "conversion_failed" };
  }
  if (result.format === "error") {
    console.error("toMarkdown error", result.error);
    return { error: "conversion_failed" };
  }

  // Sanitized once, here: every chunk offset and citation points into this stored text.
  const { text, removed } = sanitizeText(result.data);
  if (text.trim().length === 0) return { error: "no_text" }; // e.g. a scan with no text layer
  if (new TextEncoder().encode(text).length > MAX_MARKDOWN_BYTES)
    return { error: "text_too_large" };
  const hiddenCharsRemoved = Object.values(removed).reduce((sum, count) => sum + count, 0);
  return { markdown: text, hiddenCharsRemoved };
}
