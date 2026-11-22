# Progress

Where the project stands and how to resume. Read together with `PROJECT.md` (the spec),
`docs/DECISIONS.md` (deviations and their reasons) and `docs/LEARNING_LOG.md`.

_Last updated: 2026-11-22._

## Status

| Milestone                            | Status                                          |
| ------------------------------------ | ----------------------------------------------- |
| M0 Foundations                       | ✅ Done                                         |
| M1 Core packages                     | ✅ Done (CI and full-history secret scan green) |
| **M2 Ingestion & splitting**         | ⏳ **In progress: steps 1–4 done**              |
| M3 Index & retrieval                 | Not started                                     |
| M4 Extraction swarm                  | Not started                                     |
| M5 Research, verification, synthesis | Not started                                     |
| M6 Routing & caching                 | Not started                                     |
| M7 Guardrails & red team             | Not started                                     |
| M8 A2A & observability               | Not started                                     |
| M9 Evals in CI & write-up            | Not started                                     |

Deployed Worker: https://lexguard.marwan-dev.workers.dev (hello world). Repo:
https://github.com/MarwanMohamed01/lexguard (public).

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
5. Ingestion flow in the Worker: upload checks, fingerprint, `toMarkdown`, sanitize, chunk,
   D1 schema as a migration, `env.DB` binding. **Open question from D14:** whether a Queue
   consumer gets 30 s CPU on the Free plan; measure before choosing where splitting runs.
6. Conversion-quality eval: `toMarkdown` output vs CUAD's own text for the same PDFs.
7. Security tests (oversized/malformed uploads, hidden text, tenant isolation), deploy,
   learning log entry, end-of-milestone quiz.

## Working rules (agreed)

- One milestone at a time; explain what and why before each step, then file by file after.
- Everything free: verify limits in official docs first; no credit card.
- Never put secrets in chat; `.dev.vars` locally, `wrangler secret put` in production.
- **No hand-written evaluation datasets.** Measurements use downloaded public data (licence
  checked, pinned revision, SHA-256). Unit tests with small examples are fine.
- Commits are authored by Marwan only, with no co-author trailers.
- Commit only after `npm run check` passes. Never quote a flagged secret, even in comments.
- Quizzes are multiple choice.
- Marwan reviews the code; explanations in plain language with examples.

## Useful commands

```bash
npm run check                              # hidden chars, typecheck, lint, format, all tests
npm run fetch:gretel -w @lexguard/evals    # PII benchmark data (also downloaded in CI)
npm run fetch:cuad -w @lexguard/evals      # 510 real contracts with lawyer-labelled clauses
npm run fetch:cuad-pdfs -w @lexguard/evals # 30 original contract PDFs (M2 ingestion tests)
npm run eval:watch -w @lexguard/evals      # Evalite case-by-case view
npm run deploy -w @lexguard/worker         # deploy (after `npx wrangler login`)
```

## Key numbers so far

- PII redaction on Gretel (5,000 docs): precision 0.966, recall 0.750 (CI gate 0.96 / 0.74).
- CUAD (510 real contracts): redaction changes 0.06% of characters, touches 0 of 13,823
  lawyer-labelled clauses.
- Chunking on CUAD (510 contracts, 13,823 clauses): 99.41% of clauses kept whole vs 96.95%
  for LangChain-style recursive splitting at the same chunk count; 0 offset errors.
- Tests: 223 (worker 3, trace 24, guardrails 72, router 13, a2a 34, chunker 47, evals 30).
