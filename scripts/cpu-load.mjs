// Load for the M3 CPU measurement (step 8): one new upload (so the chunking and indexing
// Workflows run) and 20 hybrid searches, against the deployed Worker while
// `wrangler tail ... | node scripts/tail-cpu.mjs` records CPU. Run it yourself: it reads your
// API key from LEXGUARD_API_KEY and never prints it.
//
//   node scripts/cpu-load.mjs https://lexguard.<subdomain>.workers.dev
//
// Uploads the second-largest CUAD PDF (or PICK=n: the n-th largest; the smoke test uses
// the smallest, the middle and the largest), so it is new to your tenant. About 110 Neurons;
// the document and its vectors stay in your tenant.

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.argv[2];
const key = (process.env.LEXGUARD_API_KEY ?? "").trim();
if (base === undefined || !/^lg_[A-Za-z0-9_-]{43}$/.test(key)) {
  console.error("usage: LEXGUARD_API_KEY=<your key> node scripts/cpu-load.mjs <worker-url>");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${key}` };

const manifest = JSON.parse(
  readFileSync(new URL("../evals/cuad/pdfs.manifest.json", import.meta.url), "utf8"),
);
// PICK=n: the n-th largest PDF (default 2). Each run needs one new to your tenant, or the
// upload returns the existing document and neither Workflow runs.
const pick = Number(process.env.PICK ?? 2);
const file = [...manifest.files].sort((a, b) => a.size - b.size).at(-pick);
if (file === undefined || !(pick >= 1)) {
  console.error(`PICK must be 1-${String(manifest.files.length)}`);
  process.exit(1);
}
const pdf = readFileSync(new URL(`../evals/data/cuad/pdf/${file.sha256}.pdf`, import.meta.url));

const started = Date.now();
const upload = await fetch(new URL("/v1/documents", base), {
  method: "POST",
  headers: {
    ...auth,
    "Content-Length": String(pdf.length),
    "X-Filename": encodeURIComponent(`${file.title}.pdf`),
  },
  body: pdf,
});
let document = (await upload.json()).document;
console.log(`upload: HTTP ${String(upload.status)}, ${String(file.size)} bytes`);
while (
  document !== undefined &&
  (document.status === "chunking" ||
    (document.status === "ready" &&
      document.indexStatus !== "indexed" &&
      document.indexStatus !== "failed")) &&
  Date.now() - started < 15 * 60 * 1000
) {
  await sleep(5000);
  document = (
    await (await fetch(new URL(`/v1/documents/${document.id}`, base), { headers: auth })).json()
  ).document;
}
console.log(
  `document: ${String(document?.status)}, index ${String(document?.indexStatus)}${document?.indexError ? ` (${document.indexError})` : ""}, ${String(document?.pages)} pages, ${((Date.now() - started) / 1000).toFixed(1)} s`,
);

const questions = [
  "Governing Law: Which state's law governs the contract?",
  "Termination for convenience: can a party terminate without cause?",
  "Cap on liability: is liability limited to an amount?",
  "Exclusivity: is there an exclusive dealing commitment?",
  "Non-compete: is a party restricted from competing?",
];
const times = [];
for (let i = 0; i < 20; i++) {
  const text = JSON.stringify({ query: questions[i % questions.length] });
  const t = Date.now();
  const r = await fetch(new URL(`/v1/documents/${String(document?.id)}/search`, base), {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(text)),
    },
    body: text,
  });
  const body = await r.json();
  times.push(Date.now() - t);
  if (r.status !== 200 || (body.degraded ?? []).length > 0) {
    console.log(
      `search ${String(i + 1)}: HTTP ${String(r.status)}, degraded ${JSON.stringify(body.degraded)}`,
    );
  }
}
times.sort((a, b) => a - b);
console.log(
  `20 searches: p50 ${String(times[10])} ms, max ${String(times.at(-1))} ms (wall time from here)`,
);
