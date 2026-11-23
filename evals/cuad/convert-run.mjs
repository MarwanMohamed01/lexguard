// M2 step 6: sends the 30 CUAD contract PDFs through the real Lexguard Worker and saves what
// it stored, so conversion.test.ts can measure toMarkdown's output against CUAD's own text.
//
// Runs `wrangler dev` locally: Worker code, D1 and the chunking Workflow run on this machine;
// only toMarkdown runs on Cloudflare (it always does), through your existing `wrangler login`.
// Nothing is deployed and nothing is created on the account.
//
// The API key is generated here, in memory, for this run only: it reaches wrangler as an
// environment variable (TENANT_KEYS holds only its hash) and is never written to disk.
// Local state goes to a fresh folder under evals/data/ (git-ignored) and is deleted after.
//
// Usage (from the repo root, after `npm run fetch:cuad-pdfs -w @lexguard/evals`):
//   node evals/cuad/convert-run.mjs

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workerDir = `${root}apps/worker`;
const manifest = JSON.parse(readFileSync(new URL("pdfs.manifest.json", import.meta.url), "utf8"));
const pdfDir = new URL("../data/cuad/pdf/", import.meta.url);
const outDir = new URL("../data/cuad/converted/", import.meta.url);
const state = fileURLToPath(new URL("../data/cuad/wrangler-state/", import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const key = `lg_${randomBytes(32).toString("base64url")}`;
const tenantKeys = JSON.stringify({ [createHash("sha256").update(key).digest("hex")]: "eval" });
const auth = { Authorization: `Bearer ${key}` };

// npx on Windows is a .cmd file, which needs a shell.
const shell = process.platform === "win32";

function wrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: workerDir,
    encoding: "utf8",
    shell,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

/** Runs a read-only query against the run's local D1 and returns the rows. */
function query(sql) {
  // Through a file: SQL on a Windows command line gets mangled by shell quoting.
  const file = `${state}query.sql`;
  writeFileSync(file, sql);
  const out = wrangler([
    "d1",
    "execute",
    "lexguard",
    "--local",
    "--persist-to",
    state,
    "--json",
    "--file",
    file,
  ]);
  return JSON.parse(out)[0].results;
}

rmSync(state, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
wrangler(["d1", "migrations", "apply", "lexguard", "--local", "--persist-to", state]);

const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", state], {
  cwd: workerDir,
  shell,
  env: { ...process.env, TENANT_KEYS: tenantKeys },
  stdio: ["ignore", "pipe", "pipe"],
});
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

function stopDev() {
  if (dev.exitCode !== null) return;
  if (shell) spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"]);
  else dev.kill("SIGTERM");
}
process.on("exit", stopDev);

try {
  // Wait for the Worker to answer.
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error(`wrangler dev did not start:\n${devLog}`);
    await sleep(500);
  }

  // LIMIT=n runs only the n smallest files (a quick trial); SHOW_LOG=1 prints the Worker's log.
  const limit = Number(process.env.LIMIT ?? manifest.files.length);
  const files = [...manifest.files].sort((a, b) => a.size - b.size).slice(0, limit);
  const runs = [];
  for (const file of files) {
    const pdf = readFileSync(new URL(`${file.sha256}.pdf`, pdfDir));
    const started = Date.now();
    const response = await fetch(`${BASE}/v1/documents`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Length": String(pdf.length),
        "X-Filename": encodeURIComponent(`${file.title}.pdf`),
      },
      body: pdf,
    });
    const body = await response.json();
    const uploadMs = Date.now() - started;
    let document = body.document;

    // Wait for the chunking job.
    while (document?.status === "chunking" && Date.now() - started < 10 * 60 * 1000) {
      await sleep(1000);
      const status = await fetch(`${BASE}/v1/documents/${document.id}`, { headers: auth });
      document = (await status.json()).document;
    }
    const readyMs = Date.now() - started;
    const outcome = [document?.status, body.error ?? document?.error].filter(Boolean).join(" ");
    const line = `${outcome || String(response.status)} upload ${String(uploadMs)} ms, total ${String(readyMs)} ms`;
    console.log(`${String(file.size).padStart(8)} B  ${line}  ${file.title.slice(0, 60)}`);
    runs.push({
      file,
      status: response.status,
      error: body.error ?? null,
      document,
      uploadMs,
      readyMs,
    });
  }

  // Export what was stored (text and chunks) for the offline measurements.
  for (const run of runs) {
    const id = run.document?.id;
    const doc =
      id === undefined
        ? undefined
        : query(
            `SELECT markdown, chars, hidden_chars_removed, page_starts FROM documents WHERE tenant_id = 'eval' AND id = '${id}'`,
          )[0];
    const chunks =
      id === undefined
        ? []
        : query(
            `SELECT start_offset AS start, end_offset AS end, heading, section_path AS sectionPath
       FROM chunks WHERE tenant_id = 'eval' AND document_id = '${id}' ORDER BY idx`,
          ).map((c) => ({ ...c, sectionPath: JSON.parse(c.sectionPath) }));
    const record = {
      title: run.file.title,
      pdfSha256: run.file.sha256,
      pdfBytes: run.file.size,
      httpStatus: run.status,
      error: run.error ?? run.document?.error ?? null,
      status: run.document?.status ?? null,
      uploadMs: run.uploadMs,
      readyMs: run.readyMs,
      markdown: doc?.markdown ?? null,
      hiddenCharsRemoved: doc?.hidden_chars_removed ?? null,
      pageStarts: doc?.page_starts == null ? null : JSON.parse(doc.page_starts),
      chunks,
    };
    writeFileSync(new URL(`${run.file.sha256}.json`, outDir), `${JSON.stringify(record)}\n`);
  }
  console.log(`saved ${String(runs.length)} results to evals/data/cuad/converted/`);
} finally {
  if (process.env.SHOW_LOG) {
    await sleep(2000); // let the Worker's log flush
    console.log(
      devLog
        .split("\n")
        .filter((l) => !l.includes("explorer"))
        .slice(-25)
        .join("\n"),
    );
  }
  stopDev();
  await sleep(1000);
  rmSync(state, { recursive: true, force: true });
}
