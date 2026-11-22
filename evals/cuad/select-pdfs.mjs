// Builds evals/cuad/pdfs.manifest.json: which CUAD contract PDFs we use and their hashes.
// Run once (and again only if the selection rule changes); the manifest is committed and
// fetch-pdfs.mjs downloads exactly what it lists. Needs evals/data/cuad/CUAD_v1.json
// (npm run fetch:cuad) for text lengths.
//
// Selection rule (deterministic, nobody hand-picks contracts):
//   - eligible: PDFs whose file name (minus .pdf) equals a CUAD_v1.json title exactly, so the
//     PDF can be paired with CUAD's own text (506 of 510; 4 differ by trailing spaces/punctuation);
//   - "longest": the LONGEST_COUNT eligible contracts with the most characters of CUAD text
//     (characters, not PDF bytes: big PDFs are often scans, not long documents);
//   - "hash-order": the next SAMPLE_COUNT eligible titles in ascending SHA-256(title) order,
//     a reproducible pseudo-random sample.
//
// Usage: node cuad/select-pdfs.mjs

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const REPO = "theatticusproject/cuad";
const REVISION = "a3c393f5d103fd0c516374e4fdff676c8176dcb1"; // same pin as fetch.mjs
const PDF_DIR = "CUAD_v1/full_contract_pdf";
const SAMPLE_COUNT = 25;
const LONGEST_COUNT = 5;

const cuadFile = new URL("../data/cuad/CUAD_v1.json", import.meta.url);
const manifestFile = new URL("pdfs.manifest.json", import.meta.url);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// encodeURI would leave "#" alone and cut the URL there (two CUAD file names contain "#").
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
const gitBlobSha1 = (bytes) =>
  createHash("sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");

const treeUrl = `https://huggingface.co/api/datasets/${REPO}/tree/${REVISION}/${encodePath(PDF_DIR)}?recursive=true`;
const treeResponse = await fetch(treeUrl);
if (!treeResponse.ok) throw new Error(`listing failed: HTTP ${String(treeResponse.status)}`);
const tree = await treeResponse.json();
const files = tree.filter((entry) => entry.type === "file" && /\.pdf$/i.test(entry.path));

const cuad = JSON.parse(readFileSync(cuadFile, "utf8"));
const textLength = new Map(cuad.data.map((d) => [d.title, d.paragraphs[0].context.length]));

const eligible = files
  .map((file) => ({
    file,
    title: file.path
      .split("/")
      .at(-1)
      .replace(/\.pdf$/i, ""),
  }))
  .filter(({ title }) => textLength.has(title))
  .map((entry) => ({ ...entry, chars: textLength.get(entry.title) }));

const longest = [...eligible].sort((a, b) => b.chars - a.chars).slice(0, LONGEST_COUNT);
const taken = new Set(longest.map((e) => e.title));
const sample = eligible
  .filter((e) => !taken.has(e.title))
  .map((e) => ({ ...e, key: sha256(e.title) }))
  .sort((a, b) => (a.key < b.key ? -1 : 1))
  .slice(0, SAMPLE_COUNT);

const chosen = [
  ...longest.map((e) => ({ ...e, reason: "longest" })),
  ...sample.map((e) => ({ ...e, reason: "hash-order" })),
];

const entries = [];
for (const { file, title, chars, reason } of chosen) {
  const url = `https://huggingface.co/datasets/${REPO}/resolve/${REVISION}/${encodePath(file.path)}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`download failed for ${title}: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== file.size) throw new Error(`size mismatch for ${title}`);
  // Check against the hash the upstream repo publishes: SHA-256 for LFS files, git SHA-1 otherwise.
  const upstreamOk = file.lfs ? sha256(bytes) === file.lfs.oid : gitBlobSha1(bytes) === file.oid;
  if (!upstreamOk) throw new Error(`upstream hash mismatch for ${title}`);
  entries.push({
    title,
    reason,
    chars,
    path: file.path,
    size: bytes.length,
    sha256: sha256(bytes),
  });
  console.log(`${reason.padEnd(10)} ${String(chars).padStart(7)} chars  ${title}`);
}

const manifest = {
  repo: REPO,
  revision: REVISION,
  licence: "CC BY 4.0",
  rule: `${String(LONGEST_COUNT)} longest by CUAD text characters + first ${String(SAMPLE_COUNT)} other titles by ascending SHA-256(title); only PDFs whose name equals a CUAD_v1.json title`,
  files: entries,
};
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${String(entries.length)} entries to pdfs.manifest.json`);
