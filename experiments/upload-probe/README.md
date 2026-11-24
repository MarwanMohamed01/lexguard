# Upload CPU probe (M2 step 7)

Question: the first production deploy showed a 154-page upload (1.56 MB PDF) using 28 ms of
CPU, above the Workers Free plan's nominal 10 ms. Where does it go? Decision in
`docs/DECISIONS.md` D24. The probe Worker and its D1 database were created for the test on
2026-11-24 and deleted afterwards.

## How it was measured

`src/index.ts` runs one piece of the real upload path per route (read, hash, convert,
sanitize + pages, D1 write, and all of them together), importing the Worker's own code.
`run.mjs` sent the smallest (41 KB) and largest (1.56 MB) CUAD PDFs 5 times per route.
`performance.now()` is frozen during CPU work on deployed Workers, so CPU time comes from
Cloudflare: `wrangler tail --format json` (`cpuTime` per invocation; tail samples under
load, so some invocations are missing).

## Results (largest PDF, median CPU per invocation)

| Piece                                           | CPU       |
| ----------------------------------------------- | --------- |
| Invocation, body unread                         | 0 ms      |
| Read body, native `arrayBuffer()`               | 0 ms      |
| Read body, the Worker's JavaScript stream loop  | **5 ms**  |
| Read body, native `FixedLengthStream` (the fix) | **1 ms**  |
| SHA-256                                         | 1 ms      |
| `toMarkdown` (send 1.56 MB, receive 288k chars) | **13 ms** |
| Sanitize + page extraction                      | 2 ms      |
| D1 write of the text                            | 1 ms      |
| Whole upload path, before the fix               | 25 ms     |
| Whole upload path, after the fix                | **21 ms** |

## What it means

1. The guess before measuring (sanitizing in the request) was wrong: our own text processing
   is ~3 ms. The largest share is `toMarkdown` itself, the cost of moving the file to the
   converter and the text back, which grows with file size.
2. The Worker's capped stream loop (written in step 5e to defend against a lying
   `Content-Length`) cost 5 ms; the native `FixedLengthStream` gives the same protection for
   about 1 ms. Fixed in `apps/worker/src/upload.ts` (`readExactly`).
3. Converting has to happen in the upload request: it is the only place the file exists on
   the free setup (no R2, 1 MiB Workflow input, 2 MB D1 rows). So PDFs above roughly 0.6 MB
   (3 of the 30 CUAD PDFs) exceed the nominal 10 ms and rely on the platform's tolerance.
