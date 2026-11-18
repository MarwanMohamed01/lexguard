// Downloads the Gretel PII masking EN v1 test split at a pinned revision and verifies its
// SHA-256 before saving. The data is Apache-2.0 (see evals/gretel/README.md) and is kept
// out of git in evals/data/.
//
// Usage: npm run fetch:gretel -w @lexguard/evals

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const REPO = "gretelai/gretel-pii-masking-en-v1";
// Pinned dataset commit: a new upstream version cannot silently change our numbers.
const REVISION = "e06eb1499ca8d54470f085021cd8e54f9efac7fd";
const FILE = "data/test-00000-of-00001.parquet";
const SHA256 = "c89a6bffa838edb0f2fc6686bf35da4930944519ac97308b0b6e32298594b5b1";
const SIZE = 2_029_143;

const outDir = new URL("../data/gretel/", import.meta.url);
const outFile = new URL("test.parquet", outDir);

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

if (bytes.length !== SIZE)
  throw new Error(`unexpected size ${String(bytes.length)}, wanted ${String(SIZE)}`);
const actual = sha256(bytes);
if (actual !== SHA256) throw new Error(`SHA-256 mismatch: got ${actual}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, bytes);
console.log(`Saved ${String(bytes.length)} bytes, SHA-256 verified.`);
