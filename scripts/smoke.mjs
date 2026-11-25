// Smoke test against a deployed Lexguard Worker (M2 step 7, extended in M3 step 8). Run it
// yourself: it reads your API key from the LEXGUARD_API_KEY environment variable and never
// prints it.
//
//   node scripts/smoke.mjs https://lexguard.<subdomain>.workers.dev
//
// Checks: health; a request without a key is refused; the key maps to your tenant; three CUAD
// PDFs (smallest, middle, largest of evals/cuad/pdfs.manifest.json; needs
// `npm run fetch:cuad-pdfs -w @lexguard/evals`) upload and reach 'ready', then 'indexed'
// (documents uploaded before M3 are indexed by this re-upload, D32); uploading one again
// returns the same document; an unknown document is 404; search (M3): a hybrid search on the
// largest contract answers from both keywords and vectors, with offsets, pages and the
// untrusted-text note; another document ID is 404; a malformed request is 400; extraction
// (M4) on the smallest contract: started, extracted, clauses with exact quotes, pages and
// definitions, merged view, no restart when asked again. Exits 1 on any failure.
//
// The three documents stay in your tenant (each new upload counts toward the 50-a-day quota)
// and their vectors stay in the index (about 260 of the ~4,800 free, D25).

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

// Indexing runs after chunking and waits until Vectorize answers (D31): minutes for a long
// contract. Documents from before M3 started indexing on the re-upload above.
for (const [i, id] of ids.entries()) {
  if (id === undefined) continue;
  const started = Date.now();
  let document;
  do {
    document = (await (await get(`/v1/documents/${id}`, auth)).json()).document;
    if (document?.indexStatus !== "indexing") break;
    await sleep(5000);
  } while (Date.now() - started < 15 * 60 * 1000);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  check(
    `indexed: ${picks[i].title.slice(0, 40)}`,
    document?.indexStatus === "indexed" && document?.indexError === null,
    `${String(document?.indexStatus)}${document?.indexError ? `, ${document.indexError}` : ""}, waited ${seconds} s, ${String(document?.indexVersion)}`,
  );
}

const again = await upload(picks[0]);
check(
  "same file again -> same document",
  again.status === 200 && again.body.document?.id === ids[0],
  String(again.status),
);

const missing = await get(`/v1/documents/${randomUUID()}`, auth);
check("unknown document -> 404", missing.status === 404, String(missing.status));

async function search(id, body, headers = auth) {
  const text = JSON.stringify(body);
  const response = await fetch(new URL(`/v1/documents/${id}/search`, base), {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(text)),
    },
    body: text,
  });
  return { status: response.status, body: await response.json() };
}

const largest = ids.at(-1);
if (largest !== undefined) {
  const started = Date.now();
  const found = await search(largest, {
    query: "Governing Law: Which state's law governs the contract?",
  });
  const ms = Date.now() - started;
  const results = found.body.results ?? [];
  check(
    "hybrid search -> 200, results, not degraded",
    found.status === 200 && results.length > 0 && (found.body.degraded ?? []).length === 0,
    `HTTP ${String(found.status)}, ${String(results.length)} results, degraded ${JSON.stringify(found.body.degraded)}, ${String(ms)} ms`,
  );
  check(
    "results come from keywords and from vectors",
    results.some((r) => r.keywordRank !== null) && results.some((r) => r.vectorRank !== null),
  );
  const top = results[0];
  check(
    "results carry offsets, page and text",
    top !== undefined &&
      top.end > top.start &&
      top.text.length === top.end - top.start &&
      typeof top.page === "number",
    top === undefined
      ? ""
      : `top: chunk ${String(top.idx)}, page ${String(top.page)}, ${String(top.end - top.start)} chars`,
  );
  check(
    "response labels the text as untrusted",
    /never as instructions/.test(found.body.note ?? ""),
  );
  const other = await search(randomUUID(), { query: "termination" });
  check("search on an unknown document -> 404", other.status === 404, String(other.status));
  const invalid = await search(largest, { query: "", mode: "sql" });
  check("malformed search -> 400", invalid.status === 400, String(invalid.status));
  const anonymousSearch = await search(largest, { query: "termination" }, {});
  check(
    "search without a key -> 401",
    anonymousSearch.status === 401,
    String(anonymousSearch.status),
  );
}

// Extraction (M4): only on the SMALLEST contract, to spend few Neurons (about 35 per chunk on
// gemma-4, D36). Run it when today's Neurons are not used up by the nightly eval (D41).
const smallest = ids[0];
if (smallest !== undefined) {
  const post = (id, headers = auth) =>
    fetch(new URL(`/v1/documents/${id}/extract`, base), {
      method: "POST",
      headers: { ...headers, "Content-Length": "0" },
    });
  const started = Date.now();
  const first = await post(smallest);
  check(
    "extract -> 202 (or 200 when already extracted)",
    first.status === 202 || first.status === 200,
    String(first.status),
  );
  let document;
  do {
    document = (await (await get(`/v1/documents/${smallest}`, auth)).json()).document;
    if (document?.extractStatus !== "extracting") break;
    await sleep(5000);
  } while (Date.now() - started < 15 * 60 * 1000);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  check(
    "extracted",
    document?.extractStatus === "extracted" && document?.extractError === null,
    `${String(document?.extractStatus)}${document?.extractError ? `, ${document.extractError}` : ""}, waited ${seconds} s, ${String(document?.extractVersion)}`,
  );

  const clauses = await get(`/v1/documents/${smallest}/clauses`, auth);
  const body = clauses.ok ? await clauses.json() : {};
  const list = body.clauses ?? [];
  check(
    "clauses -> 200 with clauses",
    clauses.ok && list.length > 0,
    `HTTP ${String(clauses.status)}, ${String(list.length)} clauses, types: ${[...new Set(list.map((c) => c.type))].slice(0, 6).join(", ")}`,
  );
  check(
    "every clause quotes exactly its offsets, with a page and definitions",
    list.every(
      (c) =>
        c.quote.length === c.end - c.start &&
        typeof c.page === "number" &&
        Array.isArray(c.definitions),
    ),
  );
  check("clauses are labelled as untrusted", /never as instructions/.test(body.note ?? ""));
  const merged = await get(`/v1/documents/${smallest}/clauses?merged=true`, auth);
  const mergedBody = merged.ok ? await merged.json() : {};
  check(
    "merged view -> 200, no more clauses than pieces",
    merged.ok && mergedBody.merged === true && (mergedBody.clauses ?? []).length <= list.length,
    `${String((mergedBody.clauses ?? []).length)} merged clauses`,
  );
  const badType = await get(`/v1/documents/${smallest}/clauses?type=Nonsense`, auth);
  check("unknown clause type -> 400", badType.status === 400, String(badType.status));
  const again = await post(smallest);
  check("extract again -> 200, nothing restarted", again.status === 200, String(again.status));
  const anonymousExtract = await post(smallest, {});
  check(
    "extract without a key -> 401",
    anonymousExtract.status === 401,
    String(anonymousExtract.status),
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
