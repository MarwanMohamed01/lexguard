// The chunking Workflow, run for real in the local Workers runtime against the migrated D1.
import { chunkDocument } from "@lexguard/chunker";
import { introspectWorkflowInstance, type WorkflowInstanceIntrospector } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CHUNK_OPTIONS, WINDOW_CHARS, type ChunkParams } from "../src/chunking";
import { contractText } from "./files";

/** A converted document waiting for chunking, owned by job `jobId` (its ticket). */
async function insertConverted(
  tenantId: string,
  markdown: string,
  options: { status?: string; jobId?: string } = {},
) {
  const id = crypto.randomUUID();
  const jobId = options.jobId ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status,
       markdown, chars, hidden_chars_removed, chunk_job, created_at)
     VALUES (?, ?, ?, 'c.pdf', 'application/pdf', 1, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      tenantId,
      id,
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      options.status ?? "chunking",
      markdown,
      markdown.length,
      jobId,
      new Date().toISOString(),
    )
    .run();
  return { id, jobId };
}

type Modifier = Parameters<Parameters<WorkflowInstanceIntrospector["modify"]>[0]>[0];

/**
 * Starts the job like upload does (ticket = instance ID), with retries but no delays. The
 * hand-over to indexing is replaced unless `realHandOver`: these tests are about chunking,
 * and the indexing job needs Workers AI (the full hand-over runs in pipeline.test.ts).
 */
async function run(
  params: ChunkParams,
  modify?: (m: Modifier) => Promise<void>,
  realHandOver = false,
) {
  const instance = await introspectWorkflowInstance(env.CHUNK_DOCUMENT, params.jobId);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
    if (!realHandOver) await m.mockStepResult({ name: "start indexing" }, true);
    await modify?.(m);
  });
  await env.CHUNK_DOCUMENT.create({ id: params.jobId, params });
  return instance;
}

async function documentRow(tenantId: string, id: string) {
  return env.DB.prepare("SELECT status, error FROM documents WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, id)
    .first<{ status: string; error: string | null }>();
}

interface ChunkRow {
  idx: number;
  start_offset: number;
  end_offset: number;
  text: string;
  section_path: string;
  heading: string | null;
}

async function storedChunks(tenantId: string, id: string) {
  const { results } = await env.DB.prepare(
    `SELECT idx, start_offset, end_offset, text, section_path, heading FROM chunks
     WHERE tenant_id = ? AND document_id = ? ORDER BY idx`,
  )
    .bind(tenantId, id)
    .all<ChunkRow>();
  return results;
}

describe("ChunkDocument workflow", () => {
  it("chunks a multi-window document exactly like one pass, and marks it ready", async () => {
    const markdown = contractText(WINDOW_CHARS * 2 + 50_000); // 3 detection windows
    const { id, jobId } = await insertConverted("acme", markdown);
    await using instance = await run({ tenantId: "acme", documentId: id, jobId });

    await instance.waitForStatus("complete");
    await expect(instance.waitForStepResult({ name: "detect 3" })).resolves.toBeDefined();

    const expected = chunkDocument(markdown, CHUNK_OPTIONS);
    const chunks = await storedChunks("acme", id);
    expect(await instance.getOutput()).toEqual({
      chunks: expected.chunks.length,
      definitions: expected.definitions.length,
    });
    expect(chunks.length).toBe(expected.chunks.length);
    expect(chunks.length).toBeGreaterThan(100); // several store steps
    chunks.forEach((row, i) => {
      const chunk = expected.chunks[i];
      expect(row).toEqual({
        idx: i,
        start_offset: chunk?.start,
        end_offset: chunk?.end,
        text: chunk?.text,
        section_path: JSON.stringify(chunk?.sectionPath),
        heading: chunk?.heading,
      });
      // The rule every citation relies on, checked on what is actually stored.
      expect(row.text).toBe(markdown.slice(row.start_offset, row.end_offset));
    });

    const { results: definitions } = await env.DB.prepare(
      `SELECT term, start_offset AS start FROM definitions
       WHERE tenant_id = ? AND document_id = ? ORDER BY idx`,
    )
      .bind("acme", id)
      .all();
    expect(definitions).toEqual(expected.definitions);
    expect(await documentRow("acme", id)).toEqual({ status: "ready", error: null });
  }, 30_000); // three windows, 200+ chunks: seconds, more on CI

  it("replaces chunks left by an earlier attempt", async () => {
    const markdown = contractText(5_000);
    const { id, jobId } = await insertConverted("acme", markdown);
    await env.DB.prepare(
      `INSERT INTO chunks (tenant_id, document_id, idx, start_offset, end_offset, text, section_path)
       VALUES ('acme', ?, 999, 0, 3, 'old', '[]')`,
    )
      .bind(id)
      .run();
    await using instance = await run({ tenantId: "acme", documentId: id, jobId });

    await instance.waitForStatus("complete");

    const chunks = await storedChunks("acme", id);
    expect(chunks.map((c) => c.idx)).not.toContain(999);
    expect(chunks.length).toBe(chunkDocument(markdown, CHUNK_OPTIONS).chunks.length);
  });

  it("does nothing for a document that is not waiting for chunking", async () => {
    const { id, jobId } = await insertConverted("acme", contractText(5_000), { status: "ready" });
    await using instance = await run({ tenantId: "acme", documentId: id, jobId });

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toEqual({ skipped: true });
    expect(await storedChunks("acme", id)).toEqual([]);
  });

  it("cannot touch another tenant's document, even with its ID and ticket", async () => {
    const { id, jobId } = await insertConverted("acme", contractText(5_000));
    await using instance = await run({ tenantId: "globex", documentId: id, jobId });

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toEqual({ skipped: true });
    expect(await documentRow("acme", id)).toEqual({ status: "chunking", error: null });
  });

  it("marks the document failed when a step keeps failing after its retries", async () => {
    const { id, jobId } = await insertConverted("acme", contractText(5_000));
    await using instance = await run({ tenantId: "acme", documentId: id, jobId }, async (m) => {
      await m.mockStepError({ name: "plan" }, new Error("boom")); // every attempt
    });

    await instance.waitForStatus("errored");

    expect(await documentRow("acme", id)).toEqual({ status: "failed", error: "chunking_failed" });
    expect(await storedChunks("acme", id)).toEqual([]);
  });

  it("recovers when a step fails once and then succeeds (retry)", async () => {
    const { id, jobId } = await insertConverted("acme", contractText(5_000));
    await using instance = await run({ tenantId: "acme", documentId: id, jobId }, async (m) => {
      await m.mockStepError({ name: "store chunks 1" }, new Error("D1 busy"), 1);
    });

    await instance.waitForStatus("complete");

    expect(await documentRow("acme", id)).toEqual({ status: "ready", error: null });
  });

  it("hands the ready document to an indexing job, and keeps it ready if that cannot start", async () => {
    const { id, jobId } = await insertConverted("acme", contractText(5_000));
    await using instance = await run(
      { tenantId: "acme", documentId: id, jobId },
      async (m) => {
        await m.mockStepError({ name: "start indexing" }, new Error("workflows down")); // always
      },
      true,
    );

    await instance.waitForStatus("complete");

    const row = await env.DB.prepare(
      `SELECT status, index_status, index_error, index_job FROM documents
       WHERE tenant_id = 'acme' AND id = ?`,
    )
      .bind(id)
      .first();
    expect(row).toEqual({
      status: "ready",
      index_status: "failed",
      index_error: "indexing_not_started",
      index_job: null,
    });
    expect((await storedChunks("acme", id)).length).toBeGreaterThan(0);
  });
});

describe("fencing: only the job holding the ticket writes", () => {
  it("a job whose ticket went to a newer job does nothing", async () => {
    const { id } = await insertConverted("acme", contractText(5_000), { jobId: "job-new" });
    await using instance = await run({ tenantId: "acme", documentId: id, jobId: "job-old" });

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toEqual({ skipped: true });
    expect(await storedChunks("acme", id)).toEqual([]);
  });

  it("a job replaced mid-run stops, writes nothing, and does not fail the document", async () => {
    // The old job got through 'load' while it still held the ticket (simulated with a mocked
    // result); then a re-upload handed the document to a newer job.
    const markdown = contractText(5_000);
    const { id } = await insertConverted("acme", markdown, { jobId: "job-new" });
    await using instance = await run(
      { tenantId: "acme", documentId: id, jobId: "job-old" },
      async (m) => {
        await m.mockStepResult({ name: "load" }, { windows: [{ from: 0, to: markdown.length }] });
      },
    );

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toEqual({ superseded: true });
    expect(await storedChunks("acme", id)).toEqual([]);
    // Still the newer job's document: the old one did not fail it.
    expect(await documentRow("acme", id)).toEqual({ status: "chunking", error: null });
  });

  it("clears the ticket when done, so no late job can write afterwards", async () => {
    const { id, jobId } = await insertConverted("acme", contractText(5_000));
    await using instance = await run({ tenantId: "acme", documentId: id, jobId });
    await instance.waitForStatus("complete");

    const row = await env.DB.prepare(
      "SELECT chunk_job FROM documents WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(id)
      .first<{ chunk_job: string | null }>();
    expect(row?.chunk_job).toBeNull();
  });
});
