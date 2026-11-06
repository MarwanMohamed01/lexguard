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
