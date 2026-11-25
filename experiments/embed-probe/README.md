# Embedding probe (M3 step 1)

Question: which Workers AI embedding model fits our chunks, and what does it really return?
The docs leave bge-m3's vector size, batch limit and input limit unstated. Decision in
`docs/DECISIONS.md` D25.

## How it was measured

`src/index.ts` is a Worker that only forwards a JSON body to `@cf/baai/bge-m3` and returns the
raw result. It ran under `wrangler dev` on 2026-11-24 (the AI binding is always remote, so the
calls are real; nothing was deployed or created). `run.mjs` sent real stored chunks of the 30
converted CUAD PDFs (`evals/data/cuad/converted/`). The run used 60,406 tokens and 64.9 Neurons,
as reported by Workers AI itself in each result's `meta`.

## Results

| Question                            | Answer                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Result fields                       | `data` (vectors), `shape`, `pooling: "cls"`, `meta` (input tokens, Neurons), `response`  |
| Vector size                         | **1,024** dimensions                                                                     |
| Unit length?                        | Yes, norms 0.99999–1.00000: cosine and dot product rank the same                         |
| Same text twice                     | **Not bit-identical**, cosine 0.999996 (also alone vs in a batch: 0.999998)              |
| Texts per call                      | 500 accepted (largest tried)                                                             |
| Reads the end of long inputs?       | Yes at 2k, 4k, 8k, 16k and 32k chars (changing the last 300 chars moves the vector)      |
| Effect of the last 300 chars        | cosine 0.904 at 2k chars, 0.966 at 4k, 0.996 at 32k: long inputs dilute each part        |
| Real cost                           | 1,075 Neurons per million tokens, matching the pricing page                              |
| Characters per token (these inputs) | 3.19, not the usual rule of thumb of 4                                                   |
| Our chunks (30 PDFs)                | 1,818 chunks; 1,715 chars median, 2,821 p90, 4,000 max; up to 204 chunks in one contract |
| Chunks over 512 tokens (est.)       | **979 of 1,818 (53.9%)** at 3.19 chars per token                                         |
| Embedding all 30 PDFs once          | about 940k tokens, about 1,011 Neurons                                                   |
| Vectorize space for all 30 PDFs     | 1,861,632 of the 5,000,000 free stored dimensions (37%)                                  |

## What it means

1. `bge-base-en-v1.5` (and the other 512-token BGE models) would silently cut more than half
   of our chunks. bge-m3 reads them whole and costs 5.6× fewer Neurons per token.
2. 1,024 dimensions make Vectorize's stored-dimension allowance, not Neurons, the tightest
   limit: about 4,880 vectors in total across all tenants.
3. Vectors are not reproducible to the bit. Tests and caches must compare with a tolerance,
   never with equality.
4. Longer inputs blur the parts they contain. That argues for keeping chunks small rather than
   growing them now that the model allows it. The retrieval eval (step 2) decides.
