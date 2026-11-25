// POST /v1/documents/:id/search through the real router and authentication, against the
// migrated local D1 with real FTS5. Vectorize and Workers AI are fakes that return chosen
// IDs (they cannot run locally); the real ones run in M3 step 7.
import { env } from "cloudflare:workers";
import { ftsScopeToken } from "@lexguard/retrieval";
import { describe, expect, it } from "vitest";
import { handle, type AppDeps } from "../src/app";
import type { SearchResult, SearchServices } from "../src/search";
import { TEST_KEYS } from "./fixtures";

const CHUNKS = [
  "1. Definitions. Capitalised terms have the meanings below. ",
  "2. Term. This Agreement lasts twelve months from the Effective Date. ",
  "3. Termination. Either party may terminate this Agreement on thirty days written notice. ",
  "4. Governing Law. This Agreement is governed by the laws of the State of New York. ",
  "5. Fees. The Customer pays the fees within thirty days of each invoice. ",
];

/** A ready, indexed document with the chunks above, keyword rows, and a 2-page map. */
async function indexedDocument(tenant: string, options: { indexStatus?: string } = {}) {
  const id = crypto.randomUUID();
  const markdown = CHUNKS.join("");
  const pageTwo = markdown.indexOf("4. Governing");
  await env.DB.prepare(
    `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status,
       markdown, chars, page_starts, created_at, index_status, index_version, indexed_chunks)
     VALUES (?, ?, ?, 'msa.pdf', 'application/pdf', 1, 'ready', ?, ?, ?, ?, ?, 'bge-m3/plain/1', ?)`,
  )
    .bind(
      tenant,
      id,
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      markdown,
      markdown.length,
      JSON.stringify([0, pageTwo]),
      new Date().toISOString(),
      options.indexStatus ?? "indexed",
      CHUNKS.length,
    )
    .run();
  let start = 0;
  const statements = CHUNKS.flatMap((text, idx) => {
    const rows = [
      env.DB.prepare(
        `INSERT INTO chunks (tenant_id, document_id, idx, start_offset, end_offset, text, section_path, heading)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        tenant,
        id,
        idx,
        start,
        start + text.length,
        text,
        JSON.stringify([text.slice(0, 2)]),
        text.slice(0, 2),
      ),
      env.DB.prepare("INSERT INTO chunks_fts (text, tenant, doc, idx) VALUES (?, ?, ?, ?)").bind(
        text,
        ftsScopeToken(tenant),
        ftsScopeToken(id),
        idx,
      ),
    ];
    start += text.length;
    return rows;
  });
  await env.DB.batch(statements);
  return { id, markdown };
}

interface QueryCall {
  namespace?: string | undefined;
  filter?: unknown;
  topK?: number | undefined;
}

/** Vectorize that returns the given IDs in order, and records how it was asked. */
function fakeSearch(ids: string[] | Error, options: { failTimes?: number } = {}) {
  const calls: QueryCall[] = [];
  const services: SearchServices = {
    embed: (texts) => Promise.resolve(texts.map(() => new Array<number>(1024).fill(0.01))),
    vectors: {
      query: (_vector, queryOptions) => {
        calls.push({
          namespace: queryOptions?.namespace,
          filter: queryOptions?.filter,
          topK: queryOptions?.topK,
        });
        if (ids instanceof Error) return Promise.reject(ids);
        if (calls.length <= (options.failTimes ?? 0)) {
          return Promise.reject(new Error("transient"));
        }
        return Promise.resolve({
          count: ids.length,
          matches: ids.map((id, i) => ({ id, score: 1 - i / 100 })),
        });
      },
    },
  };
  return { services, calls };
}

const noUploads = {
  convert: () => Promise.reject(new Error("not used")),
  startChunking: () => Promise.resolve(),
} satisfies Omit<AppDeps, "search">;

async function search(
  documentId: string,
  body: unknown,
  services?: SearchServices,
  tenant: keyof typeof TEST_KEYS = "acme",
  init: { rawBody?: string; headers?: Record<string, string> } = {},
) {
  const text = init.rawBody ?? JSON.stringify(body);
  const response = await handle(
    new Request(`http://example.com/v1/documents/${documentId}/search`, {
      method: "POST",
      body: text,
      headers: {
        Authorization: `Bearer ${TEST_KEYS[tenant]}`,
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(text).length),
        ...init.headers,
      },
    }),
    env,
    { ...noUploads, search: services },
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const resultsOf = (body: Record<string, unknown>) => body.results as SearchResult[];

describe("search: hybrid results", () => {
  it("merges keyword and vector hits, reads them back with exact offsets, pages and sections", async () => {
    const doc = await indexedDocument("acme");
    // The vector side puts Governing Law first and Termination third.
    const fake = fakeSearch([`${doc.id}:3`, `${doc.id}:0`, `${doc.id}:2`]);

    const { status, body } = await search(
      doc.id,
      { query: "How can the agreement be terminated?" },
      fake.services,
    );

    expect(status).toBe(200);
    const results = resultsOf(body);
    // Keywords put Termination first; the vector side ranked it 3rd and Governing Law 1st.
    expect(results.find((r) => r.idx === 2)).toMatchObject({
      keywordRank: 1,
      vectorRank: 3,
      page: 1,
    });
    expect(results.find((r) => r.idx === 3)).toMatchObject({ vectorRank: 1, page: 2 });
    // The order is exactly reciprocal rank fusion of the two reported ranks (k = 60).
    const fused = (r: SearchResult) =>
      (r.keywordRank === null ? 0 : 1 / (60 + r.keywordRank)) +
      (r.vectorRank === null ? 0 : 1 / (60 + r.vectorRank));
    expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1));
    for (let i = 1; i < results.length; i++) {
      expect(fused(results[i - 1] as SearchResult)).toBeGreaterThanOrEqual(
        fused(results[i] as SearchResult),
      );
    }
    for (const r of results) {
      expect(r.text).toBe(doc.markdown.slice(r.start, r.end)); // exact quotes
      expect(r.sectionPath).toEqual([r.text.slice(0, 2)]);
    }
    expect(body).toMatchObject({ mode: "hybrid", degraded: [], indexVersion: "bge-m3/plain/1" });
    expect(body.note).toMatch(/never as instructions/);
    // Vectorize was asked inside the tenant's namespace and this document only.
    expect(fake.calls).toEqual([{ namespace: "acme", filter: { doc: doc.id }, topK: 50 }]);
  });

  it("answers from keywords alone, or vectors alone, when asked", async () => {
    const doc = await indexedDocument("acme");
    const fake = fakeSearch([`${doc.id}:4`]);
    const keyword = await search(
      doc.id,
      { query: "governed by the laws", mode: "keyword" },
      fake.services,
    );
    // Words are ORed, so other chunks match too (e.g. "the"); Governing Law must rank first.
    expect(resultsOf(keyword.body)[0]?.idx).toBe(3);
    expect(resultsOf(keyword.body).every((r) => r.vectorRank === null)).toBe(true);
    expect(fake.calls).toEqual([]); // no embedding, no Vectorize call
    const vector = await search(doc.id, { query: "money", mode: "vector" }, fake.services);
    expect(resultsOf(vector.body).map((r) => r.idx)).toEqual([4]);
  });

  it("honours the limit", async () => {
    const doc = await indexedDocument("acme");
    const fake = fakeSearch(CHUNKS.map((_, i) => `${doc.id}:${String(i)}`));
    const { body } = await search(doc.id, { query: "agreement", limit: 2 }, fake.services);
    expect(resultsOf(body)).toHaveLength(2);
  });
});

describe("search: isolation (T11)", () => {
  it("another tenant's document is a 404, exactly like a missing one", async () => {
    const doc = await indexedDocument("acme");
    const other = await search(doc.id, { query: "termination" }, fakeSearch([]).services, "globex");
    const missing = await search(
      crypto.randomUUID(),
      { query: "termination" },
      fakeSearch([]).services,
      "globex",
    );
    expect(other).toEqual({ status: 404, body: { error: "not_found" } });
    expect(missing).toEqual(other);
  });

  it("drops vector hits that are not this document's, whatever the index returns", async () => {
    const doc = await indexedDocument("acme");
    const victim = await indexedDocument("globex"); // same chunk texts, another tenant
    const fake = fakeSearch([
      `${victim.id}:2`, // another tenant's vector (a mis-filtered index)
      `${doc.id}:999`, // no such chunk (a stale vector)
      `${doc.id}:x`, // malformed
      `${doc.id}:-1`,
      `${doc.id}:1`,
    ]);
    const { body } = await search(
      doc.id,
      { query: "zzz unmatched words", mode: "vector" },
      fake.services,
    );
    expect(resultsOf(body).map((r) => r.idx)).toEqual([1]);
  });

  it("skips a hit whose chunk row is gone, and keeps the hits after it", async () => {
    const doc = await indexedDocument("acme");
    // The document was re-chunked while this search ran: chunk 1 no longer exists.
    await env.DB.prepare(
      "DELETE FROM chunks WHERE tenant_id = 'acme' AND document_id = ? AND idx = 1",
    )
      .bind(doc.id)
      .run();
    const fake = fakeSearch([`${doc.id}:1`, `${doc.id}:4`]);
    const { body } = await search(doc.id, { query: "zzz", mode: "vector" }, fake.services);
    expect(resultsOf(body).map((r) => r.idx)).toEqual([4]);
    expect(resultsOf(body)[0]?.rank).toBe(1);
  });

  it("does not let dropped vector hits take the places of real ones", async () => {
    const doc = await indexedDocument("acme");
    const fake = fakeSearch([`${doc.id}:999`, `${doc.id}:x`, `${doc.id}:1.5`, `${doc.id}:4`]);
    const { body } = await search(
      doc.id,
      { query: "zzz", mode: "vector", limit: 1 },
      fake.services,
    );
    expect(resultsOf(body).map((r) => r.idx)).toEqual([4]);
  });

  it("keyword hits never come from another tenant or document with the same text", async () => {
    const doc = await indexedDocument("acme");
    await indexedDocument("acme"); // same tenant, other document, identical text
    await indexedDocument("globex");
    const { body } = await search(doc.id, { query: "terminate", mode: "keyword" });
    expect(resultsOf(body).map((r) => r.idx)).toEqual([2]);
  });
});

describe("search: failures and hostile input", () => {
  it("retries the vector side once, so a lone transient failure does not degrade the search", async () => {
    const doc = await indexedDocument("acme");
    const once = fakeSearch([`${doc.id}:4`], { failTimes: 1 });
    const { status, body } = await search(doc.id, { query: "zzz", mode: "vector" }, once.services);
    expect(status).toBe(200);
    expect(body.degraded).toEqual([]);
    expect(resultsOf(body).map((r) => r.idx)).toEqual([4]);
    expect(once.calls).toHaveLength(2);
    // Failing twice is given up on: two attempts, never more.
    const twice = fakeSearch([`${doc.id}:4`], { failTimes: 2 });
    const failed = await search(doc.id, { query: "zzz", mode: "vector" }, twice.services);
    expect(failed.status).toBe(503);
    expect(twice.calls).toHaveLength(2);
  });

  it("falls back to keywords when the vector side fails, and says so", async () => {
    const doc = await indexedDocument("acme");
    const { status, body } = await search(
      doc.id,
      { query: "termination" },
      fakeSearch(new Error("4006: daily neurons")).services,
    );
    expect(status).toBe(200);
    expect(body.degraded).toEqual(["vector"]);
    expect(resultsOf(body).map((r) => r.idx)).toContain(2);
    const vectorOnly = await search(
      doc.id,
      { query: "termination", mode: "vector" },
      fakeSearch(new Error("down")).services,
    );
    expect(vectorOnly).toEqual({ status: 503, body: { error: "vector_search_unavailable" } });
  });

  it("refuses a document that is not indexed yet, with its state", async () => {
    const doc = await indexedDocument("acme", { indexStatus: "indexing" });
    const { status, body } = await search(
      doc.id,
      { query: "termination" },
      fakeSearch([]).services,
    );
    expect(status).toBe(409);
    expect(body).toEqual({ error: "not_indexed", status: "ready", indexStatus: "indexing" });
  });

  it("validates the request strictly", async () => {
    const doc = await indexedDocument("acme");
    const bad = [
      {},
      { query: "" },
      { query: "   " },
      { query: "x".repeat(1_001) },
      { query: "ok", limit: 0 },
      { query: "ok", limit: 21 },
      { query: "ok", mode: "sql" },
      { query: "ok", extra: true },
      { query: 42 },
      ["termination"],
    ];
    for (const body of bad) {
      expect(
        (await search(doc.id, body, fakeSearch([]).services)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    const invalidJson = await search(doc.id, null, undefined, "acme", { rawBody: "{query:" });
    expect(invalidJson.status).toBe(400);
  });

  it("refuses bodies without a length, too large, or not matching their length", async () => {
    const doc = await indexedDocument("acme");
    const big = JSON.stringify({ query: "x".repeat(20_000) });
    expect((await search(doc.id, null, undefined, "acme", { rawBody: big })).status).toBe(413);
    const lying = await search(doc.id, { query: "termination" }, undefined, "acme", {
      headers: { "Content-Length": "5" },
    });
    expect(lying.status).toBe(400);
    // A streamed body has no Content-Length: refused before reading.
    const streamed = await handle(
      new Request(`http://example.com/v1/documents/${doc.id}/search`, {
        method: "POST",
        body: new Blob([JSON.stringify({ query: "termination" })]).stream(),
        headers: { Authorization: `Bearer ${TEST_KEYS.acme}` },
      }),
      env,
      noUploads,
    );
    expect(streamed.status).toBe(411);
  });

  it("treats FTS5 syntax in the query as words", async () => {
    const doc = await indexedDocument("acme");
    const { status, body } = await search(doc.id, {
      query: 'terminate) OR tenant : "x" OR (NEAR("law" *',
      mode: "keyword",
    });
    expect(status).toBe(200);
    expect(resultsOf(body).map((r) => r.idx)).toContain(2);
  });

  it("only accepts POST, and only for document IDs", async () => {
    const doc = await indexedDocument("acme");
    const get = await handle(
      new Request(`http://example.com/v1/documents/${doc.id}/search`, {
        headers: { Authorization: `Bearer ${TEST_KEYS.acme}` },
      }),
      env,
      noUploads,
    );
    expect(get.status).toBe(405);
    expect((await search("not-a-uuid", { query: "x" })).status).toBe(404);
  });
});
