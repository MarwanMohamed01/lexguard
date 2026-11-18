import { evalite } from "evalite";
import { piiCases, type Label } from "./dataset";
import { compare, predict, toMetrics } from "./metrics";

// Case-by-case view of PII redaction in the Evalite UI (`npm run eval:watch -w @lexguard/evals`).
// Headline numbers and the CI gate live in report.test.ts.
evalite<string, Label[], Label[]>("PII redaction (supported types)", {
  data: piiCases.map((c) => ({
    input: c.text,
    expected: c.expected.filter((l) => l.type !== "NAME"),
  })),
  task: (text) => predict(text),
  scorers: [
    {
      name: "Recall",
      description: "Share of labelled PII that was redacted",
      scorer: ({ output, expected = [] }) => toMetrics(compare(expected, output)).recall,
    },
    {
      name: "Precision",
      description: "Share of redactions that were really PII",
      scorer: ({ output, expected = [] }) => toMetrics(compare(expected, output)).precision,
    },
  ],
  columns: ({ input, output, expected = [] }) => {
    const counts = compare(expected, output);
    return [
      { label: "Text", value: input },
      { label: "Found", value: output.map((l) => `${l.type}: ${l.value}`).join("\n") },
      { label: "Missed", value: String(counts.fn) },
      { label: "False alarms", value: String(counts.fp) },
    ];
  },
});
