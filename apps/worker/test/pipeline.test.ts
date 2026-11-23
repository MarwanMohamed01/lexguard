// The whole ingestion path in one go: upload -> real chunking Workflow -> status 'ready'.
// Only toMarkdown is faked (it always calls Cloudflare); everything else is the real code,
// in the Workers runtime, against the migrated local D1.
import { chunkDocument } from "@lexguard/chunker";
import { sanitizeText } from "@lexguard/guardrails/sanitize";
import { introspectWorkflowInstance, type WorkflowInstanceIntrospector } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { CHUNK_OPTIONS } from "../src/chunking";
import type { DocumentSummary } from "../src/documents";
import type { Converter, StartChunking } from "../src/upload";
import { contractText, makePdf } from "./files";
import { TEST_KEYS } from "./fixtures";

const converterReturning =
  (markdown: string): Converter =>
  (file) =>
    Promise.resolve({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: "application/pdf",
      format: "markdown" as const,
      tokens: 1,
      data: markdown,
    });

// Every introspector must be disposed after its test (removes mocks, frees the instance).
const opened: WorkflowInstanceIntrospector[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((instance) => instance.dispose()));
});

/** Starts the real Workflow, like index.ts does, and keeps a handle to watch each run. */
function realChunking() {
  const runs: WorkflowInstanceIntrospector[] = [];
  const start: StartChunking = async (params) => {
    const instance = await introspectWorkflowInstance(env.CHUNK_DOCUMENT, params.jobId);
    runs.push(instance);
    opened.push(instance);
    await env.CHUNK_DOCUMENT.create({ id: params.jobId, params });
  };
  return { start, runs };
}

const noChunking: StartChunking = () => Promise.resolve();

function call(method: string, path: string, init: RequestInit, deps: Parameters<typeof handle>[2]) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TEST_KEYS.acme}`);
  return handle(new Request(`http://example.com${path}`, { ...init, method, headers }), env, deps);
}

function upload(pdf: Uint8Array, convert: Converter, startChunking: StartChunking) {
  return call(
    "POST",
    "/v1/documents",
    { body: pdf, headers: { "X-Filename": "msa.pdf", "Content-Length": String(pdf.length) } },
    { convert, startChunking },
  );
}

async function getStatus(id: string) {
  const response = await call(
    "GET",
    `/v1/documents/${id}`,
    {},
    {
      convert: converterReturning(""),
      startChunking: noChunking,
    },
  );
  return (await response.json<{ document: DocumentSummary }>()).document;
}

async function stored(id: string) {
  const doc = await env.DB.prepare(
    "SELECT markdown, chunk_job FROM documents WHERE tenant_id = 'acme' AND id = ?",
  )
    .bind(id)
    .first<{ markdown: string; chunk_job: string | null }>();
  const { results: chunks } = await env.DB.prepare(
    `SELECT start_offset, end_offset, text FROM chunks
     WHERE tenant_id = 'acme' AND document_id = ? ORDER BY idx`,
  )
    .bind(id)
    .all<{ start_offset: number; end_offset: number; text: string }>();
  return { markdown: doc?.markdown ?? "", chunkJob: doc?.chunk_job ?? null, chunks };
}

describe("ingestion end to end", () => {
  it("upload -> chunking Workflow -> ready, with exact offsets into the sanitized text", async () => {
    // What a hostile or messy conversion could return: hidden characters (zero-width space,
    // right-to-left override, an invisible tag character), emoji and Windows line endings.
    const raw = contractText(30_000)
      .replaceAll("\n", "\r\n")
      .replace("1.1 Scope.", "1.1 Sco\u200Bpe.\u202E")
      .replace("2.2 Fees.", "2.2 Fees.\u{E0049}\u{E0047}");
    const clean = sanitizeText(raw).text;
    const chunking = realChunking();

    const response = await upload(makePdf(), converterReturning(raw), chunking.start);
    expect(response.status).toBe(201);
    const { document } = await response.json<{ document: DocumentSummary }>();
    expect(document.hiddenCharsRemoved).toBe(4);

    await chunking.runs[0]?.waitForStatus("complete");

    expect(await getStatus(document.id)).toMatchObject({ status: "ready", chars: clean.length });
    const { markdown, chunkJob, chunks } = await stored(document.id);
    expect(markdown).toBe(clean);
    expect(chunkJob).toBeNull();
    // Same chunks as the chunker on the stored text, and each one an exact slice of it.
    expect(chunks.map((c) => [c.start_offset, c.end_offset])).toEqual(
      chunkDocument(clean, CHUNK_OPTIONS).chunks.map((c) => [c.start, c.end]),
    );
    for (const chunk of chunks) {
      expect(chunk.text).toBe(markdown.slice(chunk.start_offset, chunk.end_offset));
    }
    // Contiguous: together the chunks are the whole text, nothing lost or repeated.
    expect(chunks.map((c) => c.text).join("")).toBe(markdown);
  });

  it("restarts a document whose chunking job vanished, and the old job can no longer write", async () => {
    const pdf = makePdf();
    // First upload: converted, handed to a job that never runs (it "died").
    const first = await upload(pdf, converterReturning(contractText(5_000)), noChunking);
    const { document } = await first.json<{ document: DocumentSummary }>();
    const oldJob = (await stored(document.id)).chunkJob;
    await env.DB.prepare("UPDATE documents SET updated_at = ? WHERE tenant_id = 'acme' AND id = ?")
      .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), document.id)
      .run();

    // Re-upload of the same file: the stuck document is reconverted under a new ticket.
    const chunking = realChunking();
    const second = await upload(pdf, converterReturning(contractText(5_000)), chunking.start);
    expect(second.status).toBe(201);
    await chunking.runs[0]?.waitForStatus("complete");
    expect(await getStatus(document.id)).toMatchObject({ status: "ready" });
    const chunksBefore = (await stored(document.id)).chunks;

    // The old job wakes up late: it holds a revoked ticket, so it changes nothing.
    expect(oldJob).not.toBeNull();
    const late = await introspectWorkflowInstance(env.CHUNK_DOCUMENT, oldJob ?? "");
    opened.push(late);
    await env.CHUNK_DOCUMENT.create({
      id: oldJob ?? "",
      params: { tenantId: "acme", documentId: document.id, jobId: oldJob ?? "" },
    });
    await late.waitForStatus("complete");
    expect(await late.getOutput()).toEqual({ skipped: true });
    expect((await stored(document.id)).chunks).toEqual(chunksBefore);
  });

  it("leaves a recently started chunking job alone on re-upload", async () => {
    const pdf = makePdf();
    await upload(pdf, converterReturning(contractText(5_000)), noChunking);
    const chunking = realChunking();

    const again = await upload(pdf, converterReturning(contractText(5_000)), chunking.start);

    expect(again.status).toBe(200);
    expect((await again.json<{ document: DocumentSummary }>()).document.status).toBe("chunking");
    expect(chunking.runs).toEqual([]);
  });
});
