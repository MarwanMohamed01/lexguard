// Downloads the CUAD contract PDFs listed in evals/cuad/pdfs.manifest.json (pinned revision)
// and verifies size and SHA-256 of each before saving. Files are stored content-addressed as
// evals/data/cuad/pdf/<sha256>.pdf (kept out of git); the manifest maps them to CUAD titles.
// CC BY 4.0 (see evals/cuad/README.md).
//
// Usage: npm run fetch:cuad-pdfs -w @lexguard/evals

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("pdfs.manifest.json", import.meta.url), "utf8"));
const outDir = new URL("../data/cuad/pdf/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// encodeURI would leave "#" alone and cut the URL there (some CUAD file names contain "#").
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

let downloaded = 0;
for (const entry of manifest.files) {
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`bad hash in manifest: ${entry.title}`);
  const outFile = new URL(`${entry.sha256}.pdf`, outDir);
  if (existsSync(outFile) && sha256(readFileSync(outFile)) === entry.sha256) continue;

  const url = `https://huggingface.co/datasets/${manifest.repo}/resolve/${manifest.revision}/${encodePath(entry.path)}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`download failed for ${entry.title}: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== entry.size) throw new Error(`unexpected size for ${entry.title}`);
  if (sha256(bytes) !== entry.sha256) throw new Error(`SHA-256 mismatch for ${entry.title}`);
  writeFileSync(outFile, bytes);
  downloaded += 1;
}
console.log(
  `${String(manifest.files.length)} PDFs verified (${String(downloaded)} downloaded now).`,
);
