// Drives the embedding probe (see src/index.ts). From the repo root, with
// `npx wrangler dev -c experiments/embed-probe/wrangler.jsonc` running elsewhere:
//   node experiments/embed-probe/run.mjs [probe-url]
// Uses the real stored chunks of the 30 converted CUAD PDFs (evals/data/cuad/converted/,
// written by evals/cuad/convert-run.mjs). Cost: about 60 of the 10,000 free daily Neurons
// (about 58k tokens, at 1,075 Neurons per million tokens).
//
// Questions:
//   1. Result shape: fields, vector size, are vectors unit length (dot product = cosine)?
//   2. Same text twice: identical vector? Same text alone vs inside a batch: identical?
//   3. How many texts does one call accept?
//   4. Does the model read the end of long inputs (2k...32k chars), or silently truncate?
//   5. Our real chunks: length distribution and estimated tokens / Neurons for the corpus.

import { readFileSync, readdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8787";
const dir = "evals/data/cuad/converted/";
const NEURONS_PER_M_TOKENS = 1075; // Workers AI pricing page, @cf/baai/bge-m3 (checked 2026-11-24)

const docs = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(dir + f, "utf8")))
  .filter((d) => typeof d.markdown === "string");
const chunks = docs.flatMap((d) =>
  d.chunks.map((c) => ({ ...c, text: d.markdown.slice(c.start, c.end), title: d.title })),
);

// Real usage, as reported by Workers AI in each result's `meta`.
let tokensSent = 0;
let neuronsUsed = 0;
let charsSent = 0;
async function embed(texts) {
  const response = await fetch(new URL("/embed", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: texts }),
  });
  const body = await response.json();
  if (!response.ok) return { error: body.error ?? String(response.status) };
  tokensSent += body.meta?.cost_metric_value_1 ?? 0;
  neuronsUsed += body.meta?.neurons ?? 0;
  charsSent += texts.reduce((n, t) => n + t.length, 0);
  return body;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const fmt = (x) => x.toFixed(6);

// 1. Shape
const sample = chunks.slice(0, 2).map((c) => c.text);
const first = await embed(sample);
if (first.error) {
  console.error("embed failed:", first.error);
  process.exit(1);
}
console.log("1. result fields:", Object.keys(first).join(", "));
const vectors = first.data;
console.log(
  `   vectors: ${String(vectors.length)} x ${String(vectors[0].length)} dims; shape field: ${JSON.stringify(first.shape)}; pooling: ${String(first.pooling)}`,
);
console.log(`   norms: ${vectors.map((v) => fmt(norm(v))).join(", ")}`);
const other = Object.fromEntries(
  Object.entries(first).filter(([k]) => !["data", "shape", "pooling"].includes(k)),
);
console.log("   other fields:", JSON.stringify(other));

// 2. Determinism and batch independence
const again = await embed([sample[0]]);
console.log(
  `2. same text twice identical: ${String(same(vectors[0], again.data[0]))}; cosine ${fmt(cosine(vectors[0], again.data[0]))}`,
);
const batched = await embed([sample[0], ...chunks.slice(10, 17).map((c) => c.text)]);
console.log(
  `   alone vs in a batch of 8 identical: ${String(same(again.data[0], batched.data[0]))}; cosine ${fmt(cosine(again.data[0], batched.data[0]))}`,
);

// 3. Batch size (short texts, so it costs almost nothing)
const short = chunks.map((c) => c.text.slice(0, 60));
for (const n of [50, 100, 200, 500]) {
  const r = await embed(short.slice(0, n));
  console.log(
    `3. batch of ${String(n).padStart(3)}: ${r.error ? `refused (${r.error.slice(0, 160)})` : `ok, ${String(r.data.length)} vectors`}`,
  );
}

// 4. Truncation: replace the last 300 chars of a long input with other text. If the vector
// does not move at all, the model never read the end.
const longest = docs.reduce((a, b) => (a.markdown.length >= b.markdown.length ? a : b)).markdown;
const tail = docs[0].markdown.slice(0, 300);
for (const length of [2000, 4000, 8000, 16000, 32000]) {
  const text = longest.slice(0, length);
  const changed = text.slice(0, length - 300) + tail;
  const r = await embed([text, changed]);
  if (r.error) {
    console.log(`4. ${String(length).padStart(5)} chars: refused (${r.error.slice(0, 160)})`);
    continue;
  }
  const c = cosine(r.data[0], r.data[1]);
  console.log(
    `4. ${String(length).padStart(5)} chars: cosine after changing the last 300 chars ${fmt(c)} -> ${c > 0.999999 ? "END NOT READ (truncated)" : "end read"}`,
  );
}

// 5. Real chunks (no calls)
const lengths = chunks.map((c) => c.text.length).sort((a, b) => a - b);
const pct = (p) => lengths[Math.min(lengths.length - 1, Math.floor((p / 100) * lengths.length))];
const totalChars = lengths.reduce((a, b) => a + b, 0);
const charsPerToken = charsSent / tokensSent; // measured on this run's inputs
const corpusTokens = totalChars / charsPerToken;
console.log(
  `5. ${String(chunks.length)} chunks in ${String(docs.length)} docs; chars p50 ${String(pct(50))}, p90 ${String(pct(90))}, p99 ${String(pct(99))}, max ${String(lengths.at(-1))}`,
);
console.log(
  `   measured ${charsPerToken.toFixed(2)} chars per token; corpus ${String(totalChars)} chars ~ ${String(Math.round(corpusTokens))} tokens ~ ${String(Math.round((corpusTokens * NEURONS_PER_M_TOKENS) / 1e6))} Neurons to embed all once`,
);
console.log(
  `   stored dims at ${String(vectors[0].length)}/vector: ${String(chunks.length * vectors[0].length)} of the 5,000,000 free`,
);
console.log(
  `probe used ${String(tokensSent)} tokens, ${neuronsUsed.toFixed(1)} Neurons (as reported by Workers AI; ${(neuronsUsed / (tokensSent / 1e6)).toFixed(0)} per million tokens)`,
);
