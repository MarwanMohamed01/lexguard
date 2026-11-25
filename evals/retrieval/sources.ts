// Loads the two corpora and the queries, shared by the embedding task and the eval.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cuadAvailable, loadCuad, loadCuadQuestions } from "../cuad/load";
import {
  convertedCorpus,
  queryFromQuestion,
  textCorpus,
  type ConvertedDoc,
  type Corpus,
} from "./dataset";

/** Same sizes as production (D15, D25). */
export const CHUNK_OPTIONS = { targetChars: 2_000, maxChars: 4_000 };

const CONVERTED = new URL("../data/cuad/converted/", import.meta.url);

export const convertedAvailable = () =>
  cuadAvailable() &&
  existsSync(CONVERTED) &&
  readdirSync(CONVERTED).some((f) => f.endsWith(".json"));

export function loadQueries(): Map<string, string> {
  return new Map([...loadCuadQuestions()].map(([type, q]) => [type, queryFromQuestion(q)]));
}

export function loadCorpora(): {
  text: Corpus;
  converted: (Corpus & { unlocated: number }) | null;
} {
  const contracts = loadCuad();
  const text = textCorpus(contracts, CHUNK_OPTIONS);
  if (!convertedAvailable()) return { text, converted: null };
  const docs = readdirSync(CONVERTED)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, CONVERTED), "utf8")) as ConvertedDoc);
  return { text, converted: convertedCorpus(docs, contracts) };
}
