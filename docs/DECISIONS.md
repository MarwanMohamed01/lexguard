# Decisions

PROJECT.md is the original spec and stays untouched. This file records where we
deliberately deviated from it, or made a choice it left open, and why.
Limits were checked against the official Cloudflare docs in November 2026.
They change, so re-check before relying on them.

## D1. Document storage: D1 instead of R2

- **Spec said:** store uploads in R2.
- **Found:** enabling R2 asks for a payment method. Rule 3 of PROJECT.md is
  "free only, no card".
- **Decision:** convert PDF/DOCX to Markdown at upload time, store only the
  Markdown chunks (with offsets) in D1, and keep a SHA-256 hash of the original
  file as proof of provenance. The original binary is not stored.
- **Trade-off:** no re-conversion from the original, so conversion must be right
  the first time. Test documents live in `fixtures/` locally.
- **Revisit:** before M2, if we find we really need the original files.

## D2. Semantic caching: build our own

- **Spec said:** semantic caching via AI Gateway.
- **Found:** AI Gateway caching is exact-match only. Semantic caching is
  documented as planned, not available.
- **Decision (proposed, confirm before M6):** use the Gateway's exact-match cache
  for identical prompts, plus our own semantic cache in Vectorize keyed by the
  embedding of a normalized clause. Measure both hit rates.

## D3. Eval tool: Evalite 0.19.0

- **Choice:** Evalite (stable `0.19.0`), not Promptfoo and not the v1 beta.
- **Why:** TypeScript-native and built on Vitest, scorers are plain functions
  (good for deterministic metrics like span checks and F1), documented CI score
  thresholds.
- **Known gaps to verify:** Ollama support and output caching. If missing, write a
  small on-disk cache keyed by a hash of the prompt.
- **Fallback:** Promptfoo only if we later need generated attacks.

## D4. Version pins

| Tool            | Pin            | Reason                                                                                |
| --------------- | -------------- | ------------------------------------------------------------------------------------- |
| Node            | 22.x           | Per PROJECT.md. Installed: 22.23.4                                                    |
| TypeScript      | 6.0.3          | typescript-eslint supports `>=4.8.4 <6.1.0`, so TS 7 (latest) is not yet supported    |
| Vitest          | 4.1.12         | Evalite requires `^4`; `@cloudflare/vitest-plugin` accepts `^4.1.0 \|\| ^5.0.0`       |
| Wrangler        | 4.158.0        | Same version `@cloudflare/vitest-plugin` 1.6.0 bundles, so only one copy is installed |
| Package manager | npm workspaces | Already installed, fewer moving parts than pnpm                                       |

## D5. Free-tier budgets that shape the design

- Workers Free: 10 ms CPU per request (waiting on LLM calls does not count), 50 subrequests per invocation.
- Queues: 10,000 operations per day, about 3 per message, so batch chunks.
- D1 and Durable Objects: 100,000 row writes per day.
- Workers AI: 10,000 Neurons per day, so evals run locally on Ollama.
- Vectorize: 5M stored vector dimensions (about 6,500 vectors at 768 dims).

## D6. `legacy-peer-deps=true` in `.npmrc` (npm 10.9.9 workaround)

- **Problem:** `npm install vitest` crashes with `Cannot read properties of null
(reading 'edgesOut')` in npm's resolver. Reproduced in an empty folder with
  vitest 4.1.0, 4.1.11 and 4.1.12, so it is npm 10.9.9 vs vitest's peer graph,
  not our workspace.
- **Decision:** set `legacy-peer-deps=true` in the project `.npmrc`. It only
  changes this repo, not your global npm.
- **Cost:** npm no longer installs peers automatically or flags peer conflicts.
  We install peers explicitly and check with `npm ls --all` (clean on 2026-11-06).
- **Alternative not taken:** upgrading npm globally (changes the whole machine).
  Revisit if a newer npm is wanted.

## D7. Known `npm audit` findings (dev tooling only)

- 15 findings (9 moderate, 6 high) in dev dependencies: wrangler/miniflare,
  undici, sharp, zod (transitive), eslint, typescript-eslint, minimatch.
- npm's suggested fixes are all downgrades (pool-workers 0.12.21, eslint 9.39.5,
  typescript-eslint 8.36.0), which would break the version alignment in D4.
  `npm audit fix --force` is therefore not used.
- None of these tools run inside the deployed Worker. Review each advisory
  properly in M7 (supply chain) and decide upgrade, ignore with reason, or replace.

## D8. Workers test integration: `@cloudflare/vitest-plugin`

- `@cloudflare/vitest-pool-workers` is deprecated (renamed, no more updates).
  We use its replacement `@cloudflare/vitest-plugin` 1.6.0 with the
  `cloudflareTest()` Vite plugin, per the official docs.
- `@cloudflare/workers-types` is not installed: `wrangler types` generates both
  our `Env` type and the runtime types into `apps/worker/worker-configuration.d.ts`.
  That file is committed. Re-run `npm run types -w @lexguard/worker` after any
  change to `wrangler.jsonc`.

## D9. Dependabot ignores blocked upgrades

- Dependabot opened PRs for TypeScript 7.0.2 and Vitest 5.1.0 on day one; CI
  failed on both, confirming the constraints in D4.
- Decision: close those PRs and add `ignore` rules in `.github/dependabot.yml`
  for TypeScript `>=6.1.0` and Vitest major versions. All other updates still
  arrive normally.
- Revisit when typescript-eslint supports TS 7 (TypeScript rule) or when we move
  to an Evalite version built on Vitest 5 (Vitest rule). Check during M9 at the latest.

## D10. How PII redaction is evaluated

- **Rule: no hand-written evaluation datasets.** Anything that produces precision, recall or
  accuracy numbers uses downloaded public data (licence checked, pinned revision, SHA-256).
  Unit tests with small specific examples are still fine: they check rules, not quality.
- Why: a first hand-made PII set (33 cases, since removed) was written by the same author as
  the detector and flattered it (phone recall 0.875 there vs 0.456 on public data).
- **Gretel PII masking EN v1 (`evals/gretel`)** is the PII benchmark and the CI gate
  (Apache-2.0, 5,000 synthetic documents, 403 contract-like). CI downloads the pinned file,
  cached by revision.
- **CUAD** (real contracts, CC BY 4.0) is next: false-alarm rate on genuine legal text, and
  later the clause-extraction and quote-check evals.
- Bare digit runs are deliberately not treated as phone numbers (see
  `evals/gretel/README.md`, "Known remaining misses").

## D11. Phone numbers: libphonenumber (VALID) instead of hand-written patterns

- **Why:** phone detection must work for any country. Hand-written patterns encoded US, UK
  and Australian formats, and were partly tuned by looking at Gretel's misses.
- **Decision:** `libphonenumber-js` 1.13.15 (MIT; Google's numbering-plan metadata for ~240
  regions, "max" metadata) with **VALID** matching. International `+` numbers need no
  configuration; national formats need `phoneRegions` set per deployment (configuration,
  not code). A country-neutral filter rejects dates, amounts, decimals, IP addresses and
  bare digit runs.
- **Measured on Gretel (regions US/GB/AU):** overall precision 0.966 / recall 0.750; phone
  precision 0.912 / recall 0.537. The hand-written patterns scored phone 0.932 / 0.778, and
  POSSIBLE matching 0.820 / 0.761, a country-neutral shape rule 0.771 / 0.689.
- **Accepted cost:** lower phone recall on Gretel, largely because its synthetic numbers are
  often not in any allocated range, which VALID rejects. To verify on real documents.
- **CPU:** on Gretel's short, number-dense documents about 2 ms per 1,000 characters; on real
  CUAD contracts 0.40 ms per 1,000 characters, about 0.5 ms per 4,000-character chunk (Node
  timings). Fits a 10 ms Workflow step **per chunk**, but a whole contract in one call took up
  to 243 ms, so redaction must run per chunk. Confirm inside Workers in M2/M4.
- **Over-redaction on real contracts (CUAD, 510 contracts):** 0.06% of characters changed and
  0 of 13,823 lawyer-labelled clause spans altered (`evals/cuad/README.md`).

## D12. Card numbers need a standard layout and an issuer prefix

- CUAD showed 33 false card detections: rows of table figures and patent numbers passing the
  Luhn checksum by chance (about 1 in 10 random numbers does).
- Cards must now be compact, in groups of 4, or 4-6-5 / 4-6-4, with one separator style, and
  start with a card-issuer prefix (ISO/IEC 7812: 3-6, or 2221-2720). Country-neutral.
- Result: 0 card false alarms on CUAD; Gretel card precision 1.000, Luhn-valid recall
  0.982 → 0.977.

## D13. A2A: follow specification v1.0

- PROJECT.md (written against older drafts) says the Agent Card lives at
  `/.well-known/agent.json`. The current specification, v1.0.0
  (https://a2a-protocol.org/latest/specification/), uses **`/.well-known/agent-card.json`**,
  lists endpoints under `supportedInterfaces`, serializes enums as `TASK_STATE_*` / `ROLE_*`,
  names operations `SendMessage`, `GetTask`, `CancelTask`, and defines error codes
  -32001 to -32009. `@lexguard/a2a` follows v1.0.
- The spec fixes the terminal states (completed, failed, canceled, rejected) but no full
  transition graph; the table in `packages/a2a/src/lifecycle.ts` is our documented choice.
- Incoming messages are untrusted (T5): unknown fields are dropped, sizes are capped, URL
  parts must be HTTPS (T10). Security schemes and the HTTP endpoint come in M8.

## D14. Free-tier limits that shape M2 (checked 2026-11-22)

| Limit (Workers Free)            | Value                                                                             | Consequence for M2                                     |
| ------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Request body (upload)           | 100 MB (set by the domain's plan)                                                 | Reject larger uploads before reading them              |
| CPU per HTTP request            | 10 ms                                                                             | No heavy splitting inside the upload request           |
| CPU per Workflow step           | 10 ms; step result max 1 MiB                                                      | Splitting a whole contract cannot run in one step      |
| CPU per Queue consumer          | 30 s default per Queues docs; **unclear on Free** (Workers page lists only 10 ms) | **Measure in M2** before relying on it                 |
| Memory per isolate              | 128 MB                                                                            | Fine for a 300-page document's text                    |
| `toMarkdown` file size / pages  | Not stated in the docs                                                            | Test with CUAD's largest PDFs                          |
| D1 row / string                 | 2 MB                                                                              | A 300-page document's text (~1M chars) fits in one row |
| D1 SQL statement / bound params | 100 KB / 100 per query                                                            | Always use bound parameters; insert chunks in batches  |
| D1 queries per invocation       | 50 (`db.batch()` counts as one)                                                   | Batch chunk inserts                                    |
| D1 database / account storage   | 500 MB / 5 GB                                                                     | Per-tenant growth must be watched                      |

`toMarkdown` returns `{ id, name, format, mimetype, tokens, data, error? }` (note the lowercase
`mimetype`); PDF conversion is described as free "for most format conversions".

## D15. How `packages/chunker` splits documents

- **Pipeline:** detect candidates (numbered markers, ARTICLE/Section, EXHIBIT, Markdown
  headings, list items, definitions) → keep plausible headings → section tree → pack to size.
- **Numbering-sequence check instead of special cases:** a numbered marker is a heading only
  if it is the next step from the last one (deeper `.1`, next sibling, or up and next). This
  rejects cross-references ("Section 5.3" inside 17.2) and numbers in text ("thirty (30)").
  **Resync:** a rejected marker is still accepted when the next two markers continue from it,
  which recovers from headings garbled by PDF extraction and from tables of contents.
- **Contiguous coverage:** chunks cover the text with no gaps or overlap, so nothing can be
  lost and `chunk.text === text.slice(start, end)` is easy to prove. The contextual header
  for embeddings (M3) is built from `sectionPath`, never written into `text`.
- **Packing:** merge neighbouring sections up to `targetChars`; a new top-level section starts
  a new chunk unless the current one is under a quarter of the target; a section over
  `maxChars` is split at list items/definitions, then paragraph, line, sentence, whitespace,
  hard cut (never inside a surrogate pair). `sectionPath` is the path shared by all sections
  in the chunk, so it is empty when a chunk spans several top-level clauses (common in
  contracts numbered flat 1, 2, 3); `heading` names the first one.
- **Sizes are provisional:** 2,000 target / 4,000 max characters (the 4,000 matches the
  per-chunk redaction budget, D11). Final values follow the embedding model's documented
  input limit, checked in M3.
- **Offsets are UTF-16 code units** (JavaScript string indices). Python consumers must
  convert for characters outside the BMP.
- **Found on CUAD and fixed:** clauses glued to an ALL-CAPS heading by PDF extraction
  ("9. PROPRIETARY MARKS 9.1 Our Representations") were missed; a marker after an ALL-CAPS
  word now counts as a boundary, but only a bare number followed by a short title with
  lowercase letters. The first, looser version took cross-references in all-caps liability
  clauses for headings ("ARISING UNDER SECTION 8 OF THIS AGREEMENT"); the clause-integrity
  eval (step 4) found it.
- **Measured (step 4, CUAD):** 99.41% of 13,823 labelled clauses kept whole vs 96.95% for
  LangChain-style recursive splitting at the same chunk count (`evals/cuad/README.md`).

## D16. Where ingestion work runs on the Free plan (measured 2026-11-22)

- **Measured** with a throwaway probe Worker (`experiments/cpu-probe/README.md`): chunking
  real CUAD contracts of 230k–338k characters took 4–9 ms of CPU warm (Cloudflare's own
  `cpuTime`), about 2.5× faster than the Node estimate. No invocation was killed, even at
  57 ms, in HTTP or a Queue consumer.
- **Not relied on:** the documented Free limit is 10 ms per invocation, with unquantified
  "flexibility" for occasional overruns. Designs must fit 10 ms; leniency is only a margin.
- **Queues give no CPU advantage on Free** (same per-invocation limit per the Queues docs),
  answering the open question from D14.
- **Decision:**
  - The upload request does only light work: checks, SHA-256, `toMarkdown` (waiting on I/O),
    sanitize, store the Markdown in D1 (up to 2 MB per row, D14).
  - Chunking runs in its own invocation, as a step of a durable job, and writes chunks to D1
    itself (a Workflow step result is capped at 1 MiB; a long document's chunks exceed it).
    Workflow vs Queue is decided in 5b after checking Workflows' Free limits.
  - One invocation chunks up to about 300k characters (fits 10 ms warm with margin). The
    project's 200-page goal (roughly 600k+ characters) needs the chunker to work in windows
    across invocations, carrying its numbering state: built in step 5d.
- **Also learned:** `performance.now()` is frozen during CPU work on deployed Workers; the
  probe's bundle is 783 KB, mostly Zod (Free Worker size limit to check in 5b).

## D17. D1 schema, tenant isolation and API keys (2026-11-22)

- **D1 Free daily limits confirmed** on the pricing page: 5 million rows read, 100,000 rows
  written (an index adds one write per indexed row), reset at 00:00 UTC; over the limit every
  query fails until reset. A 300-page contract writes about 700 rows (chunks + definitions),
  so writes are the budget to watch: no secondary indexes until M3 needs them, and every
  query goes through a primary key (an unindexed filter counts every scanned row as read).
- **Schema** (`apps/worker/migrations/0001_ingestion.sql`): `documents`, `chunks`,
  `definitions`. Every primary key starts with `tenant_id`; children reference documents by
  `(tenant_id, document_id)`, so the database refuses a row linking one tenant's data to
  another tenant's document (tested). Duplicate files are detected per tenant
  (`UNIQUE (tenant_id, sha256)`), never globally: a global check would reveal to tenant B
  that tenant A uploaded the same file. Chunk text is stored next to its offsets because
  M3's keyword search (FTS5) needs it in a table (about 2× storage; CUAD-sized corpus ≈ 54 MB
  of the 500 MB per database).
- **Workflows, not Queues, for the chunking job** (5d): 10 ms CPU per step and up to 1,024
  steps per instance on Free, per-step retries that resume where they stopped, step results
  up to 1 MiB. Windowed chunking maps onto one step per window. Workflow code is capped at
  3 MB on Free; the Worker bundle is 770 KiB today (dry run), mostly Zod.
- **Tenant API keys:** the Worker stores only SHA-256 hashes, in the secret `TENANT_KEYS`
  (`{"<hash>": "<tenant id>"}`), validated with Zod; a missing or invalid secret refuses
  every request (fails closed, 500). Keys are `lg_` + 256 random bits, created locally with
  `apps/worker/scripts/new-tenant-key.mjs` and never shown to anyone but their owner.
  Everything under `/v1/` requires a key. A minimal stand-in until M8's scoped tokens.

## D18. Upload and status endpoints (M2 step 5c, 2026-11-22)

- **API:** `POST /v1/documents` takes the raw file as the body (display name in a
  percent-encoded `X-Filename` header); `GET /v1/documents/:id` returns status and metadata,
  never the full text. Another tenant's ID answers 404 exactly like a missing one.
- **Only PDF and DOCX, detected from the bytes** (`%PDF-` header; a ZIP whose central
  directory lists `word/document.xml`). Name and `Content-Type` are ignored. Reasons:
  they are the contract formats, and `toMarkdown` is free for them, while image
  conversion uses Workers AI models and neurons (docs). The converter receives a name built
  from the detected type.
- **10 MB cap**, refused from `Content-Length` before the body is read. Hashing costs
  CPU (about 2 ms per MB); the largest CUAD PDF is 1.56 MB. To be measured at deploy (step 7)
  and lowered if needed. The converted text must fit one D1 row (2 MB) or the document fails
  with `text_too_large`, never truncated. The `toMarkdown` docs state no size or page limits.
- **Idempotent and race-safe:** the upload reserves a `converting` row with
  `INSERT ... ON CONFLICT DO NOTHING`, so the same file uploaded twice at once converts once.
  A failed document, or one stuck in `converting` for 10 minutes (its request died; tracked
  by `updated_at`, migration 0002), is reclaimed by the next upload of the same file with a
  single atomic `UPDATE`.
- **Sanitized once, at upload** (`sanitizeText` from `@lexguard/guardrails/sanitize`, a
  subpath export so the Worker does not bundle the PII code): the stored text is what every
  offset and citation refers to; the number of removed hidden characters is stored.
- **Tests never reach Cloudflare:** `toMarkdown` always runs remotely, so the converter is
  passed in as a dependency and tests use a fake one; `remoteBindings: false` in the test
  config stops the test runner from opening a remote session with the developer's login
  (CI has none). The real converter is evaluated on CUAD PDFs in step 6.

## D19. The chunking Workflow and windowed detection (M2 step 5d, 2026-11-22)

- **Measured where chunking spends CPU** (Node, largest CUAD contracts): the regex passes
  that detect headings and split points take about 90% (27.7 ms of ~29 ms on 335k chars);
  choosing headings, building sections and packing take about 9 ms for 2.8M chars. So only
  detection needs splitting across invocations.
- **Windowed detection is exact by construction:** windows start just after a line break
  (no pattern consumes a line break; look-behinds stay on their line), each window reads a
  2,000-char margin extended across whitespace runs for look-aheads, and keeps only matches
  that start inside it. Checked on all 510 CUAD contracts with 20k-char windows (1,055 edges):
  identical chunks, sections and definitions. Mutation-tested: removing the margin or the
  whitespace extension makes the unit tests fail.
- **Workflow `ChunkDocument`:** `load` (skip unless the document is still `chunking`, clear
  chunks from earlier attempts) → `detect i` per 200k-char window → `plan` (offsets only,
  stays under the 1 MiB step result) → `store chunks i` (100 rows per `db.batch`,
  `INSERT OR REPLACE` so retries are safe) → `store definitions i` → `finish` (`ready`).
  Steps retry 3 times with exponential backoff; after that the document becomes `failed`
  (`chunking_failed`) and a re-upload retries it. Step outputs are marked `sensitive` so
  contract text stays out of the dashboard. A 1M-char document takes about 15 steps.
- **Text is sliced in JavaScript, never with SQL `substr`:** SQLite counts code points,
  JavaScript counts UTF-16 units; SQL slicing would shift every offset after an emoji.
- **Upload starts the job** after storing the text; if it cannot start, the document fails
  with `chunking_not_started` (503) instead of sitting in `chunking` with nobody on it.
- **Found and fixed:** the Worker bundled Zod twice (the test plugin pins 4.6.6, which took
  the top-level slot, so each workspace nested its own 4.6.7): 1,572 KiB. A root npm
  `overrides` entry forces one 4.6.7: back to 798 KiB, well under the 3 MB Workflow limit.
- Real CPU per step on Cloudflare is measured at the step 7 deploy.

## D20. Fencing the chunking job; hardening the upload (M2 step 5e, 2026-11-23)

- **Gap found:** a document stuck in `chunking` (its job ended without managing to mark it
  failed) could never recover, and simply letting a re-upload restart it was unsafe: if the
  old job was only slow, two jobs would interleave deletes and inserts and finish `ready`
  with chunks missing.
- **Fix: a fencing token** (`documents.chunk_job`, migration 0003). Each conversion hands the
  document to a new job ID, which is also the Workflow instance ID. Every Workflow read
  checks it and every write is conditional on it in the same SQL statement
  (`INSERT ... SELECT ... WHERE EXISTS (owner check)`); a retry claim and the finish step
  clear it. A replaced job stops and ends `superseded` without failing the document. Same
  idea as a JPA `@Version` column. With it, a re-upload restarts a document stuck in
  `chunking` for over an hour (`STALE_CHUNKING_MS`). Mutation-tested: the SQL-level check
  alone stops a replaced job; removing both layers makes the test fail.
- **Measured: the runtime does not enforce `Content-Length`** (header 10, body 20: all 20
  bytes are read). The upload now reads the body as a stream and stops as soon as it passes
  10 MB, so a lying header cannot make the Worker buffer up to 100 MB in a 128 MB isolate.
- **Hostile files tested:** a ZIP naming `word/document.xml` only in an entry header (not in
  the central directory) is rejected; an end record claiming 65,535 entries is rejected in
  under 50 ms.
- **End-to-end test:** upload → real Workflow → `ready`, with hidden characters, emoji and
  CRLF in the converted text: chunks equal the chunker's output on the stored sanitized text,
  each is an exact slice, and together they rebuild the text.

## D21. Conversion quality and what it changed (M2 step 6, 2026-11-23)

- **Measured on the 30 CUAD PDFs through the real Worker** (`wrangler dev`, real
  `toMarkdown`): all 30 convert (largest 154 pages, 23 s); 97.96% of 1,174 labelled clauses
  found in the converted text; 98.63% kept whole in chunks, vs 99.74% when chunking CUAD's
  own text for the same contracts. Details in `evals/cuad/README.md`.
- **Bug found: every real upload failed.** `toMarkdown` rejects a Blob without a MIME type;
  the fake converter in tests did not. The Blob now carries the type detected from the bytes,
  pinned by a test. Lesson: a fake must be checked against the real thing at least once.
- **Page markers become a page map.** toMarkdown writes `### Page N` headings (mid-sentence)
  inside a `# document.pdf` / `## Metadata` / `## Contents` wrapper. `src/pages.ts` removes
  them, joins pages with one line break and stores page start offsets in
  `documents.page_starts` (migration 0004) for page-level citations; the status endpoint
  reports `pages`. Strict: only markers numbered 1, 2, 3... in order after the wrapper;
  anything else leaves the text unchanged with no page map. `no_text` is checked after
  removing the wrapper, so a scan (wrapper only) is still refused.
- **Conversion options:** `pdf.metadata: false` (not contract text; can leak author or
  software) and image conversion off for PDF and DOCX: no Workers AI neurons, and no
  model-written image descriptions entering the stored text as if the contract said them
  (a planted image could otherwise inject text).
- **Chunker cut ranking changed:** sentence end (and line break after a sentence end) now
  rank above a bare line break. toMarkdown output has no blank lines and a line break per
  wrapped line, so line-break cuts fell mid-sentence (25 of 34 broken clauses). CUAD-text
  results unchanged (99.41%, same 17,026 chunks).
- **Known limits, not fixed yet:** toMarkdown glues separate text pieces without a space
  (`RIGHTS10.1 Except`), so headings are under-detected (3,244 sections vs 4,021); repeated
  page footers stay in the text. Repairing either by guessing risks damaging real text.
- **Local-only eval:** CI has neither the PDFs nor a Cloudflare login. The run is recorded
  (`evals/results/cuad-conversion.json`), the gates (clause recall ≥ 0.975, integrity
  ≥ 0.98, stored chunks = chunker output) run whenever the converted files exist.
