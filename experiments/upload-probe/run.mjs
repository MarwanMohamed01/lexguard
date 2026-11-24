// Drives the upload probe (see src/index.ts). From the repo root, probe deployed, with
// `npx wrangler tail lexguard-upload-probe --format json > tail.jsonl` running elsewhere:
//   node experiments/upload-probe/run.mjs <probe-url>
// Sends the largest CUAD PDF of evals/cuad/pdfs.manifest.json (154 pages, 1.56 MB) and the
// smallest (41 KB), REPEAT times per route, plus their converted text for the text routes.

import { readFileSync } from "node:fs";

const base = process.argv[2];
if (base === undefined) {
  console.error("usage: run.mjs <probe-url>");
  process.exit(1);
}
const REPEAT = 5;
const manifest = JSON.parse(readFileSync("evals/cuad/pdfs.manifest.json", "utf8"));
const bySize = [...manifest.files].sort((a, b) => a.size - b.size);

async function post(path, body, label) {
  const results = [];
  for (let i = 0; i < REPEAT; i++) {
    const response = await fetch(new URL(`${path}?label=${label}`, base), {
      method: "POST",
      body,
    });
    results.push(response.ok ? "ok" : String(response.status));
    await response.text();
  }
  console.log(`${label.padEnd(8)} ${path.padEnd(13)} ${results.join(" ")}`);
}

for (const [label, file] of [
  ["small", bySize[0]],
  ["large", bySize.at(-1)],
]) {
  const pdf = readFileSync(`evals/data/cuad/pdf/${file.sha256}.pdf`);
  // The text as toMarkdown returns it is rebuilt by the probe itself on /convert; for the
  // text routes, convert once and reuse.
  const text = await (
    await fetch(new URL("/convert-text", base), { method: "POST", body: pdf })
  ).text();
  for (const path of ["/noop", "/read", "/read-stream", "/hash", "/convert", "/all"]) {
    await post(path, pdf, label);
  }
  if (text.length > 0) {
    for (const path of ["/sanitize", "/d1"]) await post(path, text, label);
  }
}
