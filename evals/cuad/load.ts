import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

// CUAD v1 is in SQuAD format: each contract is one "paragraph" whose context is the full text,
// with 41 questions (one per clause type) whose answers are exact character spans.

export interface CuadSpan {
  clauseType: string;
  text: string;
  start: number;
}

export interface CuadContract {
  title: string;
  text: string;
  spans: CuadSpan[];
}

export const CUAD_FILE = new URL("../data/cuad/CUAD_v1.json", import.meta.url);

export function cuadAvailable(): boolean {
  return existsSync(CUAD_FILE);
}

// Validated, not trusted: downloaded data is untrusted input.
const Squad = z.object({
  data: z.array(
    z.object({
      title: z.string(),
      paragraphs: z
        .array(
          z.object({
            context: z.string(),
            qas: z.array(
              z.object({
                id: z.string(),
                answers: z.array(z.object({ text: z.string(), answer_start: z.number().int() })),
              }),
            ),
          }),
        )
        .length(1),
    }),
  ),
});

export function loadCuad(): CuadContract[] {
  const parsed = Squad.parse(JSON.parse(readFileSync(CUAD_FILE, "utf8")));
  return parsed.data.map((contract) => {
    const paragraph = contract.paragraphs[0];
    if (paragraph === undefined) throw new Error(`no text for ${contract.title}`);
    const spans = paragraph.qas.flatMap((qa) =>
      qa.answers.map((answer) => ({
        // Question ids look like "<title>__<Clause Type>".
        clauseType: qa.id.split("__").at(-1) ?? qa.id,
        text: answer.text,
        start: answer.answer_start,
      })),
    );
    return { title: contract.title, text: paragraph.context, spans };
  });
}
