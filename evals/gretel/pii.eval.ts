import { findPii, type PiiType } from "@lexguard/guardrails";
import { evalite } from "evalite";
import { toMetrics } from "../shared/metrics";
import { CONTRACT_DOC, TYPE_MAP } from "./evaluate";
import { gretelAvailable, loadGretelTest } from "./load";

// Case-by-case view of PII redaction on Gretel's contract-like documents, in the Evalite UI:
//   npm run fetch:gretel -w @lexguard/evals
//   npm run eval:watch -w @lexguard/evals
// Headline numbers and the CI gate live in report.test.ts.

interface Found {
  type: PiiType;
  value: string;
}

const PHONE_REGIONS = ["US", "GB", "AU"] as const;
const key = (f: Found) => `${f.type}\u0000${f.value}`;

evalite<string, Found[], Found[]>("PII redaction on Gretel contracts", {
  data: async () => {
    if (!gretelAvailable()) throw new Error("Run `npm run fetch:gretel -w @lexguard/evals` first.");
    const rows = (await loadGretelTest()).filter((row) => CONTRACT_DOC.test(row.documentType));
    return rows.map((row) => ({
      input: row.text,
      expected: row.entities.flatMap((entity) =>
        entity.types.flatMap((t) => {
          const type = TYPE_MAP[t];
          return type === undefined ? [] : [{ type, value: entity.value }];
        }),
      ),
    }));
  },
  task: (text) =>
    findPii(text, { phoneRegions: PHONE_REGIONS }).map(({ type, value }) => ({ type, value })),
  scorers: [
    {
      name: "Recall",
      description: "Share of labelled PII (email, phone, card) that was redacted exactly",
      scorer: ({ output, expected = [] }) => {
        const found = new Set(output.map(key));
        const tp = expected.filter((e) => found.has(key(e))).length;
        return toMetrics({ tp, fp: 0, fn: expected.length - tp }).recall;
      },
    },
  ],
  columns: ({ input, output, expected = [] }) => {
    const found = new Set(output.map(key));
    return [
      { label: "Text", value: input },
      { label: "Redacted", value: output.map((f) => `${f.type}: ${f.value}`).join("\n") },
      {
        label: "Missed",
        value: expected
          .filter((e) => !found.has(key(e)))
          .map((e) => `${e.type}: ${e.value}`)
          .join("\n"),
      },
    ];
  },
});
