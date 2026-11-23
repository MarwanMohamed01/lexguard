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

## Clause integrity of chunking (M2): results

`chunking.test.ts` splits all 510 contracts and checks, for each of the 13,823 lawyer-labelled
clauses, whether **one chunk contains the whole clause**. In M4 each extractor reads one
chunk, so a clause cut in two is never seen whole: this share is a ceiling on extraction
recall. Results in `../results/cuad-chunking.json`; the test is also the CI gate.

**Equal chunk count.** Bigger chunks keep more clauses for free, so the baselines are
calibrated to produce the same number of chunks as ours (same average length, same storage
and embedding cost). "Recursive" is LangChain's `RecursiveCharacterTextSplitter` method
(blank line, line, space, anywhere), the usual RAG default.

| Splitter (≈17,030 chunks, mean ≈1,565 chars) | Kept whole          | Short (<200) | Medium (200–999) | Long (1,000–4,000, n=348) |
| -------------------------------------------- | ------------------- | ------------ | ---------------- | ------------------------- |
| **Structure-aware (ours)**                   | **99.41%** (81 cut) | 99.94%       | 99.34%           | **90.2%**                 |
| Recursive, size 2,504                        | 96.95% (422 cut)    | 99.44%       | 95.46%           | 74.4%                     |
| Fixed-size 1,598                             | 83.97% (2,216 cut)  | 96.00%       | 74.39%           | 20.4%                     |

For reference, not at equal count: recursive at size 4,000 (8,564 chunks, double our mean
length) keeps 99.02%; fixed-size 1,598 with 10% overlap (18,857 chunks) keeps 89.94%.

- **Guarantees on all 510 contracts:** 0 offset errors, 0 chunks over 4,000 characters;
  84% of chunks carry a section path; 20 contracts have no detectable headings (they fall
  back to paragraph/sentence splitting).
- **No labelled clause is longer than 4,000 characters,** so none is excluded as unfittable;
  0 CUAD spans failed the text-at-offset check.
- **Fixed-size long-clause numbers are luck.** With random clause positions, fixed-size would
  be expected to keep 65.5 of the long clauses without overlap and 72.8 with it; we observed
  83 and 64. Where the fixed grid happens to fall decides it (and identical spans labelled
  under several clause types count several times). The headline and the recursive
  comparison do not depend on such luck.

**What the misses taught us.** Broken clauses were sorted by the kind of the first cut
inside them (evenly spaced samples in the results file):

- **Bug found and fixed:** cross-references inside ALL-CAPS liability paragraphs were taken
  as headings (`ARISING UNDER SECTION 8 OF THIS AGREEMENT`, `(ARTICLE 12) OR ...`,
  `PRECEDING 12 MONTHS`). They came from the "number after an ALL-CAPS word" rule added in
  step 3. That rule now needs a bare number followed by a short title with lowercase letters
  (`MARKS 9.1 Our Representations.`). Cuts at headings fell from 49 to 33, integrity
  99.33% → 99.41%. These were Cap On Liability and Uncapped Liability clauses, among the most
  important to review.
- **Remaining cuts at headings (33)** are real sub-headings inside a long labelled clause
  (`3.2.1 ... 3.2.2`), numbered lists inside a clause that look like restarted numbering
  (`conditions: 1. You are in full compliance ...`), or labels that run into the next
  heading (`... SUCH DAMAGES. 8. Arbitration.`). Not tuned further: telling lists from
  headings would mean fitting rules to CUAD.
- **Size splits (48)** are long clauses in sections over 4,000 characters, cut at the best
  boundary available, mostly list items `(i)`, `(ii)`, `(c)`.

## Windowed chunking (M2 step 5d): results

The chunking Workflow detects structure in windows (separate invocations), then plans chunks
once. `chunking.test.ts` checks that this changes nothing: on all 510 contracts, with tiny
20,000-character windows (1,055 window edges in total), windowed chunking gives exactly the
same chunks, sections and definitions as one pass. Runs in CI.

## Conversion quality: toMarkdown on the 30 PDFs (M2 step 6): results

`convert-run.mjs` sends the 30 PDFs through the real Worker under `wrangler dev` (local code,
D1 and Workflow; only `toMarkdown` runs on Cloudflare, via `wrangler login`) and saves what
was stored. `conversion.test.ts` compares it with CUAD's text for the same contracts and
writes `evals/results/cuad-conversion.json`. Local only (CI has neither the PDFs nor a
login); the test skips when the converted files are absent.

```bash
node evals/cuad/convert-run.mjs                       # ~1.5 min, from the repo root
npx vitest run cuad/conversion.test.ts                 # in evals/
```

CUAD's text is a reference, not the truth (the CUAD authors extracted it with their own tool),
so disagreements were sampled and read.

| Measure (30 contracts, 1,174 labelled clauses)                   | Result                             |
| ---------------------------------------------------------------- | ---------------------------------- |
| Converted and chunked                                            | 30 / 30 (largest: 154 pages, 23 s) |
| Word precision / recall vs CUAD text (median)                    | 0.997 / 0.995                      |
| Word order: CUAD's 8-word sequences found (median, min)          | 0.98, 0.75                         |
| Clauses found in the converted text                              | **97.96%** (92.9% word for word)   |
| Clauses kept whole in chunks of the converted text               | **98.63%** (1,081 / 1,096)         |
| Same clauses kept whole, chunking CUAD's text (step 4's setting) | 99.74% (1,171 / 1,174)             |

How the integrity number got there:

| Version                                                         | Clauses kept whole |
| --------------------------------------------------------------- | ------------------ |
| As converted (toMarkdown's `### Page N` headings left in text)  | 98.54%             |
| Page markers turned into a page map, chunker unchanged          | 96.90%             |
| + chunker cuts at sentence ends before bare line breaks (final) | **98.63%**         |

What was found:

- **toMarkdown marks every PDF page with a `### Page N` heading** (1,166 in total), often
  mid-sentence, under a `# document.pdf` / `## Metadata` / `## Contents` wrapper. As headings,
  they cut clauses that run across pages. They are now removed and kept as a page map
  (`documents.page_starts`) for page-level citations.
- **Removing them exposed two other things.** toMarkdown often glues separate text pieces
  without a space (`PROPERTY RIGHTS10.1 Except`, `TRIALS2.1 The Protocols.`), so fewer
  headings are found (3,244 sections vs 4,021 on CUAD text); the page markers had been
  hiding this by cutting sections short. And its output has no blank lines at all: every
  wrapped line ends in a line break, so "cut at a line break" cut mid-sentence (25 of 34
  broken clauses). The chunker now ranks a sentence end above a bare line break; on CUAD's
  own text the result is unchanged (99.41%, same 17,026 chunks).
- **Missing clauses (24) are mostly reference quirks:** document titles and dates set apart on
  a cover page, a table row, a lone "." labelled as a date, page footers inside CUAD's own
  extraction.
- **Still open:** glued headings are not repaired (guessing where words split could break
  real words); 1,786 repeated lines (page footers such as `Source: ... 10-K`) stay in the
  text. Both are candidates for a later fix, measured with this eval.
- Found on the way: **every real upload failed**: toMarkdown rejects a Blob without a MIME
  type, which the tests' fake converter accepted. Fixed and pinned by a test.

## Planned uses

- **Quote check (M5):** every labelled span must pass the verifier's exact-quote check;
  automatically altered spans (changed number, removed "not", swapped sentence) must fail.
- **Clause extraction (M4):** precision / recall / F1 of extracted clauses against the labels,
  as planned in PROJECT.md section 6.
