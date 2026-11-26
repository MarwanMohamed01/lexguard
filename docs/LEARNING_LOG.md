# Learning Log

A plain-language diary: what I learned in each milestone, in my own words.
Newest milestone at the bottom. Technical decisions live in [DECISIONS.md](DECISIONS.md);
this file is about understanding.

---

## Milestone 0 — Foundations

### The big picture

- Lexguard is like a small **law firm made of AI agents**: a supervisor splits a long contract
  into parts, extractors read the parts in parallel, researchers look up rules, a verifier
  checks every claim has a real quote, and a synthesizer writes the report.
- A 200-page contract is too big to give to a model in one go. We **split it by structure**
  (headings, numbered clauses) and keep the exact position of every piece, so every claim
  can be traced back to a quote.

### Cloudflare, compared to what I already know

| Cloudflare          | What I already know                      | One-line idea                                                     |
| ------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| Worker              | A FastAPI endpoint without a server      | A function that wakes up per request                              |
| Bindings (`env.DB`) | Injected dependencies / connection pool  | Access to D1, Queues etc. without connection strings or passwords |
| Durable Object      | A small stateful object with its own DB  | One agent's memory during a run                                   |
| Workflow            | A pipeline that resumes after a crash    | The "process this document" job                                   |
| Queue               | RabbitMQ                                 | Hand work to many workers in parallel                             |
| D1                  | SQLite                                   | Text, chunks, keyword search (FTS5)                               |
| Vectorize           | A vector DB                              | Search by meaning                                                 |
| `wrangler`          | The project CLI (like `mvn` / `uvicorn`) | Run, test, deploy                                                 |

- **CPU time is not wall-clock time.** The free plan gives 10 ms of CPU per request, but time
  spent _waiting_ for an AI model does not count. Like ordering food: only typing the order
  counts, not waiting for the delivery.
- **`compatibility_date`** pins the Workers runtime behaviour to a date, like pinning
  `python==3.12`. Cloudflare updates cannot silently change our Worker. (I first thought it
  was a deploy schedule; it is not.)

### "Free" always has limits — check them first

- I verified every limit in the official docs instead of trusting memory. The ones that shape
  the design: Queues 10,000 ops/day (~3 per message, so batch), D1/DO 100,000 row writes/day,
  Workers AI 10,000 Neurons/day (so evals run locally on Ollama).
- **Two surprises changed the plan:**
  - R2 asks for a credit card, so we store converted text in D1 and keep only a SHA-256 hash
    of the original file (like scanning a paper contract and noting its serial number).
  - AI Gateway caching is exact-match only. Semantic caching (similar prompts hit the cache)
    is not available, so we will build our own with Vectorize in M6.

### Tools and why each exists

- **TypeScript strict**: catches bugs before running, like a strict type checker for Python.
  `noUncheckedIndexedAccess` means `list[0]` might be missing.
- **ESLint (type-aware)**: catches real bugs, e.g. a promise I forgot to `await`.
- **Prettier**: formats code so nobody argues about style.
- **Vitest + `@cloudflare/vitest-plugin`**: tests that run inside the real Workers runtime.
- **Evalite**: tests for AI _quality_ ("found 90 of 100 clauses?"), chosen because it is
  TypeScript, built on Vitest, and lets scorers be plain functions.
- **npm workspaces**: one repo, several sub-projects, like a Maven multi-module build.
- **`package-lock.json`**: exact versions of everything, like `poetry.lock`.

### Debugging lessons

- **Tools constrain each other.** "Latest of everything" broke: typescript-eslint does not
  support TypeScript 7 yet, and Evalite needs Vitest 4. Versions must fit together.
- **Isolate the problem.** `npm install vitest` crashed. I tried it alone, then in an empty
  folder, then with older versions. Failing in an empty folder proved our setup was not the
  cause: it was an npm 10.9.9 bug. Workaround: `legacy-peer-deps=true` in the project
  `.npmrc`, then check peers manually with `npm ls`.
- **Don't blindly "fix" audit warnings.** `npm audit fix --force` wanted to _downgrade_ our
  tools. We recorded the findings to review properly in M7 instead.
- **Packages get deprecated.** The Workers test package was renamed; reading the installed
  README revealed it before we built on it.

### CI and supply-chain security

- **CI** is a robot that runs our checks on every push, on a fresh Linux machine.
- **`npm ci`** installs exactly the lock file; `npm install` may change it.
- **Pin Actions to commit SHAs**, not tags: a tag can be moved to malicious code, a SHA cannot.
- **Least privilege**: the CI token can only read the repo.
- **gitleaks** scans all history for leaked secrets (the repo will be public).
- **Dependabot** proposes updates weekly; CI tells us if an update breaks something.

### Threat modelling

- Four questions: what do we protect (assets), who attacks (attackers), where does trust
  change (trust boundaries), what do we do and not do (mitigations, non-goals).
- **The contract itself can be the attack**: hidden text like "ignore your instructions".
- **A bigger model is not a defence** against prompt injection; structure is. The quarantined
  reader has no tools and can only fill a fixed form, so even if it is fooled it cannot act.
  Like a mail-room clerk who can sort letters but has no access to the bank account.
- **Verification is code, not another AI**: a quoted span must appear verbatim at its offset.
- Being honest matters: we do not claim perfect injection prevention; we measure the attack
  success rate before and after guardrails.

### Quiz scores

- npm and tooling: 3/3 · Worker basics: 3/4 (missed `compatibility_date`)
- CI: 3/3 · Threat model: 3/4 (missed "quarantined reader beats bigger model")
- Deploy: 0/3 → after recap 3/4. Remaining gap: API keys never go in `wrangler.jsonc` (it is committed and public); use `wrangler secret put` / `.dev.vars`

### Still to do in M0

- [x] Deployed hello-world on 2026-11-08 at https://lexguard.marwan-dev.workers.dev (`/` → JSON, `/health` → ok, other paths → 404). Bundle: 0.41 KiB, startup 1 ms.
- [x] Public repo https://github.com/MarwanMohamed01/lexguard created and pushed on 2026-11-08. CI green on Linux. Lesson: the first push failed gitleaks with exit code 1 (tool error, not a leak) because the push range started at the root commit, which has no parent; a manual full-history run passed.
- [x] Dependabot immediately proposed TypeScript 7 and Vitest 5; CI failed on both, as expected. The safety net works.

---

## Milestone 1 — Core packages

### What was built

Four small libraries in `packages/`, pure logic with no Cloudflare services or AI calls, so
they are fast to test and can be reused (like Maven modules):

| Package      | Job                                     | Example                                                   |
| ------------ | --------------------------------------- | --------------------------------------------------------- |
| `trace`      | Flight recorder of every step and call  | run → step → model call, with tokens, cost, duration      |
| `guardrails` | Security toolkit                        | hide `jane@acme.com` as `[EMAIL_1]` before calling an AI  |
| `router`     | Pick the cheap or the strong model      | invalid answer from the small model → ask the large one   |
| `a2a`        | Standard way for other agents to use us | Agent Card at `/.well-known/agent-card.json`, task states |

### Ideas worth remembering

- **Inject the clock and IDs** instead of reading globals: tests become exact ("this step took
  40 ms") and the code runs anywhere. Same idea as injecting a `Clock` in Java.
- **Batch writes** (`flush()`) because free D1 writes are limited per day; keep the batch if
  the write fails so nothing is lost.
- **Unknown cost is `null`, not `0`**: never report something as free when you do not know.
- **Zod = Pydantic for TypeScript.** TypeScript types disappear at runtime, so data from
  outside (AI answers, other agents, downloads) must be checked by Zod while the code runs.
- **Default deny.** The tool policy refuses anything not explicitly allowed, and uses a `Map`
  because `obj["constructor"]` on a plain object returns a function, not `undefined`.
- **The router is plain code, not an AI.** It escalates on objective signals only: high risk
  known in advance, schema failure, a failed check like "the quote is not in the source".
  It cannot catch a well-formed but wrong answer; evals measure that.
- **A2A v1.0** changed things since PROJECT.md was written (`agent-card.json`, `TASK_STATE_*`).
  Always check the current spec before building on a protocol.

### Evals: the biggest lesson of M1

- **No hand-made datasets.** My first PII test set was written by the same person as the
  code, so it flattered it: phone recall 0.875 there, 0.456 on public data. Measurements now
  come only from downloaded datasets (Gretel PII, CUAD contracts), pinned and hash-checked.
- **Unit tests are not datasets.** "A date is not a phone number" checks a rule; precision and
  recall need independent data.
- **Precision vs recall.** Precision: when we redacted, was it really PII? Recall: of all the
  real PII, how much did we catch? Low recall leaks data; low precision damages the contract.
- **Generic beats tuned.** Hand-written US/UK phone patterns scored best on Gretel because I
  tuned them on Gretel. Google's libphonenumber works for ~240 countries with no country code
  in our repo; it scores lower on Gretel partly because Gretel's numbers are fake.
- **Real data finds real bugs.** CUAD showed 33 false "card numbers" (table figures, patent
  numbers passing the Luhn checksum by chance). Fixed with the card standard's layouts and
  issuer prefixes: 0 false cards, and 0 of 13,823 lawyer-labelled clauses touched.
- **Mutation checks test the tests**: break the code on purpose; a good test must fail.

### Debugging and process lessons

- **Invisible characters in source code** ("Trojan Source"): escapes like `\u200B` were saved
  as real invisible characters. A check in `npm run check` now fails on them.
- **Generated files** (eval results) must not be checked by the formatter, or CI fails.
- **Never evaluate downloaded text as code**: Gretel's labels are Python syntax, so a small
  strict parser reads them instead.
- **Rewriting git history** changes every commit ID and needs a force push; safe only because
  I am the only contributor. Commits are now authored by me only.

### Numbers (Gretel test split, 5,000 documents, regions US/GB/AU)

- PII redaction: precision 0.966, recall 0.750 (CI fails below 0.96 / 0.74).
- Emails: recall 0.999. Cards: recall 0.977 on valid numbers. Phones: precision 0.912,
  recall 0.537 (generic library, VALID matching).
- Only 12.2% of labelled PII is a type we detect at all (names, addresses, IDs are not):
  the main open gap, for M7.

### Tests at the end of M1

164 tests: worker 3, trace 24, guardrails 72, router 13, a2a 34, evals 18.

### Quiz score

- End of M1: 3/4. Missed: a well-formed but wrong answer from the small model is **accepted**
  by the router, not escalated. The router only escalates on objective signals (schema
  failure, failed checks, high risk known in advance); how often wrong answers slip through
  is measured by evals in M6.

---

## Milestone 2 — Ingestion & splitting

### What was built

The front door of Lexguard, live at https://lexguard.marwan-dev.workers.dev:

**PDF/DOCX → checks → fingerprint → `toMarkdown` → sanitize + page map → D1 → chunking
Workflow → chunks + definitions → `ready`**

| Piece                    | Job                                                                 |
| ------------------------ | ------------------------------------------------------------------- |
| `packages/chunker`       | Split a contract along its structure (7 / 7.1 / (a)), exact offsets |
| D1 schema (4 migrations) | Documents, chunks, definitions; `tenant_id` first in every key      |
| `src/auth.ts`            | API key → tenant; only SHA-256 hashes stored; fails closed          |
| `src/upload.ts`          | Type from bytes, 10 MB, exact length, convert, sanitize, page map   |
| `ChunkDocument` Workflow | Detect in windows, plan, store in batches; retries; fencing ticket  |
| Evals on CUAD            | Clause integrity, windowed = one pass, real conversion quality      |

### Ideas worth remembering

- **Offsets are the contract.** `chunk.text === text.slice(start, end)` is what makes every
  future citation checkable. Everything that changes text (sanitizing, page markers) happens
  once, before storing; offsets point into exactly the stored text.
- **Measure the baseline you would otherwise use.** Our chunker keeps 99.41% of lawyer-labelled
  clauses whole vs 96.95% for LangChain-style splitting at the same chunk count. Without the
  baseline, "99%" would mean nothing.
- **Isolation in the schema, not only in code.** Composite foreign keys make the database
  itself refuse a chunk linked to another tenant's document. Duplicates are detected per
  tenant, because a global check would tell tenant B what tenant A uploaded.
- **Workflows = durable steps.** Each step is its own invocation (own CPU budget), its result
  is saved, a failed step is retried alone. Retried writes must be safe to repeat
  (`INSERT OR REPLACE`).
- **Fencing token = optimistic locking (`@Version`).** Each chunking job holds a ticket; every
  write checks it in the same SQL statement, so a slow, replaced job can no longer change
  anything. That made "restart a stuck job" safe.
- **Window the expensive part only.** 90% of chunking CPU was regex detection, which only
  needs nearby text; windows start at line starts and read a margin ahead. Proven equal to
  one pass on 510 contracts with 1,055 window edges.
- **Fail closed.** A broken secret refused everyone (500), twice, during the first deploy.
  Annoying, and exactly right.

### Real runs found what tests could not

- **Every upload would have failed in production:** `toMarkdown` rejects a file Blob without a
  MIME type; the fake converter in tests accepted it. A fake must be checked against the real
  thing at least once.
- **`toMarkdown` inserts `### Page N` headings mid-sentence.** Turned into a page map (useful
  for citations) instead of headings. Removing them exposed two more things: converted text
  glues words (`RIGHTS10.1`) and has no blank lines, so cutting at line breaks split
  sentences. Fixed the cut ranking; real-output integrity 98.63%.
- **Two copies of Zod** doubled the bundle (1.57 MB): an npm `overrides` line fixed it.
- **The runtime does not enforce `Content-Length`** (in a local test): body reading must
  enforce it.
- **Measure before refactoring.** I blamed sanitizing for the 28 ms upload; a probe showed it
  costs 2 ms. The real costs: `toMarkdown` 13 ms (unavoidable) and my own body-reading loop
  5 ms (fixed with the native `FixedLengthStream`: 1 ms).
- **Hidden PDF text survives conversion** (white, tiny, invisible mode): measured, documented,
  handed to M7. Some defences belong in a later layer; say so instead of pretending.

### Debugging and process lessons

- Invisible characters keep sneaking into test files (written literally instead of escaped);
  the `check:hidden` guard caught every one before a commit.
- PowerShell treats `{...}` as code: secrets are now set by a script that pipes the value, so
  nothing is pasted. Keys printed with indentation got copied with the spaces: trim inputs.
- Never let the assistant read a terminal where a secret is on screen.

### Numbers

- Chunking on CUAD text (510 contracts, 13,823 clauses): 99.41% kept whole; 0 offset errors.
- Real `toMarkdown` on 30 PDFs (up to 154 pages): 97.96% of clauses found, 98.63% kept whole.
- Production: 154-page upload 21 ms CPU (nominal Free limit 10 ms, tolerated), chunking job
  29 ms in total; all smoke checks pass.

### Tests at the end of M2

347 tests: worker 102, trace 24, guardrails 72, router 13, a2a 34, chunker 59, evals 43 (6 of
them need the locally converted PDFs and skip in CI).

### Quiz score

- End of M2: 4/8. All four design questions right (offsets for checkable citations, per-tenant
  duplicates, fencing ticket, windows for CPU per step); all four "what real runs found"
  questions missed:
  - `### Page N` markers are **removed and kept as a page map**, not left as headings (they
    cut clauses at page breaks).
  - The biggest upload CPU cost is **`toMarkdown`** (13 ms), not the D1 write (1 ms).
  - White-on-white PDF text **survives** conversion; nothing in M2 can see appearance. The
    defence is M7's dual-model design.
  - Uploads would have failed because the **fake converter accepted a Blob without a MIME
    type**; the secret problem caused 500s on `/v1/`, later and separately.
  - To revisit before M3: D21 (conversion findings), D24 (CPU probe), the T2 row of the
    threat model.

---

## Milestone 3 — Index & retrieval

### What was built

Search inside a contract, live at https://lexguard.marwan-dev.workers.dev:

**ready document → indexing Workflow (embed → Vectorize, copy → FTS5, wait until searchable)
→ `POST /v1/documents/:id/search` → keyword + vector in parallel → RRF → read back from D1**

| Piece                       | Job                                                                |
| --------------------------- | ------------------------------------------------------------------ |
| `packages/retrieval`        | Safe FTS5 queries, scope tokens, RRF, contextual header, batching  |
| Migration 0005 `chunks_fts` | Keyword index, tenant + document as filter columns                 |
| Migration 0006              | Index state: status, ticket, version, vector count, error          |
| `IndexDocument` Workflow    | Embed in size-capped batches, upsert, keywords, wait, finish       |
| `src/search.ts`             | The search endpoint: checks, both searches, fusion, read-back      |
| Retrieval eval              | CUAD's questions as queries, lawyer labels as answers, 3 methods   |
| Live run + smoke + CPU      | The same eval through the real services; production checks and CPU |

### Ideas worth remembering

- **Two kinds of search, one ranking.** Keywords (FTS5, bm25) find the exact words; vectors
  (bge-m3) find the meaning. Reciprocal rank fusion merges them using only positions,
  because a bm25 score and a cosine similarity cannot be compared.
- **The eval comes first.** CUAD's own questions and lawyer labels, no hand-made queries. On
  the 30 real PDFs: random MRR 0.125, vector 0.466, keyword 0.528, hybrid 0.550. Keyword search
  beats vector search here because CUAD's descriptions use the clauses' own legal words.
- **Choose the embedding model by the data.** bge-base reads only 512 tokens, and more than
  half of our chunks are longer: it would have embedded half a clause without saying so.
  bge-m3 reads them whole and costs 5.6× less.
- **Free-tier limits decide the design.** The tightest limit is Vectorize space (about 4,880
  vectors for everyone), not Neurons. So a space guard reserves room atomically in D1 before a
  single embedding is made.
- **Filters belong inside the query language, with zero weight.** Filtering by document after
  FTS5's MATCH made it score the whole table (28 ms → 5.6 ms when moved inside). But bm25 also
  scored the filter term, which reordered results, until the filter column got weight 0.
- **Treat user text as data in every language.** FTS5 has its own syntax (`OR`, `NEAR(`,
  `col:`). Pasting a question into MATCH let a fuzz test reach another tenant's rows; quoting
  each word never did, over 5,006 hostile inputs.
- **The system of record decides.** Vectorize is an index, not the truth: every hit is read
  back from D1 under the caller's tenant, and a vector ID that is not this document's chunk is
  dropped before it can take a place in the results.
- **Mutation checks keep finding real gaps.** In every step, some deliberate breakage first
  survived the tests: a ticket check before embedding, a stale vector emptying a `limit: 1`
  search, a tie-break nobody tested.

### What the real runs found (the part I missed in the M2 quiz)

M3 built on three M2 findings:

- **D21:** converted PDFs glue words (`RIGHTS10.1`) and have no blank lines. In M3 this
  showed up again: FTS5 cannot find `RIGHTS` in `RIGHTS10`, and the converted PDFs score
  lower than CUAD's clean text.
- **D24:** measure before refactoring. M3 repeated the lesson: I blamed Zod for the embedding
  step's CPU (0.5 ms); the cost was parsing about 1 MB of JSON (5.9 ms). Fix: 32 texts per
  batch instead of 100.
- **T2:** hidden PDF text survives conversion, so it is indexed and searchable too. Search
  results therefore carry a note: the text is untrusted data, never instructions (defence in
  M7).

New in M3, found only by running the real services:

- **Workers AI pads every batch to its longest text and bills the padding.** One 842-token
  text costs 842 tokens alone, 4,210 with four 6-token texts. So batches are sorted by length.
  The 60,000-token "context" is per request, not per text.
- **Vectorize is asynchronous: vectors answered 53 s after "indexed".** Hybrid search quietly
  fell back to keywords meanwhile. Now indexing waits until its last vector answers a query,
  so "indexed" means searchable (0.5 s after, measured on 30 documents).
- **The real path matched the offline eval to three decimals.** Vectorize's approximate search
  lost nothing on 200-vector documents, and D1's FTS5 ranked exactly like local SQLite. The
  offline eval can be trusted for the real system.
- **Old documents would never have been indexed.** Re-uploading a ready but unindexed document
  now starts indexing; the smoke test backfilled the M2 documents that way.
- **PowerShell's `>` writes only at the end, and Ctrl+C discards it.** Two CPU captures came
  out empty before the recorder wrote each event itself.

### Debugging and process lessons

- Free daily limits are a schedule: the corpus embedding runs 9,000 Neurons a day, capped
  from the Neurons each response reports, and resumes the next day from a cache.
- A fixed wait in a test hides timing bugs; poll with a deadline instead.
- An API key typed into a shared terminal is exposed: rotate it, and read keys with a hidden
  prompt (`Read-Host -AsSecureString`).

### Numbers

- 30 real PDFs, 415 cases (live = offline): hybrid MRR 0.550, hit@5 0.708; keyword 0.528 /
  0.679; vector 0.466 / 0.641; random 0.125 / 0.222.
- Keyword search on 510 CUAD contracts (6,702 cases): MRR 0.568 with stemming, 0.546 without.
- Production CPU: search 3-5 ms, indexing about 5 ms per step; 1 transient vector failure in
  3,690 searches (now retried once).

### Tests at the end of M3

440 tests: worker 138, a2a 34, chunker 59, guardrails 72, retrieval 26, router 13, trace 24,
evals 74.

### Quiz score

- End of M3: 3/8 (after a full plain-language walkthrough). Right: why RRF (scores on
  different scales), the 53 s Vectorize delay, live = offline. Missed:
  - Workers AI bills the **padded** batch: 842 + four 6-token texts costs 5 x 842 = 4,210
    tokens, not 866. That is why batches are sorted by length.
  - The FTS5 ranking was fixed by **zero bm25 weight on the filter column**
    (`bm25(fts, 1.0, 0.0)`), not by an index: an index cannot change how bm25 scores.
  - The embedding step's CPU was **parsing ~1 MB of JSON** (5.9 ms), not Zod (0.5 ms), and
    waiting for the model is not CPU at all. Fix: 32 texts per batch.
  - bge-m3 was chosen because bge-base reads only **512 tokens** and would silently cut 54% of
    our chunks; bge-m3 actually has **more** dimensions (1,024 vs 768).
  - Hidden white text (T2) is **not removed**: it is chunked, indexed and searchable, and
    results are labelled untrusted. The real defence is M7's quarantined reader.
  - To revisit before M4: D26 (padding), D27/D28 (zero-weight filter), D33 (JSON CPU), D25
    (512 tokens), T2.

## Milestone 4 — Extraction swarm

### What was built

The system now READS a contract, live at https://lexguard.marwan-dev.workers.dev:

**ready document → `POST .../extract` → extraction Workflow (one step per chunk, 4 at a time,
daily Neuron budget) → extractor on each chunk → checked clauses in D1 → `GET .../clauses`
(per chunk, or merged, with definitions)**

| Piece                      | Job                                                                     |
| -------------------------- | ----------------------------------------------------------------------- |
| `packages/extraction`      | Prompt, Zod form, quote check, merge, defined-term matching             |
| Migration 0007             | Extraction state, `clauses` (offsets, no quote), audit, Neuron budget   |
| `ExtractDocument` Workflow | Load, chunk steps in parallel, reserve Neurons atomically, finish       |
| `src/clauses.ts`           | Start extraction; return clauses, merged view, definitions              |
| Chunker `findDefinitions`  | Also inline definitions `(the "Supplier")`; `definitionSpan` cites them |
| Extraction eval            | CUAD labels per chunk, P/R/F1 per type, baselines, cached answers       |
| Injection eval             | BIPIA's 75 public attacks planted in real chunks                        |
| Nightly task               | Embedding, gemma eval and injection cases, unattended, self-disabling   |

### Ideas worth remembering

- **The extractor is a quarantined reader.** It reads untrusted text, has no tools, and can
  only fill a closed form: 41 clause types, 5 risk flags, short capped details. Contract text
  sits inside `<document id=NONCE>` tags, so a fake closing tag cannot be guessed.
- **Code checks the model.** Every quote must be in the chunk (whitespace may differ), and
  what is stored is the CONTRACT's text at that position, never the model's words. A clause
  with an invented quote is dropped.
- **The eval comes first, with baselines.** CUAD's lawyer labels per chunk. Guessing all
  types: F1 0.026; keyword search top hit: 0.20. Groq gpt-oss-20b: 0.54; gemma-4 (production)
  on 222 chunks: 0.56. A model must beat search to be worth its Neurons.
- **Check privacy before sending text anywhere.** Gemini's free tier trains on prompts, so no
  document text goes there; Groq does not say, so only public CUAD contracts go there.
- **Free limits shape the design.** Queues allow about 3,300 messages a day, so the fan-out
  is Workflow steps. A shared daily Neuron budget is reserved in one conditional UPDATE
  before each call, so parallel steps cannot overspend.
- **Merge on read.** A clause cut by a chunk border is two pieces; they are joined when the
  clauses are read (same type, overlapping or only whitespace between), so the stored data
  never changes.
- **Inline definitions doubled what can be explained.** Only "X means" was found before (35%
  of lawyer clauses used such a term); with `(the "Supplier")` it is 77%.

### What the real runs found

- **gemma-4 answered nothing at first:** "thinking" is on by default and the answer sits in
  `choices[0].message.content`, not `response`. The production Worker had the same bug.
- **9 of 13 rejected quotes differed only in whitespace** (a line break for a space). The
  check now ignores whitespace but still cites the contract's own text: F1 0.45 → 0.54.
- **My laptop was too slow** for a local model (1.5 tokens/s); a 3B model got 0 right. Free
  hosted models on public data were the fast path.
- **A Vitest `describe` body runs even when the suite is skipped.** Reading a local-only file
  there broke CI; data is read in `beforeAll`.
- **Injection: the quarantine held.** The model visibly obeyed 4 of 65 attacks (3 cipher or
  Base64 answers that broke the JSON, 1 invented "Fact" clause about Mount Everest); none
  reached the stored result. The cost is availability: F1 0.61 → 0.55 on attacked chunks.

### Debugging and process lessons

- Mutation checks again found gaps in every step (a definition looked up at the wrong place,
  a short term beating a longer one, a resample averaged over the wrong count).
- Writing files from PowerShell can change their encoding: `Get-Content`/`Set-Content` garbled
  emoji in PROGRESS.md. Restore from git and use an editor or UTF-8 without BOM.
- An unattended nightly task should resume from caches and stop itself when done.

### Numbers

- Baselines on 510 contracts: all types F1 0.026, frequency guess 0.021, keyword top-1 0.203.
- Groq gpt-oss-20b, 68 chunks: F1 0.54 (P 0.57, R 0.52). gemma-4, 222 of 473 chunks: F1 0.56
  (P 0.47, R 0.70), keyword 0.20 on the same chunks.
- gemma-4: about 2,150 input and 150 output tokens per chunk, ~32 Neurons with clauses.
- Definitions on 510 contracts: 15,291 found (8,323 inline), all cited.
- Injection (BIPIA, Groq): 73 of 75 so far, 0 stored.
- Live smoke: a 1-page contract extracted in 15.9 s, 4 clauses.
- M3 closed in this milestone (D42): hybrid beats keyword by +0.022 MRR, 95% interval
  [+0.015, +0.030] on 510 contracts; contextual header off.

### Tests at the end of M4

571 tests: worker 162, a2a 34, chunker 68, extraction 51, guardrails 72, retrieval 26, router
13, trace 24, evals 121.

### Quiz score

- During M4: quote-check question answered A (right: B, code checks the quote against the
  chunk). Definitions question and the Base64 (integrity vs availability) question not yet
  answered.
- End of M4 (2026-11-26): 5/8. Right: whitespace-tolerant quote check that stores the
  contract's own text, Workflow steps instead of Queues (about 3,300 messages a day), the
  atomic Neuron reservation, 35% -> 77% with inline definitions, no contract text to Gemini
  free or Groq. Missed:
  - **Merge on read** is not about Neurons (merging is plain code and costs none). It keeps the
    stored per-chunk clauses unchanged as evidence, so the merge rules can be improved later
    without re-extracting.
  - **gemma-4's empty answers** came from thinking being on by default and the answer sitting
    in `choices[0].message.content`, not `response`; the budget was not empty.
  - **The injection attacks cost availability, not integrity.** Nothing false was stored (0 of
    65); broken JSON answers just lost real clauses on attacked chunks (F1 0.61 -> 0.55).
  - To revisit early in M5: D39 (merge), D38 (thinking), D41 (integrity vs availability).

## Milestone 5 — Research, verification, synthesis

### What was built

Lexguard now **judges** a contract against rules and writes a cited report, live at
https://lexguard.marwan-dev.workers.dev:

**`POST .../review` (rules + my side's policy) -> review Workflow (4 rules per step: hybrid
search -> top 10 sentences -> screen -> checker -> verifier) -> `GET .../report` (JSON or
Markdown)**, plus a rulebook MCP server with OAuth at https://lexguard-rulebook.marwan-dev.workers.dev/mcp.

| Piece                    | Job                                                                            |
| ------------------------ | ------------------------------------------------------------------------------ |
| `packages/rulebook`      | GDPR (786 rules from the Official Journal) + 17 NDA rules, citable IDs         |
| `apps/rulebook-mcp`      | MCP tools get/list/search rules; OAuth for outside apps, private door inside   |
| `packages/checker`       | Quarantined reader: rule + passages -> agrees / conflicts / silent + quotes    |
| `packages/verifier`      | Code re-checks every claim against the stored contract; resolves "Section 5.3" |
| `packages/report`        | One finding per rule, rulebook-template redlines, escaped Markdown             |
| `packages/guardrails`    | + a screen for text that reads like an instruction to an AI                    |
| Review Workflow + 0008/9 | The pipeline in the Worker, fenced, budgeted                                   |
| ContractNLI eval         | 607 NDAs with expert labels: the checker's answer key                          |

### Ideas worth remembering

- **Measure the ceiling before the model.** A fake "oracle" that answers like the expert but
  sees only our top-10 passages scores macro F1 0.925. The bar (each rule's usual answer,
  never reading) is 0.617. So the checker's job is the gap between them, and above 0.925 only
  better search helps. You can tell "the model is weak" from "the model never saw the proof".
- **No evidence, no claim.** "agrees" or "conflicts" without a quote found in the contract
  becomes "silent"; the report says "not addressed", never a guess. The first live review
  answered "not addressed" for 4 rules, and it was right: the contract never mentions them.
- **Look at WHY answers are rejected.** The first Groq score was below the bar (0.552). The
  model was fine: it copied our own `[2]` passage labels into its quotes. Stripping our label in
  code raised it to 0.694 without changing the model or the prompt.
- **Scores from different collections don't compare.** BM25 over the GDPR and over the NDA
  rules separately gave "confidential" very different weights; one combined collection fixed
  it. Same lesson as bm25 vs cosine in M3.
- **Free limits shape the design, again.** 3,000 Workflow steps a day -> 4 rules per step;
  10 ms CPU per step -> the database finds the chunks, and the verifier and report read only
  those chunks, never the whole contract.
- **OAuth has no "machine login" here.** Outside apps sign in through a consent page (my API key,
  checked by the main Worker over a private line); our own pipeline uses a private service
  binding instead of a stored token. Edge OAuth, service identity inside.
- **Quote checks cannot catch a lie about meaning.** If a fooled model flips the verdict but
  quotes a real sentence, every check passes. Only keeping the attack away from the model
  helps: screening took a worst-case 339/340 down to 30/340.

### What the live runs found

- **MCP Inspector needed dynamic client registration**, which I had switched off; turned on
  for apps on this computer only (localhost), 1-day expiry, a burst limit.
- **The Inspector reused old saved metadata** (from before registration was on) without asking
  again; a fresh URL (`?fresh=1`) fixed it. A client-side cache can make a fixed server look
  broken.
- **My pasted API key had 2 invisible extra characters** (48 stars for a 46-character key);
  the consent page now trims.
- **Escapes typed into a tool came out as invisible characters** (a no-break space in a
  regex); the hidden-character check now also refuses characters that look like a space.

### Debugging and process lessons

- Mutation checks found weak tests in every step: an "order" check that matched the summary
  table instead of the findings, a fencing test that never reached the write it was meant to
  guard, an "external reference" test that passed only because the section number did not
  exist.
- Tune on one set, measure on another: the screen caught 75/75 on its training attacks and
  69/75 on held-out ones. The held-out number is the real one.
- Shell edits keep eating backslashes in regexes; use the editor for patterns.

### Numbers

- ContractNLI (2,091 test pairs): bar macro F1 0.617; oracle ceiling at top-10 passages 0.925.
  Groq gpt-oss-20b, first 148 pairs: 0.694 (run still going).
- Section references on 510 CUAD contracts: 88.2% of internal ones resolve.
- Verifier: 2,091/2,091 oracle claims verify; 5,223/5,223 tampered copies rejected.
- Screen (held-out): 92% of attacks, 0.26% / 0.09% false alarms.
- Live review: 4 rules in 11.3 s, 26.7 Neurons.

### Tests at the end of M5

776 tests: worker 178, rulebook-mcp 58, rulebook 24, checker 26, verifier 25, report 14,
guardrails 88, a2a 34, chunker 68, extraction 51, retrieval 26, router 13, trace 24, evals 147.

### Quiz score

- During M5: 7 check questions asked along the way, folded into the end-of-M5 quiz.
- End of M5 (2026-11-26): **7/8** (M3 3/8, M4 5/8). Right: the quarantined checker (no tools,
  code picks rules, verifier drops unproven claims), the bar (0.60 < 0.617 is not yet useful),
  the oracle ceiling (search, not the checker), one BM25 collection, the private service
  binding, screening against a flipped verdict that quotes a real sentence, tuning vs held-out
  measurement. Missed:
  - **The first Groq score was low because the model copied our own `[n]` passage labels into
    its quotes**, so 55 of 58 unfound quotes were really there and 36 verdicts were wrongly
    downgraded. Rate limits only made the run slow (median 7.7 s per call, waits up to 8
    minutes); they never cut an answer short (0 empty answers). Lesson: before blaming the
    model or the provider, look at why our own code rejected the answers (D49).
