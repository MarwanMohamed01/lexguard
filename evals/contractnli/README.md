# ContractNLI

Real non-disclosure agreements (NDAs) checked by experts against 17 fixed rule-like
statements. Used for Lexguard's M5 checker eval: "does this contract meet, break or ignore
this rule, and which sentences show it?" (D44).

- **Dataset:** [ContractNLI](https://stanfordnlp.github.io/contract-nli/), 607 NDAs (train
  423, dev 61, test 123), 17 hypotheses such as "Receiving Party shall not reverse engineer
  any objects which embody Disclosing Party's Confidential Information". Each (NDA,
  hypothesis) pair has a label, `Entailment`, `Contradiction` or `NotMentioned`, and for the
  first two the evidence spans (a span is a sentence or a list item, with character offsets).
- **Licence:** CC BY 4.0, (c) Hitachi America, Ltd. (the `TERMS` file in the zip). Koreeda and
  Manning, "ContractNLI: A Dataset for Document-level Natural Language Inference for
  Contracts" (Findings of EMNLP 2021). Downloaded locally, never committed.
- **Pinned:** commit `3d2a4d47da022de1f1d740b8eea16930e55c21a1` of
  `stanfordnlp/contract-nli` (gh-pages, the last commit that changed the zip); zip and each
  unpacked file verified by SHA-256 in `fetch.mjs`. The original PDFs in the zip are not
  unpacked.

## Run

```bash
npm run fetch:contractnli -w @lexguard/evals   # train/dev/test JSON + LICENSE + TERMS
npx vitest run --root evals contractnli        # unit tests + baselines on the test split
```

## Baselines on the test split (2,091 pairs, 1,188 that the contract addresses)

Written to `../results/contractnli-baselines.json`.

| Label baseline                         | Accuracy | Macro F1 | Contradiction F1 |
| -------------------------------------- | -------- | -------- | ---------------- |
| Majority label of train (`Entailment`) | 0.463    | 0.211    | 0.000            |
| Majority label per hypothesis (train)  | 0.660    | 0.617    | 0.506            |

| Evidence: keyword top k (FTS5 porter) | Precision | Recall | F1    | At least one right |
| ------------------------------------- | --------- | ------ | ----- | ------------------ |
| top 1                                 | 0.493     | 0.244  | 0.326 | 0.493              |
| top 2                                 | 0.342     | 0.338  | 0.340 | 0.630              |
| top 3                                 | 0.268     | 0.398  | 0.320 | 0.702              |

If the checker reads only the keyword search's top k spans, the share of addressed pairs where
it sees at least one / all of the expert's spans:

| k   | 1     | 3     | 5     | 10    | 20    |
| --- | ----- | ----- | ----- | ----- | ----- |
| any | 0.493 | 0.702 | 0.796 | 0.894 | 0.972 |
| all | 0.182 | 0.308 | 0.380 | 0.491 | 0.673 |

Pinned subset for model runs: the 20 test documents with the lowest SHA-256 of
`contractnli-<id>` (340 pairs), listed in the results file.
