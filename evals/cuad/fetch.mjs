// Downloads CUAD v1 (510 real commercial contracts with lawyer-labelled clause spans) at a
// pinned revision and verifies its SHA-256 before saving. CC BY 4.0 (see evals/cuad/README.md);
// kept out of git in evals/data/.
//
// Usage: npm run fetch:cuad -w @lexguard/evals

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const REPO = "theatticusproject/cuad";
// Pinned dataset commit: a new upstream version cannot silently change our numbers.
const REVISION = "a3c393f5d103fd0c516374e4fdff676c8176dcb1";
const FILE = "CUAD_v1/CUAD_v1.json";
const SHA256 = "ed0b77d85bdf4014d7495800e8e4a70565b48ee6f8a2e5dca9cf8655dbf10eae";
const SIZE = 40_128_638;

const outDir = new URL("../data/cuad/", import.meta.url);
const outFile = new URL("CUAD_v1.json", outDir);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (existsSync(outFile) && sha256(readFileSync(outFile)) === SHA256) {
  console.log("Already downloaded and verified.");
  process.exit(0);
}

const url = `https://huggingface.co/datasets/${REPO}/resolve/${REVISION}/${FILE}`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)}`);
const bytes = Buffer.from(await response.arrayBuffer());

if (bytes.length !== SIZE) {
  throw new Error(`unexpected size ${String(bytes.length)}, wanted ${String(SIZE)}`);
}
const actual = sha256(bytes);
if (actual !== SHA256) throw new Error(`SHA-256 mismatch: got ${actual}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, bytes);
console.log(`Saved ${String(bytes.length)} bytes, SHA-256 verified.`);
