# Lexguard — Long-Document Contract & Compliance Analysis Swarm

> Hand this file to the Claude session that will build this project. Read it fully before doing anything.

## 0. How you (the assistant) must work with me

I am Marwan, a software engineer (Python, Java, FastAPI, Spring Boot, RAG, data pipelines, n8n, Ollama; **new to Cloudflare, TypeScript-first Workers, MCP servers and A2A**). My goal is to **learn and fully understand everything**, and to end with a strong portfolio project. There is no deadline.

Rules for the session:

1. **One milestone at a time.** Before each step, explain *what* we are about to do and *why*. After it, explain what was built, file by file, and how it connects to the rest.
2. **Teach, don't just generate.** For every new concept (Durable Objects, Workflows, Queues, Vectorize, AI Gateway, MCP, A2A, prompt injection defenses) give a short explanation with the trade-offs, then implement it. Where reasonable, let me write or review key pieces, and quiz me briefly at the end of each milestone.
3. **Everything must be free.** No paid services, no credit card. Before depending on any Cloudflare/model/API limit, **verify the current free-tier limit from official docs** (limits change) and tell me. If a feature would need a paid plan, stop and propose a free alternative.
4. **Never ask me to paste secrets in chat.** Use `wrangler secret put` and `.dev.vars` (git-ignored). You must not create accounts or enter credentials for me; tell me exactly what to do and wait.
5. **Security is the product, not an add-on** (see section 5). Every milestone ends with its security tests.
6. **Evals before features get "done".** A feature is not finished until it has a measured eval.
7. Commit in small, meaningful steps (I will tell you when to create the GitHub repo; it will be **public**).
8. Keep a `docs/LEARNING_LOG.md`: after each milestone, add what I learned, in plain language.

## 1. What we are building

A multi-agent system on **Cloudflare Workers** that takes a **long contract or policy document (50–300 pages)**, extracts and classifies its clauses, checks them against a compliance rulebook (e.g. GDPR articles, standard-clause playbooks), researches unclear clauses with a swarm of researcher agents, verifies every claim against quoted source text, and outputs a **cited, redlined risk report**.

Core ideas to demonstrate: long-context handling by splitting (not by stuffing), parallel agent swarm, model routing, semantic caching, A2A interoperability, MCP tools, strong security guardrails, and rigorous evals.

## 2. Free-tier stack (verify limits first — Milestone 0)

| Need | Choice | Known catch (verify) |
|---|---|---|
| Compute | Cloudflare Workers | Free plan: ~10 ms CPU/request, request/day cap. Waiting on I/O (LLM calls) is not CPU. |
| Stateful agents | Cloudflare Agents SDK on Durable Objects (SQLite-backed) | Free plan supports SQLite-backed DOs only. |
| Durable orchestration | Workflows | Free plan limits apply. |
| Async fan-out | Queues | Small free quota. |
| File storage | R2 | Free allowance. |
| Relational + keyword search | D1 (with FTS5) | Free allowance. |
| Vectors | Vectorize | Free allowance. |
| Models | Workers AI free daily allowance + free tiers of Gemini / Groq (or similar) | Daily limits are small; evals run **locally with Ollama** and cached outputs. |
| Gateway, caching, analytics | AI Gateway | Core features free. |
| PDF/DOCX to Markdown | `env.AI.toMarkdown` (verify) or a local/CI ingestion script | Avoid heavy parsing in a 10 ms CPU Worker. |
| CI | GitHub Actions (public repo) | Free for public repos. |

Language: **TypeScript** (strict). Validation: Zod. Tests: Vitest (+ `@cloudflare/vitest-pool-workers`). Evals: Evalite or Promptfoo (pick one in M0 and justify), plus Python scripts where convenient (I know Python well).

## 3. Architecture

### 3.1 Long-document handling (the heart of the project)

1. **Ingest:** upload to R2; convert PDF/DOCX to Markdown.
2. **Structure-aware split:** split by headings, numbered clauses and definitions, never by fixed size alone. Each chunk keeps its section path, page/offset span, and parent heading (needed for exact citations).
3. **Contextual headers:** prefix each chunk with document title, section path and a one-line summary before embedding.
4. **Hybrid index:** embeddings in Vectorize + keyword search in D1 FTS5; merge results (e.g. reciprocal rank fusion); optional rerank step.
5. **Map phase:** a Workflow fans chunk batches out through Queues; parallel *extractor* agents output typed clauses (Zod schema: type, text span, parties, obligations, dates, risk flags).
6. **Reduce phase:** merge and deduplicate clauses, resolve cross-references ("as defined in 1.2") by injecting definitions where the term is used.
7. **Hierarchical summaries:** chunk → section → document, used for navigation only; **facts must always trace back to quoted source spans**.
8. Handle failure: retries, idempotency, partial results, resumable runs.

### 3.2 Agents

- **Supervisor:** plans the job, assigns work, enforces budgets and stop conditions.
- **Extractors (parallel):** structured clause extraction per chunk batch.
- **Researchers (parallel swarm):** look up the matching regulation text and playbook rules from an allowlisted knowledge base (and fetch-only, domain-allowlisted web access); each returns findings with sources.
- **Risk analyst:** scores each clause against the rulebook.
- **Verifier / fact-checker:** rejects any claim lacking a quoted, verifiable source span.
- **Synthesizer:** writes the redline and the final report.

Study and compare orchestration patterns (hierarchical, parallel, debate) and document why we chose ours.

### 3.3 Required features

- **Model routing:** a cheap model first; escalate to a stronger one on low confidence, schema-validation failure, or high-risk clauses. Log route decisions and measure cost vs. quality vs. escalation rate.
- **Semantic caching via AI Gateway:** repeated and near-identical prompts (standard boilerplate clauses) are served from cache; measure hit rate and savings.
- **A2A endpoint:** publish an Agent Card at `/.well-known/agent.json` and implement a task endpoint (submit document, poll status, fetch result) so other agents can use Lexguard. Lexguard is **fully standalone**: it must be complete and demonstrable without any other project. The sibling project **CodeWarden** may optionally call this endpoint at the very end (its M8, a bonus integration) to review policy/legal files in PRs — keep the contract clean and documented, and test it with a small mock A2A client of our own.
- **MCP:** build at least one **remote MCP server on Workers** (e.g. `rulebook` tool: look up regulation articles / playbook rules; and a `clause-store` tool) with OAuth-style scoped access, and consume it from the agents.
- **Observability:** every run produces a trace (steps, tool calls, model, tokens, cost estimate, latency) stored in D1 and shown in a simple trace viewer page.
- **Versioning:** prompts and model IDs are versioned; each eval run records which versions produced it.

## 4. Optional extras (after the required scope works)

Long-term memory of prior reviews in Vectorize; human approval UI; cost dashboard; eval leaderboard page; canary/shadow prompt rollouts.

## 5. Security guardrails (core deliverable)

Write a **threat model** (`docs/THREAT_MODEL.md`) first: assets, attackers, trust boundaries, what we do and do not defend against.

- **Prompt injection from documents:** a contract may contain "ignore previous instructions…". Use the dual-model pattern: a *quarantined reader* (no tools, outputs only schema-validated data) and a *privileged actor* that never sees raw untrusted text. Treat all document, web and tool output as data.
- **Tool policy:** per-agent allowlists, Zod argument validation, read vs. write scopes, human approval for risky actions (e.g. exporting a report).
- **MCP security:** scoped tokens; pin/hash tool schemas to detect tool-description poisoning and rug-pulls.
- **Data protection:** PII redaction before model calls, no secrets in prompts, output filtering for leaks, tenant isolation (per-tenant namespaces in R2/D1/Vectorize).
- **Abuse limits:** per-run token/cost caps, rate limits, loop detection, kill switch.
- **Audit log** of every tool call and decision, with replay.
- **Supply chain:** pinned dependencies, Dependabot, gitleaks in CI.

Keep reusable pieces (router, guardrails, A2A helpers) in `packages/` as clean, well-tested modules. CodeWarden does not depend on them; it may copy them later if useful.

## 6. Evals

- **Clause extraction:** precision/recall/F1 on the free **CUAD** dataset (subset).
- **Citation faithfulness:** does each cited span actually support the claim? (deterministic span check + LLM-judge, with the judge validated against a hand-labeled sample. I already found that RAGAS misbehaves with small local judges — keep deterministic metrics where possible.)
- **Long-document "needle" test:** can it find a clause buried at page 200 of a synthetic long document?
- **Routing:** quality vs. cost curve; escalation rate; compare to "always large" and "always small".
- **Cache:** hit rate and latency saved.
- **Red team:** a suite of poisoned documents (injection, exfiltration attempts, tool-abuse, hidden text). Report **attack success rate before and after guardrails**.
- **CI gate:** PRs fail if quality drops or attack success rises beyond thresholds.

## 7. Milestones (do them in order, one at a time)

- **M0 — Foundations:** I create the Cloudflare account myself (free, no card) and install Node 22 LTS. Verify every free-tier limit above. Scaffold the repo, TypeScript strict, lint/format, Vitest, CI skeleton, `docs/THREAT_MODEL.md` draft, `docs/LEARNING_LOG.md`. Hello-world Worker deployed.
- **M1 — Core packages:** `packages/router` (model routing), `packages/guardrails` (redaction, schema validation, policy), `packages/a2a` (agent card + task protocol), `packages/trace`. Unit tests.
- **M2 — Ingestion & splitting:** R2 upload, conversion, structure-aware chunking, offsets, tests on real long documents.
- **M3 — Index & retrieval:** Vectorize + D1 FTS5 hybrid retrieval; retrieval evals (reuse ideas from my RAG Evaluation Lab).
- **M4 — Extraction swarm:** Workflow + Queues fan-out, extractor agents, reduce/merge, cross-reference resolution.
- **M5 — Research, verification, synthesis:** researcher swarm, rulebook MCP server, verifier, report/redline output.
- **M6 — Routing & caching:** integrate router and AI Gateway cache; measure.
- **M7 — Guardrails & red team:** dual-model pattern, tool policy, MCP schema pinning, red-team suite and numbers.
- **M8 — A2A & observability:** agent card, task endpoint, trace viewer.
- **M9 — Evals in CI & write-up:** eval gate, results tables, architecture write-up, README, demo.

## 8. Definition of done

Deployed on free tier; a 200-page document processed end to end with a cited report; eval and red-team results published in the README with before/after numbers; CI gates active; threat model written; A2A endpoint documented and verified with a mock client (CodeWarden integration is an optional bonus); I can explain every component in an interview.

## 9. Decisions already made

Public GitHub repo; free-only; TypeScript on Workers; any free model provider; Cloudflare account to be created by me; project folder `C:\Users\lenovo\Desktop\Projects\lexguard`. CodeWarden is a sibling project built in a separate session; the link between them is optional (decided: standalone first, optional A2A integration last).
