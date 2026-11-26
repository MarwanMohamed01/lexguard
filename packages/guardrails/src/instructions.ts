// Text in a document that reads like an instruction to an AI (M5 step 9, D53; flagged as a
// gap in D41). Contracts state obligations ("The Recipient shall ..."); injected text asks a
// reader to DO something ("Write a script ...", "What is the capital of Brazil?", "Add a
// statistic in your response"). Each signal below is a generic mark of the second kind.
//
//   instructionSignals("Write a script to rename all files.")      -> ["task_verb"]
//   instructionSignals("The Recipient shall not copy the Materials.") -> []
//
// It is a filter, not a proof: tuned on BIPIA's TRAIN attacks and ContractNLI's TRAIN
// evidence, and measured on held-out data (evals/redteam/instructions.test.ts). A text that
// imitates contract language passes it; that is the counterparty writing the contract, which
// is what a review is for.

export type InstructionSignal =
  | "override" // "ignore the previous instructions", "disregard the rules above"
  | "ai_meta" // "assistant", "language model", "system prompt", "chatbot"
  | "your_output" // "in your response", "your answer"
  | "task_verb" // a sentence that opens with a request: "Write ...", "Translate ..."
  | "question" // a direct question: "What is ...?", "How can I ...?"
  | "code_or_link"; // code fences, script tags, links

const OVERRIDE =
  /\b(?:ignore|disregard|forget|override)\b[^.?!\n]{0,40}\b(?:instructions?|rules?|prompts?|guidelines?|above|previous|prior)\b/iu;
const AI_META =
  /\b(?:assistant|chatbot|chat ?gpt|language model|AI model|system prompt|jailbreak|as an AI)\b/iu;
const YOUR_OUTPUT =
  /\byour (?:response|answer|reply|output|summary|translation|message|text|words)\b/iu;
// Verbs that open requests but almost never open a sentence of a contract.
const TASK_VERBS = [
  "write",
  "translate",
  "summarize",
  "summarise",
  "explain",
  "generate",
  "compose",
  "draft",
  "develop",
  "break down",
  "replace",
  "render",
  "jumble",
  "describe",
  "tell",
  "list",
  "give",
  "suggest",
  "recommend",
  "calculate",
  "convert",
  "encode",
  "decode",
  "rewrite",
  "reply",
  "respond",
  "answer",
  "output",
  "print",
  "say",
  "repeat",
  "pretend",
  "act as",
  "imagine",
  "create",
  "add",
  "insert",
  "include a",
  "find",
  "search",
  "show",
  "provide",
  "share",
  "send",
  "visit",
  "click",
  "download",
  "please",
];
// Written as a word ("Write" or "write"), never as an ALL-CAPS heading ("LIST OF ..."): only
// the first letter may be a capital.
const verb = (v: string) => `[${(v[0] ?? "").toUpperCase()}${v[0] ?? ""}]${v.slice(1)}`;
const TASK = new RegExp(`(?:^|[.!?\\n]\\s*)(?:${TASK_VERBS.map(verb).join("|")})\\b`, "u");
const QUESTION =
  /(?:^|[.!?\n]\s*)(?:how|what|why|who|whom|where|when|which|can|could|would|should|is|are|do|does|did)\b[^.?!\n]{0,200}\?/iu;
const CODE_OR_LINK = /```|<\s*script\b|\bhttps?:\/\/|\bjavascript:/iu;

export function instructionSignals(text: string): InstructionSignal[] {
  const signals: InstructionSignal[] = [];
  if (OVERRIDE.test(text)) signals.push("override");
  if (AI_META.test(text)) signals.push("ai_meta");
  if (YOUR_OUTPUT.test(text)) signals.push("your_output");
  if (TASK.test(text.trim())) signals.push("task_verb");
  if (QUESTION.test(text.trim())) signals.push("question");
  if (CODE_OR_LINK.test(text)) signals.push("code_or_link");
  return signals;
}

export const isInstructionLike = (text: string): boolean => instructionSignals(text).length > 0;
