// M3 step 7: the real retrieval path, end to end. The 30 CUAD PDFs go through the Lexguard
// Worker under `wrangler dev` (evals/lib/local-worker.mjs): local D1 and Workflows, but the
// real toMarkdown, the real bge-m3 embeddings and the real Vectorize index `lexguard-chunks`.
//
//   1. upload every PDF as tenant "eval" and wait until it is indexed;
//   2. measure how long its vectors take to become searchable (Vectorize is asynchronous);
//   3. run CUAD's 41 queries on every document in all three modes, through the real endpoint;
//   4. isolation: the smallest PDF again as tenant "eval-b"; "eval" must get 404 on its copy,
//      and "eval-b" must get vector results from its own namespace;
//   5. compare Vectorize's own vectorCount with the count D1 keeps (the space guard, D29);
//   6. save everything to evals/data/retrieval/live-run.json, scored by live.test.ts;
//   7. delete this run's vectors from the index (unless KEEP_VECTORS=1).
//
// Usage (repo root, after `npm run fetch:cuad-pdfs -w @lexguard/evals`):
//   node evals/retrieval/live-run.mjs
// LIMIT=n uses only the n smallest PDFs (a trial). Costs about 1,100 Neurons for all 30 (D31):
// run it on a day whose corpus-embedding run is capped lower (NEURON_CAP=8000). Takes a while:
// indexing now waits until each document's vectors answer queries (about a minute each).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startLocalWorker } from "../lib/local-worker.mjs";

const INDEX = "lexguard-chunks";
const MODES = ["keyword", "vector", "hybrid"];
const CONCURRENCY = 4;
const workerDir = fileURLToPath(new URL("../../apps/worker/", import.meta.url));
const shell = process.platform === "win32";

const manifest = JSON.parse(
  readFileSync(new URL("../cuad/pdfs.manifest.json", import.meta.url), "utf8"),
);
const pdfDir = new URL("../data/cuad/pdf/", import.meta.url);
const outFile = new URL("../data/retrieval/live-run.json", import.meta.url);
mkdirSync(new URL("../data/retrieval/", import.meta.url), { recursive: true });

// CUAD's questions, reduced exactly like dataset.ts queryFromQuestion (live.test.ts checks
// that both give the same strings).
const cuad = JSON.parse(
  readFileSync(new URL("../data/cuad/CUAD_v1.json", import.meta.url), "utf8"),
);
const queries = new Map();
for (const qa of cuad.data[0].paragraphs[0].qas) {
  const type = qa.id.split("__").at(-1);
  const m = /related to "([^"]+)".*Details: (.+)$/su.exec(qa.question);
  if (m === null) throw new Error(`unexpected question: ${qa.question.slice(0, 80)}`);
  queries.set(type, `${m[1]}: ${m[2].trim()}`);
}

function wrangler(args) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: workerDir, encoding: "utf8", shell });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")}:\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

/** Vectorize's own count: `{ dimensions, vectorCount, processedUpTo... }`. */
function vectorCount() {
  const out = wrangler(["vectorize", "info", INDEX, "--json"]);
  const count = JSON.parse(out.slice(out.indexOf("{"))).vectorCount;
  return typeof count === "number" ? count : null;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const worker = await startLocalWorker({
  stateDir: new URL("../data/retrieval/wrangler-state/", import.meta.url),
  otherTenants: ["eval-b"],
});
const written = []; // [tenant, documentId, vectors]
const run = {
  startedAt: new Date().toISOString(),
  queries: Object.fromEntries(queries),
  documents: [],
  isolation: null,
  vectorCount: null,
};
try {
  const limit = Number(process.env.LIMIT ?? manifest.files.length);
  const files = [...manifest.files].sort((a, b) => a.size - b.size).slice(0, limit);
  const vectorsBefore = vectorCount();

  // 1-2. Upload, index, and time until the vectors answer.
  for (const file of files) {
    const pdf = readFileSync(new URL(`${file.sha256}.pdf`, pdfDir));
    const up = await worker.upload(pdf, `${file.title}.pdf`, { waitForIndex: true });
    const doc = up.document;
    const entry = {
      title: file.title,
      pdfSha256: file.sha256,
      id: doc?.id ?? null,
      status: doc?.status ?? null,
      indexStatus: doc?.indexStatus ?? null,
      indexError: doc?.indexError ?? null,
      error: up.error,
      indexedMs: up.readyMs,
      searchableMs: null,
      markdown: null,
      chunks: [],
      searches: [],
    };
    run.documents.push(entry);
    console.log(
      `${(doc?.indexStatus ?? up.error ?? "?").padEnd(9)} ${String(up.readyMs).padStart(6)} ms  ${file.title.slice(0, 60)}`,
    );
    if (doc?.indexStatus !== "indexed") continue;
    const rows = worker.query(
      `SELECT indexed_chunks AS n, markdown FROM documents WHERE tenant_id = 'eval' AND id = '${doc.id}'`,
    );
    written.push(["eval", doc.id, rows[0].n]);
    entry.markdown = rows[0].markdown;
    entry.chunks = worker
      .query(
        `SELECT start_offset AS start, end_offset AS end, heading, section_path AS sectionPath
         FROM chunks WHERE tenant_id = 'eval' AND document_id = '${doc.id}' ORDER BY idx`,
      )
      .map((c) => ({ ...c, sectionPath: JSON.parse(c.sectionPath) }));

    const indexedAt = Date.now();
    for (;;) {
      const r = await worker.request(`/v1/documents/${doc.id}/search`, {
        method: "POST",
        body: { query: "agreement", mode: "vector", limit: 1 },
      });
      if (r.status === 200 && r.body.results.length > 0) {
        entry.searchableMs = Date.now() - indexedAt;
        break;
      }
      if (Date.now() - indexedAt > 180_000) break;
      await sleep(1_000);
    }
  }

  // 3. Every query in every mode, on every indexed document.
  const jobs = run.documents
    .filter((d) => d.indexStatus === "indexed")
    .flatMap((d) =>
      [...queries].flatMap(([type, query]) => MODES.map((mode) => ({ d, type, query, mode }))),
    );
  console.log(`running ${String(jobs.length)} searches...`);
  await pool(jobs, CONCURRENCY, async ({ d, type, query, mode }) => {
    const started = Date.now();
    const r = await worker.request(`/v1/documents/${d.id}/search`, {
      method: "POST",
      body: { query, mode, limit: 20 },
    });
    d.searches.push({
      clauseType: type,
      mode,
      status: r.status,
      ms: Date.now() - started,
      degraded: r.body.degraded ?? null,
      ranking: (r.body.results ?? []).map((x) => x.idx),
    });
  });

  // 4. Isolation with a second tenant holding the same text.
  const smallest = files[0];
  if (smallest !== undefined) {
    const pdf = readFileSync(new URL(`${smallest.sha256}.pdf`, pdfDir));
    const copy = await worker.upload(pdf, `${smallest.title}.pdf`, {
      as: "eval-b",
      waitForIndex: true,
    });
    const id = copy.document?.id;
    if (id !== undefined && copy.document?.indexStatus === "indexed") {
      const n = worker.query(
        `SELECT indexed_chunks AS n FROM documents WHERE tenant_id = 'eval-b' AND id = '${id}'`,
      )[0].n;
      written.push(["eval-b", id, n]);
      const crossTenant = await worker.request(`/v1/documents/${id}/search`, {
        method: "POST",
        body: { query: "agreement" },
      });
      // Indexing now waits until vectors answer (D31), so this should succeed at once; it
      // polls anyway, so a regression shows up as a delay, not as a false isolation failure.
      const asked = Date.now();
      let own;
      do {
        own = await worker.request(`/v1/documents/${id}/search`, {
          method: "POST",
          body: { query: "agreement", mode: "vector" },
          as: "eval-b",
        });
        if ((own.body.results?.length ?? 0) > 0) break;
        await sleep(2_000);
      } while (Date.now() - asked < 180_000);
      run.isolation = {
        otherTenantStatus: crossTenant.status,
        ownVectorResults: own.body.results?.length ?? 0,
        ownSearchableMs: Date.now() - asked,
      };
    }
  }

  // 5. Vectorize's count vs D1's (Vectorize applies writes asynchronously: wait for it).
  const expected = (vectorsBefore ?? 0) + written.reduce((s, [, , n]) => s + n, 0);
  let actual = null;
  for (let i = 0; i < 24; i++) {
    actual = vectorCount();
    if (actual === expected) break;
    await sleep(5_000);
  }
  run.vectorCount = { before: vectorsBefore, expected, actual };
  console.log(
    `Vectorize count: before ${String(vectorsBefore)}, expected ${String(expected)}, actual ${String(actual)}`,
  );
} finally {
  run.finishedAt = new Date().toISOString();
  writeFileSync(outFile, `${JSON.stringify(run)}\n`);
  console.log(`saved ${fileURLToPath(outFile)}`);

  // 7. Remove this run's vectors from the real index.
  if (process.env.KEEP_VECTORS !== "1") {
    const ids = written.flatMap(([, id, n]) =>
      Array.from({ length: n }, (_, i) => `${id}:${String(i)}`),
    );
    for (let i = 0; i < ids.length; i += 100) {
      wrangler(["vectorize", "delete-vectors", INDEX, "--ids", ...ids.slice(i, i + 100)]);
    }
    console.log(`deleted ${String(ids.length)} vectors from ${INDEX}`);
  }
  if (process.env.SHOW_LOG === "1") console.log(worker.log(60));
  await worker.stop();
}
