// The chunking Workflow, run for real in the local Workers runtime against the migrated D1.
import { chunkDocument } from "@lexguard/chunker";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CHUNK_OPTIONS, WINDOW_CHARS, type ChunkParams } from "../src/chunking";

/** Contract-like text of at least `minChars`, with numbered clauses, definitions and emoji. */
function contractText(minChars: number): string {
  const parts = ["MASTER SERVICES AGREEMENT\n\n"];
  let length = parts[0]?.length ?? 0;
  for (let article = 1; length < minChars; article++) {
    const part =
      `${String(article)}. Article Title ${String(article)}\n` +
      `"Term ${String(article)}" means the period set out in this clause 📄.\n` +
      `${String(article)}.1 Scope. The Supplier shall provide the services (a) on time; ` +
      `(b) with care. ${"Further obligations apply. ".repeat(20)}\n` +
      `${String(article)}.2 Fees. Payable within 30 days of invoice.\n\n`;
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}

async function insertConverted(tenantId: string, markdown: string, status = "chunking") {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status,
       markdown, chars, hidden_chars_removed, created_at)
     VALUES (?, ?, ?, 'c.pdf', 'application/pdf', 1, ?, ?, ?, 0, ?)`,
  )
    .bind(
      tenantId,
      id,
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      status,
      markdown,
      markdown.length,
      new Date().toISOString(),
    )
    .run();
  return id;
}

async function run(params: ChunkParams) {
  const instanceId = crypto.randomUUID();
  const instance = await introspectWorkflowInstance(env.CHUNK_DOCUMENT, instanceId);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
  });
  await env.CHUNK_DOCUMENT.create({ id: instanceId, params });
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
    const id = await insertConverted("acme", markdown);
    await using instance = await run({ tenantId: "acme", documentId: id });

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
      "SELECT term, start_offset AS start FROM definitions WHERE tenant_id = ? AND document_id = ? ORDER BY idx",
    )
      .bind("acme", id)
      .all();
    expect(definitions).toEqual(expected.definitions);
    expect(await documentRow("acme", id)).toEqual({ status: "ready", error: null });
  });

  it("replaces chunks left by an earlier attempt", async () => {
    const markdown = contractText(5_000);
    const id = await insertConverted("acme", markdown);
    await env.DB.prepare(
      `INSERT INTO chunks (tenant_id, document_id, idx, start_offset, end_offset, text, section_path)
       VALUES ('acme', ?, 999, 0, 3, 'old', '[]')`,
    )
      .bind(id)
      .run();
    await using instance = await run({ tenantId: "acme", documentId: id });

    await instance.waitForStatus("complete");

    const chunks = await storedChunks("acme", id);
    expect(chunks.map((c) => c.idx)).not.toContain(999);
    expect(chunks.length).toBe(chunkDocument(markdown, CHUNK_OPTIONS).chunks.length);
  });

  it("does nothing for a document that is not waiting for chunking", async () => {
    const id = await insertConverted("acme", contractText(5_000), "ready");
    await using instance = await run({ tenantId: "acme", documentId: id });

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toEqual({ skipped: true });
    expect(await storedChunks("acme", id)).toEqual([]);
  });

  it("cannot touch another tenant's document, even when given its ID", async () => {
    const id = await insertConverted("acme", contractText(5_000));
    await using instance = await run({ tenantId: "globex", documentId: id });

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toEqual({ skipped: true });
    expect(await documentRow("acme", id)).toEqual({ status: "chunking", error: null });
  });

  it("marks the document failed when a step keeps failing after its retries", async () => {
    const id = await insertConverted("acme", contractText(5_000));
    const instanceId = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.CHUNK_DOCUMENT, instanceId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "plan" }, new Error("boom")); // every attempt
    });
    await env.CHUNK_DOCUMENT.create({
      id: instanceId,
      params: { tenantId: "acme", documentId: id },
    });

    await instance.waitForStatus("errored");

    expect(await documentRow("acme", id)).toEqual({ status: "failed", error: "chunking_failed" });
    expect(await storedChunks("acme", id)).toEqual([]);
  });

  it("recovers when a step fails once and then succeeds (retry)", async () => {
    const id = await insertConverted("acme", contractText(5_000));
    const instanceId = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.CHUNK_DOCUMENT, instanceId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "store chunks 1" }, new Error("D1 busy"), 1);
    });
    await env.CHUNK_DOCUMENT.create({
      id: instanceId,
      params: { tenantId: "acme", documentId: id },
    });

    await instance.waitForStatus("complete");

    expect(await documentRow("acme", id)).toEqual({ status: "ready", error: null });
  });
});
