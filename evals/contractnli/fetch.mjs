// Downloads ContractNLI (607 real NDAs, 17 fixed rule-like hypotheses, expert labels and
// evidence spans) at a pinned commit, verifies the zip's SHA-256, and unpacks only the JSON
// splits and the licence files. CC BY 4.0, (c) Hitachi America, Ltd. (see
// evals/contractnli/README.md); kept out of git in evals/data/ like every dataset (D10).
//
// The zip also holds the 600 original PDFs (60 MB), which the eval does not need: they are
// never written to disk.
//
// Usage: npm run fetch:contractnli -w @lexguard/evals

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// Pinned commit of the project's gh-pages branch (the last one that changed the zip).
const COMMIT = "3d2a4d47da022de1f1d740b8eea16930e55c21a1";
const URL_ = `https://raw.githubusercontent.com/stanfordnlp/contract-nli/${COMMIT}/resources/contract-nli.zip`;
const ZIP_SHA256 = "e03fc77bbf8b53e2976a250e81d8a294bc3d5e5fb014521e477dee9340d6287b";
const ZIP_SIZE = 65_362_913;

/** The entries we keep, each verified after unpacking too. */
const FILES = {
  "contract-nli/train.json": "dbceb356cd6203b35b27be94a5fa85e499a81c34c42c89ad53060b39f0257ba5",
  "contract-nli/dev.json": "310af7d661d2ab50ee3700169cef524c75f39fb296bbf5a515c229eb0f42e68e",
  "contract-nli/test.json": "460267b56052a2dc5aead98eb35eadef9e6734d5723d37b4a9790e410f812387",
  "contract-nli/LICENSE": "9e5f1b3c610b9c2da5c313bf81d577a7d1acec686bdb0384edefa6df0f90cd94",
  "contract-nli/TERMS": "b86e5b9bd7d2c49fd0d60e1d0842b7f64746abc8b206451acbe9080027cc49c8",
};

const outDir = new URL("../data/contractnli/", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const outName = (entry) => entry.slice("contract-nli/".length);

const missing = Object.entries(FILES).filter(([entry, hash]) => {
  const out = new URL(outName(entry), outDir);
  return !existsSync(out) || sha256(readFileSync(out)) !== hash;
});
if (missing.length === 0) {
  console.log("Already downloaded and verified.");
  process.exit(0);
}

console.log(`Downloading ${URL_}`);
const response = await fetch(URL_);
if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)}`);
const zip = Buffer.from(await response.arrayBuffer());
if (zip.length !== ZIP_SIZE) {
  throw new Error(`unexpected size ${String(zip.length)}, wanted ${String(ZIP_SIZE)}`);
}
const actual = sha256(zip);
if (actual !== ZIP_SHA256) throw new Error(`SHA-256 mismatch: got ${actual}`);

// Minimal ZIP reader (no ZIP64, which a 65 MB file does not need). Names come from the
// verified zip and are only compared with the fixed list above, never used as paths.
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const found = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    found.set(name, { method, compressed, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

function unpack(buf, { method, compressed, size, local }) {
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("bad local header");
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compressed);
  const bytes = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
  if (bytes === null) throw new Error(`unsupported compression method ${String(method)}`);
  if (bytes.length !== size) throw new Error("unpacked size differs from the directory");
  return bytes;
}

const directory = entries(zip);
mkdirSync(outDir, { recursive: true });
for (const [entry, hash] of Object.entries(FILES)) {
  const info = directory.get(entry);
  if (info === undefined) throw new Error(`${entry} not in the zip`);
  const bytes = unpack(zip, info);
  if (sha256(bytes) !== hash) throw new Error(`${entry}: SHA-256 mismatch`);
  writeFileSync(new URL(outName(entry), outDir), bytes);
  console.log(`${outName(entry)}: saved ${String(bytes.length)} bytes, SHA-256 verified.`);
}
