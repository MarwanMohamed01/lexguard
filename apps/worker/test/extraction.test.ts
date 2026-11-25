// The extraction job (src/extraction.ts) and its endpoints (src/clauses.ts) against the
// migrated local D1, in the Workers runtime. Workers AI cannot run locally, so the model is a
// fake that answers per chunk; the step runner runs each step directly (parallel groups run
// through Promise.all as in production).
import { env } from "cloudflare:workers";
import type { Prompt } from "@lexguard/extraction";
import { describe, expect, it } from "vitest";
import { findDefinitions } from "@lexguard/chunker";
import { handle } from "../src/app";
import { documentText } from "../src/clauses";
import {
  DAILY_EXTRACT_NEURONS,
  estimateNeurons,
  EXTRACT_PARALLEL,
  EXTRACT_VERSION,
  MAX_EXTRACT_CHUNKS,
  runExtraction,
  type Completion,
  type ExtractServices,
  type StepRunner,
} from "../src/extraction";
import { TEST_KEYS } from "./fixtures";

const TODAY = "2031-01-01"; // a day no other test file uses for the shared budget table

function directSteps(hooks: { before?: Record<string, () => Promise<void>> } = {}) {
  const names: string[] = [];
  const step: StepRunner = {
    do: async (name, _config, callback) => {
      names.push(name);
      await hooks.before?.[name]?.();
      return callback();
    },
  };
  return { step, names };
}

/** The chunk text sits between the wrapper lines of the user prompt. */
const chunkOf = (prompt: Prompt) => prompt.user.split("\n").slice(1, -1).join("\n");

/** A fake model: `answer` decides per chunk text; usage is reported unless told otherwise. */
function fakeServices(
  answer: (chunk: string) => unknown,
  options: { usage?: boolean; today?: string; fail?: boolean } = {},
) {
  const prompts: Prompt[] = [];
  const nonces: string[] = [];
  const services: ExtractServices = {
    complete: (prompt): Promise<Completion> => {
      prompts.push(prompt);
      if (options.fail === true) return Promise.reject(new Error("Workers AI is down"));
      const a = answer(chunkOf(prompt));
      return Promise.resolve({
        text: typeof a === "string" ? a : JSON.stringify(a),
        inputTokens: options.usage === false ? null : 1_000,
        outputTokens: options.usage === false ? null : 100,
      });
    },
    nonce: () => {
      const n = crypto.randomUUID().replaceAll("-", "");
      nonces.push(n);
      return n;
    },
    today: () => options.today ?? TODAY,
  };
  return { services, prompts, nonces };
}

async function readyDocument(tenant: string, chunkTexts: string[], pageStarts?: number[]) {
  const id = crypto.randomUUID();
  const job = crypto.randomUUID();
  const markdown = chunkTexts.join("");
  await env.DB.prepare(
    `INSERT INTO documents (tenant_id, id, sha256, filename, mime_type, size_bytes, status,
       markdown, chars, created_at, page_starts, extract_status, extract_job)
     VALUES (?, ?, ?, 'msa.pdf', 'application/pdf', 1, 'ready', ?, ?, ?, ?, 'extracting', ?)`,
  )
    .bind(
      tenant,
      id,
      crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      markdown,
      markdown.length,
      new Date().toISOString(),
      pageStarts === undefined ? null : JSON.stringify(pageStarts),
      job,
    )
    .run();
  let start = 0;
  await env.DB.batch(
    chunkTexts.map((text, idx) => {
      const s = env.DB.prepare(
        `INSERT INTO chunks (tenant_id, document_id, idx, start_offset, end_offset, text, section_path)
         VALUES (?, ?, ?, ?, ?, ?, '[]')`,
      ).bind(tenant, id, idx, start, start + text.length, text);
      start += text.length;
      return s;
    }),
  );
  return { id, job, markdown, params: { tenantId: tenant, documentId: id, jobId: job } };
}

const state = (tenant: string, id: string) =>
  env.DB.prepare(
    `SELECT extract_status AS status, extract_job AS job, extract_version AS version,
       extract_error AS error FROM documents WHERE tenant_id = ? AND id = ?`,
  )
    .bind(tenant, id)
    .first<{ status: string; job: string | null; version: string | null; error: string | null }>();

const storedClauses = async (tenant: string, id: string) =>
  (
    await env.DB.prepare(
      `SELECT chunk_idx AS chunk, clause_type AS type, start_offset AS start, end_offset AS end
       FROM clauses WHERE tenant_id = ? AND document_id = ? ORDER BY chunk_idx, n`,
    )
      .bind(tenant, id)
      .all<{ chunk: number; type: string; start: number; end: number }>()
  ).results;

const spent = async (day: string) =>
  (
    await env.DB.prepare("SELECT neurons FROM neuron_budget WHERE day = ?")
      .bind(day)
      .first<{ neurons: number }>()
  )?.neurons ?? 0;

const setBudget = (day: string, neurons: number) =>
  env.DB.prepare(
    "INSERT INTO neuron_budget (day, neurons) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET neurons = excluded.neurons",
  )
    .bind(day, neurons)
    .run();

const LAW = "This Agreement is governed by the laws of New York.";
const ASSIGN = "Neither party may assign this Agreement without consent.";
const CHUNKS = [`1. Law. ${LAW} `, `2. Assignment. ${ASSIGN} `, "3. Fees. Fees are due monthly. "];

/** Answers what each chunk really contains, plus one invented quote in the fees chunk. */
const honest = (chunk: string) => {
  if (chunk.includes(LAW)) return { clauses: [{ clauseType: "Governing Law", quote: LAW }] };
  if (chunk.includes(ASSIGN)) {
    return {
      clauses: [{ clauseType: "Anti-Assignment", quote: ASSIGN, parties: ["Acme", "Beta"] }],
    };
  }
  return { clauses: [{ clauseType: "Uncapped Liability", quote: "Liability is unlimited." }] };
};

describe("extraction job", () => {
  it("extracts every chunk, stores verbatim clauses in document offsets, marks extracted", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices(honest);
    const { step, names } = directSteps();

    const outcome = await runExtraction(env.DB, fake.services, doc.params, step);

    expect(outcome).toMatchObject({ extracted: 2, chunks: 3 });
    expect(names).toEqual(["load", "chunk 0", "chunk 1", "chunk 2", "finish"]);
    const rows = await storedClauses("acme", doc.id);
    expect(rows.map((r) => r.type)).toEqual(["Governing Law", "Anti-Assignment"]);
    for (const r of rows) {
      expect([LAW, ASSIGN]).toContain(doc.markdown.slice(r.start, r.end));
    }
    expect(await state("acme", doc.id)).toMatchObject({
      status: "extracted",
      job: null,
      version: EXTRACT_VERSION,
      error: null,
    });
    // The invented quote in chunk 2 was rejected and recorded.
    const audit = await env.DB.prepare(
      "SELECT outcome, accepted, rejected FROM extraction_chunks WHERE tenant_id = 'acme' AND document_id = ? AND chunk_idx = 2",
    )
      .bind(doc.id)
      .first<{ outcome: string; accepted: number; rejected: string }>();
    expect(audit).toMatchObject({ outcome: "ok", accepted: 0 });
    expect(JSON.parse(audit?.rejected ?? "{}")).toMatchObject({ quoteNotFound: 1 });
  });

  it("uses a fresh nonce per call and never puts chunk text in the system prompt", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices(honest);
    await runExtraction(env.DB, fake.services, doc.params, directSteps().step);
    expect(new Set(fake.nonces).size).toBe(3);
    for (const [i, p] of fake.prompts.entries()) {
      expect(p.system).not.toContain("Fees are due");
      expect(p.user).toContain(`<document id=${fake.nonces[i] ?? "?"}>`);
    }
  });

  it("runs chunk steps in groups of EXTRACT_PARALLEL", async () => {
    const texts = Array.from({ length: EXTRACT_PARALLEL + 1 }, (_, i) => `Chunk ${String(i)}. `);
    const doc = await readyDocument("acme", texts);
    let running = 0;
    let peak = 0;
    const fake = fakeServices(() => ({ clauses: [] }));
    const slow: ExtractServices = {
      ...fake.services,
      complete: async (prompt) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return fake.services.complete(prompt);
      },
    };
    await runExtraction(env.DB, slow, doc.params, directSteps().step);
    expect(peak).toBe(EXTRACT_PARALLEL);
  });

  it("records a chunk whose answer is not JSON and goes on", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices((chunk) =>
      chunk.includes(LAW) ? "Sure! Here you go." : honest(chunk),
    );
    const outcome = await runExtraction(env.DB, fake.services, doc.params, directSteps().step);
    expect(outcome).toMatchObject({ extracted: 1 });
    const { results } = await env.DB.prepare(
      "SELECT chunk_idx AS idx, outcome FROM extraction_chunks WHERE tenant_id = 'acme' AND document_id = ? ORDER BY chunk_idx",
    )
      .bind(doc.id)
      .all<{ idx: number; outcome: string }>();
    expect(results.map((r) => r.outcome)).toEqual(["not_json", "ok", "ok"]);
  });

  it("re-extraction replaces the previous clauses", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    await runExtraction(env.DB, fakeServices(honest).services, doc.params, directSteps().step);
    const job2 = crypto.randomUUID();
    await env.DB.prepare(
      "UPDATE documents SET extract_status = 'extracting', extract_job = ? WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(job2, doc.id)
      .run();
    const onlyLaw = fakeServices((c) => (c.includes(LAW) ? honest(c) : { clauses: [] }));
    await runExtraction(
      env.DB,
      onlyLaw.services,
      { ...doc.params, jobId: job2 },
      directSteps().step,
    );
    expect((await storedClauses("acme", doc.id)).map((r) => r.type)).toEqual(["Governing Law"]);
  });
});

describe("fencing", () => {
  it("a job whose ticket was revoked before a chunk writes nothing more", async () => {
    // More chunks than one parallel group, so a job that ignored the lost ticket would go on.
    const texts = [...CHUNKS, ...CHUNKS].map((t, i) => `${String(i)}. ${t}`);
    const doc = await readyDocument("acme", texts);
    const revoke = async () => {
      await env.DB.prepare(
        "UPDATE documents SET extract_job = ? WHERE tenant_id = 'acme' AND id = ?",
      )
        .bind(crypto.randomUUID(), doc.id)
        .run();
    };
    const fake = fakeServices(honest);
    const { step, names } = directSteps({ before: { "chunk 0": revoke } });
    const outcome = await runExtraction(env.DB, fake.services, doc.params, step);
    expect(outcome).toEqual({ superseded: true });
    expect(await storedClauses("acme", doc.id)).toEqual([]);
    // It stops at once: no model call, no later group, never "finish".
    expect(fake.prompts).toHaveLength(0);
    expect(names).not.toContain(`chunk ${String(EXTRACT_PARALLEL)}`);
    expect(names).not.toContain("finish");
    expect((await state("acme", doc.id))?.status).toBe("extracting"); // the new owner's state
  });

  it("skips a document that is no longer handed to this job", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices(honest);
    const outcome = await runExtraction(
      env.DB,
      fake.services,
      { ...doc.params, jobId: crypto.randomUUID() },
      directSteps().step,
    );
    expect(outcome).toEqual({ skipped: true });
    expect(fake.prompts).toHaveLength(0);
  });

  it("never touches another tenant's document with the same ID", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    const outcome = await runExtraction(
      env.DB,
      fakeServices(honest).services,
      { ...doc.params, tenantId: "globex" },
      directSteps().step,
    );
    expect(outcome).toEqual({ skipped: true });
  });
});

describe("budget (T15)", () => {
  it("reserves before each call and keeps the real usage afterwards", async () => {
    const day = "2031-02-01";
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices(honest, { today: day });
    const outcome = await runExtraction(env.DB, fake.services, doc.params, directSteps().step);
    // 1,000 input + 100 output tokens per call at gemma-4's prices.
    const perCall = (1_000 * 9_091 + 100 * 27_273) / 1_000_000;
    expect(await spent(day)).toBeCloseTo(3 * perCall, 6);
    expect(outcome).toMatchObject({ neurons: expect.closeTo(3 * perCall, 6) as number });
  });

  it("keeps the worst-case estimate when the model reports no usage", async () => {
    const day = "2031-02-02";
    const doc = await readyDocument("acme", [CHUNKS[0] ?? ""]);
    const fake = fakeServices(honest, { today: day, usage: false });
    await runExtraction(env.DB, fake.services, doc.params, directSteps().step);
    const prompt = fake.prompts[0];
    expect(prompt).toBeDefined();
    expect(await spent(day)).toBeCloseTo(estimateNeurons(prompt as Prompt), 6);
  });

  it("stops without calling the model when the day's budget is spent", async () => {
    const day = "2031-02-03";
    await setBudget(day, DAILY_EXTRACT_NEURONS - 1);
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices(honest, { today: day });
    const outcome = await runExtraction(env.DB, fake.services, doc.params, directSteps().step);
    expect(outcome).toEqual({ failed: "daily_budget" });
    expect(fake.prompts).toHaveLength(0);
    expect(await state("acme", doc.id)).toMatchObject({ status: "failed", error: "daily_budget" });
    expect(await spent(day)).toBe(DAILY_EXTRACT_NEURONS - 1);
  });

  it("a re-extraction stopped by the budget leaves none of the previous run's clauses", async () => {
    const day = "2031-02-04";
    const doc = await readyDocument("acme", CHUNKS);
    await runExtraction(
      env.DB,
      fakeServices(honest, { today: day }).services,
      doc.params,
      directSteps().step,
    );
    expect(await storedClauses("acme", doc.id)).toHaveLength(2);
    const job2 = crypto.randomUUID();
    await env.DB.prepare(
      "UPDATE documents SET extract_status = 'extracting', extract_job = ? WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(job2, doc.id)
      .run();
    await setBudget(day, DAILY_EXTRACT_NEURONS);
    const outcome = await runExtraction(
      env.DB,
      fakeServices(honest, { today: day }).services,
      { ...doc.params, jobId: job2 },
      directSteps().step,
    );
    expect(outcome).toEqual({ failed: "daily_budget" });
    // Old results would mix two versions: they are gone, not half-replaced.
    expect(await storedClauses("acme", doc.id)).toEqual([]);
  });

  it("refuses a document with too many chunks before any call", async () => {
    const texts = Array.from({ length: MAX_EXTRACT_CHUNKS + 1 }, (_, i) => `C${String(i)} `);
    const doc = await readyDocument("acme", texts);
    const fake = fakeServices(honest);
    const outcome = await runExtraction(env.DB, fake.services, doc.params, directSteps().step);
    expect(outcome).toEqual({ failed: "too_many_chunks" });
    expect(fake.prompts).toHaveLength(0);
  });

  it("a failing model marks the document failed and rethrows", async () => {
    const doc = await readyDocument("acme", CHUNKS);
    const fake = fakeServices(honest, { fail: true });
    await expect(
      runExtraction(env.DB, fake.services, doc.params, directSteps().step),
    ).rejects.toThrow("Workers AI is down");
    expect(await state("acme", doc.id)).toMatchObject({
      status: "failed",
      error: "extraction_failed",
    });
  });
});

const auth = (tenant: keyof typeof TEST_KEYS) => ({
  Authorization: `Bearer ${TEST_KEYS[tenant]}`,
});
const deps = (started: unknown[] = [], fail = false) => ({
  convert: () => Promise.reject(new Error("not used")),
  startChunking: () => Promise.resolve(),
  startExtraction: (params: unknown) => {
    started.push(params);
    return fail ? Promise.reject(new Error("workflows down")) : Promise.resolve();
  },
});
const call = (path: string, method: string, tenant: keyof typeof TEST_KEYS, d = deps()) =>
  handle(new Request(`https://lexguard.test${path}`, { method, headers: auth(tenant) }), env, d);

async function plainReadyDocument(tenant: string) {
  const doc = await readyDocument(tenant, CHUNKS, [0, CHUNKS[0]?.length ?? 0]);
  await env.DB.prepare(
    "UPDATE documents SET extract_status = NULL, extract_job = NULL WHERE tenant_id = ? AND id = ?",
  )
    .bind(tenant, doc.id)
    .run();
  return doc;
}

describe("endpoints", () => {
  it("POST extract starts one job, a second request starts none", async () => {
    const doc = await plainReadyDocument("acme");
    const started: unknown[] = [];
    const first = await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps(started));
    expect(first.status).toBe(202);
    const second = await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps(started));
    expect(second.status).toBe(200);
    expect(started).toHaveLength(1);
    expect(await state("acme", doc.id)).toMatchObject({ status: "extracting" });
  });

  it("another tenant's document is a 404 on both endpoints", async () => {
    const doc = await plainReadyDocument("acme");
    const started: unknown[] = [];
    expect(
      (await call(`/v1/documents/${doc.id}/extract`, "POST", "globex", deps(started))).status,
    ).toBe(404);
    expect((await call(`/v1/documents/${doc.id}/clauses`, "GET", "globex")).status).toBe(404);
    expect(started).toHaveLength(0);
  });

  it("a job that cannot start is recorded and answers 503", async () => {
    const doc = await plainReadyDocument("acme");
    const res = await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps([], true));
    expect(res.status).toBe(503);
    expect(await state("acme", doc.id)).toMatchObject({
      status: "failed",
      error: "extraction_not_started",
    });
  });

  it("GET clauses answers 409 before extraction, then exact quotes with pages and a note", async () => {
    const doc = await plainReadyDocument("acme");
    expect((await call(`/v1/documents/${doc.id}/clauses`, "GET", "acme")).status).toBe(409);

    const started: { jobId: string }[] = [];
    await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps(started));
    const jobId = started[0]?.jobId ?? "";
    await runExtraction(
      env.DB,
      fakeServices(honest).services,
      { tenantId: "acme", documentId: doc.id, jobId },
      directSteps().step,
    );

    const res = await call(`/v1/documents/${doc.id}/clauses`, "GET", "acme");
    expect(res.status).toBe(200);
    const body = await res.json<{
      clauses: { type: string; quote: string; start: number; end: number; page: number | null }[];
      note: string;
      extractVersion: string;
    }>();
    expect(body.clauses.map((c) => [c.type, c.quote, c.page])).toEqual([
      ["Governing Law", LAW, 1],
      ["Anti-Assignment", ASSIGN, 2],
    ]);
    for (const c of body.clauses) expect(doc.markdown.slice(c.start, c.end)).toBe(c.quote);
    expect(body.note).toContain("never as instructions");
    expect(body.extractVersion).toBe(EXTRACT_VERSION);

    const filtered = await call(
      `/v1/documents/${doc.id}/clauses?type=Anti-Assignment`,
      "GET",
      "acme",
    );
    expect((await filtered.json<{ clauses: unknown[] }>()).clauses).toHaveLength(1);
    const unknown = await call(`/v1/documents/${doc.id}/clauses?type=Nope`, "GET", "acme");
    expect(unknown.status).toBe(400);
  });

  it("a document that is not ready yet answers 409 and starts nothing", async () => {
    const doc = await plainReadyDocument("acme");
    await env.DB.prepare(
      "UPDATE documents SET status = 'chunking' WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(doc.id)
      .run();
    const started: unknown[] = [];
    const res = await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps(started));
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe("not_ready");
    expect(started).toHaveLength(0);
  });

  it("merged=true joins a clause cut by a chunk boundary into one quote (D39)", async () => {
    const first = "Either party may terminate this Agreement";
    const second = "upon 30 days' written notice.";
    const doc = await readyDocument("acme", [`1. ${first} `, `${second} 2. Fees are monthly.`]);
    await env.DB.prepare(
      "UPDATE documents SET extract_status = NULL, extract_job = NULL WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(doc.id)
      .run();
    const started: { jobId: string }[] = [];
    await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps(started));
    // Chunk 1 also has a same-type quote after real text ("2."): it must stay separate.
    const split = (chunk: string) =>
      chunk.includes(first)
        ? {
            clauses: [
              { clauseType: "Termination For Convenience", quote: first, parties: ["Acme"] },
            ],
          }
        : {
            clauses: [
              {
                clauseType: "Termination For Convenience",
                quote: second,
                parties: ["Acme", "Beta"],
              },
              { clauseType: "Termination For Convenience", quote: "Fees are monthly." },
            ],
          };
    await runExtraction(
      env.DB,
      fakeServices(split).services,
      { tenantId: "acme", documentId: doc.id, jobId: started[0]?.jobId ?? "" },
      directSteps().step,
    );

    const raw = await call(`/v1/documents/${doc.id}/clauses`, "GET", "acme");
    expect((await raw.json<{ clauses: unknown[] }>()).clauses).toHaveLength(3);

    const res = await call(`/v1/documents/${doc.id}/clauses?merged=true`, "GET", "acme");
    expect(res.status).toBe(200);
    const body = await res.json<{
      merged: boolean;
      note: string;
      clauses: {
        type: string;
        quote: string;
        start: number;
        end: number;
        chunks: number[];
        pieces: number;
        parties: string[];
      }[];
    }>();
    expect(body.merged).toBe(true);
    expect(body.note).toContain("never as instructions");
    expect(body.clauses.map((c) => c.quote)).toEqual([`${first} ${second}`, "Fees are monthly."]);
    const [m] = body.clauses;
    expect(m).toMatchObject({
      type: "Termination For Convenience",
      quote: `${first} ${second}`,
      chunks: [0, 1],
      pieces: 2,
      parties: ["Acme", "Beta"],
    });
    expect(doc.markdown.slice(m?.start, m?.end)).toBe(m?.quote);
  });

  it("attaches the definitions of the terms a clause uses, quoted with their page (D40)", async () => {
    const chunkTexts = [
      'This Agreement is made as of March 1, 2020 (the "Effective Date") by Acme Inc. ("Supplier"). ',
      '"Products" means the goods listed in Schedule A.\n\n',
      "5. Termination. The Supplier may terminate within 30 days after the Effective Date. ",
    ];
    const doc = await readyDocument("acme", chunkTexts, [0, chunkTexts[0]?.length ?? 0]);
    await env.DB.prepare(
      "UPDATE documents SET extract_status = NULL, extract_job = NULL WHERE tenant_id = 'acme' AND id = ?",
    )
      .bind(doc.id)
      .run();
    // The definitions as the chunking job stores them (findDefinitions on the whole text).
    const defs = findDefinitions(doc.markdown);
    expect(defs.map((d) => d.term)).toEqual(["Effective Date", "Supplier", "Products"]);
    await env.DB.batch(
      defs.map((d, idx) =>
        env.DB.prepare(
          "INSERT INTO definitions (tenant_id, document_id, idx, term, start_offset) VALUES ('acme', ?, ?, ?, ?)",
        ).bind(doc.id, idx, d.term, d.start),
      ),
    );
    // "Supplier" appears again later as a defined term: the FIRST definition is the one used.
    await env.DB.prepare(
      "INSERT INTO definitions (tenant_id, document_id, idx, term, start_offset) VALUES ('acme', ?, 99, 'Supplier', ?)",
    )
      .bind(doc.id, defs[2]?.start ?? 0)
      .run();
    const termination = "The Supplier may terminate within 30 days after the Effective Date.";
    const products = '"Products" means the goods listed in Schedule A.';
    const started: { jobId: string }[] = [];
    await call(`/v1/documents/${doc.id}/extract`, "POST", "acme", deps(started));
    await runExtraction(
      env.DB,
      fakeServices((chunk) =>
        chunk.includes(termination)
          ? { clauses: [{ clauseType: "Termination For Convenience", quote: termination }] }
          : chunk.includes(products)
            ? { clauses: [{ clauseType: "License Grant", quote: products }] }
            : { clauses: [] },
      ).services,
      { tenantId: "acme", documentId: doc.id, jobId: started[0]?.jobId ?? "" },
      directSteps().step,
    );

    for (const view of ["", "?merged=true"]) {
      const res = await call(`/v1/documents/${doc.id}/clauses${view}`, "GET", "acme");
      const body = await res.json<{
        clauses: {
          type: string;
          definitions: { term: string; quote: string; start: number; end: number; page: number }[];
        }[];
      }>();
      const term = body.clauses.find((c) => c.type === "Termination For Convenience");
      expect(term?.definitions.map((d) => [d.term, d.quote, d.page])).toEqual([
        [
          "Supplier",
          'This Agreement is made as of March 1, 2020 (the "Effective Date") by Acme Inc. ("Supplier")',
          1,
        ],
        ["Effective Date", 'This Agreement is made as of March 1, 2020 (the "Effective Date")', 1],
      ]);
      for (const d of term?.definitions ?? []) {
        expect(doc.markdown.slice(d.start, d.end)).toBe(d.quote);
      }
      // A clause that IS the definition does not get it repeated.
      const own = body.clauses.find((c) => c.type === "License Grant");
      expect(own?.definitions).toEqual([]);
    }
  });

  it("wrong methods are refused", async () => {
    const doc = await plainReadyDocument("acme");
    expect((await call(`/v1/documents/${doc.id}/extract`, "GET", "acme")).status).toBe(405);
    expect((await call(`/v1/documents/${doc.id}/clauses`, "POST", "acme")).status).toBe(405);
  });
});

describe("documentText", () => {
  const chunks = [
    { start: 0, text: "Hello " },
    { start: 6, text: "big " },
    { start: 10, text: "world." },
  ];
  const textOf = documentText(chunks);

  it("joins text across chunks", () => {
    expect(textOf(0, 16)).toBe("Hello big world.");
    expect(textOf(3, 12)).toBe("lo big wo");
    expect(textOf(6, 10)).toBe("big ");
    expect(textOf(4, 4)).toBe("");
  });

  it("returns null when the loaded chunks leave a gap or the range runs past them", () => {
    const withGap = documentText([chunks[0], chunks[2]].filter((c) => c !== undefined));
    expect(withGap(3, 12)).toBeNull();
    expect(textOf(10, 20)).toBeNull();
    expect(textOf(5, 2)).toBeNull();
  });
});
