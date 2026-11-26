import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

// ContractNLI (M5 step 2, D44): each NDA is checked against the same 17 hypotheses, e.g.
//   nda-11 "Receiving Party shall not reverse engineer any objects ... of Confidential Information."
// and an expert says Entailment (the contract says so), Contradiction (it says the opposite)
// or NotMentioned, with the evidence as indices into the document's spans (a span is a
// sentence or a list item, [start, end) character offsets into the text).

export type Choice = "Entailment" | "Contradiction" | "NotMentioned";
export const CHOICES: readonly Choice[] = ["Entailment", "Contradiction", "NotMentioned"];

export interface NliAnswer {
  choice: Choice;
  /** Indices into the document's spans; empty when NotMentioned. */
  evidence: number[];
}

export interface NliDoc {
  id: number;
  /** Stable name for pinned subsets (evals/extraction/dataset.ts pinnedSubset). */
  title: string;
  text: string;
  spans: (readonly [number, number])[];
  answers: Map<string, NliAnswer>;
}

export interface NliSplit {
  docs: NliDoc[];
  /** Hypothesis key -> its text, in key order (nda-1, nda-2, ...). */
  hypotheses: Map<string, string>;
}

export type SplitName = "train" | "dev" | "test";

export const contractNliFile = (split: SplitName) =>
  new URL(`../data/contractnli/${split}.json`, import.meta.url);

export function contractNliAvailable(): boolean {
  return (["train", "dev", "test"] as const).every((s) => existsSync(contractNliFile(s)));
}

// Validated, not trusted: downloaded data is untrusted input.
const File = z.object({
  documents: z.array(
    z.object({
      id: z.number().int(),
      text: z.string(),
      spans: z.array(z.tuple([z.number().int(), z.number().int()])),
      annotation_sets: z
        .array(
          z.object({
            annotations: z.record(
              z.string(),
              z.object({
                choice: z.enum(["Entailment", "Contradiction", "NotMentioned"]),
                spans: z.array(z.number().int()),
              }),
            ),
          }),
        )
        .min(1),
    }),
  ),
  labels: z.record(z.string(), z.object({ hypothesis: z.string() })),
});

const keyOrder = (a: string, b: string) =>
  Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""));

/** Parses and checks one split; throws on anything that would make a score meaningless. */
export function parseContractNli(raw: unknown): NliSplit {
  const file = File.parse(raw);
  const hypotheses = new Map(
    Object.keys(file.labels)
      .sort(keyOrder)
      .map((key) => [key, file.labels[key]?.hypothesis ?? ""]),
  );
  const docs = file.documents.map((doc): NliDoc => {
    for (const [start, end] of doc.spans) {
      if (start < 0 || end <= start || end > doc.text.length) {
        throw new Error(
          `doc ${String(doc.id)}: span [${String(start)}, ${String(end)}) out of range`,
        );
      }
    }
    const answers = new Map<string, NliAnswer>();
    // A single annotation set per document (the dataset's README).
    const annotations = doc.annotation_sets[0]?.annotations ?? {};
    for (const [key, a] of Object.entries(annotations)) {
      if (!hypotheses.has(key)) throw new Error(`doc ${String(doc.id)}: unknown hypothesis ${key}`);
      if (a.spans.some((i) => i < 0 || i >= doc.spans.length)) {
        throw new Error(`doc ${String(doc.id)} ${key}: evidence index out of range`);
      }
      if ((a.choice === "NotMentioned") !== (a.spans.length === 0)) {
        throw new Error(`doc ${String(doc.id)} ${key}: evidence and label disagree`);
      }
      answers.set(key, { choice: a.choice, evidence: [...new Set(a.spans)].sort((x, y) => x - y) });
    }
    return {
      id: doc.id,
      title: `contractnli-${String(doc.id)}`,
      text: doc.text,
      spans: doc.spans.map(([s, e]) => [s, e] as const),
      answers,
    };
  });
  return { docs, hypotheses };
}

export function loadContractNli(split: SplitName): NliSplit {
  return parseContractNli(JSON.parse(readFileSync(contractNliFile(split), "utf8")));
}
