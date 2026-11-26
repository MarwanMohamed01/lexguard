# Progress

Where the project stands and how to resume. Read together with `PROJECT.md` (the spec),
`docs/DECISIONS.md` (deviations and their reasons) and `docs/LEARNING_LOG.md`.

_Last updated: 2026-11-25._

## Status

| Milestone                            | Status                                          |
| ------------------------------------ | ----------------------------------------------- |
| M0 Foundations                       | ✅ Done                                         |
| M1 Core packages                     | ✅ Done (CI and full-history secret scan green) |
| M2 Ingestion & splitting             | ✅ Done (deployed, smoke test green)            |
| M3 Index & retrieval                 | ✅ Done (deployed; full-corpus eval finishing)  |
| **M4 Extraction swarm**              | ⏳ **Next**                                     |
| M5 Research, verification, synthesis | Not started                                     |
| M6 Routing & caching                 | Not started                                     |
| M7 Guardrails & red team             | Not started                                     |
| M8 A2A & observability               | Not started                                     |
| M9 Evals in CI & write-up            | Not started                                     |

Deployed Worker: https://lexguard.marwan-dev.workers.dev, version `ce4c803b` (2026-11-25:
M2 ingestion + M3 indexing and search + M4 extraction: upload, status, chunking, indexing
and extraction Workflows, `POST /v1/documents/:id/search`, `POST .../extract`,
`GET .../clauses`; smoke test `scripts/smoke.mjs`, D23/D32/D41). Cloudflare resources: D1
`lexguard` (migrations 0001-0007 applied remotely), Vectorize index `lexguard-chunks` (1,024
dims, cosine, metadata index `doc`), Workers AI, Workflows `lexguard-chunk-document`,
`lexguard-index-document` and `lexguard-extract-document`, secret `TENANT_KEYS`. Repo:
https://github.com/MarwanMohamed01/lexguard (public).

## Open items (carry into M4)

- **Full-corpus retrieval eval (M3 step 2):** every text embedded (night of 2026-11-26). **Automated** (D36): the scheduled task "Lexguard nightly embedding" runs
  `scripts/nightly-embed.ps1` at 01:10 local (00:10 UTC); log in
  `evals/data/retrieval/nightly-embed.log`; it disables itself when done. Then decide hybrid vs keyword and the contextual
  header with a per-case paired comparison, and set the CI gate (D26). Live = offline (D31),
  so the offline result stands for production.
- **Rotate the API key** (it appeared in a terminal shared with the assistant on 2026-11-25):
  `node apps/worker/scripts/new-tenant-key.mjs marwan --set`.
- Not built yet: deleting a document (its vectors and FTS rows; retention, D25); an index
  stuck in `indexing` whose job never ran (D32); a per-tenant daily search cap (T15, D30).
- Threat model open question 3 (T12): data-use terms of each free model provider, to answer in
  M4 step 1 before any document text goes to one.

## M4 plan (draft, explained to Marwan on 2026-11-25; explain each step again before starting)

Goal: extractor agents read every chunk and return a filled-in, Zod-validated form per clause
(type, verbatim quote, parties, obligations, dates, risk flags); map (parallel, per chunk
batch) then reduce (merge, deduplicate, join clauses split across chunks); cross-references
resolved with M2's definitions. Extractors are quarantined readers (no tools, schema output
only, document text marked as data, T1/T2); every quote is checked by code against the chunk.

1. ✅ Verify limits and data-use terms (D34): no document text to Gemini free (trains, human
   review) or Groq (training not stated); candidates llama3.1:8b (local), gemma-4-26b-a4b-it,
   qwen3-30b-a3b-fp8 (Workers AI); fan-out with Workflow steps, no Queues for now; ~16
   average contracts a day on gemma-4 (estimate).
2. ✅ Extraction eval first (D35): CUAD labels as the answer key per chunk, verbatim-quote
   rule, precision / recall / F1 per type, "grounded" quotes. Baselines on 510 contracts:
   all types F1 0.026, frequency guess 0.021, M3 keyword top-1 **0.203** (the bar to beat).
   Pinned subsets: 10 contracts / 473 chunks, 20 / 924.
3. ✅ The extractor (D36): `packages/extraction`, Zod form with closed type and risk lists,
   nonce-wrapped untrusted text, optional PII redaction with restore, verbatim-quote check
   with exact offsets; 18 tests with a fake model, 0 of 20 mutations survive.
4. ⏳ Measure on the pinned 10-contract subset (473 chunks), answers cached (D38). Laptop too
   slow; Groq gpt-oss-20b early signal on 68 chunks: F1 0.54 vs keyword 0.20 (whitespace-
   tolerant quotes, contract text cited). **Full subset on Workers AI gemma-4 (thinking off),
   run automatically by the nightly task after the embedding, about 3 nights**; then compare,
   choose the model, record.
5. ✅ Extraction Workflow in the Worker (D37): `POST .../extract`, `GET .../clauses`, parallel
   chunk steps (4), atomic daily Neuron budget, fencing, migration 0007 (not applied remotely
   yet); 20 tests, 0 of 19 mutations survive.
6. ✅ Reduce / merge (D39): `mergeClauses` (same type, overlapping or whitespace-separated),
   computed on read by `GET .../clauses?merged=true`; 14 tests, mutation-checked.
7. ✅ Cross-references (D40): inline definitions found too (35% -> 77% of CUAD clauses use an
   explainable term), definition text cut from the contract, `definitions` on every clause
   from `GET .../clauses`; checked on all 510 contracts; 16 mutations caught.
8. ⏳ Security tests, real run, deploy, learning log, quiz.
   - ✅ Injection test (D41): BIPIA's 75 public attacks planted in real CUAD chunks, Groq
     gpt-oss-20b, 65 of 75 so far (last 10 by the nightly task): the model visibly obeyed in
     4 (6%), **0 reached the stored result**; cost is availability (F1 0.61 -> 0.55).
   - ✅ Migration 0007 applied remotely and the extraction Workflow deployed (version
     `ce4c803b`, Marwan's OK, 2026-11-25); `/health` 200, new routes 401 without a key.
   - ✅ Real run (2026-11-26, Marwan ran `scripts/smoke.mjs`): all 28 checks passed;
     extraction of the smallest contract (1 page) on gemma-4 took 15.9 s, 4 clauses (Document
     Name, Renewal Term, Effective Date, Parties), exact quotes, merged view, no restart.
   - Nightly results so far: M3 corpus fully embedded; gemma-4 222 of 473 subset chunks, F1
     0.56 vs keyword 0.20 on the same chunks; injection 73 of 75, still 0 stored.
   - Next: CPU check of an extraction run, learning log, quiz.

## M2 plan

Goal: upload (PDF/DOCX) → checks + SHA-256 → `toMarkdown` → sanitize → structure-aware
chunks with exact offsets (`chunk.text === fullText.slice(start, end)`) and section paths →
D1 (every row has `tenant_id`).

1. ✅ Verify free-tier limits (results in `docs/DECISIONS.md` D14).
2. ✅ Download a pinned subset of CUAD contract PDFs: 30 PDFs (5 longest + 25 by hash order),
   up to ~154 pages, manifest with SHA-256 (`evals/cuad/README.md`, "Contract PDFs").
3. ✅ `packages/chunker`: structure-aware splitter (headings, numbered clauses like 7 / 7.1 /
   (a), definitions; size limits; offsets; section path), pure logic with unit tests. Design in
   `docs/DECISIONS.md` D15. Sanity run on all 510 CUAD contracts: 0 offset errors, 0 chunks
   over 4,000 chars, 0.067 ms per 1,000 chars (Node).
4. ✅ Evals on CUAD text: offset correctness (must be 100%), clause integrity (share of the
   13,823 lawyer-labelled clauses kept in one chunk; fixed-size splitting is the baseline).
   At equal chunk count: ours 99.41%, recursive (LangChain-style) 96.95%, fixed-size 83.97%.
   CI gate ≥ 0.993 and must beat both baselines (`evals/cuad/README.md`).
5. ✅ Ingestion flow in the Worker: upload checks, fingerprint, `toMarkdown`, sanitize, chunk,
   D1 schema as a migration, `env.DB` binding.
   - ✅ 5a CPU measured (D16): real contracts chunk in 4–9 ms on Workers; Queues give no CPU
     advantage on Free. Upload stays light; chunking runs as its own job step.
   - ✅ 5b D1 database `lexguard` created and migrated (local + remote), `DB` binding,
     tenant API keys as SHA-256 hashes in secret `TENANT_KEYS`, `/v1/*` requires a key;
     schema-level tenant isolation tested (D17). Chunking job will be a Workflow.
   - ✅ 5c `POST /v1/documents` (PDF/DOCX by bytes, 10 MB cap, SHA-256, toMarkdown,
     sanitize, idempotent and race-safe) and `GET /v1/documents/:id` (D18).
   - ✅ 5d chunking Workflow `ChunkDocument`: detection in 200k-char windows (one step
     each), plan, store in batches of 100, then `ready`; windowed == one pass on all 510 CUAD
     contracts (D19).
   - ✅ 5e end-to-end test, fencing token for the chunking job (stuck jobs restartable
     safely), capped streaming upload read, hostile ZIP tests (D20).
6. ✅ Conversion-quality eval: 30 CUAD PDFs through the real Worker. 97.96% of labelled clauses
   found, 98.63% kept whole (99.74% on CUAD text). Fixed: uploads failing (Blob type), page
   markers turned into a page map, chunker cut ranking (D21).
7. ✅ Security pass (daily quota, hidden PDF text measured, headers, logs; D22), deploy and
   smoke test (D23), upload CPU probe and fix (D24), learning log, quiz.

## M3 plan

Goal: hybrid search over a tenant's chunks (Vectorize + D1 FTS5, merged by reciprocal rank
fusion), each hit with exact offsets and page, measured against keyword-only and vector-only.

1. ✅ Limits checked; embedding model chosen and probed: `@cf/baai/bge-m3`, 1,024 dimensions;
   Vectorize space (~4,880 vectors) is the tightest limit (D25).
2. ⏳ Retrieval eval first: CUAD's clause-category questions as queries, the chunk holding the
   lawyer-labelled span as the answer; recall@k, MRR, nDCG; keyword / vector / hybrid (D26).
   Built; keyword measured on all 510 contracts, vector and hybrid on the 30 converted PDFs.
   **Open:** embed the rest of the corpus on Workers AI (9,000 Neurons a day, about 3 more
   days: start the probe Worker, then `npm run embed:cuad -w @lexguard/evals`), then decide
   hybrid / header with a paired comparison and set the CI gate.
3. ✅ `packages/retrieval`: contextual header, RRF, safe FTS5 query builder (`ftsQuery`,
   `scopedFtsQuery`, `reciprocalRankFusion`, `contextualHeader`). Fuzzed against real FTS5
   (never fails, never leaves tenant + document scope), two bugs fixed, 0 of 16 mutations
   survive (D27).
4. ✅ D1 migration 0005 `chunks_fts` (porter, tenant/doc scope tokens), applied locally;
   measured 1 write per chunk, reads ~2 per matching chunk of the searched document (D28).
   **Remote apply still to do, with Marwan's OK** (before step 7's real run).
5. ✅ `IndexDocument` Workflow after chunking (D29): migration 0006 (index state), embed in
   padded-size batches, upsert into the tenant's namespace, keyword rows, fenced, atomic space
   guard; tested with fakes plus a real end-to-end run with only the embedding step replaced;
   0 of 11 mutations survive. Vectorize index `lexguard-chunks` (1,024 dims, cosine) and its
   `doc` metadata index created 2026-11-24 with Marwan's OK, verified before any vector was
   written. **Still to do, with Marwan's OK:** apply 0005/0006 remotely.
6. ✅ `POST /v1/documents/:id/search` (D30): keyword + vector in parallel, RRF, vector IDs
   checked before fusion, every hit read back from D1 under the caller's tenant, exact
   offsets + page, untrusted-text note, keyword fallback when the vector side fails;
   0 of 13 mutations survive.
7. ✅ Real run on the 30 PDFs (D31): real toMarkdown, bge-m3 and Vectorize. Quality identical
   to the offline eval in every mode (hybrid MRR 0.550, keyword 0.528, vector 0.466); vectors
   searchable right after `indexed`; tenants isolated (404); Vectorize count = D1 count
   (1,820). Found and fixed: vectors searchable 53 s after `indexed` (indexing now waits),
   1 transient vector failure in 3,690 searches (now retried once), Windows cleanup EBUSY.
   CPU is measured after the deploy (step 8). Corpus embedding continues daily (step 2).
8. ⏳ Deploy and measure (D32). Prepared: re-upload indexes pre-M3 documents, smoke test
   checks indexing and search, `scripts/tail-cpu.mjs` filters tail output to CPU facts only.
   **Order (each Cloudflare action with Marwan's OK):**
   1. ✅ migrations 0005 + 0006 applied to the remote D1 (2026-11-25, Marwan's OK);
   2. ✅ deployed, version `c659a26e` (Workflow `lexguard-index-document` created); health
      200, search without a key 401;
   3. ✅ smoke test (Marwan): all 19 checks passed; the three pre-M3 documents were indexed by
      the re-upload (D32); hybrid search 438 ms, results from keywords and vectors.
      **Rotate the API key** (it appeared in a terminal shared with the assistant):
      `node apps/worker/scripts/new-tenant-key.mjs marwan --set`.
   4. ✅ CPU measured (D33): search 3-5 ms, status 0 ms, upload 15 ms (known, D24), chunking
      35 ms and indexing 102 ms per whole instance (~20 steps, all ok). The embedding step's
      CPU is mostly JSON, so batches are now 32 texts (was 100); redeployed as `201237a6`.
   5. ✅ `tail-cpu.mjs --record` (writes each event at once; PowerShell's `>` lost two captures).
   6. docs, learning log, quiz.

## Working rules (agreed)

- One milestone at a time; explain what and why before each step, then file by file after.
- Everything free: verify limits in official docs first; no credit card.
- Never put secrets in chat; `.dev.vars` locally, `wrangler secret put` in production.
- **No hand-written evaluation datasets.** Measurements use downloaded public data (licence
  checked, pinned revision, SHA-256). Unit tests with small examples are fine.
- Commits are authored by Marwan only, with no co-author trailers.
- Commit only after `npm run check` passes. Never quote a flagged secret, even in comments.
- Quizzes are multiple choice.
- Marwan reviews the code; explanations in plain language with examples. Keep them very
  simple (everyday analogies, small worked examples): the M3 quiz was 3/8 even after a full
  walkthrough.
- Ask before creating, deleting or deploying Cloudflare resources and before applying remote
  migrations. Marwan runs anything that needs his API key, entered with a hidden prompt; never
  read a terminal where a key may be on screen.

## Useful commands

```bash
npm run check                              # hidden chars, typecheck, lint, format, all tests
npm run fetch:gretel -w @lexguard/evals    # PII benchmark data (also downloaded in CI)
npm run fetch:cuad -w @lexguard/evals      # 510 real contracts with lawyer-labelled clauses
npm run fetch:cuad-pdfs -w @lexguard/evals # 30 original contract PDFs (M2 ingestion tests)
node evals/cuad/convert-run.mjs            # those PDFs through the real Worker (local, needs login)
npm run eval:watch -w @lexguard/evals      # Evalite case-by-case view
npm run deploy -w @lexguard/worker         # deploy (after `npx wrangler login`)
LEXGUARD_API_KEY=... node scripts/smoke.mjs <worker-url>   # production smoke test (your key)
node apps/worker/scripts/new-tenant-key.mjs <tenant> --set  # new API key, stored as the secret (run it yourself)
# M3
npx wrangler dev -c experiments/embed-probe/wrangler.jsonc  # probe Worker for corpus embedding (keep running)
npm run embed:cuad -w @lexguard/evals      # corpus embedding, 9,000 Neurons/day cap (NEURON_CAP=n), resumes
node evals/retrieval/live-run.mjs          # real retrieval path on the 30 PDFs (~1,100 Neurons; LIMIT=n)
npx vitest run --root evals retrieval/live.test.ts   # scores the live run
node scripts/tail-cpu.mjs --record tail-cpu.jsonl    # CPU facts from wrangler tail (Ctrl+C to stop)
node scripts/tail-cpu.mjs --summary tail-cpu.jsonl
PICK=3 node scripts/cpu-load.mjs <worker-url>        # one new upload + 20 searches (your key)
```

## Key numbers so far

- PII redaction on Gretel (5,000 docs): precision 0.966, recall 0.750 (CI gate 0.96 / 0.74).
- CUAD (510 real contracts): redaction changes 0.06% of characters, touches 0 of 13,823
  lawyer-labelled clauses.
- Chunking on CUAD (510 contracts, 13,823 clauses): 99.41% of clauses kept whole vs 96.95%
  for LangChain-style recursive splitting at the same chunk count; 0 offset errors.
- Real toMarkdown output (30 PDFs): 97.96% of clauses found, 98.63% kept whole.
- Retrieval on the 30 real PDFs (415 cases, live = offline, D31): hybrid MRR 0.550 / hit@5
  0.708; keyword 0.528 / 0.679; vector 0.466 / 0.641; random 0.125 / 0.222. Keyword on 510
  CUAD contracts: MRR 0.568 with stemming.
- Production CPU (D33): search 3-5 ms, status 0 ms, upload 15 ms (655 KB, known since D24),
  indexing ~5 ms per step.
- Tests: 558 (worker 162, a2a 34, chunker 68, extraction 51, guardrails 72, retrieval 26,
  router 13, trace 24, evals 108; the live-run and converted-PDF evals skip in CI).
