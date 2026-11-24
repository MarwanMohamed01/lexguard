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
