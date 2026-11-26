// Downloads BIPIA's text attacks (Microsoft's benchmark for INDIRECT prompt injection: attack
// instructions hidden in the content a model reads) at a pinned commit and verifies their
// SHA-256 before saving. MIT licence (LICENSE at the same commit, saved alongside). The repo
// was archived by its owner in 2026, so the pinned commit is final. Kept out of git in
// evals/data/ like every downloaded dataset (D10).
//
// Usage: npm run fetch:bipia -w @lexguard/evals

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const COMMIT = "a004b69ec0dd446e0afd461d98cb5e96e120a5d0";
const FILES = [
  {
    path: "benchmark/text_attack_test.json",
    name: "text_attack_test.json",
    sha256: "75750e7b4e8b34e8f9d88d89b357aeaaf02bd07f9e493ccd37eda74a0cd7c7f8",
  },
  {
    // Disjoint from the test attacks (0 in common): used to tune the M5 detector, which is
    // then measured on the test attacks only (D53).
    path: "benchmark/text_attack_train.json",
    name: "text_attack_train.json",
    sha256: "63f95d3e67eac4178cdabdbdaf192cd05f2b6ed0702b578f1d30d556e5155670",
  },
  {
    path: "LICENSE",
    name: "LICENSE",
    sha256: "57cf81c45e0929899bc18051cf90134f00e55963ddecc7b37cfc5ea1494b1e8b",
  },
];

const outDir = new URL("../data/redteam/bipia/", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(outDir, { recursive: true });

for (const file of FILES) {
  const out = new URL(file.name, outDir);
  if (existsSync(out) && sha256(readFileSync(out)) === file.sha256) {
    console.log(`${file.name}: already downloaded and verified.`);
    continue;
  }
  const url = `https://raw.githubusercontent.com/microsoft/BIPIA/${COMMIT}/${file.path}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== file.sha256) throw new Error(`${file.name}: SHA-256 mismatch, got ${actual}`);
  writeFileSync(out, bytes);
  console.log(`${file.name}: saved ${String(bytes.length)} bytes, SHA-256 verified.`);
}
