// Checks migrations/0001_ingestion.sql against the local D1, in the Workers runtime.
// IDs are random per test so tests never depend on each other's rows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function insertDocument(tenantId: string, id: string, sha256: string, status = "converting") {
  return env.DB.prepare(
    `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status, created_at)
     VALUES (?, ?, ?, 'contract.pdf', 'application/pdf', 1024, ?, ?)`,
  )
    .bind(tenantId, id, sha256, status, new Date().toISOString())
    .run();
}

function insertChunk(tenantId: string, documentId: string, idx = 0, start = 0, end = 5) {
  return env.DB.prepare(
    `INSERT INTO chunks (tenant_id, document_id, idx, start_offset, end_offset, text, section_path)
     VALUES (?, ?, ?, ?, ?, 'Hello', '[]')`,
  )
    .bind(tenantId, documentId, idx, start, end)
    .run();
}

const randomSha = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");

describe("documents", () => {
  it("rejects the same file twice for the same tenant", async () => {
    const sha = randomSha();
    await insertDocument("acme", crypto.randomUUID(), sha);

    await expect(insertDocument("acme", crypto.randomUUID(), sha)).rejects.toThrow(/UNIQUE/);
  });

  it("accepts the same file for two tenants (no cross-tenant duplicate signal)", async () => {
    const sha = randomSha();
    await insertDocument("acme", crypto.randomUUID(), sha);

    await expect(insertDocument("globex", crypto.randomUUID(), sha)).resolves.toBeDefined();
  });

  it("rejects an unknown status", async () => {
    await expect(insertDocument("acme", crypto.randomUUID(), randomSha(), "done")).rejects.toThrow(
      /CHECK/,
    );
  });
});

describe("tenant isolation in the schema", () => {
  it("refuses a chunk that points at another tenant's document", async () => {
    const acmeDocument = crypto.randomUUID();
    await insertDocument("acme", acmeDocument, randomSha());

    await expect(insertChunk("globex", acmeDocument)).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertChunk("acme", acmeDocument)).resolves.toBeDefined();
  });

  it("refuses a definition that points at another tenant's document", async () => {
    const acmeDocument = crypto.randomUUID();
    await insertDocument("acme", acmeDocument, randomSha());

    await expect(
      env.DB.prepare(
        `INSERT INTO definitions (tenant_id, document_id, idx, term, start_offset)
         VALUES ('globex', ?, 0, 'Affiliate', 0)`,
      )
        .bind(acmeDocument)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("a tenant-scoped query never returns another tenant's rows", async () => {
    const id = crypto.randomUUID(); // same document ID under two tenants: distinct rows
    await insertDocument("acme", id, randomSha());
    await insertDocument("globex", id, randomSha());

    const { results } = await env.DB.prepare(
      "SELECT tenant_id FROM documents WHERE tenant_id = ? AND id = ?",
    )
      .bind("globex", id)
      .all<{ tenant_id: string }>();

    expect(results).toEqual([{ tenant_id: "globex" }]);
  });

  it("deleting a document deletes its chunks (ON DELETE CASCADE)", async () => {
    const id = crypto.randomUUID();
    await insertDocument("acme", id, randomSha());
    await insertChunk("acme", id, 0);
    await insertChunk("acme", id, 1);

    await env.DB.prepare("DELETE FROM documents WHERE tenant_id = ? AND id = ?")
      .bind("acme", id)
      .run();
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ? AND document_id = ?",
    )
      .bind("acme", id)
      .first<{ n: number }>();

    expect(left?.n).toBe(0);
  });

  it("rejects a chunk whose end is not after its start", async () => {
    const id = crypto.randomUUID();
    await insertDocument("acme", id, randomSha());

    await expect(insertChunk("acme", id, 0, 5, 5)).rejects.toThrow(/CHECK/);
  });
});
