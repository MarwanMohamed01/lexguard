// Smoke test against a deployed Lexguard Worker (M2 step 7). Run it yourself: it reads your
// API key from the LEXGUARD_API_KEY environment variable and never prints it.
//
//   node scripts/smoke.mjs https://lexguard.<subdomain>.workers.dev
//
// Checks: health; a request without a key is refused; the key maps to your tenant; three CUAD
// PDFs (smallest, middle, largest of evals/cuad/pdfs.manifest.json; needs
// `npm run fetch:cuad-pdfs -w @lexguard/evals`) upload and reach 'ready'; uploading one again
// returns the same document; an unknown document is 404. Exits 1 on any failure.
//
// The three documents stay in your tenant (each upload counts toward the 50-a-day quota).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.argv[2];
// Trimmed: a key copied from the indented output of new-tenant-key.mjs carries spaces.
const key = (process.env.LEXGUARD_API_KEY ?? "").trim();
if (base === undefined || key === "") {
  console.error("usage: LEXGUARD_API_KEY=... node scripts/smoke.mjs <worker-url>");
  process.exit(1);
}
// Same shape the Worker requires (src/auth.ts). Describe the problem without showing the key.
if (!/^lg_[A-Za-z0-9_-]{43}$/.test(key)) {
  console.error(
    `LEXGUARD_API_KEY does not look like an API key: expected "lg_" + 43 characters (46 in ` +
      `total); got ${String(key.length)} characters, ${key.startsWith("lg_") ? "starting" : "not starting"} with "lg_".`,
  );
  process.exit(1);
}
const auth = { Authorization: `Bearer ${key}` };
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
  if (!ok) failures++;
}

const get = (path, headers = {}) => fetch(new URL(path, base), { headers });

const health = await get("/health");
check("GET /health", health.ok, String(health.status));

const anonymous = await get("/v1/whoami");
check("no key -> 401", anonymous.status === 401, String(anonymous.status));
check("tenant responses are no-store", anonymous.headers.get("Cache-Control") === "no-store");

const whoami = await get("/v1/whoami", auth);
const tenant = whoami.ok ? (await whoami.json()).tenant : null;
check("key -> tenant", whoami.ok, tenant ?? String(whoami.status));

const manifest = JSON.parse(
  readFileSync(new URL("../evals/cuad/pdfs.manifest.json", import.meta.url), "utf8"),
);
const bySize = [...manifest.files].sort((a, b) => a.size - b.size);
const picks = [bySize[0], bySize[Math.floor(bySize.length / 2)], bySize.at(-1)];

async function upload(file) {
  const pdf = readFileSync(new URL(`../evals/data/cuad/pdf/${file.sha256}.pdf`, import.meta.url));
  const response = await fetch(new URL("/v1/documents", base), {
    method: "POST",
    headers: {
      ...auth,
      "Content-Length": String(pdf.length),
      "X-Filename": encodeURIComponent(`${file.title}.pdf`),
    },
    body: pdf,
  });
  return { status: response.status, body: await response.json() };
}

const ids = [];
for (const file of picks) {
  const started = Date.now();
  const { status, body } = await upload(file);
  let document = body.document;
  while (document?.status === "chunking" && Date.now() - started < 10 * 60 * 1000) {
    await sleep(2000);
    document = (await (await get(`/v1/documents/${document.id}`, auth)).json()).document;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const detail = `HTTP ${String(status)}, ${document?.status ?? body.error}, ${String(document?.pages)} pages, ${String(document?.chars)} chars, ${seconds} s, ${String(file.size)} bytes`;
  check(`upload -> ready: ${file.title.slice(0, 40)}`, document?.status === "ready", detail);
  ids.push(document?.id);
}

const again = await upload(picks[0]);
check(
  "same file again -> same document",
  again.status === 200 && again.body.document?.id === ids[0],
  String(again.status),
);

const missing = await get(`/v1/documents/${randomUUID()}`, auth);
check("unknown document -> 404", missing.status === 404, String(missing.status));

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
