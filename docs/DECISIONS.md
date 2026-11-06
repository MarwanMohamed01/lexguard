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

| Tool | Pin | Reason |
|---|---|---|
| Node | 22.x | Per PROJECT.md. Installed: 22.23.4 |
| TypeScript | 6.0.3 | typescript-eslint supports `>=4.8.4 <6.1.0`, so TS 7 (latest) is not yet supported |
| Vitest | 4.x | `@cloudflare/vitest-pool-workers` and Evalite both require `^4`; Vitest 5 is not compatible |
| Package manager | npm workspaces | Already installed, fewer moving parts than pnpm |

## D5. Free-tier budgets that shape the design

- Workers Free: 10 ms CPU per request (waiting on LLM calls does not count), 50 subrequests per invocation.
- Queues: 10,000 operations per day, about 3 per message, so batch chunks.
- D1 and Durable Objects: 100,000 row writes per day.
- Workers AI: 10,000 Neurons per day, so evals run locally on Ollama.
- Vectorize: 5M stored vector dimensions (about 6,500 vectors at 768 dims).
