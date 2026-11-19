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
npm run fetch:cuad -w @lexguard/evals
```

## Planned uses

- **PII over-redaction (M1):** how often the redactor changes genuine contract text.
- **Quote check (M5):** every labelled span must pass the verifier's exact-quote check;
  automatically altered spans (changed number, removed "not", swapped sentence) must fail.
- **Clause extraction (M4):** precision / recall / F1 of extracted clauses against the labels,
  as planned in PROJECT.md section 6.
