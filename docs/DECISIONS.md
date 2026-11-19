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
