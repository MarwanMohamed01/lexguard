// migrations/0005_chunks_fts.sql in the Workers runtime, with the query builders the search
// will use (@lexguard/retrieval). IDs are random per test so tests never share rows.
import { env } from "cloudflare:workers";
import { ftsScopeMatch, ftsScopeToken, scopedFtsQuery } from "@lexguard/retrieval";
import { describe, expect, it } from "vitest";

const insert = (tenant: string, doc: string, idx: number, text: string) =>
  env.DB.prepare("INSERT INTO chunks_fts (text, tenant, doc, idx) VALUES (?, ?, ?, ?)").bind(
    text,
    ftsScopeToken(tenant),
    ftsScopeToken(doc),
    idx,
  );

async function search(tenant: string, doc: string, text: string): Promise<number[]> {
  const match = scopedFtsQuery("text", text, {
    tenant: ftsScopeToken(tenant),
    doc: ftsScopeToken(doc),
  });
  if (match === null) return [];
  const { results } = await env.DB.prepare(
    `SELECT idx FROM chunks_fts WHERE chunks_fts MATCH ?
     ORDER BY bm25(chunks_fts, 1.0, 0.0, 0.0), idx LIMIT 50`,
  )
    .bind(match)
    .all<{ idx: number }>();
  return results.map((r) => r.idx);
}

describe("chunks_fts (migration 0005)", () => {
  it("stems English words: 'law governs' finds 'governed by the laws'", async () => {
    const doc = crypto.randomUUID();
    await env.DB.batch([
      insert("acme", doc, 0, "This Agreement is governed by the laws of New York."),
      insert("acme", doc, 1, "Payment is due within thirty days."),
    ]);
    expect(await search("acme", doc, "Which law governs?")).toEqual([0]);
  });

  it("never returns another tenant's chunks, even for the same document ID", async () => {
    const doc = crypto.randomUUID();
    await env.DB.batch([
      insert("acme-legal", doc, 0, "Termination for convenience."),
      insert("acme", doc, 1, "Termination for cause."), // a prefix of the other tenant's ID
      insert("acmelegal", doc, 2, "Termination by notice."), // the ID without its dash
    ]);
    expect(await search("acme-legal", doc, "termination")).toEqual([0]);
    expect(await search("acme", doc, "termination")).toEqual([1]);
    expect(await search("acme-legal", doc, 'x) OR tenant : "x61636d65" OR (x')).toEqual([]);
  });

  it("ranks by text only: the filter columns carry zero weight", async () => {
    const doc = crypto.randomUUID();
    await env.DB.batch([
      insert("acme", doc, 0, "Fees. " + "The supplier delivers goods. ".repeat(40)),
      insert("acme", doc, 1, "Fees fees fees: the fees are payable monthly."),
      insert("acme", doc, 2, "Short."),
    ]);
    expect(await search("acme", doc, "fees")).toEqual([1, 0]);
  });

  it("deletes exactly one document's rows with the scope-only match", async () => {
    const [kept, removed] = [crypto.randomUUID(), crypto.randomUUID()];
    await env.DB.batch([
      insert("acme", kept, 0, "Governing law clause."),
      insert("acme", removed, 0, "Governing law clause."),
      insert("acme", removed, 1, "Another governing law clause."),
    ]);
    const result = await env.DB.prepare(
      `DELETE FROM chunks_fts WHERE rowid IN
         (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?)`,
    )
      .bind(ftsScopeMatch({ tenant: ftsScopeToken("acme"), doc: ftsScopeToken(removed) }))
      .run();
    expect(await search("acme", removed, "governing")).toEqual([]);
    expect(await search("acme", kept, "governing")).toEqual([0]);
    // Measured (D28): D1 counts 1 written row per FTS row, but meta.changes also counts FTS5's
    // internal shadow-table changes (6 here for 2 rows). Code must never use meta.changes on
    // this table to check how many chunks it deleted or wrote.
    expect(result.meta.rows_written).toBe(2);
    expect(result.meta.changes).toBeGreaterThan(2);
  });
});
