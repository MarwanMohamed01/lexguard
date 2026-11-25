// The indexing job's logic (src/indexing.ts) against the migrated local D1, in the Workers
// runtime. Workers AI and Vectorize cannot run locally, so they are fakes that record calls;
// the step runner runs each step directly. The real services are exercised in M3 step 7.
import { env } from "cloudflare:workers";
import { EMBED_BATCH, ftsScopeToken, scopedFtsQuery } from "@lexguard/retrieval";
import { describe, expect, it } from "vitest";
import {
  DIMENSIONS,
  INDEX_VERSION,
  MAX_INDEXED_VECTORS,
  runIndexing,
  SEARCHABLE_CHECKS,
  type IndexServices,
  type StepRunner,
} from "../src/indexing";

/**
 * Runs every step at once and records the step names. `before` / `after` run around the step
 * of that name: to change the world between steps (e.g. revoke the ticket) or to look at it.
 */
function directSteps(
  hooks: {
    before?: Record<string, () => Promise<void>>;
    after?: Record<string, () => Promise<void>>;
  } = {},
) {
  const names: string[] = [];
  const step: StepRunner = {
    do: async (name, _config, callback) => {
      names.push(name);
      await hooks.before?.[name]?.();
      const result = await callback();
      await hooks.after?.[name]?.();
      return result;
    },
    sleep: (name) => {
      names.push(name); // recorded, not waited
      return Promise.resolve();
    },
  };
  return { step, names };
}

const revokeTicket = (id: string) => async () => {
  await env.DB.prepare("UPDATE documents SET index_job = ? WHERE tenant_id = 'acme' AND id = ?")
    .bind(crypto.randomUUID(), id)
    .run();
};

interface Upserted {
  id: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
  values: number[];
}

interface Probe {
  id: string;
  namespace: string | undefined;
  filter: unknown;
}

/**
 * Fake Workers AI + Vectorize. `searchableAfter`: how many searchability checks answer
 * "nothing yet" before the vectors are found (Infinity: never); `probeFails` makes them throw.
 */
function fakeServices(
  options: {
    failEmbed?: boolean;
    onEmbed?: () => Promise<void>;
    searchableAfter?: number;
    probeFails?: boolean;
  } = {},
) {
  const embedCalls: string[][] = [];
  const upserted: Upserted[] = [];
  const deleted: string[] = [];
  const probes: Probe[] = [];
  const services: IndexServices = {
    embed: async (texts) => {
      embedCalls.push(texts);
      await options.onEmbed?.();
      if (options.failEmbed === true) throw new Error("Workers AI is down");
      return texts.map((t) =>
        Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? t.length : 0)),
      );
    },
    vectors: {
      upsert: (vectors) => {
        upserted.push(...(vectors as Upserted[]));
        return Promise.resolve({ mutationId: "m" });
      },
      deleteByIds: (ids) => {
        deleted.push(...ids);
        return Promise.resolve({ mutationId: "m" });
      },
      queryById: (id, queryOptions) => {
        probes.push({ id, namespace: queryOptions?.namespace, filter: queryOptions?.filter });
        if (options.probeFails === true) return Promise.reject(new Error("vector not found"));
        const ready = probes.length > (options.searchableAfter ?? 0);
        return Promise.resolve(
          ready ? { count: 1, matches: [{ id, score: 1 }] } : { count: 0, matches: [] },
        );
      },
    },
  };
  return { services, embedCalls, upserted, deleted, probes };
}

/** A ready document with chunks, handed to an indexing job with the given ticket. */
async function readyDocument(tenant: string, chunkTexts: string[], indexedChunks = 0) {
  const id = crypto.randomUUID();
  const job = crypto.randomUUID();
  const markdown = chunkTexts.join("");
  await env.DB.prepare(
    `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status,
       markdown, chars, created_at, index_status, index_job, indexed_chunks)
     VALUES (?, ?, ?, 'msa.pdf', 'application/pdf', 1, 'ready', ?, ?, ?, 'indexing', ?, ?)`,
  )
    .bind(
      tenant,
      id,
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      markdown,
      markdown.length,
      new Date().toISOString(),
      job,
      indexedChunks,
    )
    .run();
  let start = 0;
  await env.DB.batch(
    chunkTexts.map((text, idx) => {
      const statement = env.DB.prepare(
        `INSERT INTO chunks (tenant_id, document_id, idx, start_offset, end_offset, text, section_path)
         VALUES (?, ?, ?, ?, ?, ?, '[]')`,
      ).bind(tenant, id, idx, start, start + text.length, text);
      start += text.length;
      return statement;
    }),
  );
  return { id, job, params: { tenantId: tenant, documentId: id, jobId: job } };
}

const indexState = (tenant: string, id: string) =>
  env.DB.prepare(
    `SELECT index_status AS status, index_job AS job, index_version AS version,
       indexed_chunks AS chunks, index_error AS error
     FROM documents WHERE tenant_id = ? AND id = ?`,
  )
    .bind(tenant, id)
    .first<{
      status: string;
      job: string | null;
      version: string | null;
      chunks: number;
      error: string | null;
    }>();

async function keywordHits(tenant: string, id: string, words: string) {
  const match = scopedFtsQuery("text", words, {
    tenant: ftsScopeToken(tenant),
    doc: ftsScopeToken(id),
  });
  const { results } = await env.DB.prepare(
    "SELECT idx FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY idx",
  )
    .bind(match)
    .all<{ idx: number }>();
  return results.map((r) => r.idx);
}

/** Space used by other tests' documents (all tenants share one Vectorize index). */
async function usedElsewhere() {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(indexed_chunks), 0) AS used FROM documents",
  ).first<{ used: number }>();
  return row?.used ?? 0;
}

describe("indexing job", () => {
  it("embeds every chunk, upserts tenant-namespaced vectors, fills keywords, marks indexed", async () => {
    const doc = await readyDocument("acme", [
      "1. Governing law. New York law governs this Agreement. ",
      "2. Termination. Either party may terminate on notice. ",
      "3. Fees. ",
    ]);
    const fake = fakeServices();
    const { step, names } = directSteps();

    const outcome = await runIndexing(env.DB, fake.services, doc.params, step);

    expect(outcome).toEqual({ indexed: 3, batches: 1 });
    expect(names).toEqual(["load", "embed 1", "keywords", "searchable 1", "finish"]);
    expect(fake.upserted.map((v) => v.id).sort()).toEqual(
      [0, 1, 2].map((i) => `${doc.id}:${String(i)}`),
    );
    for (const v of fake.upserted) {
      expect(v.namespace).toBe("acme");
      expect(v.metadata?.doc).toBe(doc.id);
      expect(v.values).toHaveLength(DIMENSIONS);
    }
    expect(await keywordHits("acme", doc.id, "terminate")).toEqual([1]);
    expect(await indexState("acme", doc.id)).toEqual({
      status: "indexed",
      job: null,
      version: INDEX_VERSION,
      chunks: 3,
      error: null,
    });
  });

  it("sends the vector of each chunk with that chunk's ID (batches are sorted by length)", async () => {
    const texts = ["short", "a much longer chunk of text", "medium text"];
    const doc = await readyDocument("acme", texts);
    const fake = fakeServices();
    await runIndexing(env.DB, fake.services, doc.params, directSteps().step);
    // The fake encodes the text length in the first dimension.
    for (const v of fake.upserted) {
      const idx = Number(v.id.split(":")[1]);
      expect(v.values[0]).toBe(texts[idx]?.length);
    }
  });

  it("caps each embedding request by padded size, longest chunks first", async () => {
    // 40 chunks of 3,500 chars: 28 x 3,500 = 98,000 fits the padded size, 29 would not.
    const doc = await readyDocument(
      "acme",
      Array.from({ length: 40 }, (_, i) => String(i).padEnd(3_500, "x")),
    );
    const fake = fakeServices();
    const outcome = await runIndexing(env.DB, fake.services, doc.params, directSteps().step);
    expect(outcome).toEqual({ indexed: 40, batches: 2 });
    expect(fake.embedCalls.map((c) => c.length)).toEqual([28, 12]);
  });

  it("caps each embedding request at EMBED_BATCH texts (CPU per step, D33)", async () => {
    // 60 chunks of 1,000 chars would fit one padded request; the count cap splits them.
    const doc = await readyDocument(
      "acme",
      Array.from({ length: 60 }, (_, i) => String(i).padEnd(1_000, "x")),
    );
    const fake = fakeServices();
    await runIndexing(env.DB, fake.services, doc.params, directSteps().step);
    expect(fake.embedCalls.map((c) => c.length)).toEqual([EMBED_BATCH, 60 - EMBED_BATCH]);
  });

  it("gives every vector its own chunk's ID across several batches", async () => {
    // Different lengths, so batches (sorted by length) mix chunk positions.
    const texts = Array.from({ length: 50 }, (_, i) => "y".repeat(1_000 + ((i * 37) % 50) * 60));
    const doc = await readyDocument("acme", texts);
    const fake = fakeServices();
    const outcome = await runIndexing(env.DB, fake.services, doc.params, directSteps().step);
    expect(outcome).toMatchObject({ indexed: 50 });
    expect(fake.embedCalls.length).toBeGreaterThan(1);
    expect(fake.upserted.map((v) => v.id).sort()).toEqual(
      texts.map((_, i) => `${doc.id}:${String(i)}`).sort(),
    );
    for (const v of fake.upserted) {
      // The fake encodes the text length in the first dimension.
      expect(v.values[0]).toBe(texts[Number(v.id.split(":")[1])]?.length);
    }
  });

  it("checks its ticket before embedding: a job replaced after 'load' embeds nothing", async () => {
    const doc = await readyDocument("acme", ["Governing law clause. "]);
    const fake = fakeServices();
    const { step } = directSteps({ before: { "embed 1": revokeTicket(doc.id) } });
    const outcome = await runIndexing(env.DB, fake.services, doc.params, step);
    expect(outcome).toEqual({ superseded: true });
    expect(fake.embedCalls).toEqual([]);
    expect(fake.upserted).toEqual([]);
  });

  it("keeps old and new vectors reserved until finish when re-indexing shrinks a document", async () => {
    const doc = await readyDocument("acme", ["a", "b"], 5); // indexed before with 5 chunks
    let duringJob: number | undefined;
    const { step } = directSteps({
      after: {
        load: async () => {
          duringJob = (await indexState("acme", doc.id))?.chunks;
        },
      },
    });
    await runIndexing(env.DB, fakeServices().services, doc.params, step);
    expect(duringJob).toBe(5); // max(old 5, new 2): old vectors still exist mid-job
    expect((await indexState("acme", doc.id))?.chunks).toBe(2);
  });

  it("waits until its vectors answer queries before marking the document indexed", async () => {
    const doc = await readyDocument("acme", ["Governing law clause. ", "Fees. "]);
    const fake = fakeServices({ searchableAfter: 2 });
    let statusWhileWaiting: string | undefined;
    const { step, names } = directSteps({
      after: {
        "searchable 2": async () => {
          statusWhileWaiting = (await indexState("acme", doc.id))?.status;
        },
      },
    });

    await runIndexing(env.DB, fake.services, doc.params, step);

    expect(names.slice(3)).toEqual([
      "searchable 1",
      "wait 1",
      "searchable 2",
      "wait 2",
      "searchable 3",
      "finish",
    ]);
    expect(statusWhileWaiting).toBe("indexing"); // not "indexed" before the vectors answer
    // Probed with a vector it wrote, inside the tenant's namespace and this document.
    const written = new Set(fake.upserted.map((v) => v.id));
    for (const probe of fake.probes) {
      expect(written.has(probe.id)).toBe(true);
      expect(probe).toMatchObject({ namespace: "acme", filter: { doc: doc.id } });
    }
    expect(await indexState("acme", doc.id)).toMatchObject({ status: "indexed", error: null });
  });

  it("marks the document indexed after 5 minutes anyway, and records the delay", async () => {
    for (const options of [{ searchableAfter: Infinity }, { probeFails: true }]) {
      const doc = await readyDocument("acme", ["Some clause. "]);
      const { step, names } = directSteps();
      await runIndexing(env.DB, fakeServices(options).services, doc.params, step);
      expect(names.filter((n) => n.startsWith("searchable"))).toHaveLength(SEARCHABLE_CHECKS);
      expect(await indexState("acme", doc.id)).toMatchObject({
        status: "indexed",
        error: "vectors_not_confirmed",
      });
    }
  });

  it("does nothing when another job holds the ticket", async () => {
    const doc = await readyDocument("acme", ["Some text."]);
    const fake = fakeServices();
    const outcome = await runIndexing(
      env.DB,
      fake.services,
      { ...doc.params, jobId: crypto.randomUUID() },
      directSteps().step,
    );
    expect(outcome).toEqual({ skipped: true });
    expect(fake.embedCalls).toEqual([]);
    expect((await indexState("acme", doc.id))?.status).toBe("indexing");
  });

  it("stops writing as soon as its ticket is revoked mid-job", async () => {
    const doc = await readyDocument("acme", ["Governing law clause. "]);
    // A newer job takes over while this one is embedding.
    const fake = fakeServices({ onEmbed: revokeTicket(doc.id) });
    const outcome = await runIndexing(env.DB, fake.services, doc.params, directSteps().step);
    expect(outcome).toEqual({ superseded: true });
    expect(await keywordHits("acme", doc.id, "governing")).toEqual([]);
    expect((await indexState("acme", doc.id))?.status).toBe("indexing"); // the new job's state
  });

  it("re-indexing with fewer chunks deletes the surplus vectors and old keyword rows", async () => {
    // Indexed before with 5 chunks; now the document has 2.
    const doc = await readyDocument("acme", ["Payment terms. ", "Delivery terms. "], 5);
    await env.DB.prepare("INSERT INTO chunks_fts (text, tenant, doc, idx) VALUES (?, ?, ?, 4)")
      .bind("obsolete warranty clause", ftsScopeToken("acme"), ftsScopeToken(doc.id))
      .run();
    const fake = fakeServices();
    await runIndexing(env.DB, fake.services, doc.params, directSteps().step);
    expect(fake.deleted).toEqual([2, 3, 4].map((i) => `${doc.id}:${String(i)}`));
    expect(await keywordHits("acme", doc.id, "warranty")).toEqual([]);
    expect(await keywordHits("acme", doc.id, "terms")).toEqual([0, 1]);
    expect((await indexState("acme", doc.id))?.chunks).toBe(2);
  });

  it("refuses a document whose vectors would not fit in the shared space (D25)", async () => {
    // Fill the account's space up to just below this document's need.
    const filler = await readyDocument("globex", ["x"]);
    const free = MAX_INDEXED_VECTORS - (await usedElsewhere());
    await env.DB.prepare(
      "UPDATE documents SET indexed_chunks = ?, index_status = 'indexed', index_job = NULL WHERE tenant_id = 'globex' AND id = ?",
    )
      .bind(free - 1, filler.id)
      .run();
    const doc = await readyDocument("acme", ["one", "two"]);
    const fake = fakeServices();

    const outcome = await runIndexing(env.DB, fake.services, doc.params, directSteps().step);

    expect(outcome).toEqual({ failed: "index_full" });
    expect(fake.embedCalls).toEqual([]);
    expect(await indexState("acme", doc.id)).toMatchObject({
      status: "failed",
      error: "index_full",
      job: null,
    });
    // Free the space again for the other tests.
    await env.DB.prepare(
      "UPDATE documents SET indexed_chunks = 0 WHERE tenant_id = 'globex' AND id = ?",
    )
      .bind(filler.id)
      .run();
  });

  it("marks the index failed (not the document) when embedding keeps failing", async () => {
    const doc = await readyDocument("acme", ["Some clause."]);
    const fake = fakeServices({ failEmbed: true });
    await expect(
      runIndexing(env.DB, fake.services, doc.params, directSteps().step),
    ).rejects.toThrow(/Workers AI is down/);
    const state = await env.DB.prepare(
      "SELECT status, index_status, index_error FROM documents WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(doc.id)
      .first();
    expect(state).toEqual({
      status: "ready",
      index_status: "failed",
      index_error: "indexing_failed",
    });
  });
});
