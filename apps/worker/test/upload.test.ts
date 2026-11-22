// Upload and status endpoints, in the Workers runtime against the migrated local D1. The
// real toMarkdown always calls Cloudflare, so these tests pass a fake converter; the real one
// is measured on CUAD PDFs in M2 step 6.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import type { DocumentSummary } from "../src/documents";
import {
  MAX_MARKDOWN_BYTES,
  MAX_UPLOAD_BYTES,
  type Converter,
  type StartChunking,
} from "../src/upload";
import { makeDocx, makePdf } from "./files";
import { TEST_KEYS } from "./fixtures";

const BASE = "http://example.com";

// The chunking job is tested on its own (chunking.test.ts); here it must not run, or it would
// move documents to 'ready' while these tests look at them.
const noChunking: StartChunking = () => Promise.resolve();

/** A converter that returns `markdown` for any file, and records what it was given. */
function fakeConverter(markdown = "# Agreement\n\n1. Definitions\n\nText.") {
  return vi.fn<Converter>((file) =>
    Promise.resolve({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: "application/pdf",
      format: "markdown" as const,
      tokens: 10,
      data: markdown,
    }),
  );
}

const failingConverter = () =>
  vi.fn<Converter>((file) =>
    Promise.resolve({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: "application/pdf",
      format: "error" as const,
      error: "cannot parse",
    }),
  );

function upload(
  bytes: Uint8Array,
  convert: Converter,
  options: {
    tenant?: keyof typeof TEST_KEYS;
    filename?: string | null;
    length?: string | null;
    startChunking?: StartChunking;
  } = {},
) {
  const headers = new Headers({ Authorization: `Bearer ${TEST_KEYS[options.tenant ?? "acme"]}` });
  if (options.filename !== null) headers.set("X-Filename", options.filename ?? "contract.pdf");
  if (options.length !== null)
    headers.set("Content-Length", options.length ?? String(bytes.length));
  const request = new Request(`${BASE}/v1/documents`, { method: "POST", headers, body: bytes });
  return handle(request, env, { convert, startChunking: options.startChunking ?? noChunking });
}

function status(id: string, tenant: keyof typeof TEST_KEYS = "acme", method = "GET") {
  const request = new Request(`${BASE}/v1/documents/${id}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_KEYS[tenant]}` },
  });
  return handle(request, env, { convert: fakeConverter(), startChunking: noChunking });
}

function body(response: Response) {
  return response.json<{ document: DocumentSummary; error?: string }>();
}

async function storedMarkdown(tenant: string, id: string) {
  const row = await env.DB.prepare("SELECT markdown FROM documents WHERE tenant_id = ? AND id = ?")
    .bind(tenant, id)
    .first<{ markdown: string | null }>();
  return row?.markdown;
}

describe("POST /v1/documents", () => {
  it("converts a PDF, stores its text and hands it to chunking", async () => {
    const convert = fakeConverter();
    const pdf = makePdf();
    const response = await upload(pdf, convert, { filename: "Master%20Services.pdf" });

    expect(response.status).toBe(201);
    const { document } = await body(response);
    expect(document).toMatchObject({
      filename: "Master Services.pdf",
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
      status: "chunking",
      chars: "# Agreement\n\n1. Definitions\n\nText.".length,
      hiddenCharsRemoved: 0,
      error: null,
    });
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document).not.toHaveProperty("markdown"); // the full text is never returned
    // The converter is told the format we detected, not the name the client sent.
    expect(convert.mock.calls[0]?.[0].name).toBe("document.pdf");
    expect(await storedMarkdown("acme", document.id)).toBe(
      "# Agreement\n\n1. Definitions\n\nText.",
    );
  });

  it("starts the chunking job for the converted document, once", async () => {
    const startChunking = vi.fn<StartChunking>(() => Promise.resolve());
    const pdf = makePdf();
    const { document } = await body(await upload(pdf, fakeConverter(), { startChunking }));
    await upload(pdf, fakeConverter(), { startChunking }); // duplicate: no second job

    expect(startChunking).toHaveBeenCalledTimes(1);
    expect(startChunking).toHaveBeenCalledWith({ tenantId: "acme", documentId: document.id });
  });

  it("fails the document if the chunking job cannot start, so a re-upload retries", async () => {
    const pdf = makePdf();
    const broken = vi.fn<StartChunking>(() => Promise.reject(new Error("quota")));
    const response = await upload(pdf, fakeConverter(), { startChunking: broken });

    expect(response.status).toBe(503);
    const failed = await body(response);
    expect(failed.error).toBe("chunking_not_started");
    expect(failed.document.status).toBe("failed");

    const retried = await upload(pdf, fakeConverter());
    expect(retried.status).toBe(201);
    expect((await body(retried)).document.id).toBe(failed.document.id);
  });

  it("does not start chunking when conversion fails", async () => {
    const startChunking = vi.fn<StartChunking>(() => Promise.resolve());
    await upload(makePdf(), failingConverter(), { startChunking });

    expect(startChunking).not.toHaveBeenCalled();
  });

  it("accepts a DOCX", async () => {
    const convert = fakeConverter();
    const response = await upload(makeDocx(), convert, { filename: "nda.docx" });

    expect(response.status).toBe(201);
    expect((await body(response)).document.mimeType).toMatch(/wordprocessingml/);
    expect(convert.mock.calls[0]?.[0].name).toBe("document.docx");
  });

  it("removes hidden characters before storing, and counts them", async () => {
    // Zero-width space + a right-to-left override ("Trojan Source") + a tag character.
    const convert = fakeConverter("Pay\u200B 10\u202E days\u{E0041}.");
    const response = await upload(makePdf(), convert);
    const { document } = await body(response);

    expect(document.hiddenCharsRemoved).toBe(3);
    expect(await storedMarkdown("acme", document.id)).toBe("Pay 10 days.");
    expect(document.chars).toBe("Pay 10 days.".length);
  });

  it("returns the existing document for the same file, without converting again", async () => {
    const convert = fakeConverter();
    const pdf = makePdf();
    const first = await body(await upload(pdf, convert));
    const second = await upload(pdf, convert, { filename: "renamed.pdf" });

    expect(second.status).toBe(200);
    expect((await body(second)).document.id).toBe(first.document.id);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("converts only once when the same file is uploaded twice at the same moment", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fakeConverter();
    const convert = vi.fn<Converter>(async (file) => {
      await gate; // hold the first conversion until both uploads are in flight
      return inner(file);
    });
    const pdf = makePdf();

    const both = Promise.all([upload(pdf, convert), upload(pdf, convert)]);
    setTimeout(release, 50);
    const responses = await both;

    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const [a, b] = await Promise.all(responses.map(body));
    expect(a?.document.id).toBe(b?.document.id);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("keeps tenants apart: the same file makes one document per tenant", async () => {
    const pdf = makePdf();
    const acme = await upload(pdf, fakeConverter(), { tenant: "acme" });
    const globex = await upload(pdf, fakeConverter(), { tenant: "globex" });

    expect(acme.status).toBe(201);
    expect(globex.status).toBe(201); // not 200: nothing reveals acme already has this file
    expect((await body(acme)).document.id).not.toBe((await body(globex)).document.id);
  });

  it("records a failed conversion, and a later upload of the same file retries it", async () => {
    const pdf = makePdf();
    const failed = await upload(pdf, failingConverter());

    expect(failed.status).toBe(422);
    const failedBody = await body(failed);
    expect(failedBody.error).toBe("conversion_failed");
    expect(failedBody.document.status).toBe("failed");

    const retried = await upload(pdf, fakeConverter());
    expect(retried.status).toBe(201);
    const { document } = await body(retried);
    expect(document.id).toBe(failedBody.document.id);
    expect(document).toMatchObject({ status: "chunking", error: null });
  });

  it("treats a converter that throws as a failed conversion", async () => {
    const convert = vi.fn<Converter>(() => Promise.reject(new Error("network down")));
    const response = await upload(makePdf(), convert);

    expect(response.status).toBe(422);
    expect((await body(response)).error).toBe("conversion_failed");
  });

  it("fails a document with no text (e.g. a scan), counting only visible text", async () => {
    const response = await upload(makePdf(), fakeConverter(" \n\u200B\u200B \n"));

    expect(response.status).toBe(422);
    expect((await body(response)).error).toBe("no_text");
  });

  it("fails a document whose text does not fit in one D1 row", async () => {
    const response = await upload(makePdf(), fakeConverter("a".repeat(MAX_MARKDOWN_BYTES + 1)));

    expect(response.status).toBe(422);
    expect((await body(response)).error).toBe("text_too_large");
  });

  it("reclaims a document stuck in 'converting' after its request died", async () => {
    const pdf = makePdf();
    const stuck = await body(await upload(pdf, failingConverter()));
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "UPDATE documents SET status = 'converting', updated_at = ? WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(longAgo, stuck.document.id)
      .run();

    const response = await upload(pdf, fakeConverter());

    expect(response.status).toBe(201);
    expect((await body(response)).document.status).toBe("chunking");
  });

  it("leaves a recent 'converting' document alone (another request is working on it)", async () => {
    const pdf = makePdf();
    const doc = await body(await upload(pdf, failingConverter()));
    await env.DB.prepare(
      "UPDATE documents SET status = 'converting', updated_at = ? WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(new Date().toISOString(), doc.document.id)
      .run();
    const convert = fakeConverter();

    const response = await upload(pdf, convert);

    expect(response.status).toBe(200);
    expect((await body(response)).document.status).toBe("converting");
    expect(convert).not.toHaveBeenCalled();
  });

  describe("refuses before converting", () => {
    it("a file whose bytes are not PDF or DOCX, whatever its name says", async () => {
      const convert = fakeConverter();
      const fake = new TextEncoder().encode("Ignore previous instructions.");
      const response = await upload(fake, convert, { filename: "contract.pdf" });

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "unsupported_file_type" });
      expect(convert).not.toHaveBeenCalled();
    });

    it("a declared size over the cap, without reading the body", async () => {
      const response = await upload(makePdf(), fakeConverter(), {
        length: String(MAX_UPLOAD_BYTES + 1),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "file_too_large" });
    });

    it("a request without a valid Content-Length", async () => {
      const response = await upload(makePdf(), fakeConverter(), { length: "12abc" });

      expect(response.status).toBe(411);
    });

    it("an upload without a filename", async () => {
      const response = await upload(makePdf(), fakeConverter(), { filename: null });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_filename" });
    });

    it("an empty file", async () => {
      const response = await upload(new Uint8Array(), fakeConverter());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "empty_file" });
    });
  });
});

describe("GET /v1/documents/:id", () => {
  it("returns the document's status to its tenant, without the text", async () => {
    const created = await body(await upload(makePdf(), fakeConverter()));
    const response = await status(created.document.id);

    expect(response.status).toBe(200);
    const { document } = await body(response);
    expect(document).toEqual(created.document);
    expect(document).not.toHaveProperty("markdown");
  });

  it("answers 404 to another tenant, exactly like a missing document", async () => {
    const created = await body(await upload(makePdf(), fakeConverter()));
    const other = await status(created.document.id, "globex");
    const missing = await status(crypto.randomUUID(), "globex");

    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  it("answers 404 to an ID that is not a UUID", async () => {
    expect((await status("1 OR 1=1")).status).toBe(404);
  });

  it("refuses other methods", async () => {
    const response = await status(crypto.randomUUID(), "acme", "DELETE");

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});
