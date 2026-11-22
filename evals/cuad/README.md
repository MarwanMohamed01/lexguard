# CUAD (Contract Understanding Atticus Dataset)

Real commercial contracts with lawyer-labelled clauses, used for Lexguard's contract evals.

- **Dataset:** [theatticusproject/cuad](https://huggingface.co/datasets/theatticusproject/cuad),
  file `CUAD_v1/CUAD_v1.json`: 510 contracts (26.8M characters of full text) and 13,823
  labelled clause spans across 41 clause types, each with its exact character offset.
- **Licence:** CC BY 4.0, © The Atticus Project. Hendrycks et al., "CUAD: An Expert-Annotated
  NLP Dataset for Legal Contract Review" (NeurIPS 2021). Downloaded locally, never committed.
- **Pinned revision:** `a3c393f5d103fd0c516374e4fdff676c8176dcb1`, verified by SHA-256 in
  `fetch.mjs`.

## Run

```bash
npm run fetch:cuad -w @lexguard/evals        # text + labels (CUAD_v1.json)
npm run fetch:cuad-pdfs -w @lexguard/evals   # the 30 original PDFs in pdfs.manifest.json
```

## Contract PDFs (M2)

The original PDFs of a 30-contract subset, for testing ingestion (`toMarkdown`, limits, CPU)
and comparing conversion output with CUAD's own text for the same contract.

- **Same pinned revision**, folder `CUAD_v1/full_contract_pdf` (510 PDFs, 101 MB in total).
- **Selection is a fixed rule, not hand-picked** (`select-pdfs.mjs`, which wrote the committed
  `pdfs.manifest.json`; re-running it gives a byte-identical manifest):
  - only PDFs whose file name equals a `CUAD_v1.json` title, so each pairs exactly with its
    text (506 of 510; the other 4 differ by trailing spaces or punctuation);
  - the **5 longest** by CUAD text characters (290k–338k). Characters, not PDF bytes: the
    largest PDFs are often scans, not long documents;
  - the **first 25 other titles by ascending SHA-256(title)**, a reproducible pseudo-random
    sample (3k–233k characters).
- **Integrity:** at selection, each file was checked against the hash Hugging Face publishes
  (SHA-256 for the 9 LFS files, git blob SHA-1 for the rest); the manifest records size and
  SHA-256, and `fetch-pdfs.mjs` verifies both. Files are stored as
  `evals/data/cuad/pdf/<sha256>.pdf` (8.3 MB, not committed).
- **Length:** about 1 to 154 pages (rough count of PDF page objects); 7 have more than 85
  pages. CUAD's longest contract is about 150 pages, so tests at 200–300 pages need the
  synthetic long document planned for the needle eval.

## PII over-redaction (M1): results

`redaction.test.ts` runs the redactor on all 510 contracts and writes
`../results/cuad-redaction.json`. CUAD has no PII labels, so this **describes** what would be
redacted; it is not a precision score.

| Configuration          | Redactions | Email | Phone | Card | Characters changed | Clause spans altered |
| ---------------------- | ---------- | ----- | ----- | ---- | ------------------ | -------------------- |
| No regions             | 414        | 339   | 75    | 0    | 0.033%             | 0 / 13,823           |
| `phoneRegions: ["US"]` | 947        | 339   | 608   | 0    | 0.059%             | 0 / 13,823           |

- Redactions are contact details in notice blocks, signature pages and press-release
  contacts (`Facsimile No. (708) 598-4671`, `Email: …@dova.com`). No lawyer-labelled clause
  span is touched.
- **Bug found and fixed here:** card detection first produced 33 hits, all false: rows of
  table figures and patent numbers that passed Luhn by chance. Cards now require a standard
  print layout and a card-issuer prefix (ISO/IEC 7812). Gretel card precision went to 1.000;
  Luhn-valid card recall 0.982 → 0.977.
- **CPU (Node, not yet measured inside Workers):** 0.40 ms per 1,000 characters with US
  phones; about 0.5 ms per 4,000-character chunk; 243 ms for the longest contract (292k
  characters) in one call, so redaction must run per chunk.

## Planned uses

- **Quote check (M5):** every labelled span must pass the verifier's exact-quote check;
  automatically altered spans (changed number, removed "not", swapped sentence) must fail.
- **Clause extraction (M4):** precision / recall / F1 of extracted clauses against the labels,
  as planned in PROJECT.md section 6.
