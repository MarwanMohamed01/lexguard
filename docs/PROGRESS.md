# Progress

Where the project stands and how to resume. Read together with `PROJECT.md` (the spec),
`docs/DECISIONS.md` (deviations and their reasons) and `docs/LEARNING_LOG.md`.

_Last updated: 2026-11-26._

## Status

| Milestone                                | Status                                              |
| ---------------------------------------- | --------------------------------------------------- |
| M0 Foundations                           | ✅ Done                                             |
| M1 Core packages                         | ✅ Done (CI and full-history secret scan green)     |
| M2 Ingestion & splitting                 | ✅ Done (deployed, smoke test green)                |
| M3 Index & retrieval                     | ✅ Done (deployed; full-corpus eval and gates, D42) |
| **M4 Extraction swarm**                  | ⏳ Nearly done (deployed; eval finishing nightly)   |
| **M5 Research, verification, synthesis** | ⏳ **Next** (new chat)                              |
| M6 Routing & caching                     | Not started                                         |
| M7 Guardrails & red team                 | Not started                                         |
| M8 A2A & observability                   | Not started                                         |
| M9 Evals in CI & write-up                | Not started                                         |

Deployed Worker: https://lexguard.marwan-dev.workers.dev, version `41e1d114` (2026-11-26: M5 review
pipeline with the instruction screen, migrations 0008-0009, D53; before: `bcca83bf`, Workflow `lexguard-review-document`, D52; before: `b2acbd6c` with the
private `TenantAuth` entrypoint, D47; before that: `ce4c803b`, 2026-11-25:
M2 ingestion + M3 indexing and search + M4 extraction: upload, status, chunking, indexing
and extraction Workflows, `POST /v1/documents/:id/search`, `POST .../extract`,
`GET .../clauses`; smoke test `scripts/smoke.mjs`, D23/D32/D41). Cloudflare resources: D1
`lexguard` (migrations 0001-0009 applied remotely), Vectorize index `lexguard-chunks` (1,024
dims, cosine, metadata index `doc`), Workers AI, Workflows `lexguard-chunk-document`,
`lexguard-index-document` and `lexguard-extract-document`, secret `TENANT_KEYS`.

Rulebook MCP server: https://lexguard-rulebook.marwan-dev.workers.dev/mcp, version `f7d3784a`
(2026-11-26, D46/D47): OAuth 2.1, KV `OAUTH_KV` (`b2317d0c...`), service binding to
`lexguard#TenantAuth`, private entrypoint `RulebookInternal`. Repo:
https://github.com/MarwanMohamed01/lexguard (public).

## Resume here (next chat: start M6, planned for 2026-11-27)

**M5 is built and deployed** (D43-D53): rulebook + MCP server with OAuth, checker, verifier,
report, review pipeline in the Worker, instruction screen. End-of-M5 quiz 7/8. M6 is not
blocked by the M5 leftovers below; they are runs that finish on their own plus short follow-ups.

First in the new chat:

1. ✅ **Overnight runs checked (2026-11-27):** M4 step 4 closed (gemma-4 F1 0.52 vs keyword
   0.17 on all 473 chunks, D38); Groq checker re-scored on 200 of 340 pairs (macro F1 0.654 vs
   bar 0.588 on the same pairs, D49); gemma-4 checker 289 of 340 (on the same 200 pairs
   macro F1 0.692 vs Groq 0.654, evidence precision 0.94; D49). Still open: the last 2
   injection cases (D41, nightly) and the last 51 gemma-4 checker pairs (after 00:00 UTC: start the probe Worker, then
   `PROVIDER=workers-ai npm run check:contractnli -w @lexguard/evals`); Groq's other 140 pairs
   are optional now.
2. **Start M6 (routing & caching)**: explain M6 simply with small examples, draft the plan, verify
   free-tier limits in the official docs first (AI Gateway caching, Workers AI models and
   prices), design the M6 eval before building (D10: public data only). Build with fake models
   first; gemma-4 is the measured default checker (D49); a stronger model mainly for
   contradiction verdicts.

## Open items (carry into M6)

- **M5 leftovers (D49, D53, D52):** the last 51 of 340 gemma-4 checker pairs
  (289 done 2026-11-27, stopped at the daily Neuron cap); a real-model run of planted attacks
  against the checker; a live review that quotes
  something (Marwan, smoke test on a larger contract); the screen's false alarms on list items
  after "shall not:" (read the previous sentence, measure on fresh data).
- **Marwan:** `git push` (24+ local commits); rotate the API key (open since M3).

- **M4 finishing by itself (nightly task, D36):** the scheduled task "Lexguard nightly
  embedding" (`scripts/nightly-embed.ps1`, 01:10 local) still runs: embedding and the gemma-4
  extraction subset are complete (night of 2026-11-27), only the last 2 of 75 injection cases
  (Groq) remain; they failed again with 429 because Marwan's checker run used the same Groq
  daily budget. The task disables itself when they are answered. Then re-score
  (`LIMIT=0 npm run injection:cuad -w @lexguard/evals`) and update D41 with 75 of 75. Run the
  rest of the Groq checker (`PROVIDER=groq npm run check:contractnli -w @lexguard/evals`) only
  after that night's run.
- **M4 CPU check of an extraction run:** Marwan starts an extraction on the middle smoke
  contract (4 pages) while `node scripts/tail-cpu.mjs --record tail-cpu.jsonl` records; needs
  his key and about 200 Neurons.
- ✅ **M3 closed 2026-11-26 (D42):** hybrid really beats keyword (+0.022 MRR, 95% interval
  [+0.015, +0.030], 510 contracts); contextual header off; CI gates set.
- **Rotate the API key** (it appeared in a terminal shared with the assistant on 2026-11-25):
  `node apps/worker/scripts/new-tenant-key.mjs marwan --set`.
- Not built yet: deleting a document (its vectors, FTS rows and clauses; retention, D25); an
  index or extraction stuck in `indexing` / `extracting` whose job never ran (D32); a
  per-tenant daily search and extraction cap (T15, D30); section cross-references ("as set
  out in Section 5.3", D40, the M5 verifier needs them); flagging instruction-like lines in
  chunks (D41, M7).

## M5 plan (draft, explained to Marwan on 2026-11-26; explain each step again before starting)

Goal: for each extracted clause, find the rules that apply, decide whether the clause meets,
breaks or ignores each rule, keep only claims whose quotes code can find in the contract and in
the rule text, and write a cited report with suggested edits (redline).

Design idea (dual-model, T1/T2): the agent that reads contract text (the **checker**) has no
tools and fills a closed form; choosing which rules to fetch is done by code from the clause
TYPE (typed data, not contract text) through the rulebook MCP server. The Workflow is the
supervisor (budgets, stop conditions); no LLM decides what runs.

1. ✅ Limits and licences (D43): stateless `createMcpHandler`, no Durable Object (`McpAgent`
   is deprecated); OAuth needs a KV namespace (1,000 writes a day); **Workflows 3,000 steps a
   day on Free** (new), so checks are grouped per step; ContractNLI CC BY 4.0; EUR-Lex texts
   reusable, pinned once, no web access at run time.
2. ✅ Eval first (D44): **ContractNLI** pinned and hashed, 2,091 test pairs; scorer (macro F1,
   evidence P/R/F1, coverage@k). Bar to beat: majority label per hypothesis, macro F1
   **0.617** (overall majority 0.211); keyword top 10 spans hold some expert evidence for 89%
   of addressed pairs. Pinned subset 20 NDAs / 340 pairs; 9 tests, 0 of 11 mutations survive.
3. ✅ Rulebook data (D45): `packages/rulebook`, GDPR from the Official Journal (Cellar, pinned)
   as 786 rules with legal-citation IDs (`gdpr:28(3)(a)`), and the 17 ContractNLI rules as
   an NDA playbook; committed data, identical rebuild; hidden-character check widened to
   space look-alikes; 15 tests, 0 of 26 mutations survive.
4. Rulebook MCP server on Workers (`apps/rulebook-mcp`), full OAuth (Marwan's choice).
   - ✅ 4a (D46): MCP SDK 2.4.0's stateless `createMcpHandler` (no `agents` package, no
     Durable Object); tools `get_rule`, `list_rules`, `search_rules` (BM25 over one combined
     corpus, so scores compare); 36 tests with a real MCP client; 1 equivalent mutation left.
   - ✅ 4b (D47): full OAuth on public `/mcp` (`OAuthProvider`, CIMD clients, no dynamic
     registration), consent page with sign-in by Lexguard API key via the main Worker's private
     `TenantAuth`; private service-binding door `RulebookInternal` for the pipeline (option A);
     threat model T9 tested, T21 added; 30 + 19 tests; 1 equivalent mutation left.
   - ✅ Deployed 2026-11-26 with Marwan's OK: KV `OAUTH_KV` created, main Worker `b2acbd6c`,
     `lexguard-rulebook` `4511c133`; 8 live checks from outside passed (401 + discovery, tenant
     header ignored, made-up token 401, metadata with CIMD on and no registration, unknown
     client rendered not redirected, `TenantAuth` 404 publicly).
   - ✅ 4c (D48): the first demo showed MCP Inspector needs dynamic registration; turned on with
     guards (localhost redirect URIs only, 1-day expiry, 5 a minute); redeployed `lexguard-rulebook`
     `9fbb4cfd`; live checks passed. Residual: a script can use up a day of KV writes (M7 cap).
   - ✅ Demo (2026-11-26, Marwan's recording): MCP Inspector registered, consent page, key,
     Allow, "Authorization complete", Connected, `tools/list` OK. Two findings on the way
     (stale saved discovery state in the client; whitespace in the pasted key, now trimmed,
     `f7d3784a`). Still to record for the README GIF: a `get_rule` call.
   - The client pins the tool-schema hash (rug-pull check): M7.
5. ⏳ Checker (D49): `packages/checker` built (quarantined reader, verdict agrees / conflicts /
   silent, no evidence = no claim, quotes under 3 words ignored); ContractNLI runner with cache.
   Ceiling with keyword top 10 passages (oracle, no model): macro F1 **0.925** (bar 0.617).
   First Groq run (148 of 340 pairs): models copied our `[n]` passage labels into quotes;
   stripped in code, re-scored: macro F1 **0.694** vs bar 0.586 (D49). **Still to do:** finish
   the 340 pairs (Marwan's Groq run resumes from the cache; re-score with `LIMIT=0` after it
   ends, since a run started before the fix scores with the old code), gemma-4 when the nightly
   task frees Neurons, then choose k (10 or 20).
6. ✅ Verifier (D50): `packages/verifier` re-checks each claim against the stored contract and
   the rulebook (any mismatch rejects it); section references found and resolved (88.2% of
   internal references on 510 CUAD contracts, CI gate 0.87); all 2,091 oracle claims verify and
   all 5,223 tampered copies are rejected; 23 tests, 0 of 18 mutations survive.
7. ✅ Report (D51): `packages/report`, one finding per rule from verified claims only, policy
   require/forbid per rule, redlines from the rulebook's own wording (no model), escaped
   Markdown; reports for 20 NDAs pass every invariant; 14 tests, 0 of 17 mutations survive.
   Open: scope and policy per rule come with the review request (step 8; depends on the side).
8. ✅ Review pipeline (D52): `POST .../review` (scope + policy per rule), `ReviewDocument`
   Workflow (4 rules per step; hybrid search -> top 10 sentences -> checker -> verifier on the
   loaded chunks), `GET .../report` (JSON / Markdown), migration 0008; tested locally with a
   fake model (11 tests, 0 of 17 mutations survive). ✅ Deployed 2026-11-26: 0008 applied
   remotely, Worker `bcca83bf`. Smoke test (Marwan): all 35 checks passed; review of 4 NDA rules on
   the smallest contract in 11.3 s, 26.7 Neurons, all 4 correctly "missing" (D52).
9. ✅ Security (D53): worst case with a model that always obeys planted attacks: 340/340 flipped
   verdicts without defences, **30/340** with the screen + verifier rule; screen 92% recall, 0.26%
   / 0.09% false alarms on held-out data; rulebook bytes pinned in CI; threat model T1, T19, T22;
   learning log; quiz 7/8. ✅ Deployed: 0009 applied remotely, Worker `41e1d114`.

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
4. ✅ Measure on the pinned 10-contract subset (473 chunks), answers cached (D38). Laptop too
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
   - ✅ Step 4 closed 2026-11-27 (D38): gemma-4 on all 473 chunks, precision 0.43, recall 0.66,
     F1 0.52 vs keyword 0.17; gemma-4 is the extraction model.
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
2. ✅ Retrieval eval first: CUAD's clause-category questions as queries, the chunk holding the
   lawyer-labelled span as the answer; recall@k, MRR, nDCG; keyword / vector / hybrid (D26).
   Full corpus (510 contracts, 6,702 questions) embedded; paired comparison clustered by
   contract: hybrid +0.022 MRR [+0.015, +0.030] over keyword, header -0.009 [-0.012,
   -0.005]; hybrid stays, header off; CI gates (D42).
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
- ContractNLI test split (2,091 pairs, D44): majority label macro F1 0.211, majority per
  hypothesis 0.617 (the checker's bar); keyword top 10 spans hold expert evidence for 89%.
- Tests: 776 (worker 178, rulebook-mcp 58, checker 26, verifier 25, report 14, a2a 34, chunker 68, extraction 51, guardrails 88,
  retrieval 26, router 13, rulebook 24, trace 24, evals 147; the live-run, converted-PDF and hybrid-gate evals skip in
  CI).
