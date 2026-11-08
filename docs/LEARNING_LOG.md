# Learning Log

A plain-language diary: what I learned in each milestone, in my own words.
Newest milestone at the bottom. Technical decisions live in [DECISIONS.md](DECISIONS.md);
this file is about understanding.

---

## Milestone 0 — Foundations

_Draft written with Claude on 2026-11-08. Marwan: rewrite anything that is not how you would
explain it._

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

### Still to do in M0

- [ ] Deploy hello-world (`wrangler login`, then `npm run deploy -w @lexguard/worker`)
- [ ] Create the public GitHub repo and see CI run (when I decide)
