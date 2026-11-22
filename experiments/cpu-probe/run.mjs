// Drives the CPU probe. Usage (from the repo root, probe deployed):
//   node experiments/cpu-probe/run.mjs <probe-url> real      # real CUAD texts via HTTP
//   node experiments/cpu-probe/run.mjs <probe-url> burn      # generated text via HTTP
//   node experiments/cpu-probe/run.mjs <probe-url> enqueue   # same sizes via the Queue
// Queue results appear in `npx wrangler tail lexguard-cpu-probe --format json` (outcome).
// "real" needs evals/data/cuad/CUAD_v1.json (npm run fetch:cuad -w @lexguard/evals).

import { readFileSync } from "node:fs";

const [base, mode] = process.argv.slice(2);
if (base === undefined || !["real", "burn", "enqueue"].includes(mode ?? "")) {
  console.error("usage: run.mjs <probe-url> real|burn|enqueue");
  process.exit(1);
}

const REPEAT = 5; // the CPU limit tolerates occasional overruns, so one success proves little
const SIZES = [25_000, 50_000, 100_000, 150_000, 200_000, 300_000, 400_000, 600_000];

async function attempt(path, init) {
  const response = await fetch(new URL(path, base), init);
  const body = await response.text();
  return response.ok ? "ok" : `${String(response.status)}${body.includes("1102") ? "/1102" : ""}`;
}

async function row(label, path, init) {
  const results = [];
  for (let i = 0; i < REPEAT; i++) results.push(await attempt(path, init));
  const ok = results.filter((r) => r === "ok").length;
  console.log(`${label.padEnd(12)} ${String(ok)}/${String(REPEAT)} ok   ${results.join(" ")}`);
}

if (mode === "real") {
  const manifest = JSON.parse(readFileSync("evals/cuad/pdfs.manifest.json", "utf8"));
  const cuad = JSON.parse(readFileSync("evals/data/cuad/CUAD_v1.json", "utf8"));
  const text = new Map(cuad.data.map((d) => [d.title, d.paragraphs[0].context]));
  const files = [...manifest.files].sort((a, b) => a.chars - b.chars);
  for (const file of files) {
    await row(`${String(file.chars)} ch`, "/chunk", { method: "POST", body: text.get(file.title) });
  }
} else if (mode === "burn") {
  for (const chars of SIZES) await row(`${String(chars)} ch`, `/burn?chars=${String(chars)}`);
} else {
  for (const chars of SIZES) {
    console.log(await attempt(`/enqueue?chars=${String(chars)}&repeat=3`, { method: "POST" }));
  }
}
