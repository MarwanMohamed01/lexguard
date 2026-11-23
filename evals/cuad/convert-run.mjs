// M2 step 6: sends the 30 CUAD contract PDFs through the real Lexguard Worker (run locally,
// see evals/lib/local-worker.mjs) and saves what it stored, so conversion.test.ts can measure
// toMarkdown's output against CUAD's own text.
//
// Usage (from the repo root, after `npm run fetch:cuad-pdfs -w @lexguard/evals`):
//   node evals/cuad/convert-run.mjs
// LIMIT=n runs only the n smallest files (a quick trial); SHOW_LOG=1 prints the Worker's log.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { startLocalWorker } from "../lib/local-worker.mjs";

const manifest = JSON.parse(readFileSync(new URL("pdfs.manifest.json", import.meta.url), "utf8"));
const pdfDir = new URL("../data/cuad/pdf/", import.meta.url);
const outDir = new URL("../data/cuad/converted/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const worker = await startLocalWorker({
  stateDir: new URL("../data/cuad/wrangler-state/", import.meta.url),
});
try {
  const limit = Number(process.env.LIMIT ?? manifest.files.length);
  const files = [...manifest.files].sort((a, b) => a.size - b.size).slice(0, limit);
  for (const file of files) {
    const pdf = readFileSync(new URL(`${file.sha256}.pdf`, pdfDir));
    const run = await worker.upload(pdf, `${file.title}.pdf`);
    const outcome = [run.document?.status, run.error].filter(Boolean).join(" ");
    const line = `${outcome || String(run.httpStatus)} upload ${String(run.uploadMs)} ms, total ${String(run.readyMs)} ms`;
    console.log(`${String(file.size).padStart(8)} B  ${line}  ${file.title.slice(0, 60)}`);

    // Export what was stored (text and chunks) for the offline measurements.
    const id = run.document?.id;
    const doc =
      id === undefined
        ? undefined
        : worker.query(
            `SELECT markdown, hidden_chars_removed, page_starts FROM documents
             WHERE tenant_id = 'eval' AND id = '${id}'`,
          )[0];
    const chunks =
      id === undefined
        ? []
        : worker
            .query(
              `SELECT start_offset AS start, end_offset AS end, heading, section_path AS sectionPath
               FROM chunks WHERE tenant_id = 'eval' AND document_id = '${id}' ORDER BY idx`,
            )
            .map((c) => ({ ...c, sectionPath: JSON.parse(c.sectionPath) }));
    const record = {
      title: file.title,
      pdfSha256: file.sha256,
      pdfBytes: file.size,
      httpStatus: run.httpStatus,
      error: run.error,
      status: run.document?.status ?? null,
      uploadMs: run.uploadMs,
      readyMs: run.readyMs,
      markdown: doc?.markdown ?? null,
      hiddenCharsRemoved: doc?.hidden_chars_removed ?? null,
      pageStarts: doc?.page_starts == null ? null : JSON.parse(doc.page_starts),
      chunks,
    };
    writeFileSync(new URL(`${file.sha256}.json`, outDir), `${JSON.stringify(record)}\n`);
  }
  console.log(`saved ${String(files.length)} results to evals/data/cuad/converted/`);
} finally {
  if (process.env.SHOW_LOG) console.log(worker.log());
  await worker.stop();
}
