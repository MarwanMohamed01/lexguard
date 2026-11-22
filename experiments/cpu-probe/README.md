# CPU probe (M2 step 5a)

Question: on the Workers **Free** plan, can a long contract be chunked in one invocation, and
does a Queue consumer get more CPU than an HTTP request? Decision recorded in
`docs/DECISIONS.md` D16. The probe Worker and its Queue were deployed for the test on
2026-11-22 and deleted afterwards.

## How it was measured

- `src/index.ts` chunks text with `@lexguard/chunker` in three places: `POST /chunk` (real
  text in the body), `GET /burn?chars=N` (generated contract-like text) and a Queue consumer
  (same generated text, one message per invocation, no retries).
- `run.mjs` sent the 30 CUAD contracts of `evals/cuad/pdfs.manifest.json` (their CUAD text) 5
  times each, generated text from 25k to 2M characters 5 times each over HTTP, and 3 Queue
  messages per size.
- Inside a deployed Worker `performance.now()` does not advance during CPU work, so timing
  comes from Cloudflare: `wrangler tail --format json` reports `cpuTime` (ms) and `outcome`
  per invocation. The docs list `outcome` but not `cpuTime`; it is there.
- Tail is sampled under load: it captured part of the invocations. Every HTTP response was
  checked directly (200 vs error 1102).

## Results

| Case                                   | CPU reported by Cloudflare                  | Outcome   |
| -------------------------------------- | ------------------------------------------- | --------- |
| Real CUAD text, 3k–40k chars (HTTP)    | 0–2 ms                                      | all ok    |
| Real CUAD text, 230k–338k chars (HTTP) | 4–9 ms; outliers 14 and 26 ms (likely cold) | all 30 ok |
| Generated text, 25k–100k chars (HTTP)  | 0–2 ms                                      | all ok    |
| Generated text, 1M chars (HTTP)        | 15–17 ms                                    | all ok    |
| Generated text, 1.5M / 2M chars (HTTP) | not captured by tail                        | all 10 ok |
| Queue consumer, 25k–150k chars         | 1–5 ms                                      | all ok    |
| Queue consumer, 600k / 1M / 2M chars   | 16 / 26 / 49–57 ms                          | all ok    |

## What it means

1. **Chunking is about 2.5× faster on Workers than the Node estimate** (0.067 ms per 1,000
   chars in Node; about 0.027 warm on Workers). The longest CUAD contract (338k chars) took
   about 9 ms warm.
2. **No invocation was killed, even at 57 ms.** The documented Free limit is 10 ms per
   invocation, with "built-in flexibility" for occasional overruns. That leniency is
   undocumented in size and can change, so the design does not rely on it.
3. **A Queue consumer gets no documented CPU advantage on Free**: the Queues docs say
   consumers "share the same per invocation CPU limits as any Workers do" (10 ms on Free; the
   30 s default is the Paid default). The probe cannot tell them apart since neither was killed.
4. Cold starts cost extra (first request loads Zod and compiles the chunker's regexes).

## Rerun

Needs a Queue named `lexguard-cpu-probe` (`npx wrangler queues create lexguard-cpu-probe`).

```bash
cd experiments/cpu-probe && npx wrangler deploy
npx wrangler tail lexguard-cpu-probe --format json > tail.jsonl   # separate terminal
node experiments/cpu-probe/run.mjs <probe-url> real|burn|enqueue  # from the repo root
# clean up: queues consumer remove, then wrangler delete, then queues delete
```
