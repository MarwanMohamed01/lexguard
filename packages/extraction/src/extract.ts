import {
  parseModelOutput,
  redactPii,
  restorePii,
  type ParseFailureReason,
} from "@lexguard/guardrails";
import { buildPrompt, PROMPT_VERSION, type Prompt } from "./prompt";
import { ExtractedClause, ExtractionEnvelope } from "./schema";

// One extractor call on one chunk (M4 step 3):
//   [redact PII] -> prompt -> model -> JSON + envelope check -> each clause checked alone ->
//   [put PII back] -> quote must be in the ORIGINAL chunk verbatim -> exact offsets.
// The model is a parameter, so the same code runs with Ollama (evals), Workers AI (the
// Worker) and fakes (tests).

export type Model = (prompt: Prompt) => Promise<string>;

export interface ExtractOptions {
  /** Fresh random letters/digits for the document wrapper (see buildPrompt). */
  nonce: string;
  /** Replace emails, phones, IBANs and cards with placeholders before the model sees the
   * text. For providers outside Cloudflare (T12); quotes are restored before checking. */
  redact?: boolean;
}

/** An accepted clause, with its quote's position inside the chunk (UTF-16 offsets). */
export interface AcceptedClause extends ExtractedClause {
  start: number;
  end: number;
}

export interface Rejections {
  /** Did not match the form (unknown type, missing quote, too long...). */
  invalid: number;
  /** Quote not in the chunk. */
  quoteNotFound: number;
  /** ...of which only whitespace differs (diagnostic: still rejected). */
  whitespaceOnly: number;
  /** Same type and quote as an earlier entry. */
  duplicate: number;
}

export type ExtractionResult =
  | {
      ok: true;
      promptVersion: string;
      clauses: AcceptedClause[];
      rejected: Rejections;
      redacted: number;
    }
  | { ok: false; promptVersion: string; reason: ParseFailureReason; message: string };

const MAX_OUTPUT_CHARS = 60_000;

const collapse = (s: string) => s.replace(/\s+/gu, " ").trim();

export async function extractClauses(
  chunkText: string,
  model: Model,
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const redaction = options.redact === true ? redactPii(chunkText) : null;
  const sent = redaction?.text ?? chunkText;
  const raw = await model(buildPrompt(sent, options.nonce));

  const envelope = parseModelOutput(ExtractionEnvelope, raw, { maxChars: MAX_OUTPUT_CHARS });
  if (!envelope.ok) {
    return {
      ok: false,
      promptVersion: PROMPT_VERSION,
      reason: envelope.reason,
      message: envelope.message,
    };
  }

  const restore = (s: string) => (redaction === null ? s : restorePii(s, redaction.mapping));
  const rejected: Rejections = { invalid: 0, quoteNotFound: 0, whitespaceOnly: 0, duplicate: 0 };
  const clauses: AcceptedClause[] = [];
  const seen = new Set<string>();

  for (const entry of envelope.data.clauses) {
    const parsed = ExtractedClause.safeParse(entry);
    if (!parsed.success) {
      rejected.invalid++;
      continue;
    }
    const c = parsed.data;
    const clause: ExtractedClause = {
      ...c,
      quote: restore(c.quote),
      parties: c.parties.map(restore),
      obligations: c.obligations.map((o) => ({
        party: restore(o.party),
        action: restore(o.action),
      })),
      dates: c.dates.map(restore),
    };
    // The check is against the original chunk, never the text the model saw (T3).
    const start = chunkText.indexOf(clause.quote);
    if (clause.quote.trim().length === 0 || start === -1) {
      rejected.quoteNotFound++;
      if (clause.quote.trim().length > 0 && collapse(chunkText).includes(collapse(clause.quote))) {
        rejected.whitespaceOnly++;
      }
      continue;
    }
    const key = `${clause.clauseType}\u0000${clause.quote}`;
    if (seen.has(key)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(key);
    clauses.push({ ...clause, start, end: start + clause.quote.length });
  }

  return {
    ok: true,
    promptVersion: PROMPT_VERSION,
    clauses,
    rejected,
    redacted: redaction === null ? 0 : redaction.mapping.size,
  };
}
